/* FB Video Downloader — service worker: store, match, download.
 *
 * Everything is persisted in chrome.storage.session rather than a module-level
 * Map. An MV3 service worker is evicted after ~30s idle, which wipes module
 * state — so links captured at page load were gone by the time the user
 * actually clicked. storage.session survives that, stays in memory, and is
 * dropped when the browser closes.
 */

const MAX_PER_TAB = 40;
const key = (tabId) => `tab_${tabId}`;

async function loadTab(tabId) {
  if (tabId == null || Number.isNaN(tabId)) return {};
  const o = await chrome.storage.session.get(key(tabId));
  return o[key(tabId)] || {};
}

async function saveTab(tabId, recs) {
  try {
    await chrome.storage.session.set({ [key(tabId)]: recs });
    return recs;
  } catch (e) {
    // Quota: keep the newest half and try once more rather than losing everything.
    const keys = Object.keys(recs).sort((a, b) => recs[b].ts - recs[a].ts);
    const half = {};
    for (const k of keys.slice(0, Math.max(1, Math.floor(keys.length / 2)))) half[k] = recs[k];
    try { await chrome.storage.session.set({ [key(tabId)]: half }); } catch (_) {}
    return half;
  }
}

/* ---------------- shaping ---------------- */

const qualityRank = (label) => {
  const s = String(label || '').toUpperCase();
  const m = s.match(/(\d{3,4})\s*P?/);
  if (m) return parseInt(m[1], 10);
  if (s.includes('HD')) return 720;
  if (s.includes('SD')) return 360;
  return 100;
};

function dashInfo(dashList) {
  // "Quality" is reported by the short side, so a 1080x1920 reel reads as 1080p.
  let best = 0, maxH = 0, maxW = 0, hasAudio = false, count = 0;
  for (const d of dashList || []) {
    const xml = d.xml || '';
    for (const m of xml.matchAll(/<Representation\b[^>]*>/g)) {
      const tag = m[0];
      const w = +((tag.match(/\bwidth="(\d+)"/) || [])[1] || 0);
      const h = +((tag.match(/\bheight="(\d+)"/) || [])[1] || 0);
      if (w && h) {
        best = Math.max(best, Math.min(w, h));
        maxW = Math.max(maxW, w);
        maxH = Math.max(maxH, h);
      }
    }
    if (/mimeType="audio|contentType="audio/i.test(xml)) hasAudio = true;
    count += (xml.match(/<Representation/g) || []).length;
  }
  return { best, maxH, maxW, hasAudio, count };
}

function summarize(rec) {
  const progressive = [...rec.progressive].sort((a, b) => qualityRank(b.label) - qualityRank(a.label));
  const di = dashInfo(rec.dash);
  const bestProg = progressive[0] || null;
  return {
    id: rec.id,
    videoId: rec.videoId,
    title: rec.title,
    thumb: rec.thumb,
    durationMs: rec.durationMs,
    permalink: rec.permalink,
    progressive,
    best: bestProg ? { url: bestProg.url, label: bestProg.label, note: 'MP4 tải thẳng' } : null,
    hasDash: !!(rec.dash && rec.dash.length && di.count),
    dashNote: di.best ? `tối đa ${di.best}p${di.hasAudio ? ' + audio' : ''}` : 'DASH',
    dashMaxHeight: di.best,
    ts: rec.ts,
  };
}

function keyFor(rec) {
  if (rec.videoId) return 'v' + rec.videoId;
  const first = (rec.progressive[0] && rec.progressive[0].url) || '';
  return 'u' + (first.split('?')[0] || rec.id);
}

function mergeInto(recs, incoming) {
  const k = keyFor(incoming);
  const cur = recs[k];
  if (!cur) {
    incoming.id = k;
    recs[k] = incoming;
    return;
  }
  cur.title = cur.title || incoming.title;
  cur.thumb = cur.thumb || incoming.thumb;
  cur.durationMs = cur.durationMs || incoming.durationMs;
  cur.permalink = cur.permalink || incoming.permalink;
  cur.videoId = cur.videoId || incoming.videoId;
  cur.ts = Date.now();
  for (const p of incoming.progressive) {
    if (!cur.progressive.some((x) => x.url === p.url)) cur.progressive.push(p);
  }
  for (const d of incoming.dash || []) {
    if (cur.dash.length >= 3) break;   // manifests are bulky; a few is plenty
    if (!cur.dash.some((x) => x.xml === d.xml)) cur.dash.push(d);
  }
}

function trim(recs) {
  const keys = Object.keys(recs);
  if (keys.length <= MAX_PER_TAB) return recs;
  keys.sort((a, b) => recs[b].ts - recs[a].ts);
  const out = {};
  for (const k of keys.slice(0, MAX_PER_TAB)) out[k] = recs[k];
  return out;
}

async function setBadge(tabId, recs) {
  const n = Object.keys(recs).length;
  chrome.action.setBadgeBackgroundColor({ color: '#1877f2' });
  try { await chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }); } catch (_) {}
}

function sanitize(name) {
  return (name || 'facebook-video')
    .replace(/[\\/:*?"<>|\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90) || 'facebook-video';
}

function filenameFor(rec, label, ext = 'mp4') {
  const base = sanitize(rec && rec.title ? rec.title : 'facebook-video');
  const q = label ? '-' + String(label).replace(/[^\w]+/g, '') : '';
  const id = rec && rec.videoId ? '-' + rec.videoId : '';
  return `FBVideo/${base}${id}${q}.${ext}`;
}

/* ---------------- messaging ----------------
 * Every branch is async, so the listener always returns true to keep the
 * response channel open. */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  const tabId = (msg.tabId != null) ? msg.tabId : (sender.tab && sender.tab.id);

  (async () => {
    switch (msg.type) {
      case 'FBVD_ADD': {
        if (tabId == null) return sendResponse({ ok: false });
        const recs = await loadTab(tabId);
        for (const rec of msg.records || []) {
          if (!rec || (!(rec.progressive || []).length && !(rec.dash || []).length)) continue;
          mergeInto(recs, {
            id: rec.id, videoId: rec.videoId || null, title: rec.title || null,
            thumb: rec.thumb || null, durationMs: rec.durationMs || null,
            permalink: rec.permalink || null,
            progressive: rec.progressive || [], dash: rec.dash || [], ts: Date.now(),
          });
        }
        const stored = await saveTab(tabId, trim(recs));
        await setBadge(tabId, stored);
        return sendResponse({ ok: true, count: Object.keys(stored).length });
      }

      case 'FBVD_LIST': {
        const recs = await loadTab(tabId);
        const list = Object.values(recs).sort((a, b) => b.ts - a.ts).map(summarize);
        return sendResponse({ list });
      }

      case 'FBVD_MATCH': {
        const recs = await loadTab(tabId);
        let rec = null;
        for (const id of msg.ids || []) {
          if (recs['v' + id]) { rec = recs['v' + id]; break; }
        }
        if (!rec) rec = Object.values(recs).sort((a, b) => b.ts - a.ts)[0] || null;
        return sendResponse({ record: rec ? summarize(rec) : null });
      }

      case 'FBVD_GET_RECORD': {
        const recs = await loadTab(msg.forTabId);
        const rec = recs[msg.recordId] || null;
        return sendResponse({ record: rec, summary: rec ? summarize(rec) : null });
      }

      case 'FBVD_DOWNLOAD': {
        const recs = await loadTab(tabId);
        chrome.downloads.download({
          url: msg.url,
          filename: filenameFor(recs[msg.recordId], msg.label),
          saveAs: false,
        }, () => { if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError.message); });
        return sendResponse({ ok: true });
      }

      case 'FBVD_OPEN_DASH': {
        chrome.tabs.create({
          url: chrome.runtime.getURL(
            `downloader/downloader.html?tab=${encodeURIComponent(tabId)}&rec=${encodeURIComponent(msg.recordId)}`),
        });
        return sendResponse({ ok: true });
      }

      case 'FBVD_SUGGEST_NAME': {
        const recs = await loadTab(msg.forTabId);
        return sendResponse({ filename: filenameFor(recs[msg.recordId], msg.label) });
      }

      default:
        return sendResponse({ ok: false });
    }
  })().catch((e) => {
    console.error('[FBVD]', e);
    try { sendResponse({ ok: false, error: String(e) }); } catch (_) {}
  });

  return true;
});

/* ---------------- lifecycle ----------------
 * Deliberately NOT clearing on tabs.onUpdated 'loading': that event can land
 * after document_start content scripts have already reported the first links,
 * which silently wiped them. Records are capped instead, matched by video id,
 * and dropped when the tab goes away. */

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(key(tabId)).catch(() => {});
});
