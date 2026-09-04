/* WebCodecs transcoder.
 *
 * Why this exists: the bundled ffmpeg core is built without libdav1d and
 * without libaom, so its only AV1 "decoder" is the hardware-accelerated stub —
 * in wasm that fails with "Failed to get pixel format" / "Missing Sequence
 * Header" and the conversion dies. Chrome, however, decodes AV1 and VP9 in
 * software and encodes H.264, and it does both far faster than libx264 in wasm.
 *
 * So: demux the MP4 with mp4box, decode → re-encode through WebCodecs, and hand
 * ffmpeg a raw Annex-B H.264 stream that it only has to mux with the audio.
 */

const CODEC_CANDIDATES = [
  'avc1.640034', // High @ 5.2
  'avc1.640033', // High @ 5.1
  'avc1.640028', // High @ 4.0
  'avc1.4d0034', // Main @ 5.2
  'avc1.42E01F', // Baseline @ 3.1
];

function descriptionFor(file, trackId) {
  const trak = file.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.av1C || entry.avcC || entry.hvcC || entry.vpcC;
    if (!box) continue;
    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    box.write(stream);
    return { bytes: new Uint8Array(stream.buffer, 8), kind: box.type };
  }
  return null;
}

function demux(mp4Bytes) {
  return new Promise((resolve, reject) => {
    const file = MP4Box.createFile();
    const samples = [];
    let info = null;

    file.onError = (e) => reject(new Error('Không đọc được MP4: ' + e));
    file.onSamples = (_id, _user, list) => { for (const s of list) samples.push(s); };
    file.onReady = (i) => {
      info = i;
      const track = i.videoTracks && i.videoTracks[0];
      if (!track) return reject(new Error('MP4 không có luồng hình.'));
      file.setExtractionOptions(track.id, null, { nbSamples: 100000 });
      file.start();
    };

    const ab = mp4Bytes.buffer.slice(mp4Bytes.byteOffset, mp4Bytes.byteOffset + mp4Bytes.byteLength);
    ab.fileStart = 0;
    file.appendBuffer(ab);
    file.flush();

    if (!info) return reject(new Error('Không phân tích được cấu trúc MP4.'));
    const track = info.videoTracks[0];
    if (!samples.length) return reject(new Error('Không lấy được frame nào từ MP4.'));
    resolve({ file, track, samples, description: descriptionFor(file, track.id) });
  });
}

async function pickEncoderConfig(width, height, bitrate, framerate) {
  for (const codec of CODEC_CANDIDATES) {
    const config = {
      codec, width, height, bitrate, framerate,
      avc: { format: 'annexb' },
      latencyMode: 'quality',
    };
    try {
      const { supported } = await VideoEncoder.isConfigSupported(config);
      if (supported) return config;
    } catch (_) { /* try the next one */ }
  }
  return null;
}

/**
 * @returns {Promise<{data: Uint8Array, fps: number, frames: number, codec: string}>}
 */
export async function transcodeToH264(mp4Bytes, { onProgress, onLog } = {}) {
  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') {
    throw new Error('Trình duyệt này không có WebCodecs.');
  }
  if (typeof MP4Box === 'undefined' || typeof DataStream === 'undefined') {
    throw new Error('Không nạp được mp4box.');
  }

  const { track, samples, description } = await demux(mp4Bytes);
  const width = track.video.width || track.track_width;
  const height = track.video.height || track.track_height;
  const durationSec = track.duration / track.timescale;
  const fps = durationSec > 0 ? Math.round((track.nb_samples / durationSec) * 1000) / 1000 : 30;

  // H.264 needs noticeably more bits than AV1/VP9 for the same picture.
  const bitrate = Math.round(Math.min(16e6, Math.max(2.5e6, width * height * Math.min(fps, 60) * 0.10)));

  const encConfig = await pickEncoderConfig(width, height, bitrate, Math.round(fps) || 30);
  if (!encConfig) throw new Error(`Trình duyệt không encode được H.264 ở ${width}×${height}.`);

  onLog && onLog(`WebCodecs: ${track.codec} → ${encConfig.codec}, ${width}×${height} @ ${fps}fps, ` +
                 `${(bitrate / 1e6).toFixed(1)} Mbps, ${samples.length} frame.`);

  const chunks = [];
  let encoded = 0;
  let failure = null;

  const encoder = new VideoEncoder({
    output: (chunk) => {
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      chunks.push(b);
      encoded++;
    },
    error: (e) => { failure = failure || e; },
  });
  encoder.configure(encConfig);

  let decodedIdx = 0;
  const keyEvery = Math.max(1, Math.round((Math.round(fps) || 30) * 2));

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        if (!failure) encoder.encode(frame, { keyFrame: decodedIdx % keyEvery === 0 });
        decodedIdx++;
      } catch (e) {
        failure = failure || e;
      } finally {
        frame.close();
      }
    },
    error: (e) => { failure = failure || e; },
  });

  const decConfig = {
    codec: track.codec,
    codedWidth: width,
    codedHeight: height,
    hardwareAcceleration: 'no-preference',
  };
  // VP8/VP9 configs are rejected by some builds when a description is attached.
  if (description && /^(av1C|avcC|hvcC)$/.test(description.kind)) {
    decConfig.description = description.bytes;
  }
  const support = await VideoDecoder.isConfigSupported(decConfig);
  if (!support.supported) throw new Error(`Trình duyệt không decode được ${track.codec}.`);
  decoder.configure(decConfig);

  const usToTicks = 1e6 / track.timescale;
  for (let i = 0; i < samples.length; i++) {
    if (failure) break;
    while (decoder.decodeQueueSize > 24 || encoder.encodeQueueSize > 24) {
      await new Promise((r) => setTimeout(r, 6));
      if (failure) break;
    }
    const s = samples[i];
    decoder.decode(new EncodedVideoChunk({
      type: s.is_sync ? 'key' : 'delta',
      timestamp: Math.round(s.cts * usToTicks),
      duration: Math.round(s.duration * usToTicks),
      data: s.data,
    }));
    if (onProgress && (i % 15 === 0)) onProgress((i / samples.length) * 96);
  }

  if (failure) { try { decoder.close(); encoder.close(); } catch (_) {} throw failure; }

  await decoder.flush();
  await encoder.flush();
  decoder.close();
  encoder.close();
  if (failure) throw failure;
  if (!encoded) throw new Error('WebCodecs không tạo ra frame nào.');

  onProgress && onProgress(100);

  let total = 0;
  for (const c of chunks) total += c.length;
  const data = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { data.set(c, off); off += c.length; }

  return { data, fps: Math.round(fps) || 30, frames: encoded, codec: encConfig.codec };
}
