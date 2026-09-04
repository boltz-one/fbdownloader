import { FFmpeg } from '../vendor/ffmpeg/index.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const forTabId = parseInt(params.get('tab'), 10);
const recordId = params.get('rec');

const log = (m) => {
  const el = $('#log');
  el.textContent += m + '\n';
  el.scrollTop = el.scrollHeight;
};

const setStep = (id, pct, done) => {
  const el = $(id);
  el.querySelector('.bar i').style.width = Math.max(0, Math.min(100, pct)) + '%';
  el.querySelector('.pct').textContent = Math.round(pct) + '%';
  el.classList.toggle('done', !!done);
};

const send = (msg) => new Promise((res) =>
  chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); }));

const fmtBytes = (b) => {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(i > 1 ? 1 : 0) + ' ' + u[i];
};

/* ------------------------------------------------------------------ */
/* MPD parsing                                                         */
/* ------------------------------------------------------------------ */

function absolute(url, base) {
  try { return new URL(url, base || location.href).href; } catch (_) { return url; }
}

function parseManifest(xml, manifestBase) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Không đọc được DASH manifest.');

  const mpdBase = doc.querySelector('MPD > BaseURL');
  const periodBase = doc.querySelector('MPD > Period > BaseURL');
  let base = manifestBase || location.href;
  if (mpdBase && mpdBase.textContent.trim()) base = absolute(mpdBase.textContent.trim(), base);
  if (periodBase && periodBase.textContent.trim()) base = absolute(periodBase.textContent.trim(), base);

  const streams = [];
  for (const set of doc.querySelectorAll('AdaptationSet')) {
    const setMime = set.getAttribute('mimeType') || set.getAttribute('contentType') || '';
    const setBaseEl = set.querySelector(':scope > BaseURL');
    const setBase = setBaseEl && setBaseEl.textContent.trim()
      ? absolute(setBaseEl.textContent.trim(), base) : base;

    for (const rep of set.querySelectorAll('Representation')) {
      const mime = rep.getAttribute('mimeType') || setMime;
      const kind = /audio/i.test(mime) ? 'audio' : /video/i.test(mime) ? 'video' : 'other';
      if (kind === 'other') continue;

      const repBaseEl = rep.querySelector(':scope > BaseURL');
      const repBase = repBaseEl && repBaseEl.textContent.trim()
        ? absolute(repBaseEl.textContent.trim(), setBase) : setBase;

      const st = rep.querySelector(':scope > SegmentTemplate') || set.querySelector(':scope > SegmentTemplate');
      const sl = rep.querySelector(':scope > SegmentList') || set.querySelector(':scope > SegmentList');

      let parts = null;
      if (sl) {
        parts = [];
        const init = sl.querySelector('Initialization');
        if (init && init.getAttribute('sourceURL')) parts.push(absolute(init.getAttribute('sourceURL'), repBase));
        for (const s of sl.querySelectorAll('SegmentURL')) {
          const m = s.getAttribute('media');
          if (m) parts.push(absolute(m, repBase));
        }
      } else if (st && st.getAttribute('media')) {
        const repId = rep.getAttribute('id') || '';
        const fill = (tpl, n) => tpl
          .replace(/\$RepresentationID\$/g, repId)
          .replace(/\$Bandwidth\$/g, rep.getAttribute('bandwidth') || '')
          .replace(/\$Number(%0(\d+)d)?\$/g, (_, __, w) => w ? String(n).padStart(+w, '0') : String(n));
        parts = [];
        const initTpl = st.getAttribute('initialization');
        if (initTpl) parts.push(absolute(fill(initTpl, 0), repBase));
        const timeline = st.querySelector('SegmentTimeline');
        let count = 0;
        if (timeline) {
          for (const s of timeline.querySelectorAll('S')) count += 1 + (parseInt(s.getAttribute('r') || '0', 10) || 0);
        }
        const start = parseInt(st.getAttribute('startNumber') || '1', 10);
        if (!count) count = 0; // unknown → handled below as a single-file fallback
        for (let i = 0; i < count; i++) parts.push(absolute(fill(st.getAttribute('media'), start + i), repBase));
        if (!count) parts = null;
      }

      streams.push({
        kind,
        id: rep.getAttribute('id') || '',
        codecs: rep.getAttribute('codecs') || '',
        mime,
        width: parseInt(rep.getAttribute('width') || '0', 10),
        height: parseInt(rep.getAttribute('height') || '0', 10),
        bandwidth: parseInt(rep.getAttribute('bandwidth') || '0', 10),
        fps: rep.getAttribute('frameRate') || set.getAttribute('frameRate') || '',
        audioRate: parseInt(rep.getAttribute('audioSamplingRate') || '0', 10),
        url: repBase,
        parts,
      });
    }
  }
  return streams;
}

/* ------------------------------------------------------------------ */
/* fetching with progress                                              */
/* ------------------------------------------------------------------ */

async function fetchStream(stream, stepId, onLabel) {
  const urls = stream.parts && stream.parts.length ? stream.parts : [stream.url];
  const chunks = [];
  let received = 0;
  let total = 0;

  if (urls.length === 1) {
    const res = await fetch(urls[0], { credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} khi tải ${stream.kind}`);
    total = parseInt(res.headers.get('content-length') || '0', 10);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      setStep(stepId, total ? (received / total) * 100 : Math.min(95, received / 5e6 * 100));
      onLabel && onLabel(received, total);
    }
  } else {
    for (let i = 0; i < urls.length; i++) {
      const res = await fetch(urls[i], { credentials: 'omit', cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ở đoạn ${i + 1}/${urls.length}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      chunks.push(buf);
      received += buf.length;
      setStep(stepId, ((i + 1) / urls.length) * 100);
      onLabel && onLabel(received, 0);
    }
  }

  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  setStep(stepId, 100, true);
  return out;
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

let record = null, summary = null, streams = [], videoBuf = null, audioBuf = null;

const CODECS = [
  { re: /^avc[13]/i,   name: 'H.264', compat: 3, note: '' },
  { re: /^(hev1|hvc1)/i, name: 'HEVC', compat: 1, note: 'kén trình phát' },
  { re: /^vp0?9/i,     name: 'VP9',   compat: 1, note: 'kén trình phát' },
  { re: /^vp8/i,       name: 'VP8',   compat: 1, note: 'kén trình phát' },
  { re: /^av01/i,      name: 'AV1',   compat: 0, note: 'kén trình phát' },
];

function codecOf(s) {
  const raw = (s.codecs || '').split('.')[0];
  return CODECS.find((c) => c.re.test(raw)) || { name: raw || 'n/a', compat: 2, note: '' };
}

function resLabel(s) {
  if (s.width && s.height) return Math.min(s.width, s.height) + 'p';
  if (s.height) return s.height + 'p';
  return 'video';
}

function describe(s) {
  if (s.kind === 'video') {
    const res = resLabel(s);
    const br = s.bandwidth ? ` · ${(s.bandwidth / 1e6).toFixed(2)} Mbps` : '';
    const dim = s.width && s.height ? ` · ${s.width}×${s.height}` : '';
    const c = codecOf(s);
    return `${res}${dim}${br} · ${c.name}${c.note ? ' (' + c.note + ')' : ''}`;
  }
  const br = s.bandwidth ? `${Math.round(s.bandwidth / 1000)} kbps` : 'audio';
  const codec = s.codecs ? ` · ${s.codecs.split('.')[0]}` : '';
  const hz = s.audioRate ? ` · ${(s.audioRate / 1000).toFixed(1)} kHz` : '';
  return `${br}${hz}${codec}`;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function suggestName(label, ext) {
  const r = await send({ type: 'FBVD_SUGGEST_NAME', forTabId, recordId, label });
  const full = (r && r.filename) || `facebook-video-${label}.mp4`;
  return full.split('/').pop().replace(/\.mp4$/, '.' + ext);
}

async function init() {
  const r = await send({ type: 'FBVD_GET_RECORD', forTabId, recordId });
  record = r && r.record;
  summary = r && r.summary;
  if (!record) {
    $('#lead').textContent = 'Không tìm thấy dữ liệu video. Hãy quay lại tab Facebook, phát lại video rồi thử lại.';
    return;
  }

  const title = (summary && summary.title) || 'Video Facebook';
  $('#lead').textContent = title;
  document.title = title + ' — Tải chất lượng tối đa';

  const all = [];
  for (const d of record.dash || []) {
    try { all.push(...parseManifest(d.xml, d.baseUrl)); }
    catch (e) { log('⚠ ' + e.message); }
  }
  // de-dupe by url
  const seen = new Set();
  streams = all.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));

  // Facebook publishes one manifest per codec. Its top VP9 track often beats the
  // top H.264 track on bitrate, but VP9-in-MP4 plays in Chrome and VLC and in
  // very little else — so rank by resolution, then by how widely playable the
  // codec is, and default to the best track that will actually open anywhere.
  const byQuality = (a, b) =>
    (Math.min(b.width || 0, b.height || 0) - Math.min(a.width || 0, a.height || 0)) ||
    (codecOf(b).compat - codecOf(a).compat) ||
    (b.bandwidth - a.bandwidth);

  const vids = streams.filter((s) => s.kind === 'video').sort(byQuality);
  const auds = streams.filter((s) => s.kind === 'audio').sort((a, b) => b.bandwidth - a.bandwidth);

  if (!vids.length) {
    $('#lead').textContent = 'Manifest DASH không có luồng hình nào dùng được. Hãy dùng nút MP4 HD trong popup.';
    return;
  }

  const vsel = $('#vsel'), asel = $('#asel');
  const safe = vids.filter((s) => codecOf(s).compat >= 2);
  const fussy = vids.filter((s) => codecOf(s).compat < 2);

  const addGroup = (label, list, tag) => {
    if (!list.length) return;
    const g = document.createElement('optgroup');
    g.label = label;
    for (const s of list) {
      const o = new Option(describe(s), String(streams.indexOf(s)));
      g.appendChild(o);
    }
    vsel.appendChild(g);
  };
  addGroup('Mở được ở mọi nơi', safe);
  addGroup('Bitrate cao hơn — chỉ Chrome / VLC mở được', fussy);

  const preferred = safe[0] || vids[0];
  vsel.value = String(streams.indexOf(preferred));

  asel.add(new Option(auds.length ? 'Tự động (bitrate cao nhất)' : 'Video này không có luồng tiếng riêng',
    auds.length ? String(streams.indexOf(auds[0])) : '-1'));
  auds.forEach((s) => asel.add(new Option(describe(s), String(streams.indexOf(s)))));

  const msel = $('#msel');
  const warn = () => {
    const sel = streams[parseInt(vsel.value, 10)];
    const c = codecOf(sel);
    const el = $('#codecWarn');
    if (c.compat >= 2 || msel.value === 'h264') { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = '';
    const p = document.createElement('p');
    p.style.margin = '0 0 9px';
    p.textContent =
      `⚠ Luồng này mã hoá ${c.name}. File tải về vẫn đủ dữ liệu, nhưng Windows Media Player, ` +
      `Photos, QuickTime và phần lớn trình phát mặc định không giải mã được ${c.name} — mở ra ` +
      `sẽ có tiếng mà không có hình. VLC và Chrome thì xem bình thường.` +
      (safe.length ? ' Cách nhanh nhất là chọn luồng H.264 ở nhóm trên.' : '');
    el.appendChild(p);
    if (!safe.length) {
      const hint = document.createElement('p');
      hint.style.margin = '0 0 9px';
      hint.textContent = 'Video này Facebook chỉ phát DASH bằng ' + c.name + ', không có bản H.264 nào. ' +
        'Hai lựa chọn: chuyển mã tại đây (giữ nguyên độ phân giải, mất vài phút), ' +
        'hoặc đóng tab này và bấm nút HD trong popup — bản progressive của Facebook là H.264, tải một phát là xong.';
      el.appendChild(hint);
    }
    const b = document.createElement('button');
    b.className = 'ghost';
    b.style.padding = '7px 12px';
    b.style.fontSize = '12.5px';
    b.textContent = 'Chuyển sang H.264';
    b.onclick = () => { msel.value = 'h264'; warn(); };
    el.appendChild(b);
  };
  vsel.addEventListener('change', warn);
  msel.addEventListener('change', warn);
  warn();

  $('#pick').hidden = false;
}

async function run() {
  $('#go').disabled = true;
  $('#pick').hidden = true;
  $('#work').hidden = false;
  $('#fail').hidden = true;

  const v = streams[parseInt($('#vsel').value, 10)];
  const mode = $('#msel').value;
  const aIdx = parseInt($('#asel').value, 10);
  const a = aIdx >= 0 ? streams[aIdx] : null;

  try {
    log(`Hình: ${describe(v)}`);
    videoBuf = await fetchStream(v, '#s-video', (rec, tot) =>
      $('#s-video .lbl').setAttribute('title', `${fmtBytes(rec)}${tot ? ' / ' + fmtBytes(tot) : ''}`));
    log(`Đã tải hình: ${fmtBytes(videoBuf.length)}`);

    if (a) {
      log(`Tiếng: ${describe(a)}`);
      audioBuf = await fetchStream(a, '#s-audio');
      log(`Đã tải tiếng: ${fmtBytes(audioBuf.length)}`);
    } else {
      setStep('#s-audio', 100, true);
      log('Không có luồng tiếng riêng — bỏ qua bước ghép.');
    }

    const label = resLabel(v) + '-' + (mode === 'h264' ? 'H264' : codecOf(v).name.replace(/\./g, ''));

    if (!a) {
      saveBlob(new Blob([videoBuf], { type: 'video/mp4' }), await suggestName(label, 'mp4'));
      setStep('#s-mux', 100, true);
      $('#work').hidden = false; $('#done').hidden = false;
      return;
    }

    log('Khởi động ffmpeg (lần đầu mất vài giây)…');
    const ffmpeg = new FFmpeg();
    ffmpeg.on('log', ({ message }) => {
      if (!message || message.length >= 300) return;
      // emscripten prints this when ffmpeg calls exit() after a successful run
      if (/^Aborted\(\)$/.test(message.trim())) { log('(ffmpeg thoát — bình thường)'); return; }
      log(message);
    });
    ffmpeg.on('progress', ({ progress }) => setStep('#s-mux', (progress || 0) * 100));

    await ffmpeg.load({
      coreURL: chrome.runtime.getURL('vendor/core/ffmpeg-core.js'),
      wasmURL: chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm'),
      classWorkerURL: chrome.runtime.getURL('vendor/ffmpeg/worker.js'),
    });

    await ffmpeg.writeFile('v.mp4', videoBuf);
    await ffmpeg.writeFile('a.mp4', audioBuf);

    const transcode = mode === 'h264' && codecOf(v).compat < 2;
    const args = transcode
      ? ['-i', 'v.mp4', '-i', 'a.mp4',
         '-c:v', 'libx264', '-preset', 'superfast', '-crf', '22', '-pix_fmt', 'yuv420p',
         '-c:a', 'copy', '-movflags', '+faststart', '-y', 'out.mp4']
      : ['-i', 'v.mp4', '-i', 'a.mp4', '-c', 'copy', '-movflags', '+faststart', '-y', 'out.mp4'];
    if (transcode) {
      $('#s-mux .lbl').textContent = 'Chuyển mã';
      log(`Chuyển ${codecOf(v).name} → H.264. Việc này chạy trong trình duyệt nên chậm — ` +
          `1080p dài vài phút thì mất khoảng 5–20 phút. Cứ để tab mở.`);
    }
    await ffmpeg.exec(args);
    const out = await ffmpeg.readFile('out.mp4');
    if (!out || !out.length) throw new Error('ffmpeg không tạo được file kết quả.');
    setStep('#s-mux', 100, true);

    saveBlob(new Blob([out], { type: 'video/mp4' }), await suggestName(label, 'mp4'));
    try { ffmpeg.terminate(); } catch (_) {}
    $('#done').hidden = false;
  } catch (err) {
    console.error(err);
    log('✗ ' + (err && err.message ? err.message : String(err)));
    $('#errmsg').textContent = 'Lỗi: ' + (err && err.message ? err.message : String(err)) +
      ' — bạn vẫn có thể tải riêng hai file rồi ghép bằng phần mềm khác.';
    $('#fail').hidden = false;
    $('#rawv').disabled = !videoBuf;
    $('#rawa').disabled = !audioBuf;
  }
}

$('#go').addEventListener('click', run);
$('#again').addEventListener('click', () => location.reload());
$('#rawv').addEventListener('click', async () => {
  if (videoBuf) saveBlob(new Blob([videoBuf], { type: 'video/mp4' }), await suggestName('video-only', 'mp4'));
});
$('#rawa').addEventListener('click', async () => {
  if (audioBuf) saveBlob(new Blob([audioBuf], { type: 'audio/mp4' }), await suggestName('audio-only', 'm4a'));
});

init();
