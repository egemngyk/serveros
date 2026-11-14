// Phone support helpers.
// 1) On narrow screens every data table is shown as a list of cards (CSS in app.css). To label the
//    values we copy each column header into a data-label attribute on the cells.
// 2) Keeps a CSS custom property with the real viewport height (mobile browser toolbars change it).
function label(table) {
  if (table.dataset.m) return;
  const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.replace(/[▲▼]/g, '').trim());
  if (!heads.length) { table.dataset.m = '0'; return; }
  table.dataset.m = '1'; table.classList.add('stack');
  table.querySelectorAll('tbody tr').forEach((tr) => {
    let col = 0;
    for (const td of tr.children) {
      if (td.colSpan === 1 && heads[col]) td.dataset.label = heads[col];
      col += td.colSpan || 1;
    }
  });
}
function scan(node) {
  if (node.nodeType !== 1) return;
  if (node.tagName === 'TABLE') label(node);
  node.querySelectorAll?.('table').forEach(label);
}
new MutationObserver((muts) => { for (const m of muts) m.addedNodes.forEach(scan); }).observe(document.body, { childList: true, subtree: true });
scan(document.body);

const setVh = () => document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
setVh(); addEventListener('resize', setVh); addEventListener('orientationchange', setVh);
