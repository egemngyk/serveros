const NS = 'http://www.w3.org/2000/svg';
const el = (n, a = {}, t) => { const e = document.createElementNS(NS, n); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); if (t !== undefined) e.textContent = t; return e; };
const COLORS = ['#2f7bff', '#2fbf71', '#f0a93b', '#b06bff'];

/** Responsive SVG line chart. series: [{name, color?, values:[{t,v}]}] */
export function lineChart({ series, max, unit = '', fmt = (v) => v.toFixed(0), height = 160, fill = true }) {
  const phone = window.innerWidth < 700;
  const W = phone ? 340 : 600, H = phone ? Math.round(height * 1.05) : height, L = phone ? 34 : 38, R = 8, T = 8, B = 20;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: phone ? 'xMidYMid meet' : 'none', class: 'chart' + (phone ? ' phone' : '') });
  const all = series.flatMap((s) => s.values);
  if (!all.length) { svg.append(el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle' }, 'No data yet')); return svg; }
  const t0 = Math.min(...all.map((p) => p.t)), t1 = Math.max(...all.map((p) => p.t)) || t0 + 1;
  const vmax = max ?? Math.max(1, ...all.map((p) => p.v)) * 1.15;
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - Math.min(v, vmax) / vmax) * (H - T - B);
  for (let i = 0; i <= 4; i++) {
    const yy = T + (i / 4) * (H - T - B);
    svg.append(el('line', { x1: L, x2: W - R, y1: yy, y2: yy, class: 'grid', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
    svg.append(el('text', { x: L - 4, y: yy + 3, 'text-anchor': 'end' }, fmt(vmax * (1 - i / 4)) + (i === 0 ? unit : '')));
  }
  const fmtT = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  svg.append(el('text', { x: L, y: H - 5 }, fmtT(t0)), el('text', { x: W - R, y: H - 5, 'text-anchor': 'end' }, fmtT(t1)));
  series.forEach((s, i) => {
    if (!s.values.length) return;
    const c = s.color || COLORS[i % COLORS.length];
    const pts = s.values.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`);
    if (fill && i === 0) svg.append(el('polygon', { points: `${L},${H - B} ${pts.join(' ')} ${x(s.values[s.values.length - 1].t).toFixed(1)},${H - B}`, fill: c, opacity: '.12' }));
    svg.append(el('polyline', { points: pts.join(' '), fill: 'none', stroke: c, 'stroke-width': 1.8, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }));
  });
  series.forEach((s, i) => { svg.append(el('text', { x: L + 6 + i * 90, y: T + 10, class: 'legend', fill: s.color || COLORS[i % COLORS.length], style: 'fill:' + (s.color || COLORS[i % COLORS.length]) }, s.name)); });
  return svg;
}

export function sparkline(values, { color = COLORS[0], w = 120, h = 28 } = {}) {
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h });
  if (values.length < 2) return svg;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(' ');
  svg.append(el('polyline', { points: pts, fill: 'none', stroke: color, 'stroke-width': 1.6 }));
  return svg;
}
