#!/usr/bin/env python3
"""
ServerOS host agent.

A small, narrowly scoped privileged helper that runs on the Ubuntu host (outside Docker)
and executes a fixed WHITELIST of host operations on behalf of the ServerOS container.

Security model
--------------
* Listens ONLY on a Unix socket (root:<socket_group>, mode 0660). Never on TCP.
* Every request carries a shared secret token (/etc/serveros/agent.token).
* No generic "run command" operation exists. Every operation has validated arguments and
  every external command is executed as an argv list (never through a shell).
* File operations are confined to configured roots and a deny-list of sensitive paths.
* Nginx file operations are confined to the detected Nginx configuration directory and
  never follow symlinks that leave it.
"""
import asyncio
import datetime
import fcntl
import hashlib
import hmac
import json
import logging
import os
import pty
import pwd
import re
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import termios
import threading
import time
import zipfile

VERSION = "1.0.0"
CONFIG_PATH = os.environ.get("SERVEROS_AGENT_CONFIG", "/etc/serveros/agent.json")

DEFAULT_CONFIG = {
    "socket": "/run/serveros/agent.sock",
    "socket_group": "serveros",
    "token_file": "/etc/serveros/agent.token",
    "state_dir": "/var/lib/serveros-agent",
    "app_uid": 10001,
    "app_gid": 10001,
    "file_roots": ["/home", "/opt", "/srv", "/var/www", "/etc/nginx", "/tmp"],
    "backup_dest_root": "/opt/serveros/data",
    "terminal_user": "root",
    "max_terminals": 8,
    "max_edit_bytes": 2 * 1024 * 1024,
    "max_upload_bytes": 4 * 1024 * 1024 * 1024,
    "max_zip_bytes": 8 * 1024 * 1024 * 1024,
    "max_zip_files": 200000,
    "protected_units": [],
}

T_DATA, T_CTRL, T_EXIT = 0, 1, 2
log = logging.getLogger("serveros-agent")


class AgentError(Exception):
    def __init__(self, code, message, status=400, details=None):
        super().__init__(message)
        self.code, self.message, self.status, self.details = code, message, status, details


# ----------------------------------------------------------------------------- config

def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH) as f:
            cfg.update(json.load(f))
    except FileNotFoundError:
        pass
    return cfg


CFG = load_config()
TOKEN = ""


def load_token():
    with open(CFG["token_file"]) as f:
        t = f.read().strip()
    if len(t) < 32:
        raise SystemExit("agent token is too short")
    return t


# ----------------------------------------------------------------------------- helpers

def run(cmd, timeout=60, input_text=None, cwd=None):
    """Run an argv list. Never uses a shell."""
    assert isinstance(cmd, (list, tuple)) and all(isinstance(c, str) for c in cmd)
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, input=input_text, cwd=cwd,
                           env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"})
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "command timed out after %ss" % timeout
    except FileNotFoundError:
        return 127, "", "command not found: %s" % cmd[0]


def which(name, extra=()):
    p = shutil.which(name, path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
    if p:
        return p
    for e in extra:
        if os.path.isfile(e) and os.access(e, os.X_OK):
            return e
    return None


def real(p):
    return os.path.realpath(p)


def within(path, root):
    path, root = real(path), real(root)
    return path == root or path.startswith(root.rstrip("/") + "/")


def now_stamp():
    return datetime.datetime.now().strftime("%Y%m%d-%H%M%S")


def ensure_dir(p, mode=0o700):
    os.makedirs(p, mode=mode, exist_ok=True)
    return p


def atomic_write(path, data, mode=None, owner=None):
    """Write bytes atomically (temp file in the same directory + rename)."""
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix=".serveros-", dir=d)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        if owner is not None:
            os.chown(tmp, owner[0], owner[1])
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._@:+-]{0,127}$")
UNIT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,127}\.service$")
DOMAIN_RE = re.compile(r"^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$", re.I)


def req_str(args, key, maxlen=4096, required=True, default=""):
    v = args.get(key, default)
    if v is None:
        v = default
    if not isinstance(v, str):
        raise AgentError("bad_request", "%s must be a string" % key)
    if required and not v:
        raise AgentError("bad_request", "%s is required" % key)
    if len(v) > maxlen or "\x00" in v:
        raise AgentError("bad_request", "%s is invalid" % key)
    return v


# ----------------------------------------------------------------------------- system info

def parse_os_release():
    out = {}
    try:
        with open("/etc/os-release") as f:
            for line in f:
                if "=" in line:
                    k, v = line.rstrip().split("=", 1)
                    out[k] = v.strip('"')
    except OSError:
        pass
    return out


_nginx_cache = {"t": 0, "v": None}


def nginx_info(force=False):
    if not force and time.time() - _nginx_cache["t"] < 15 and _nginx_cache["v"] is not None:
        return _nginx_cache["v"]
    binp = which("nginx", ("/usr/sbin/nginx", "/usr/local/nginx/sbin/nginx", "/usr/local/sbin/nginx", "/opt/nginx/sbin/nginx"))
    info = {"installed": False}
    if binp:
        rc, out, err = run([binp, "-V"], timeout=10)
        text = (err or "") + (out or "")
        m = re.search(r"nginx/([\w.\-]+)", text)

        def opt(name):
            mm = re.search(r"--%s=(\S+)" % re.escape(name), text)
            return mm.group(1) if mm else None
        conf = opt("conf-path") or "/etc/nginx/nginx.conf"
        unit = None
        rc2, o2, _ = run(["systemctl", "list-unit-files", "nginx*.service", "--no-legend", "--no-pager", "--plain"], timeout=10)
        for line in o2.splitlines():
            parts = line.split()
            if parts and parts[0].endswith(".service") and "@" not in parts[0]:
                unit = parts[0]
                break
        info = {
            "installed": True, "binary": binp, "version": m.group(1) if m else None,
            "conf_path": conf, "conf_dir": os.path.dirname(conf), "prefix": opt("prefix"),
            "error_log": opt("error-log-path") or "/var/log/nginx/error.log",
            "access_log": opt("http-log-path") or "/var/log/nginx/access.log",
            "pid_path": opt("pid-path"), "unit": unit, "build": text.strip()[:2000],
        }
    _nginx_cache.update(t=time.time(), v=info)
    return info


def certbot_bin():
    return which("certbot", ("/snap/bin/certbot", "/usr/local/bin/certbot", "/opt/certbot/bin/certbot"))


def op_ping(args):
    osr = parse_os_release()
    nx = nginx_info()
    return {
        "version": VERSION,
        "hostname": os.uname().nodename,
        "os": osr.get("PRETTY_NAME", "Linux"),
        "kernel": os.uname().release,
        "arch": os.uname().machine,
        "systemd": os.path.isdir("/run/systemd/system"),
        "nginx": {k: nx.get(k) for k in ("installed", "binary", "version", "conf_dir", "unit", "error_log", "access_log")},
        "certbot": {"installed": bool(certbot_bin()), "binary": certbot_bin()},
        "file_roots": [r for r in CFG["file_roots"] if os.path.isdir(r)],
        "terminal": {"user": CFG["terminal_user"], "shells": available_shells()},
        "limits": {"max_edit_bytes": CFG["max_edit_bytes"], "max_upload_bytes": CFG["max_upload_bytes"]},
    }


def available_shells():
    out = []
    try:
        with open("/etc/shells") as f:
            for line in f:
                line = line.strip()
                if line.startswith("/") and os.path.isfile(line) and os.access(line, os.X_OK) and line not in out:
                    if "nologin" in line or line.endswith("/false"):
                        continue
                    out.append(line)
    except OSError:
        pass
    return out or ["/bin/sh"]


def op_df(args):
    seen = {}
    ok_types = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "vfat", "ntfs", "ntfs3", "fuseblk", "exfat", "f2fs", "nfs", "nfs4", "cifs", "reiserfs", "jfs"}
    try:
        with open("/proc/mounts") as f:
            for line in f:
                parts = line.split()
                if len(parts) < 3:
                    continue
                dev, mnt, fst = parts[0], parts[1].replace("\\040", " "), parts[2]
                if fst not in ok_types:
                    continue
                if mnt.startswith("/var/lib/docker") or mnt.startswith("/snap/"):
                    continue
                try:
                    st = os.statvfs(mnt)
                except OSError:
                    continue
                total = st.f_blocks * st.f_frsize
                free = st.f_bavail * st.f_frsize
                used = (st.f_blocks - st.f_bfree) * st.f_frsize
                if total <= 0:
                    continue
                cur = {"device": dev, "mount": mnt, "fstype": fst, "total": total, "used": used, "free": free,
                       "percent": round(used / (used + free) * 100, 1) if (used + free) else 0}
                if dev not in seen or len(mnt) < len(seen[dev]["mount"]):
                    seen[dev] = cur
    except OSError:
        pass
    return sorted(seen.values(), key=lambda x: x["mount"])


def op_kill(args):
    pid = int(args.get("pid", 0))
    sig = args.get("signal", "TERM")
    allowed = {"TERM": signal.SIGTERM, "KILL": signal.SIGKILL, "HUP": signal.SIGHUP, "INT": signal.SIGINT, "STOP": signal.SIGSTOP, "CONT": signal.SIGCONT}
    if sig not in allowed:
        raise AgentError("bad_request", "unsupported signal")
    if pid <= 1 or pid == os.getpid() or pid == os.getppid():
        raise AgentError("forbidden", "refusing to signal this process", 403)
    try:
        os.kill(pid, allowed[sig])
    except ProcessLookupError:
        raise AgentError("not_found", "process not found", 404)
    except PermissionError:
        raise AgentError("forbidden", "permission denied", 403)
    return {"pid": pid, "signal": sig}


# ----------------------------------------------------------------------------- nginx

def nginx_root():
    info = nginx_info()
    if not info.get("installed"):
        raise AgentError("unavailable", "Nginx is not installed on this host", 501)
    root = info["conf_dir"]
    if not os.path.isdir(root):
        raise AgentError("unavailable", "Nginx configuration directory not found: %s" % root, 501)
    return real(root)


def ng_lexical(rel):
    """Return the lexical absolute path inside the nginx root (no symlink resolution)."""
    root = nginx_root()
    if not isinstance(rel, str) or "\x00" in rel:
        raise AgentError("bad_request", "invalid path")
    p = os.path.normpath(os.path.join(root, rel.lstrip("/")))
    if p != root and not p.startswith(root + "/"):
        raise AgentError("forbidden", "path is outside the Nginx configuration directory", 403)
    # parent directory must really live inside root (no symlinked directories leaving it)
    if not within(os.path.dirname(p), root):
        raise AgentError("forbidden", "directory resolves outside the Nginx configuration directory", 403)
    return p


def ng_real_target(rel):
    """Resolve for reading/writing content. Symlink targets must stay inside root."""
    p = ng_lexical(rel)
    rp = real(p)
    if not within(rp, nginx_root()):
        raise AgentError("forbidden", "symlink target is outside the Nginx configuration directory", 403)
    return p, rp


def ng_category(rel):
    parts = rel.split("/")
    if rel == os.path.basename(nginx_info().get("conf_path", "nginx.conf")):
        return "main"
    top = parts[0] if len(parts) > 1 else ""
    return {"sites-available": "sites-available", "sites-enabled": "sites-enabled", "conf.d": "conf.d",
            "snippets": "snippets", "modules-enabled": "modules", "modules-available": "modules"}.get(top, "other")


def op_nginx_info(args):
    return nginx_info(force=True)


def op_nginx_list(args):
    root = nginx_root()
    out = []
    count = 0
    for dp, dn, fn in os.walk(root, followlinks=False):
        dn[:] = sorted(d for d in dn if not d.startswith("."))
        for name in sorted(fn):
            if name.startswith(".") or name.endswith(".serveros-tmp"):
                continue
            full = os.path.join(dp, name)
            rel = os.path.relpath(full, root)
            count += 1
            if count > 3000:
                break
            try:
                lst = os.lstat(full)
                entry = {"path": rel, "category": ng_category(rel), "size": lst.st_size, "mtime": int(lst.st_mtime),
                         "symlink": stat.S_ISLNK(lst.st_mode)}
                if entry["symlink"]:
                    entry["target"] = os.readlink(full)
                    entry["broken"] = not os.path.exists(full)
                    entry["target_ok"] = (not entry["broken"]) and within(full, root)
                    if not entry["broken"]:
                        entry["size"] = os.stat(full).st_size
                out.append(entry)
            except OSError:
                continue
    # which available sites are enabled
    enabled = {}
    for e in out:
        if e["category"] == "sites-enabled" and e.get("symlink") and e.get("target_ok"):
            enabled[os.path.relpath(real(os.path.join(root, e["path"])), root)] = e["path"]
    for e in out:
        if e["category"] == "sites-available":
            e["enabled"] = e["path"] in enabled
    return {"root": root, "files": out}


def op_nginx_read(args):
    rel = req_str(args, "path")
    p, rp = ng_real_target(rel)
    if not os.path.isfile(rp):
        raise AgentError("not_found", "file not found", 404)
    st = os.stat(rp)
    if st.st_size > CFG["max_edit_bytes"]:
        raise AgentError("too_large", "file is too large to edit", 413)
    with open(rp, "rb") as f:
        data = f.read()
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise AgentError("binary", "file is not valid UTF-8 text", 415)
    return {"path": rel, "content": text, "mtime": int(st.st_mtime), "size": st.st_size,
            "symlink": os.path.islink(p), "target": os.readlink(p) if os.path.islink(p) else None,
            "sha256": hashlib.sha256(data).hexdigest()}


def nginx_backup_dir():
    return ensure_dir(os.path.join(CFG["state_dir"], "nginx-backups"))


def nginx_make_backup(rel, rp):
    if not os.path.isfile(rp):
        return None
    name = "%s__%s" % (now_stamp(), rel.replace("/", "%2F"))
    dst = os.path.join(nginx_backup_dir(), name)
    shutil.copy2(rp, dst)
    os.chmod(dst, 0o600)
    return name


def nginx_test():
    info = nginx_info()
    if not info.get("installed"):
        raise AgentError("unavailable", "Nginx is not installed", 501)
    rc, out, err = run([info["binary"], "-t"], timeout=30)
    return {"ok": rc == 0, "code": rc, "output": ((err or "") + (out or "")).strip()}


def nginx_included(rp):
    info = nginx_info()
    rc, out, err = run([info["binary"], "-T"], timeout=30)
    if rc != 0:
        return None
    for line in out.splitlines():
        if line.startswith("# configuration file ") and line.rstrip(":").endswith(rp):
            return True
        if line.startswith("# configuration file ") and real(line[len("# configuration file "):].rstrip(":")) == rp:
            return True
    return False


def nginx_service_reload():
    info = nginx_info()
    if info.get("unit") and os.path.isdir("/run/systemd/system"):
        rc, out, err = run(["systemctl", "reload", info["unit"]], timeout=60)
        cmd = "systemctl reload %s" % info["unit"]
    else:
        rc, out, err = run([info["binary"], "-s", "reload"], timeout=60)
        cmd = "nginx -s reload"
    return {"ok": rc == 0, "code": rc, "command": cmd, "output": ((err or "") + (out or "")).strip(), "status": nginx_status()}


def op_nginx_apply(args):
    """Stage -> validate -> (rollback on failure | keep + backup) -> optional reload."""
    rel = req_str(args, "path", 512)
    content = req_str(args, "content", CFG["max_edit_bytes"], required=False, default="")
    create = bool(args.get("create"))
    dry = bool(args.get("dry_run"))
    reload_after = bool(args.get("reload")) and not dry
    expected = args.get("expected_sha256")
    p = ng_lexical(rel)
    exists = os.path.lexists(p)
    if exists:
        p, rp = ng_real_target(rel)
        if not os.path.isfile(rp):
            raise AgentError("bad_request", "not a regular file")
    else:
        if not create:
            raise AgentError("not_found", "file does not exist (pass create=true to create it)", 404)
        rp = p
        if not os.path.isdir(os.path.dirname(rp)):
            raise AgentError("bad_request", "parent directory does not exist")
    original = None
    mode, owner = 0o644, None
    if exists:
        with open(rp, "rb") as f:
            original = f.read()
        st = os.stat(rp)
        mode, owner = stat.S_IMODE(st.st_mode), (st.st_uid, st.st_gid)
        if expected and hashlib.sha256(original).hexdigest() != expected:
            raise AgentError("conflict", "the file was modified on disk since you opened it", 409)
    new_bytes = content.encode("utf-8")
    backup = None
    # write candidate (atomic) so that `nginx -t` sees the real include graph
    atomic_write(rp, new_bytes, mode=mode, owner=owner)
    try:
        test = nginx_test()
    except Exception:
        _restore(rp, original, mode, owner)
        raise
    if not test["ok"] or dry:
        _restore(rp, original, mode, owner)
        return {"applied": False, "dry_run": dry, "test": test, "rolled_back": True}
    backup = nginx_make_backup_from_bytes(rel, original) if original is not None else None
    included = nginx_included(real(rp))
    res = {"applied": True, "test": test, "backup": backup, "included": included, "reload": None}
    if reload_after:
        res["reload"] = nginx_service_reload()
    return res


def nginx_make_backup_from_bytes(rel, data):
    name = "%s__%s" % (now_stamp(), rel.replace("/", "%2F"))
    dst = os.path.join(nginx_backup_dir(), name)
    fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return name


def _restore(rp, original, mode, owner):
    if original is None:
        try:
            os.unlink(rp)
        except OSError:
            pass
    else:
        atomic_write(rp, original, mode=mode, owner=owner)


def op_nginx_rename(args):
    a, b = ng_lexical(req_str(args, "from")), ng_lexical(req_str(args, "to"))
    if not os.path.lexists(a):
        raise AgentError("not_found", "source does not exist", 404)
    if os.path.lexists(b):
        raise AgentError("conflict", "destination already exists", 409)
    os.rename(a, b)
    return {"from": args["from"], "to": args["to"], "test": nginx_test()}


def op_nginx_delete(args):
    rel = req_str(args, "path")
    p = ng_lexical(rel)
    if not os.path.lexists(p):
        raise AgentError("not_found", "file does not exist", 404)
    if os.path.isdir(p) and not os.path.islink(p):
        raise AgentError("bad_request", "refusing to delete a directory")
    root = nginx_root()
    if p == os.path.join(root, os.path.basename(nginx_info()["conf_path"])):
        raise AgentError("forbidden", "refusing to delete the main nginx configuration file", 403)
    backup = None
    if not os.path.islink(p):
        backup = nginx_make_backup(rel, p)
    os.unlink(p)
    return {"deleted": rel, "backup": backup, "test": nginx_test()}


def op_nginx_toggle(args):
    name = req_str(args, "name", 255)
    enable = bool(args.get("enable"))
    root = nginx_root()
    avail, enabled = os.path.join(root, "sites-available"), os.path.join(root, "sites-enabled")
    if not os.path.isdir(avail) or not os.path.isdir(enabled):
        raise AgentError("unavailable", "this Nginx layout has no sites-available/sites-enabled directories", 501)
    if "/" in name or name.startswith("."):
        raise AgentError("bad_request", "invalid site name")
    src, link = os.path.join(avail, name), os.path.join(enabled, name)
    if enable:
        if not os.path.isfile(src):
            raise AgentError("not_found", "site does not exist in sites-available", 404)
        if os.path.lexists(link):
            raise AgentError("conflict", "a file named %s already exists in sites-enabled" % name, 409)
        os.symlink("../sites-available/" + name, link)
        test = nginx_test()
        if not test["ok"]:
            os.unlink(link)
            return {"changed": False, "test": test, "rolled_back": True}
        return {"changed": True, "test": test}
    if not os.path.lexists(link):
        raise AgentError("not_found", "site is not enabled", 404)
    if not os.path.islink(link):
        raise AgentError("conflict", "sites-enabled/%s is a regular file, not a symlink; refusing to remove it" % name, 409)
    target = os.readlink(link)
    os.unlink(link)
    test = nginx_test()
    if not test["ok"]:
        os.symlink(target, link)
        return {"changed": False, "test": test, "rolled_back": True}
    return {"changed": True, "test": test}


def op_nginx_backups(args):
    d = nginx_backup_dir()
    out = []
    for n in sorted(os.listdir(d), reverse=True)[:500]:
        if "__" not in n:
            continue
        ts, rel = n.split("__", 1)
        st = os.stat(os.path.join(d, n))
        out.append({"name": n, "time": ts, "path": rel.replace("%2F", "/"), "size": st.st_size})
    flt = args.get("path")
    if flt:
        out = [o for o in out if o["path"] == flt]
    return out


def op_nginx_backup_read(args):
    name = req_str(args, "name", 400)
    if "/" in name or name.startswith("."):
        raise AgentError("bad_request", "invalid backup name")
    fp = os.path.join(nginx_backup_dir(), name)
    if not os.path.isfile(fp):
        raise AgentError("not_found", "backup not found", 404)
    with open(fp, "rb") as f:
        return {"name": name, "content": f.read().decode("utf-8", "replace"), "path": name.split("__", 1)[1].replace("%2F", "/")}


def op_nginx_service(args):
    action = args.get("action")
    info = nginx_info()
    if not info.get("installed"):
        raise AgentError("unavailable", "Nginx is not installed", 501)
    if action == "test":
        return nginx_test()
    if action == "reload":
        t = nginx_test()
        if not t["ok"]:
            return {"ok": False, "code": t["code"], "command": "nginx -t", "output": t["output"], "refused": "Configuration test failed; reload was not attempted."}
        return nginx_service_reload()
    if action in ("restart", "start", "stop"):
        if action != "stop":
            t = nginx_test()
            if not t["ok"]:
                return {"ok": False, "code": t["code"], "command": "nginx -t", "output": t["output"], "refused": "Configuration test failed; %s was not attempted." % action}
        if info.get("unit"):
            rc, out, err = run(["systemctl", action, info["unit"]], timeout=90)
            return {"ok": rc == 0, "code": rc, "command": "systemctl %s %s" % (action, info["unit"]), "output": ((err or "") + (out or "")).strip(), "status": nginx_status()}
        raise AgentError("unavailable", "no systemd unit detected for nginx; only test/reload are supported", 501)
    raise AgentError("bad_request", "unknown action")


def nginx_status():
    info = nginx_info()
    if not info.get("installed"):
        return {"installed": False}
    st = {"installed": True, "version": info.get("version"), "unit": info.get("unit"), "binary": info["binary"]}
    if info.get("unit"):
        rc, out, _ = run(["systemctl", "show", info["unit"], "--no-pager", "-p", "ActiveState,SubState,UnitFileState,MainPID,ActiveEnterTimestamp"], timeout=10)
        for line in out.splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                st[k] = v
        st["active"] = st.get("ActiveState") == "active"
    else:
        st["active"] = os.path.exists(info.get("pid_path") or "/run/nginx.pid")
    return st


def op_nginx_status(args):
    return nginx_status()


def op_nginx_references(args):
    """Return nginx config files referencing a certificate name."""
    name = req_str(args, "cert_name", 255)
    root = nginx_root()
    needle = "/live/%s/" % name
    refs = []
    for dp, dn, fn in os.walk(root):
        for f in fn:
            fp = os.path.join(dp, f)
            try:
                if os.path.getsize(fp) > 2_000_000:
                    continue
                with open(fp, "r", errors="replace") as fh:
                    if needle in fh.read():
                        refs.append(os.path.relpath(fp, root))
            except OSError:
                continue
    return {"cert_name": name, "files": refs}


# ----------------------------------------------------------------------------- certbot

def need_certbot():
    b = certbot_bin()
    if not b:
        raise AgentError("unavailable", "Certbot is not installed on this host", 501)
    return b


CERT_BLOCK = re.compile(r"Certificate Name: (?P<name>.+)")


def op_certbot_list(args):
    b = need_certbot()
    rc, out, err = run([b, "certificates"], timeout=120)
    if rc != 0:
        raise AgentError("certbot_failed", (err or out).strip()[-1500:] or "certbot failed", 500)
    certs, cur = [], None
    for line in out.splitlines():
        s = line.strip()
        if s.startswith("Certificate Name:"):
            cur = {"name": s.split(":", 1)[1].strip(), "domains": [], "renewal_conf": None}
            certs.append(cur)
        elif cur is not None:
            if s.startswith("Domains:"):
                cur["domains"] = s.split(":", 1)[1].split()
            elif s.startswith("Expiry Date:"):
                m = re.match(r"Expiry Date:\s*(\S+ \S+)", s)
                cur["expiry"] = m.group(1) if m else None
                cur["valid_text"] = s[s.find("(") + 1:s.rfind(")")] if "(" in s else ""
                cur["status"] = "valid" if "VALID" in s and "INVALID" not in s else ("expired" if "EXPIRED" in s else "invalid")
            elif s.startswith("Certificate Path:"):
                cur["cert_path"] = s.split(":", 1)[1].strip()
            elif s.startswith("Private Key Path:"):
                cur["key_path"] = s.split(":", 1)[1].strip()  # path only, never the key
            elif s.startswith("Key Type:"):
                cur["key_type"] = s.split(":", 1)[1].strip()
    for c in certs:
        try:
            d = datetime.datetime.strptime(c["expiry"][:19], "%Y-%m-%d %H:%M:%S")
            c["days_left"] = (d - datetime.datetime.utcnow()).days
        except Exception:
            c["days_left"] = None
        cp = c.get("cert_path")
        if cp and os.path.isfile(cp):
            rc2, o2, _ = run(["openssl", "x509", "-in", cp, "-noout", "-issuer", "-subject", "-startdate", "-enddate"], timeout=10)
            for l in o2.splitlines():
                if l.startswith("issuer="):
                    c["issuer"] = l[7:].strip()
                elif l.startswith("notBefore="):
                    c["not_before"] = l[10:].strip()
        rc_path = "/etc/letsencrypt/renewal/%s.conf" % c["name"]
        c["renewal_conf"] = rc_path if os.path.isfile(rc_path) else None
    return {"certificates": certs}


def op_certbot_renewal_conf(args):
    name = req_str(args, "cert_name", 255)
    if not NAME_RE.match(name):
        raise AgentError("bad_request", "invalid certificate name")
    p = "/etc/letsencrypt/renewal/%s.conf" % name
    if not os.path.isfile(p):
        raise AgentError("not_found", "renewal configuration not found", 404)
    with open(p) as f:
        return {"path": p, "content": f.read()}


def op_certbot_timer(args):
    rc, out, _ = run(["systemctl", "list-timers", "--all", "--no-pager", "--no-legend", "*certbot*", "*snap.certbot*"], timeout=10)
    lines = [l for l in out.splitlines() if "certbot" in l]
    return {"timers": lines}


def certbot_argv(args):
    b = need_certbot()
    action = args.get("action")
    argv = [b]
    if action == "issue":
        domains = args.get("domains") or []
        if not isinstance(domains, list) or not domains or len(domains) > 20:
            raise AgentError("bad_request", "1-20 domains are required")
        for d in domains:
            if not isinstance(d, str) or not DOMAIN_RE.match(d):
                raise AgentError("bad_request", "invalid domain: %r" % (d,))
        method = args.get("method", "nginx")
        argv += ["certonly", "--non-interactive", "--agree-tos"]
        email = args.get("email") or ""
        if email:
            if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email) or len(email) > 254:
                raise AgentError("bad_request", "invalid e-mail address")
            argv += ["-m", email]
        else:
            argv += ["--register-unsafely-without-email"]
        if method == "nginx":
            argv += ["--nginx"]
        elif method == "standalone":
            argv += ["--standalone"]
        elif method == "webroot":
            wr = args.get("webroot") or ""
            if not wr.startswith("/") or not os.path.isdir(wr):
                raise AgentError("bad_request", "webroot must be an existing absolute directory")
            argv += ["--webroot", "-w", wr]
        else:
            raise AgentError("bad_request", "unsupported method")
        for d in domains:
            argv += ["-d", d]
        cn = args.get("cert_name") or ""
        if cn:
            if not NAME_RE.match(cn):
                raise AgentError("bad_request", "invalid certificate name")
            argv += ["--cert-name", cn]
        if args.get("staging"):
            argv += ["--staging"]
        return argv
    if action in ("renew", "dry_run"):
        argv += ["renew", "--non-interactive"]
        cn = args.get("cert_name") or ""
        if cn:
            if not NAME_RE.match(cn):
                raise AgentError("bad_request", "invalid certificate name")
            argv += ["--cert-name", cn]
        if action == "dry_run":
            argv += ["--dry-run"]
        elif args.get("force"):
            argv += ["--force-renewal"]
        return argv
    if action == "revoke":
        cn = req_str(args, "cert_name", 255)
        if not NAME_RE.match(cn):
            raise AgentError("bad_request", "invalid certificate name")
        return argv + ["revoke", "--non-interactive", "--cert-name", cn]
    if action == "delete":
        cn = req_str(args, "cert_name", 255)
        if not NAME_RE.match(cn):
            raise AgentError("bad_request", "invalid certificate name")
        refs = op_nginx_references({"cert_name": cn}) if nginx_info().get("installed") else {"files": []}
        if refs["files"] and not args.get("force"):
            raise AgentError("in_use", "certificate is referenced by Nginx configuration files", 409, refs)
        return argv + ["delete", "--non-interactive", "--cert-name", cn]
    raise AgentError("bad_request", "unknown certbot action")


# ----------------------------------------------------------------------------- systemd

CRITICAL = re.compile(r"^(ssh|sshd|docker|containerd|dbus|dbus-broker|networking|network|NetworkManager|systemd-[a-z0-9-]+|serveros-agent|"
                      r"getty@.*|serial-getty@.*|cron|rsyslog|polkit|ufw|firewalld|snapd|apparmor|netplan-.*|"
                      r"user@.*|multipathd|udev|cloud-init.*)\.service$")


def need_systemd():
    if not os.path.isdir("/run/systemd/system"):
        raise AgentError("unavailable", "systemd is not running on this host", 501)


def op_systemd_list(args):
    need_systemd()
    rc, out, err = run(["systemctl", "list-units", "--type=service", "--all", "--no-legend", "--no-pager", "--plain"], timeout=30)
    units = {}
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 4 or not parts[0].endswith(".service") or "@" in parts[0] and parts[0].endswith("@.service"):
            continue
        units[parts[0]] = {"name": parts[0], "load": parts[1], "active": parts[2], "sub": parts[3], "description": parts[4].strip() if len(parts) > 4 else "", "enabled": None}
    rc, out, err = run(["systemctl", "list-unit-files", "--type=service", "--no-legend", "--no-pager", "--plain"], timeout=30)
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 2 or parts[0].endswith("@.service"):
            continue
        u = units.setdefault(parts[0], {"name": parts[0], "load": "not-loaded", "active": "inactive", "sub": "dead", "description": "", "enabled": None})
        u["enabled"] = parts[1]
    res = sorted(units.values(), key=lambda u: u["name"])
    for u in res:
        u["critical"] = bool(CRITICAL.match(u["name"])) or u["name"] in CFG.get("protected_units", [])
    return res


def check_unit(args):
    need_systemd()
    name = req_str(args, "unit", 160)
    if not UNIT_RE.match(name):
        raise AgentError("bad_request", "invalid unit name")
    return name


def op_systemd_show(args):
    name = check_unit(args)
    rc, out, _ = run(["systemctl", "show", name, "--no-pager", "-p",
                      "Id,Description,LoadState,ActiveState,SubState,UnitFileState,MainPID,FragmentPath,ExecStart,ActiveEnterTimestamp,"
                      "MemoryCurrent,TasksCurrent,Restart,Result,NRestarts,Type,User"], timeout=15)
    props = {}
    for line in out.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            props[k] = v
    rc, st, _ = run(["systemctl", "status", name, "--no-pager", "-n", "0", "--lines=0"], timeout=15)
    return {"name": name, "properties": props, "status_text": st[-4000:], "critical": bool(CRITICAL.match(name))}


def op_systemd_action(args):
    name = check_unit(args)
    action = args.get("action")
    if action not in ("start", "stop", "restart", "reload", "enable", "disable"):
        raise AgentError("bad_request", "unsupported action")
    critical = bool(CRITICAL.match(name)) or name in CFG.get("protected_units", [])
    if name == "serveros-agent.service":
        raise AgentError("forbidden", "the ServerOS agent cannot be controlled through itself", 403)
    if critical and action in ("stop", "disable"):
        raise AgentError("forbidden", "%s is a critical system service; '%s' is blocked to prevent locking you out" % (name, action), 403)
    if critical and action == "restart" and not args.get("confirm_critical"):
        raise AgentError("confirm_required", "%s is a critical service; restarting may interrupt access. Confirm explicitly." % name, 409)
    rc, out, err = run(["systemctl", action, name], timeout=120)
    rc2, o2, _ = run(["systemctl", "is-active", name], timeout=10)
    return {"ok": rc == 0, "code": rc, "output": ((err or "") + (out or "")).strip(), "active": o2.strip()}


def op_systemd_failed(args):
    need_systemd()
    rc, out, _ = run(["systemctl", "list-units", "--state=failed", "--type=service", "--no-legend", "--no-pager", "--plain"], timeout=20)
    return [l.split()[0] for l in out.splitlines() if l.strip()]


# ----------------------------------------------------------------------------- logs

def log_sources():
    nx = nginx_info()
    src = [{"id": "journal", "label": "systemd journal (all)", "kind": "journal"},
           {"id": "unit:docker.service", "label": "Docker daemon", "kind": "journal"}]
    if nx.get("installed"):
        src += [{"id": "file:nginx_access", "label": "Nginx access log", "kind": "file", "path": nx["access_log"]},
                {"id": "file:nginx_error", "label": "Nginx error log", "kind": "file", "path": nx["error_log"]}]
        if nx.get("unit"):
            src.append({"id": "unit:%s" % nx["unit"], "label": "Nginx service (journal)", "kind": "journal"})
    if os.path.isfile("/var/log/letsencrypt/letsencrypt.log"):
        src.append({"id": "file:certbot", "label": "Certbot log", "kind": "file", "path": "/var/log/letsencrypt/letsencrypt.log"})
    return src


def op_log_sources(args):
    return log_sources()


def log_command(args, follow):
    sid = req_str(args, "source", 200)
    lines = max(1, min(int(args.get("lines", 200)), 5000))
    if sid == "journal" or sid.startswith("unit:"):
        cmd = ["journalctl", "--no-pager", "-o", "short-iso", "-n", str(lines)]
        if sid.startswith("unit:"):
            u = sid[5:]
            if not UNIT_RE.match(u):
                raise AgentError("bad_request", "invalid unit")
            cmd += ["-u", u]
        prio = args.get("priority")
        if prio in ("0", "1", "2", "3", "4", "5", "6", "7"):
            cmd += ["-p", prio]
        since, until = args.get("since"), args.get("until")
        for flag, val in (("--since", since), ("--until", until)):
            if val:
                if not re.match(r"^[0-9A-Za-z :.\-+T/]{1,40}$", str(val)):
                    raise AgentError("bad_request", "invalid time value")
                cmd += [flag, str(val)]
        if follow:
            cmd += ["-f"]
        return cmd
    if sid.startswith("file:"):
        files = {"nginx_access": nginx_info().get("access_log"), "nginx_error": nginx_info().get("error_log"),
                 "certbot": "/var/log/letsencrypt/letsencrypt.log"}
        path = files.get(sid[5:])
        if not path or not os.path.isfile(path):
            raise AgentError("not_found", "log file not found", 404)
        return ["tail", "-n", str(lines)] + (["-F"] if follow else []) + [path]
    raise AgentError("bad_request", "unknown log source")


def op_log_read(args):
    cmd = log_command(args, follow=False)
    rc, out, err = run(cmd, timeout=60)
    if rc != 0 and not out:
        raise AgentError("log_failed", (err or "failed to read log").strip()[:500], 500)
    return {"lines": out.splitlines()[-5000:]}


# ----------------------------------------------------------------------------- files

DENY_RE = re.compile(r"(^/etc/serveros(/|$))|(^/etc/shadow)|(^/etc/gshadow)|(^/etc/ssh/ssh_host_.*_key$)|(/privkey[^/]*\.pem$)|"
                     r"(^/etc/letsencrypt/(archive|keys|accounts)(/|$))|(^/var/lib/serveros-agent(/|$))|(^/root/\.ssh(/|$))|(\.ssh/id_[a-z0-9]+$)")


def effective_roots(args):
    cfg_roots = [real(r) for r in CFG["file_roots"] if os.path.isdir(r)]
    req = args.get("roots")
    if isinstance(req, list) and req:
        out = []
        for r in req:
            if isinstance(r, str) and os.path.isdir(r):
                rr = real(r)
                if any(rr == c or rr.startswith(c.rstrip("/") + "/") for c in cfg_roots):
                    out.append(rr)
        return out
    return cfg_roots


def fpath(args, key="path", must_exist=True, allow_link_leaf=False):
    roots = effective_roots(args)
    p = req_str(args, key, 4096)
    if not p.startswith("/"):
        raise AgentError("bad_request", "path must be absolute")
    norm = os.path.normpath(p)
    # resolve parent directory fully, leaf optionally (for symlink-aware operations)
    parent = real(os.path.dirname(norm))
    leaf = os.path.basename(norm)
    resolved = os.path.join(parent, leaf) if allow_link_leaf else real(norm)
    if not any(resolved == r or resolved.startswith(r.rstrip("/") + "/") for r in roots):
        raise AgentError("forbidden", "path is outside the permitted management directories", 403)
    if DENY_RE.search(resolved):
        raise AgentError("forbidden", "access to this path is blocked for security reasons", 403)
    if must_exist and not os.path.lexists(resolved):
        raise AgentError("not_found", "path does not exist", 404)
    return resolved


def entry_for(path, name=None):
    try:
        lst = os.lstat(path)
    except OSError:
        return None
    is_link = stat.S_ISLNK(lst.st_mode)
    try:
        st = os.stat(path) if is_link else lst
    except OSError:
        st = lst
    try:
        owner = pwd.getpwuid(st.st_uid).pw_name
    except KeyError:
        owner = str(st.st_uid)
    try:
        import grp
        group = grp.getgrgid(st.st_gid).gr_name
    except Exception:
        group = str(st.st_gid)
    return {"name": name or os.path.basename(path), "path": path,
            "type": "dir" if stat.S_ISDIR(st.st_mode) else ("file" if stat.S_ISREG(st.st_mode) else "other"),
            "symlink": is_link, "target": os.readlink(path) if is_link else None,
            "size": st.st_size, "mode": oct(stat.S_IMODE(st.st_mode))[2:].zfill(3), "owner": owner, "group": group,
            "mtime": int(st.st_mtime)}


def op_fs_list(args):
    p = fpath(args)
    if not os.path.isdir(p):
        raise AgentError("bad_request", "not a directory")
    items = []
    for name in sorted(os.listdir(p), key=str.lower)[:5000]:
        full = os.path.join(p, name)
        if DENY_RE.search(real(full)) and not os.path.islink(full):
            continue
        e = entry_for(full, name)
        if e:
            items.append(e)
    return {"path": p, "items": items, "roots": effective_roots(args)}


def op_fs_stat(args):
    return entry_for(fpath(args))


def op_fs_read(args):
    p = fpath(args)
    if not os.path.isfile(p):
        raise AgentError("bad_request", "not a regular file")
    st = os.stat(p)
    if st.st_size > CFG["max_edit_bytes"]:
        raise AgentError("too_large", "file is larger than the editor limit (%d bytes)" % CFG["max_edit_bytes"], 413)
    with open(p, "rb") as f:
        data = f.read()
    if b"\x00" in data[:8192]:
        raise AgentError("binary", "binary files cannot be edited as text", 415)
    return {"path": p, "content": data.decode("utf-8", "replace"), "mtime": int(st.st_mtime), "sha256": hashlib.sha256(data).hexdigest()}


def op_fs_write(args):
    exists_ok = True
    p = fpath(args, must_exist=False)
    content = args.get("content")
    if not isinstance(content, str) or len(content.encode("utf-8")) > CFG["max_edit_bytes"]:
        raise AgentError("too_large", "content too large", 413)
    mode, owner = 0o644, None
    if os.path.exists(p):
        if not os.path.isfile(p):
            raise AgentError("bad_request", "not a regular file")
        st = os.stat(p)
        mode, owner = stat.S_IMODE(st.st_mode), (st.st_uid, st.st_gid)
        exp = args.get("expected_sha256")
        if exp:
            with open(p, "rb") as f:
                if hashlib.sha256(f.read()).hexdigest() != exp:
                    raise AgentError("conflict", "file changed on disk since it was opened", 409)
    elif not args.get("create"):
        raise AgentError("not_found", "file does not exist", 404)
    elif not os.path.isdir(os.path.dirname(p)):
        raise AgentError("bad_request", "parent directory does not exist")
    atomic_write(p, content.encode("utf-8"), mode=mode, owner=owner)
    return entry_for(p)


def op_fs_mkdir(args):
    p = fpath(args, must_exist=False)
    if os.path.exists(p):
        raise AgentError("conflict", "already exists", 409)
    os.mkdir(p, 0o755)
    return entry_for(p)


def op_fs_rename(args):
    a = fpath(args, "from", allow_link_leaf=True)
    b = fpath(args, "to", must_exist=False, allow_link_leaf=True)
    if os.path.lexists(b):
        raise AgentError("conflict", "destination already exists", 409)
    shutil.move(a, b)
    return entry_for(b)


def op_fs_copy(args):
    a = fpath(args, "from", allow_link_leaf=True)
    b = fpath(args, "to", must_exist=False, allow_link_leaf=True)
    if os.path.lexists(b):
        raise AgentError("conflict", "destination already exists", 409)
    if os.path.isdir(a) and not os.path.islink(a):
        if b.startswith(a.rstrip("/") + "/"):
            raise AgentError("bad_request", "cannot copy a directory into itself")
        shutil.copytree(a, b, symlinks=True)
    else:
        shutil.copy2(a, b, follow_symlinks=False)
    return entry_for(b)


def op_fs_delete(args):
    p = fpath(args, allow_link_leaf=True)
    roots = effective_roots(args)
    if any(p == r for r in roots):
        raise AgentError("forbidden", "refusing to delete a management root", 403)
    if os.path.isdir(p) and not os.path.islink(p):
        if os.listdir(p) and not args.get("recursive"):
            raise AgentError("not_empty", "directory is not empty (recursive delete must be confirmed)", 409)
        shutil.rmtree(p)
    else:
        os.unlink(p)
    return {"deleted": p}


def op_fs_chmod(args):
    p = fpath(args)
    mode = req_str(args, "mode", 4)
    if not re.match(r"^[0-7]{3,4}$", mode):
        raise AgentError("bad_request", "mode must be octal like 644")
    os.chmod(p, int(mode, 8))
    return entry_for(p)



def zip_scan(p):
    """List regular files below directory p (no symlinks followed, sensitive files skipped) and enforce limits."""
    files, total = [], 0
    for dp, dn, fn in os.walk(p, followlinks=False):
        dn[:] = [d for d in dn if not os.path.islink(os.path.join(dp, d))]
        for f in fn:
            fp = os.path.join(dp, f)
            try:
                st = os.lstat(fp)
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode) or DENY_RE.search(fp):
                continue
            files.append(fp)
            total += st.st_size
            if len(files) > CFG["max_zip_files"]:
                raise AgentError("too_large", "folder has more than %d files" % CFG["max_zip_files"], 413)
            if total > CFG["max_zip_bytes"]:
                raise AgentError("too_large", "folder is larger than the ZIP limit (%d bytes)" % CFG["max_zip_bytes"], 413)
    return files, total


def op_dir_zip_info(args):
    p = fpath(args)
    if not os.path.isdir(p):
        raise AgentError("bad_request", "not a directory")
    files, total = zip_scan(p)
    return {"files": len(files), "size": total, "name": (os.path.basename(p.rstrip("/")) or "root")}

# ----------------------------------------------------------------------------- backup / restore of host config

def dest_ok(dest):
    root = real(CFG["backup_dest_root"])
    d = os.path.normpath(dest)
    if not within(os.path.dirname(d), root):
        raise AgentError("forbidden", "destination outside the configured backup directory", 403)
    return d


def op_host_archive(args):
    kind = args.get("kind")
    dest = dest_ok(req_str(args, "dest", 1024))
    include_keys = bool(args.get("include_keys"))
    uid, gid = CFG["app_uid"], CFG["app_gid"]
    fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    files = 0
    with os.fdopen(fd, "wb") as raw, tarfile.open(fileobj=raw, mode="w:gz") as tar:
        if kind == "nginx":
            root = nginx_root()
            tar.add(root, arcname="nginx", recursive=True)
            files = 1
        elif kind == "certbot":
            base = "/etc/letsencrypt"
            if not os.path.isdir(base):
                raise AgentError("unavailable", "/etc/letsencrypt does not exist", 501)
            if include_keys:
                tar.add(base, arcname="letsencrypt-full", recursive=True)
            else:
                for sub in ("renewal", "renewal-hooks"):
                    if os.path.isdir(os.path.join(base, sub)):
                        tar.add(os.path.join(base, sub), arcname="letsencrypt-config/" + sub, recursive=True)
                if os.path.isfile(os.path.join(base, "cli.ini")):
                    tar.add(os.path.join(base, "cli.ini"), arcname="letsencrypt-config/cli.ini")
                live = os.path.join(base, "live")
                if os.path.isdir(live):
                    for name in os.listdir(live):
                        for f in ("cert.pem", "chain.pem", "fullchain.pem"):  # public material only, never privkey
                            fp = os.path.join(live, name, f)
                            if os.path.exists(fp):
                                ti = tar.gettarinfo(real(fp), arcname="letsencrypt-public/%s/%s" % (name, f))
                                with open(real(fp), "rb") as fh:
                                    tar.addfile(ti, fh)
            files = 1
        elif kind == "extra":
            for i, p in enumerate(args.get("paths") or []):
                rp = fpath({"path": p, "roots": args.get("roots")})
                tar.add(rp, arcname="extra/%d_%s" % (i, os.path.basename(rp.rstrip("/")) or "root"), recursive=True)
                files += 1
        else:
            raise AgentError("bad_request", "unknown archive kind")
    os.chown(dest, uid, gid)
    return {"dest": dest, "size": os.path.getsize(dest), "kind": kind, "includes_private_keys": include_keys and kind == "certbot"}


def tar_members_safe(tar, allowed_prefixes):
    for m in tar.getmembers():
        n = m.name
        if n.startswith("/") or ".." in n.split("/"):
            raise AgentError("bad_archive", "archive contains unsafe path: %s" % n)
        if not any(n == p or n.startswith(p + "/") for p in allowed_prefixes):
            raise AgentError("bad_archive", "archive contains unexpected entry: %s" % n)
        if m.isdev() or m.isfifo():
            raise AgentError("bad_archive", "archive contains special files")
        if m.issym():
            tgt = os.path.normpath(os.path.join(os.path.dirname(n), m.linkname))
            if m.linkname.startswith("/") or tgt.startswith(".."):
                raise AgentError("bad_archive", "archive contains an escaping symlink: %s" % n)
    return True


def op_host_restore(args):
    kind = args.get("kind")
    src = real(req_str(args, "src", 1024))
    if not within(src, CFG["backup_dest_root"]):
        raise AgentError("forbidden", "source outside the configured backup directory", 403)
    dry = bool(args.get("dry_run"))
    with tarfile.open(src, "r:gz") as tar:
        if kind == "nginx":
            tar_members_safe(tar, ["nginx"])
            names = [m.name for m in tar.getmembers() if m.isfile() or m.issym()]
            root = nginx_root()
            replace = [n for n in names if os.path.lexists(os.path.join(os.path.dirname(root), n))]
            if dry:
                return {"kind": kind, "new": len(names) - len(replace), "replaced": replace[:300], "total": len(names)}
            pre = os.path.join(ensure_dir(os.path.join(CFG["state_dir"], "pre-restore")), "nginx-%s.tar.gz" % now_stamp())
            with tarfile.open(pre, "w:gz") as t2:
                t2.add(root, arcname="nginx")
            os.chmod(pre, 0o600)
            tar.extractall(os.path.dirname(root), filter="data")
            test = nginx_test()
            if not test["ok"]:
                with tarfile.open(pre, "r:gz") as t3:
                    t3.extractall(os.path.dirname(root), filter="data")
                return {"kind": kind, "restored": False, "rolled_back": True, "test": test, "pre_restore": pre}
            return {"kind": kind, "restored": True, "test": test, "pre_restore": pre}
        if kind == "certbot":
            names = [m.name for m in tar.getmembers()]
            if any(n.startswith("letsencrypt-full") for n in names):
                prefix, target = "letsencrypt-full", "/etc"
            elif any(n.startswith("letsencrypt-config") for n in names):
                prefix, target = "letsencrypt-config", "/etc"
            else:
                raise AgentError("bad_archive", "not a certbot archive")
            tar_members_safe(tar, [prefix, "letsencrypt-public"])
            if dry:
                return {"kind": kind, "mode": prefix, "total": len(names),
                        "note": "Public certificate copies (letsencrypt-public) are informational and are never written back." if prefix == "letsencrypt-config" else "Full /etc/letsencrypt (including private keys) will be restored."}
            pre = os.path.join(ensure_dir(os.path.join(CFG["state_dir"], "pre-restore")), "letsencrypt-%s.tar.gz" % now_stamp())
            with tarfile.open(pre, "w:gz") as t2:
                t2.add("/etc/letsencrypt", arcname="letsencrypt-full")
            os.chmod(pre, 0o600)
            members = [m for m in tar.getmembers() if m.name.startswith(prefix)]
            dest_tmp = tempfile.mkdtemp(prefix="restore-", dir=CFG["state_dir"])
            tar.extractall(dest_tmp, members=members, filter="data")
            srcdir = os.path.join(dest_tmp, prefix)
            if prefix == "letsencrypt-full":
                shutil.copytree(srcdir, "/etc/letsencrypt", symlinks=True, dirs_exist_ok=True)
            else:
                shutil.copytree(srcdir, "/etc/letsencrypt", symlinks=True, dirs_exist_ok=True)
            shutil.rmtree(dest_tmp, ignore_errors=True)
            return {"kind": kind, "restored": True, "pre_restore": pre}
    raise AgentError("bad_request", "unknown restore kind")



# ----------------------------------------------------------------------------- docker compose (projects living on the host)

PROJECT_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,62}$")
SERVICE_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$")
COMPOSE_OPS = {"up": ["up", "-d"], "down": ["down"], "stop": ["stop"], "start": ["start"], "restart": ["restart"],
               "pull": ["pull"], "recreate": ["up", "-d", "--force-recreate"]}


def docker_bin():
    return which("docker", ("/usr/bin/docker", "/usr/local/bin/docker", "/snap/bin/docker"))


def compose_base(args):
    """Validated `docker compose -p P --project-directory D -f F...` prefix. Directory/files must be inside permitted roots."""
    b = docker_bin()
    if not b:
        raise AgentError("unavailable", "The Docker CLI was not found on the host", 501)
    d = fpath({"path": req_str(args, "dir"), "roots": args.get("roots")})
    if not os.path.isdir(d):
        raise AgentError("bad_request", "project directory does not exist")
    project = req_str(args, "project", 63)
    if not PROJECT_RE.match(project):
        raise AgentError("bad_request", "invalid project name")
    files = args.get("files") or []
    if not isinstance(files, list) or not files or len(files) > 10:
        raise AgentError("bad_request", "compose files are required")
    argv = [b, "compose", "-p", project, "--project-directory", d]
    for f in files:
        argv += ["-f", fpath({"path": f, "roots": args.get("roots")})]
    return argv, d


COMPOSE_ENV = {"COMPOSE_ANSI": "never", "COMPOSE_PROGRESS": "plain", "HOME": "/root"}


def op_compose_check(args):
    argv, d = compose_base(args)
    action = args.get("action")
    if action == "config":
        cmd = argv + ["config", "-q"]
    elif action == "ps":
        cmd = argv + ["ps", "-a", "--format", "json"]
    else:
        raise AgentError("bad_request", "unknown action")
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=60, cwd=d,
                           env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", **COMPOSE_ENV})
    except subprocess.TimeoutExpired:
        raise AgentError("timeout", "docker compose timed out", 504)
    return {"code": p.returncode, "stdout": p.stdout, "stderr": p.stderr}

# ----------------------------------------------------------------------------- RPC table

RPC = {
    "ping": op_ping, "df": op_df, "kill": op_kill,
    "nginx_info": op_nginx_info, "nginx_list": op_nginx_list, "nginx_read": op_nginx_read, "nginx_apply": op_nginx_apply,
    "nginx_rename": op_nginx_rename, "nginx_delete": op_nginx_delete, "nginx_toggle": op_nginx_toggle,
    "nginx_backups": op_nginx_backups, "nginx_backup_read": op_nginx_backup_read, "nginx_service": op_nginx_service,
    "nginx_status": op_nginx_status, "nginx_references": op_nginx_references,
    "certbot_list": op_certbot_list, "certbot_renewal_conf": op_certbot_renewal_conf, "certbot_timer": op_certbot_timer,
    "systemd_list": op_systemd_list, "systemd_show": op_systemd_show, "systemd_action": op_systemd_action, "systemd_failed": op_systemd_failed,
    "log_sources": op_log_sources, "log_read": op_log_read,
    "fs_list": op_fs_list, "fs_stat": op_fs_stat, "fs_read": op_fs_read, "fs_write": op_fs_write, "fs_mkdir": op_fs_mkdir,
    "fs_rename": op_fs_rename, "fs_copy": op_fs_copy, "fs_delete": op_fs_delete, "fs_chmod": op_fs_chmod,
    "host_archive": op_host_archive, "host_restore": op_host_restore,
    "compose_check": op_compose_check, "dir_zip_info": op_dir_zip_info,
}

# ----------------------------------------------------------------------------- streaming

def frame(t, payload=b""):
    if isinstance(payload, str):
        payload = payload.encode()
    return struct.pack(">BI", t, len(payload)) + payload


async def read_frame(reader):
    hdr = await reader.readexactly(5)
    t, n = struct.unpack(">BI", hdr)
    if n > 16 * 1024 * 1024:
        raise AgentError("bad_request", "frame too large")
    return t, (await reader.readexactly(n) if n else b"")


async def stream_subprocess(reader, writer, cmd, cwd=None, env_extra=None):
    env = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}
    if env_extra:
        env.update(env_extra)
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, cwd=cwd, env=env)

    async def pump():
        while True:
            chunk = await proc.stdout.read(8192)
            if not chunk:
                break
            writer.write(frame(T_DATA, chunk))
            await writer.drain()
        code = await proc.wait()
        writer.write(frame(T_EXIT, json.dumps({"code": code})))
        await writer.drain()

    async def watch_client():
        try:
            while True:
                await read_frame(reader)
        except Exception:
            pass

    t1, t2 = asyncio.create_task(pump()), asyncio.create_task(watch_client())
    done, pending = await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
    if proc.returncode is None:
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), 5)
        except Exception:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
    for t in pending:
        t.cancel()


async def sop_log_follow(reader, writer, args):
    cmd = log_command(args, follow=True)
    writer.write(b'{"ok":true}\n')
    await stream_subprocess(reader, writer, cmd)


async def sop_certbot(reader, writer, args):
    cmd = certbot_argv(args)
    writer.write(b'{"ok":true}\n')
    writer.write(frame(T_DATA, ("$ " + " ".join(cmd) + "\n").encode()))
    await stream_subprocess(reader, writer, cmd)


async def sop_file_get(reader, writer, args):
    p = fpath(args)
    if not os.path.isfile(p):
        raise AgentError("bad_request", "not a regular file")
    size = os.path.getsize(p)
    writer.write((json.dumps({"ok": True, "size": size, "name": os.path.basename(p)}) + "\n").encode())
    loop = asyncio.get_running_loop()
    with open(p, "rb") as f:
        while True:
            chunk = await loop.run_in_executor(None, f.read, 256 * 1024)
            if not chunk:
                break
            writer.write(frame(T_DATA, chunk))
            await writer.drain()
    writer.write(frame(T_EXIT, json.dumps({"code": 0})))
    await writer.drain()


async def sop_file_put(reader, writer, args):
    p = fpath(args, must_exist=False)
    if os.path.lexists(p) and not args.get("overwrite"):
        raise AgentError("conflict", "file already exists", 409)
    if not os.path.isdir(os.path.dirname(p)):
        raise AgentError("bad_request", "parent directory does not exist")
    limit = CFG["max_upload_bytes"]
    fd, tmp = tempfile.mkstemp(prefix=".serveros-upload-", dir=os.path.dirname(p))
    writer.write(b'{"ok":true}\n')
    await writer.drain()
    total = 0
    loop = asyncio.get_running_loop()
    try:
        with os.fdopen(fd, "wb") as f:
            while True:
                t, payload = await read_frame(reader)
                if t == T_DATA:
                    total += len(payload)
                    if total > limit:
                        raise AgentError("too_large", "upload exceeds the size limit", 413)
                    await loop.run_in_executor(None, f.write, payload)
                elif t == T_CTRL and json.loads(payload).get("end"):
                    break
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o644)
        if os.path.exists(p):
            os.chmod(tmp, stat.S_IMODE(os.stat(p).st_mode))
        os.replace(tmp, p)
        writer.write(frame(T_EXIT, json.dumps({"code": 0, "size": total})))
    except Exception as e:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        writer.write(frame(T_EXIT, json.dumps({"code": 1, "error": str(e)})))
    await writer.drain()


_terminals = 0


async def sop_pty(reader, writer, args):
    global _terminals
    if _terminals >= CFG["max_terminals"]:
        raise AgentError("limit", "too many open host terminals", 429)
    shells = available_shells()
    shell = args.get("shell") or shells[0]
    if shell not in shells:
        raise AgentError("bad_request", "shell is not available on this host")
    user = CFG["terminal_user"]
    try:
        pw = pwd.getpwnam(user)
    except KeyError:
        raise AgentError("config", "terminal_user %r does not exist" % user, 500)
    cols = max(10, min(int(args.get("cols", 80)), 500))
    rows = max(2, min(int(args.get("rows", 24)), 300))
    env = {"TERM": "xterm-256color", "LANG": "C.UTF-8", "HOME": pw.pw_dir, "USER": user, "LOGNAME": user, "SHELL": shell,
           "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
    pid, fd = pty.fork()
    if pid == 0:  # child
        try:
            os.chdir(pw.pw_dir if os.path.isdir(pw.pw_dir) else "/")
            if user == "root":
                os.execve(shell, [shell, "-l"], env)
            else:
                os.execve("/bin/su", ["su", "-l", "-s", shell, user], env)
        finally:
            os._exit(127)
    _terminals += 1
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    writer.write(json.dumps({"ok": True, "pid": pid, "shell": shell, "user": user}).encode() + b"\n")
    await writer.drain()
    loop = asyncio.get_running_loop()
    q = asyncio.Queue()
    closed = {"v": False}

    def on_readable():
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        q.put_nowait(data)
        if not data:
            loop.remove_reader(fd)

    loop.add_reader(fd, on_readable)

    async def to_client():
        while True:
            data = await q.get()
            if not data:
                break
            writer.write(frame(T_DATA, data))
            await writer.drain()
        try:
            _, status = await loop.run_in_executor(None, os.waitpid, pid, 0)
            code = os.waitstatus_to_exitcode(status)
        except ChildProcessError:
            code = 0
        closed["v"] = True
        writer.write(frame(T_EXIT, json.dumps({"code": code})))
        await writer.drain()

    async def from_client():
        try:
            while True:
                t, payload = await read_frame(reader)
                if t == T_DATA:
                    os.write(fd, payload)
                elif t == T_CTRL:
                    c = json.loads(payload)
                    if c.get("resize"):
                        r, cc = max(2, min(int(c["rows"]), 300)), max(10, min(int(c["cols"]), 500))
                        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, cc, 0, 0))
        except Exception:
            pass

    t1, t2 = asyncio.create_task(to_client()), asyncio.create_task(from_client())
    try:
        await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        _terminals -= 1
        try:
            loop.remove_reader(fd)
        except Exception:
            pass
        if not closed["v"]:
            try:
                os.kill(pid, signal.SIGHUP)
                await asyncio.sleep(0.2)
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                pass
        try:
            os.close(fd)
        except OSError:
            pass
        for t in (t1, t2):
            t.cancel()



async def sop_compose(reader, writer, args):
    argv, d = compose_base(args)
    op = args.get("op")
    svc = args.get("services") or []
    if not isinstance(svc, list) or len(svc) > 50 or not all(isinstance(x, str) and SERVICE_RE.match(x) for x in svc):
        raise AgentError("bad_request", "invalid service list")
    if op == "logs":
        try:
            tail = max(0, min(int(args.get("tail", 100)), 5000))
        except (TypeError, ValueError):
            tail = 100
        cmd = argv + ["logs", "-f", "--no-color", "--timestamps", "--tail", str(tail)]
    elif op in COMPOSE_OPS:
        cmd = argv + COMPOSE_OPS[op] + svc
    else:
        raise AgentError("bad_request", "unknown compose operation")
    writer.write(b'{"ok":true}\n')
    writer.write(frame(T_DATA, ("$ " + " ".join(cmd[1:]) + "\n").encode()))
    await stream_subprocess(reader, writer, cmd, cwd=d, env_extra=COMPOSE_ENV)


async def sop_dir_zip(reader, writer, args):
    """Stream a ZIP archive of a directory (built on the fly, never stored on disk)."""
    p = fpath(args)
    if not os.path.isdir(p):
        raise AgentError("bad_request", "not a directory")
    loop = asyncio.get_running_loop()
    files, total = await loop.run_in_executor(None, zip_scan, p)
    base = os.path.basename(p.rstrip("/")) or "root"
    writer.write((json.dumps({"ok": True, "name": base + ".zip", "files": len(files), "size": total}) + "\n").encode())
    await writer.drain()
    q = asyncio.Queue(maxsize=16)
    cancel = threading.Event()

    class Sink:
        def write(self, b):
            if cancel.is_set():
                raise IOError("cancelled")
            if b:
                asyncio.run_coroutine_threadsafe(q.put(bytes(b)), loop).result()
            return len(b)

        def flush(self):
            pass

    def build():
        try:
            with zipfile.ZipFile(Sink(), "w", zipfile.ZIP_DEFLATED, allowZip64=True, strict_timestamps=False) as zf:
                for fp in files:
                    if cancel.is_set():
                        break
                    try:
                        zf.write(fp, os.path.join(base, os.path.relpath(fp, p)))
                    except (OSError, ValueError):
                        if cancel.is_set():
                            break
                        continue  # file vanished or became unreadable: skip it
        except Exception:
            pass
        finally:
            asyncio.run_coroutine_threadsafe(q.put(None), loop).result()

    async def watch():
        try:
            while True:
                await read_frame(reader)
        except Exception:
            cancel.set()

    async def pump():
        while True:
            b = await q.get()
            if b is None:
                break
            if cancel.is_set():
                continue  # keep draining so the worker thread can finish
            try:
                writer.write(frame(T_DATA, b))
                await writer.drain()
            except Exception:
                cancel.set()
        if not cancel.is_set():
            writer.write(frame(T_EXIT, json.dumps({"code": 0})))
            await writer.drain()

    w = asyncio.create_task(watch())
    try:
        await asyncio.gather(loop.run_in_executor(None, build), pump())
    finally:
        cancel.set()
        w.cancel()

STREAMS = {"dir_zip": sop_dir_zip, "compose": sop_compose, "log_follow": sop_log_follow, "certbot": sop_certbot, "file_get": sop_file_get, "file_put": sop_file_put, "pty": sop_pty}


# ----------------------------------------------------------------------------- server

def err_payload(e):
    return {"ok": False, "error": {"code": e.code, "message": e.message, "status": e.status, "details": e.details}}


async def handle(reader, writer):
    loop = asyncio.get_running_loop()
    op = "?"
    try:
        line = await asyncio.wait_for(reader.readline(), 10)
        if not line:
            return
        req = json.loads(line)
        if not hmac.compare_digest(str(req.get("token", "")), TOKEN):
            writer.write(json.dumps(err_payload(AgentError("unauthorized", "invalid token", 401))).encode() + b"\n")
            await writer.drain()
            return
        op, args = req.get("op"), req.get("args") or {}
        if not isinstance(args, dict):
            raise AgentError("bad_request", "args must be an object")
        try:
            if op in STREAMS:
                log.info("stream op=%s", op)
                await STREAMS[op](reader, writer, args)
            elif op in RPC:
                res = await loop.run_in_executor(None, RPC[op], args)
                writer.write(json.dumps({"ok": True, "data": res}).encode() + b"\n")
            else:
                raise AgentError("bad_request", "unknown operation")
        except AgentError as e:
            writer.write(json.dumps(err_payload(e)).encode() + b"\n")
        except PermissionError as e:
            writer.write(json.dumps(err_payload(AgentError("permission", str(e), 403))).encode() + b"\n")
        except FileNotFoundError as e:
            writer.write(json.dumps(err_payload(AgentError("not_found", str(e), 404))).encode() + b"\n")
        except (tarfile.TarError, OSError, ValueError, KeyError) as e:
            log.warning("op %s failed: %s", op, e)
            writer.write(json.dumps(err_payload(AgentError("failed", "%s: %s" % (type(e).__name__, e), 500))).encode() + b"\n")
        await writer.drain()
    except (asyncio.TimeoutError, asyncio.IncompleteReadError, ConnectionError, json.JSONDecodeError):
        pass
    except Exception:
        log.exception("unhandled error in op %s", op)
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def main():
    global TOKEN
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if os.geteuid() != 0:
        raise SystemExit("the ServerOS agent must run as root")
    TOKEN = load_token()
    ensure_dir(CFG["state_dir"])
    sock = CFG["socket"]
    sdir = os.path.dirname(sock)
    ensure_dir(sdir, 0o750)
    try:
        import grp
        gid = grp.getgrnam(CFG["socket_group"]).gr_gid
    except KeyError:
        raise SystemExit("group %r does not exist (run install.sh)" % CFG["socket_group"])
    os.chown(sdir, 0, gid)
    os.chmod(sdir, 0o750)
    if os.path.exists(sock):
        os.unlink(sock)
    server = await asyncio.start_unix_server(handle, path=sock)
    os.chown(sock, 0, gid)
    os.chmod(sock, 0o660)
    log.info("ServerOS agent %s listening on %s", VERSION, sock)
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for s in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(s, stop.set)
    async with server:
        await stop.wait()
    try:
        os.unlink(sock)
    except OSError:
        pass


if __name__ == "__main__":
    asyncio.run(main())
