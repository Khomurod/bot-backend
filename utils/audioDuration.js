/**
 * audioDuration.js
 *
 * Best-effort playback-duration extraction for uploaded music, WITHOUT any
 * native/ffmpeg dependency. The admin/hub process (bot-backend) does not ship
 * ffprobe, so we parse the container headers directly for the formats the app
 * accepts:
 *   - MP4 / M4A / AAC (ISO-BMFF): read the `mvhd` box (timescale + duration).
 *   - WAV (RIFF/PCM): bytes ÷ byte-rate from the `fmt ` chunk.
 *   - MP3: estimate from the first frame's bitrate (CBR) — approximate.
 *
 * Returns the duration in seconds (Number) or null when it cannot be determined
 * with confidence. A null result is fine: the samsara-integration side re-probes
 * with real ffprobe before using the asset, so this is only an admin-preview hint.
 */

function parseMp4Duration(buf) {
  // Walk top-level ISO-BMFF boxes to find `moov`, then `mvhd` inside it.
  function findBox(name, start, end) {
    let o = start;
    while (o + 8 <= end) {
      const size = buf.readUInt32BE(o);
      const type = buf.toString('latin1', o + 4, o + 8);
      if (size < 8) break; // 64-bit sizes (size===1) not needed for small clips
      if (type === name) return { start: o, dataStart: o + 8, dataEnd: o + size };
      o += size;
    }
    return null;
  }
  const moov = findBox('moov', 0, buf.length);
  if (!moov) return null;
  const mvhd = findBox('mvhd', moov.dataStart, moov.dataEnd);
  if (!mvhd) return null;
  const version = buf[mvhd.dataStart];
  try {
    let timescale;
    let duration;
    if (version === 1) {
      timescale = buf.readUInt32BE(mvhd.dataStart + 20);
      duration = Number(buf.readBigUInt64BE(mvhd.dataStart + 24));
    } else {
      timescale = buf.readUInt32BE(mvhd.dataStart + 12);
      duration = buf.readUInt32BE(mvhd.dataStart + 16);
    }
    if (!timescale || !Number.isFinite(duration)) return null;
    const seconds = duration / timescale;
    return seconds > 0 && Number.isFinite(seconds) ? seconds : null;
  } catch (_) {
    return null;
  }
}

function parseWavDuration(buf) {
  if (buf.length < 44) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    return null;
  }
  let o = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (o + 8 <= buf.length) {
    const id = buf.toString('latin1', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') {
      byteRate = buf.readUInt32LE(o + 8 + 8); // avgBytesPerSec at fmt offset +8
    } else if (id === 'data') {
      dataSize = size;
      break;
    }
    o += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!byteRate || !dataSize) return null;
  const seconds = dataSize / byteRate;
  return seconds > 0 && Number.isFinite(seconds) ? seconds : null;
}

// MP3 CBR bitrate table (MPEG-1 Layer III), kbps.
const MP3_BITRATES_V1_L3 = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const MP3_SAMPLERATES_V1 = [44100, 48000, 32000, 0];

function parseMp3Duration(buf) {
  // Skip an ID3v2 tag if present.
  let start = 0;
  if (buf.toString('latin1', 0, 3) === 'ID3' && buf.length > 10) {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14)
      | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    start = 10 + size;
  }
  // Find the first frame sync (11 set bits).
  for (let o = start; o + 4 < buf.length; o += 1) {
    if (buf[o] === 0xff && (buf[o + 1] & 0xe0) === 0xe0) {
      const versionBits = (buf[o + 1] >> 3) & 0x03; // 3 => MPEG-1
      const bitrateIdx = (buf[o + 2] >> 4) & 0x0f;
      const sampleRateIdx = (buf[o + 2] >> 2) & 0x03;
      if (versionBits !== 3) return null; // only estimate MPEG-1 Layer III
      const bitrate = MP3_BITRATES_V1_L3[bitrateIdx];
      const sampleRate = MP3_SAMPLERATES_V1[sampleRateIdx];
      if (!bitrate || !sampleRate) return null;
      // CBR estimate: total audio bytes ÷ (bitrate bytes/sec).
      const audioBytes = buf.length - start;
      const seconds = audioBytes / (bitrate * 1000 / 8);
      return seconds > 0 && Number.isFinite(seconds) ? seconds : null;
    }
  }
  return null;
}

/**
 * Extract audio duration (seconds) from a Buffer, using the mime type as a hint.
 * @param {Buffer} buffer
 * @param {string} [mimeType]
 * @returns {number|null} seconds, or null if undetermined.
 */
function getAudioDurationSeconds(buffer, mimeType = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const mime = String(mimeType || '').toLowerCase();
  const attempts = [];
  // Order the parsers by the mime hint, but always try the others as a fallback.
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac') || mime.includes('mpeg-4')) {
    attempts.push(parseMp4Duration, parseWavDuration, parseMp3Duration);
  } else if (mime.includes('wav') || mime.includes('x-wav')) {
    attempts.push(parseWavDuration, parseMp4Duration, parseMp3Duration);
  } else if (mime.includes('mpeg') || mime.includes('mp3')) {
    attempts.push(parseMp3Duration, parseMp4Duration, parseWavDuration);
  } else {
    attempts.push(parseMp4Duration, parseWavDuration, parseMp3Duration);
  }
  for (const fn of attempts) {
    try {
      const seconds = fn(buffer);
      if (seconds && seconds > 0) return Math.round(seconds * 1000) / 1000;
    } catch (_) {
      /* try next parser */
    }
  }
  return null;
}

module.exports = {
  getAudioDurationSeconds,
  // Exported for focused unit tests.
  parseMp4Duration,
  parseWavDuration,
  parseMp3Duration,
};
