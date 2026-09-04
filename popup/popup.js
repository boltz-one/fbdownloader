const $ = (s) => document.querySelector(s);

function fmtDur(ms) {
  if (!ms) return '';
  const t = Math.round(ms / 1000);
  const m = Math.floor(t / 60), s = t % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function send(msg) {
  return new Promise((res) => chrome.runtime.sendMessage(msg, (r) => {
    void chrome.runtime.lastError; res(r);
  }));
}

function render(list, tabId) {
  const wrap = $('#list');
  wrap.innerHTML = '';
  $('#empty').hidden = list.length > 0;
  $('#sub').textContent = list.length
    ? `${list.length} video bắt được trên tab này`
    : 'Chưa có video nào';

  for (const rec of list) {
    const card = document.createElement('div');
    card.className = 'card';

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (rec.thumb) thumb.style.backgroundImage = `url("${rec.thumb.replace(/"/g, '')}")`;
    else thumb.textContent = '🎬';

    const body = document.createElement('div');
    body.className = 'body';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = rec.title || (rec.videoId ? 'Video ' + rec.videoId : 'Video Facebook');

    const meta = document.createElement('div');
    meta.className = 'meta';
    const bits = [];
    if (rec.durationMs) bits.push(fmtDur(rec.durationMs));
    if (rec.dashMaxHeight) bits.push('DASH tối đa ' + rec.dashMaxHeight + 'p');
    bits.push(rec.progressive.length + ' link MP4');
    meta.textContent = bits.join(' · ');

    const opts = document.createElement('div');
    opts.className = 'opts';

    if (rec.best) {
      const b = document.createElement('button');
      b.className = 'opt primary';
      b.textContent = '⬇ ' + rec.best.label;
      b.onclick = () => send({ type: 'FBVD_DOWNLOAD', tabId, recordId: rec.id, url: rec.best.url, label: rec.best.label });
      opts.appendChild(b);
    }
    for (const p of rec.progressive) {
      if (rec.best && p.url === rec.best.url) continue;
      const b = document.createElement('button');
      b.className = 'opt';
      b.textContent = p.label;
      b.onclick = () => send({ type: 'FBVD_DOWNLOAD', tabId, recordId: rec.id, url: p.url, label: p.label });
      opts.appendChild(b);
    }
    if (rec.hasDash) {
      const b = document.createElement('button');
      b.className = 'opt max';
      b.textContent = '★ Tối đa (' + rec.dashNote + ')';
      b.onclick = () => send({ type: 'FBVD_OPEN_DASH', tabId, recordId: rec.id });
      opts.appendChild(b);
    }

    body.append(title, meta, opts);
    card.append(thumb, body);
    wrap.appendChild(card);
  }
}

async function refresh() {
  const tab = await activeTab();
  if (!tab) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: 'FBVD_PING_DOM' }); } catch (_) {}
  const r = await send({ type: 'FBVD_LIST', tabId: tab.id });
  render((r && r.list) || [], tab.id);
}

$('#refresh').onclick = refresh;
refresh();
setTimeout(refresh, 900);
