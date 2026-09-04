/* FB Video Downloader — page-world sniffer.
 * Runs in MAIN world so it can hook fetch/XHR and read Facebook's own JSON payloads.
 * Never sends anything anywhere: it only posts findings to the extension's content script.
 */
(() => {
  if (window.__FBVD_INJECTED__) return;
  window.__FBVD_INJECTED__ = true;

  const TAG = 'FBVD_PAGE';
  const MAX_NODES = 60000;          // guard against pathological payloads
  const seenPayloads = new Set();   // cheap de-dupe of identical response bodies

  const PROGRESSIVE_KEYS = {
    playable_url_quality_hd: 'HD',
    browser_native_hd_url: 'HD',
    hd_src: 'HD',
    hd_src_no_ratelimit: 'HD',
    playable_url: 'SD',
    browser_native_sd_url: 'SD',
    sd_src: 'SD',
    sd_src_no_ratelimit: 'SD',
    progressive_url: 'AUTO',
    spherical_playable_url_hd: 'HD',
    spherical_playable_url_sd: 'SD',
  };

  const isVideoUrl = (v) =>
    typeof v === 'string' &&
    v.length > 20 &&
    /^https?:\/\//.test(v) &&
    /\.(mp4|webm)(\?|$)/i.test(v.split('#')[0]);

  // Looser test, used only for values read out of keys we already trust
  // (playable_url, progressive_url, ...). Facebook now serves plenty of video
  // URLs with no file extension at all, e.g. /o1/v/t2/f2/m412/AQ...
  const isMediaUrl = (v) =>
    typeof v === 'string' &&
    v.length > 30 &&
    /^https?:\/\//.test(v) &&
    (isVideoUrl(v) || /(fbcdn\.net|fbsbx\.com)\//i.test(v));

  const isManifest = (v) =>
    typeof v === 'string' && v.length > 40 && /<MPD[\s>]/i.test(v.slice(0, 400));

  const looksLikeId = (v) => typeof v === 'string' && /^\d{8,25}$/.test(v);

  const pick = (obj, ...keys) => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v) return v;
      if (v && typeof v === 'object') {
        if (typeof v.text === 'string' && v.text) return v.text;
        if (typeof v.uri === 'string' && v.uri) return v.uri;
      }
    }
    return null;
  };

  function harvest(node) {
    return {
      id:
        (looksLikeId(node.video_id) && node.video_id) ||
        (looksLikeId(node.videoId) && node.videoId) ||
        (looksLikeId(node.id) && node.id) ||
        null,
      title: pick(node, 'title', 'name', 'savable_title', 'savable_description', 'message'),
      thumb:
        (node.preferred_thumbnail && node.preferred_thumbnail.image && node.preferred_thumbnail.image.uri) ||
        (node.thumbnailImage && node.thumbnailImage.uri) ||
        (node.previewImage && node.previewImage.uri) ||
        (node.image && typeof node.image.uri === 'string' && node.image.uri) ||
        (typeof node.first_frame_thumbnail === 'string' && node.first_frame_thumbnail) ||
        null,
      durationMs:
        (typeof node.playable_duration_in_ms === 'number' && node.playable_duration_in_ms) ||
        (typeof node.length_in_second === 'number' && node.length_in_second * 1000) ||
        null,
      permalink:
        (typeof node.permalink_url === 'string' && node.permalink_url) ||
        (typeof node.url === 'string' && /facebook\.com\/(reel|videos|watch)/.test(node.url) && node.url) ||
        null,
      width: node.original_width || (typeof node.width === 'number' ? node.width : 0) || null,
      height: node.original_height || (typeof node.height === 'number' ? node.height : 0) || null,
    };
  }

  /* ---------------- deep scan ---------------- */

  function scan(root) {
    const found = new Map(); // key -> record
    let budget = MAX_NODES;

    const getRec = (ctx) => {
      const key = ctx.id || ctx.fallbackKey;
      let rec = found.get(key);
      if (!rec) {
        rec = {
          id: key,
          videoId: ctx.id || null,
          title: ctx.title || null,
          thumb: ctx.thumb || null,
          durationMs: ctx.durationMs || null,
          width: ctx.width || null,
          height: ctx.height || null,
          permalink: ctx.permalink || null,
          progressive: [],
          dash: [],
          ts: Date.now(),
        };
        found.set(key, rec);
      }
      if (!rec.title && ctx.title) rec.title = ctx.title;
      if (!rec.thumb && ctx.thumb) rec.thumb = ctx.thumb;
      if (!rec.durationMs && ctx.durationMs) rec.durationMs = ctx.durationMs;
      if (!rec.width && ctx.width) rec.width = ctx.width;
      if (!rec.height && ctx.height) rec.height = ctx.height;
      if (!rec.permalink && ctx.permalink) rec.permalink = ctx.permalink;
      if (!rec.videoId && ctx.id) rec.videoId = ctx.id;
      return rec;
    };

    const addProgressive = (rec, url, label) => {
      if (!isMediaUrl(url)) return;
      if (rec.progressive.some((p) => p.url === url)) return;
      rec.progressive.push({ url, label });
    };

    const walk = (node, ctx) => {
      if (budget-- < 0 || !node || typeof node !== 'object') return;

      if (Array.isArray(node)) {
        for (const item of node) walk(item, ctx);
        return;
      }

      // --- derive context (id / title / thumb) from this node and its direct
      //     children, so metadata sitting in a sibling branch still lands on the
      //     record built further down (Facebook splits these all the time).
      const own = harvest(node);
      let merged = own;
      for (const k of Object.keys(node)) {
        const child = node[k];
        if (!child || typeof child !== 'object' || Array.isArray(child)) continue;
        const h = harvest(child);
        merged = {
          id: merged.id || h.id,
          title: merged.title || h.title,
          thumb: merged.thumb || h.thumb,
          durationMs: merged.durationMs || h.durationMs,
          permalink: merged.permalink || h.permalink,
          width: merged.width || h.width,
          height: merged.height || h.height,
        };
      }

      let local = ctx;
      if (merged.id || merged.title || merged.thumb || merged.durationMs ||
          merged.permalink || merged.width || merged.height) {
        local = {
          ...ctx,
          id: merged.id || ctx.id,
          title: merged.title || ctx.title,
          thumb: merged.thumb || ctx.thumb,
          durationMs: merged.durationMs || ctx.durationMs,
          permalink: merged.permalink || ctx.permalink,
          width: merged.width || ctx.width,
          height: merged.height || ctx.height,
        };
      }

      // --- progressive urls ---
      for (const key in PROGRESSIVE_KEYS) {
        const val = node[key];
        if (isMediaUrl(val)) addProgressive(getRec(local), val, PROGRESSIVE_KEYS[key]);
      }
      // newer shape: progressive_urls: [{ progressive_url, metadata: { quality } }]
      if (Array.isArray(node.progressive_urls)) {
        for (const p of node.progressive_urls) {
          if (!p) continue;
          const url = p.progressive_url || p.url;
          const label = (p.metadata && p.metadata.quality) || p.quality || 'AUTO';
          if (isMediaUrl(url)) addProgressive(getRec(local), url, String(label).toUpperCase());
        }
      }

      // --- dash manifests ---
      for (const key of Object.keys(node)) {
        if (!/dash/i.test(key)) continue;
        const val = node[key];
        if (isManifest(val)) {
          const rec = getRec(local);
          if (!rec.dash.some((d) => d.xml === val)) {
            rec.dash.push({ xml: val, baseUrl: node.dash_manifest_url || node.base_url || null });
          }
        } else if (val && typeof val === 'object') {
          // `dash_manifests: [{ manifest_xml, failure_reason }]` today, something
          // else tomorrow — so look for the MPD itself, not for a field name.
          for (const d of (Array.isArray(val) ? val : [val])) {
            if (!d || typeof d !== 'object') continue;
            for (const dv of Object.values(d)) {
              if (!isManifest(dv)) continue;
              const rec = getRec(local);
              if (!rec.dash.some((x) => x.xml === dv)) {
                rec.dash.push({ xml: dv, baseUrl: d.base_url || d.manifest_url || null });
              }
            }
          }
        }
      }

      for (const key of Object.keys(node)) {
        const val = node[key];
        if (val && typeof val === 'object') walk(val, local);
      }
    };

    walk(root, { id: null, fallbackKey: 'fbvd_' + Math.random().toString(36).slice(2, 9) });

    // keep only records that actually carry something downloadable
    return [...found.values()].filter((r) => r.progressive.length || r.dash.length);
  }

  /* ---------------- payload handling ---------------- */

  function parseMulti(text) {
    // FB often returns several JSON objects separated by newlines, sometimes with a
    // `for (;;);` prefix.
    const out = [];
    const cleaned = text.replace(/^for\s*\(;;\);/, '').trim();
    if (!cleaned) return out;
    try {
      out.push(JSON.parse(cleaned));
      return out;
    } catch (_) { /* fall through to line-by-line */ }
    for (const line of cleaned.split('\n')) {
      const t = line.trim();
      if (!t || (t[0] !== '{' && t[0] !== '[')) continue;
      try { out.push(JSON.parse(t)); } catch (_) {}
    }
    return out;
  }

  function handleText(text, sourceUrl) {
    if (!text || text.length < 60 || text.length > 40 * 1024 * 1024) return;
    if (!/playable_url|browser_native|progressive_url|<MPD|hd_src/i.test(text)) return;

    const fingerprint = text.length + ':' + text.slice(0, 120);
    if (seenPayloads.has(fingerprint)) return;
    seenPayloads.add(fingerprint);
    if (seenPayloads.size > 400) seenPayloads.clear();

    let records = [];
    for (const obj of parseMulti(text)) {
      try { records = records.concat(scan(obj)); } catch (_) {}
    }

    // Raw-text fallback: manifests / mp4 links that survived escaping tricks.
    if (!records.length) {
      const urls = new Set();
      const re = /https:\\?\/\\?\/[^"'\\\s]+?\.mp4[^"'\s]*/g;
      let m;
      while ((m = re.exec(text)) && urls.size < 12) {
        urls.add(m[0].replace(/\\\//g, '/').replace(/\\u0025/g, '%').replace(/\\/g, ''));
      }
      if (urls.size) {
        records = [{
          id: 'raw_' + (sourceUrl || '').slice(-24) + '_' + urls.size,
          videoId: null, title: null, thumb: null, durationMs: null,
          width: null, height: null, permalink: null,
          progressive: [...urls].map((u) => ({ url: u, label: 'AUTO' })),
          dash: [], ts: Date.now(),
        }];
      }
    }

    if (records.length) {
      window.postMessage({ __fbvd: TAG, records, pageUrl: location.href }, '*');
    }
  }

  /* ---------------- hooks ---------------- */

  const SKIP_URL = /\.(mp4|webm|m4s|jpg|jpeg|png|gif|webp|woff2?|css|svg)(\?|$)/i;

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (!SKIP_URL.test(url)) {
        p.then((res) => {
          try {
            const ct = res.headers.get('content-type') || '';
            if (!/json|javascript|text\/|application\/x-/.test(ct)) return;
            res.clone().text().then((t) => handleText(t, url)).catch(() => {});
          } catch (_) {}
        }).catch(() => {});
      }
    } catch (_) {}
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__fbvdUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      if (!SKIP_URL.test(this.__fbvdUrl || '')) {
        this.addEventListener('load', () => {
          try {
            if (this.responseType && this.responseType !== 'text') return;
            handleText(this.responseText, this.__fbvdUrl);
          } catch (_) {}
        });
      }
    } catch (_) {}
    return origSend.apply(this, args);
  };

  /* ---------------- inline JSON already in the document ---------------- */

  // A parser-inserted <script> fires its mutation record the moment the element
  // is appended — its text child usually arrives a tick later, so reading
  // textContent right then gives "". Everything below exists to make sure a
  // script is looked at again once it actually has content.
  let scanned = new WeakSet();

  const scanScript = (el) => {
    try {
      if (!el || el.tagName !== 'SCRIPT') return;
      const t = el.textContent;
      if (!t || t.length < 200) return;   // not marked as scanned: retry later
      if (scanned.has(el)) return;
      scanned.add(el);
      handleText(t, 'inline-script');
    } catch (_) {}
  };

  const sweep = () => {
    try { document.querySelectorAll('script').forEach(scanScript); } catch (_) {}
  };

  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.tagName === 'SCRIPT') {
          scanScript(n);
          setTimeout(() => scanScript(n), 0);
        }
      }
      if (m.type === 'characterData' && m.target.parentNode) scanScript(m.target.parentNode);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sweep, { once: true });
  } else {
    sweep();
  }

  // Facebook keeps injecting payloads long after load, and Reels only fetch the
  // next clip's data when you scroll to it — so keep sweeping. The WeakSet makes
  // each pass cost nothing for scripts already handled.
  let fastTicks = 0;
  const fast = setInterval(() => { sweep(); if (++fastTicks > 30) clearInterval(fast); }, 1000);
  setInterval(sweep, 4000);

  /* ---------------- direct <video> src fallback ---------------- */

  window.addEventListener('message', (e) => {
    if (!e.data || e.data.__fbvd !== 'FBVD_ASK_VIDEO_SRC') return;

    // Full re-read: forget what we've already parsed and go through every
    // inline payload again, in case one was empty when we first saw it.
    scanned = new WeakSet();
    seenPayloads.clear();
    sweep();

    const out = [];
    document.querySelectorAll('video').forEach((v) => {
      if (v.src && /^https?:/.test(v.src)) out.push(v.src);
      v.querySelectorAll('source').forEach((s) => { if (s.src && /^https?:/.test(s.src)) out.push(s.src); });
    });
    if (out.length) {
      window.postMessage({
        __fbvd: TAG,
        records: [{
          id: 'domsrc_' + out[0].slice(-20), videoId: null, title: document.title,
          thumb: null, durationMs: null, width: null, height: null, permalink: location.href,
          progressive: out.map((u) => ({ url: u, label: 'AUTO' })), dash: [], ts: Date.now(),
        }],
        pageUrl: location.href,
      }, '*');
    }
  });
})();
