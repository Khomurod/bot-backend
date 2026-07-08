const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getAudioDurationSeconds } = require('../utils/audioDuration');

function buildWav({ sampleRate = 8000, channels = 1, bitsPerSample = 8, seconds = 1 } = {}) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const dataSize = Math.round(byteRate * seconds);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + dataSize, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(channels, 22);
  hdr.writeUInt32LE(sampleRate, 24);
  hdr.writeUInt32LE(byteRate, 28);
  hdr.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  hdr.writeUInt16LE(bitsPerSample, 34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(dataSize, 40);
  return Buffer.concat([hdr, Buffer.alloc(dataSize)]);
}

function buildMp4({ timescale = 1000, durationUnits = 5000 } = {}) {
  // Minimal ftyp + moov>mvhd (version 0) box just large enough for the parser.
  const mvhdData = Buffer.alloc(100);
  mvhdData[0] = 0; // version 0
  mvhdData.writeUInt32BE(timescale, 12);
  mvhdData.writeUInt32BE(durationUnits, 16);
  const mvhd = Buffer.concat([Buffer.alloc(8), mvhdData]);
  mvhd.writeUInt32BE(mvhd.length, 0);
  mvhd.write('mvhd', 4);
  const moov = Buffer.concat([Buffer.alloc(8), mvhd]);
  moov.writeUInt32BE(moov.length, 0);
  moov.write('moov', 4);
  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0);
  ftyp.write('ftyp', 4);
  ftyp.write('isom', 8);
  // Include 'mp4a' somewhere so a codec sniff would pass (not asserted here).
  return Buffer.concat([ftyp, moov]);
}

test('parses WAV duration from the fmt/data chunks', () => {
  assert.equal(getAudioDurationSeconds(buildWav({ seconds: 3 }), 'audio/wav'), 3);
});

test('parses MP4/M4A duration from the mvhd box', () => {
  const d = getAudioDurationSeconds(buildMp4({ timescale: 1000, durationUnits: 171108 }), 'audio/mp4');
  assert.equal(d, 171.108);
});

test('returns null for an empty buffer', () => {
  assert.equal(getAudioDurationSeconds(Buffer.alloc(0), 'audio/mpeg'), null);
});

test('returns null for non-audio garbage', () => {
  assert.equal(getAudioDurationSeconds(Buffer.from('this is definitely not audio'), 'audio/mpeg'), null);
});

test('falls back across parsers when the mime hint is wrong', () => {
  // A WAV labelled as mp4 should still be parsed via the WAV fallback.
  assert.equal(getAudioDurationSeconds(buildWav({ seconds: 2 }), 'audio/mp4'), 2);
});
