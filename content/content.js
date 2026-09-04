/* Isolated-world bridge + floating download button. */
(() => {
  if (window.__FBVD_CONTENT__) return;
  window.__FBVD_CONTENT__ = true;

  /* ---------- receive findings from the page-world sniffer ---------- */
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__fbvd !== 'FBVD_PAGE' || !Array.isArray(d.records)) return;
    try {
      chrome.runtime.sendMessage({ type: 'FBVD_ADD', records: d.records, pageUrl: d.pageUrl });
    } catch (_) { /* extension reloaded */ }
  });

  if (window.top !== window) return; // UI only in the top frame

  /* ---------- floating button ---------- */
  const host = document.createElement('div');
  host.id = '__fbvd_host';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .btn {
        position: fixed; z-index: 2147483647; display: none;
        align-items: center; gap: 6px;
        padding: 7px 11px; border-radius: 999px;
        background: rgba(17,17,20,.82); color: #fff;
        font: 600 12px/1 -apple-system, "Segoe UI", Roboto, sans-serif;
        cursor: pointer; user-select: none;
        backdrop-filter: blur(8px);
        box-shadow: 0 4px 14px rgba(0,0,0,.35);
        transition: background .15s, transform .15s;
      }
      .btn:hover { background: #1877f2; transform: translateY(-1px); }
      .btn svg { width: 14px; height: 14px; fill: currentColor; }
      .menu {
        position: fixed; z-index: 2147483647; display: none;
        min-width: 218px; padding: 6px;
        background: #1c1e21; color: #e4e6eb; border-radius: 12px;
        border: 1px solid rgba(255,255,255,.08);
        box-shadow: 0 12px 32px rgba(0,0,0,.5);
        font: 13px/1.35 -apple-system, "Segoe UI", Roboto, sans-serif;
      }
      .menu .row {
        display: flex; justify-content: space-between; align-items: center; gap: 10px;
        padding: 9px 10px; border-radius: 8px; cursor: pointer;
      }
      .menu .row:hover { background: rgba(255,255,255,.08); }
      .menu .row .q { font-weight: 600; }
      .menu .row .s { opacity: .55; font-size: 11px; }
      .menu .hint { padding: 8px 10px; opacity: .6; font-size: 12px; }
      .menu .sep { height: 1px; background: rgba(255,255,255,.08); margin: 4px 2px; }
    </style>
    <div class="btn" part="btn">
      <svg viewBox="0 0 24 24"><path d="M12 3v10.6l3.3-3.3 1.4 1.4L12 17.4 7.3 11.7l1.4-1.4L12 13.6V3h0zM5 19h14v2H5z"/></svg>
      <span>Tải video</span>
    </div>
    <div class="menu"></div>`;
  const btn = shadow.querySelector('.btn');
  const menu = shadow.querySelector('.menu');

  const attach = () => {
    if (!document.body) return setTimeout(attach, 200);
    document.documentElement.appendChild(host);
  };
  attach();

  let currentVideo = null;

  function mostVisibleVideo() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (r.width < 160 || r.height < 90) continue;
      const vh = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      const vw = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
      if (vh <= 0 || vw <= 0) continue;
      const area = vh * vw;
      if (area > bestArea) { bestArea = area; best = v; }
    }
    return best;
  }

  let raf = 0;
  function reposition() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (menu.style.display === 'block') return;
      const v = mostVisibleVideo();
      currentVideo = v;
      if (!v) { btn.style.display = 'none'; return; }
      const r = v.getBoundingClientRect();
      btn.style.display = 'flex';
      btn.style.top = Math.max(8, r.top + 10) + 'px';
      btn.style.left = Math.min(innerWidth - 130, r.right - 122) + 'px';
    });
  }

  addEventListener('scroll', reposition, { passive: true, capture: true });
  addEventListener('resize', reposition, { passive: true });
  setInterval(reposition, 700);
  reposition();

  /* ---------- work out which captured record belongs to this video ---------- */
  function idsFromPage() {
    const ids = [];
    const push = (m) => { if (m && m[1]) ids.push(m[1]); };
    push(location.pathname.match(/\/reel\/(\d{6,})/));
    push(location.pathname.match(/\/videos\/(?:[^/]+\/)?(\d{6,})/));
    push(location.search.match(/[?&]v=(\d{6,})/));
    push(location.pathname.match(/\/watch\/(\d{6,})/));
    return ids;
  }

  function idsFromElement(v) {
    const ids = [];
    let node = v;
    for (let i = 0; node && i < 14; i++, node = node.parentElement) {
      const links = node.querySelectorAll ? node.querySelectorAll('a[href]') : [];
      for (const a of links) {
        const h = a.getAttribute('href') || '';
        const m = h.match(/\/(?:reel|videos|watch)\/(?:[^/?]+\/)?(\d{6,})/) || h.match(/[?&]v=(\d{6,})/);
        if (m) ids.push(m[1]);
      }
      if (ids.length) break;
    }
    return ids;
  }

  function fmtSize(b) {
    if (!b) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return b.toFixed(b < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
  }

  function openMenu() {
    const ids = [...idsFromElement(currentVideo), ...idsFromPage()];
    chrome.runtime.sendMessage({ type: 'FBVD_MATCH', ids }, (resp) => {
      const rec = resp && resp.record;
      const r = btn.getBoundingClientRect();
      menu.innerHTML = '';
      if (!rec) {
        menu.innerHTML = '<div class="hint">Chưa bắt được link. Hãy bấm play cho video chạy vài giây rồi thử lại.</div>';
      } else {
        const add = (label, sub, onClick) => {
          const row = document.createElement('div');
          row.className = 'row';
          row.innerHTML = `<span class="q"></span><span class="s"></span>`;
          row.children[0].textContent = label;
          row.children[1].textContent = sub || '';
          row.onclick = () => { onClick(); closeMenu(); };
          menu.appendChild(row);
        };
        if (rec.best) {
          add('⬇ Tải ' + rec.best.label, rec.best.note || 'MP4 trực tiếp',
            () => chrome.runtime.sendMessage({ type: 'FBVD_DOWNLOAD', recordId: rec.id, url: rec.best.url, label: rec.best.label }));
        }
        for (const p of rec.progressive || []) {
          if (rec.best && p.url === rec.best.url) continue;
          add(p.label, 'MP4 trực tiếp',
            () => chrome.runtime.sendMessage({ type: 'FBVD_DOWNLOAD', recordId: rec.id, url: p.url, label: p.label }));
        }
        if (rec.hasDash) {
          if (menu.children.length) menu.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }));
          add('★ Chất lượng tối đa', rec.dashNote || 'DASH + ghép audio',
            () => chrome.runtime.sendMessage({ type: 'FBVD_OPEN_DASH', recordId: rec.id }));
        }
        if (!menu.children.length) menu.innerHTML = '<div class="hint">Không tìm thấy nguồn tải cho video này.</div>';
      }
      menu.style.display = 'block';
      const mh = menu.getBoundingClientRect().height;
      menu.style.top = Math.min(innerHeight - mh - 8, r.bottom + 8) + 'px';
      menu.style.left = Math.max(8, Math.min(innerWidth - 230, r.left - 90)) + 'px';
    });
  }

  function closeMenu() { menu.style.display = 'none'; }

  btn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (menu.style.display === 'block') closeMenu(); else openMenu();
  }, true);

  document.addEventListener('click', (e) => {
    if (e.composedPath && e.composedPath().includes(host)) return;
    closeMenu();
  }, true);

  /* popup can ask us to re-scan the DOM for plain <video> sources */
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg && msg.type === 'FBVD_PING_DOM') {
      window.postMessage({ __fbvd: 'FBVD_ASK_VIDEO_SRC' }, '*');
      sendResponse({ ok: true });
    }
    return false;
  });
})();
