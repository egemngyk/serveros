try { document.documentElement.dataset.theme = localStorage.getItem('serveros.theme') || 'dark'; } catch (e) { /* ignore */ }
