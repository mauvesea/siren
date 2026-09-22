import assert from 'node:assert/strict';
import test from 'node:test';

import { convert, encodeWav, FRAME_SAMPLES, FRAME_RATE, makeAsm, prepareWav, RATE, readWav } from '../../src/converter.js';
import { applyCryParameters, parseCryAsm } from '../../src/cry-asm.js';
import { renderPreview } from '../../src/preview.js';
import { fitPrecisePreset } from '../../src/preset-engine.js';
import { scorePrecisePreview } from '../../src/quality.js';

test('Precise emits a playable wave cry with hardware-correct pitch and frame count', () => {
  const samples = Float64Array.from({ length: FRAME_SAMPLES * 21 + 70 }, (_, i) =>
    0.4 * Math.sin(2 * Math.PI * 440 * i / RATE));
  const project = { ...convert(samples, { precise: true }), label: 'Tone' };
  const asm = makeAsm(project);
  assert.equal(project.frames, 21);
  assert.match(asm, /channel 7, Cry_Tone_Ch7/);
  assert.match(asm, /channel_count [2-4]/);
  assert.ok(project.channels.ch7.some(note => note.volume > 0));
  for (const note of project.channels.ch7.filter(note => note.volume))
    assert.ok(Math.abs(65536 / (2048 - note.frequency) - 440) < 15);

  const played = applyCryParameters(parseCryAsm(asm), 0, 256);
  for (const notes of Object.values(played.channels))
    if (notes.length) assert.equal(notes.reduce((sum, note) => sum + note.frames, 0), 21);
  const preview = readWav(renderPreview(project));
  assert.ok(Math.abs(preview.duration - 21 / FRAME_RATE) < 1 / preview.rate);
  assert.ok(preview.samples.some(sample => Math.abs(sample) > 0.05));
});

test('Precise omits unused channels and combines sustained silence', () => {
  const samples = new Float64Array(FRAME_SAMPLES * 30);
  const project = { ...convert(samples, { precise: true }), label: 'Silence' };
  const asm = makeAsm(project);
  assert.match(asm, /channel_count 1/);
  assert.equal(project.channels.ch5.length, 1);
  assert.equal(project.channels.ch5[0].duration, 29);
  assert.doesNotMatch(asm, /channel 7,/);
  assert.equal(applyCryParameters(parseCryAsm(asm), 0, 256).channels.ch5[0].frames, 30);
});

test('Precise retains a hard stereo side in exported ASM and preview', () => {
  const count = FRAME_SAMPLES * 12;
  const buffer = new ArrayBuffer(44 + count * 4);
  const view = new DataView(buffer);
  const text = (at, value) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 2, true); view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 4, true); view.setUint16(32, 4, true);
  view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, count * 4, true);
  for (let i = 0; i < count; i++)
    view.setInt16(46 + i * 4, Math.round(12000 * Math.sin(2 * Math.PI * 330 * i / RATE)), true);

  const source = readWav(buffer);
  assert.equal(source.stereoBalance, 0);
  const prepared = prepareWav(source);
  const project = { ...convert(prepared.samples, { precise: true, stereoBalance: prepared.stereoBalance }),
    label: 'Right' };
  const asm = makeAsm(project);
  assert.match(asm, /force_stereo_panning FALSE, TRUE/);
  const parsed = applyCryParameters(parseCryAsm(asm), 0, 256);
  assert.equal(parsed.channels.ch5[0].route, 'right');
  const preview = renderPreview(project);
  assert.equal(new DataView(preview).getUint16(22, true), 2);
  const audio = new DataView(preview);
  let left = 0, right = 0;
  for (let i = 44; i < preview.byteLength; i += 4) {
    left += Math.abs(audio.getInt16(i, true));
    right += Math.abs(audio.getInt16(i + 2, true));
  }
  assert.equal(left, 0);
  assert.ok(right > 0);
});

test('Precise reaches low wave-only fundamentals and high register pitches', () => {
  const tone = hz => Float64Array.from({ length: FRAME_SAMPLES * 30 }, (_, i) =>
    0.4 * Math.sin(2 * Math.PI * hz * i / RATE));
  const bass = convert(tone(40), { precise: true });
  assert.ok(bass.channels.ch7.some(note => note.volume &&
    Math.abs(65536 / (2048 - note.frequency) - 40) < 1));
  assert.ok(bass.channels.ch5.every(note => note.volume === 0));
  const high = convert(tone(3000), { precise: true });
  assert.ok(high.channels.ch5.some(note => note.volume &&
    Math.abs(131072 / (2048 - note.frequency) - 3000) < 40));
});

test('WAV preparation rejects frequencies above the analysis Nyquist before downsampling', () => {
  const preparedRms = hz => {
    const source = Float64Array.from({ length: 11025 }, (_, i) =>
      0.5 * Math.sin(2 * Math.PI * hz * i / 44100));
    const samples = prepareWav(readWav(encodeWav(source, 44100))).samples.slice(100, -100);
    return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  };
  assert.ok(preparedRms(3000) > 0.3);
  assert.ok(preparedRms(10000) < 0.01);
});

test('Precise selects and previews a measured hardware fit', () => {
  const samples = Float64Array.from({ length: FRAME_SAMPLES * 12 }, (_, i) =>
    0.25 * Math.sin(2 * Math.PI * 220 * i / RATE) +
    0.15 * Math.sin(2 * Math.PI * 660 * i / RATE));
  const fitted = fitPrecisePreset(samples);
  assert.ok(['focused', 'layered'].includes(fitted.strategy));
  assert.ok(Number.isFinite(fitted.score));
  assert.ok(Math.abs(scorePrecisePreview(samples, fitted.preview).score - fitted.score) < 1e-9);
  const asm = makeAsm({ ...fitted.result, label: 'Measured' });
  assert.ok(parseCryAsm(asm).channels.ch5.length > 0);
});
