// Deterministic Siren conversion core. Keep constants and scoring in sync.
export const RATE = 10512;
export const FRAME_SAMPLES = 176;
export const FRAME_RATE = 4194304 / 70224;
export const MAX_SECONDS = 5;
export const MAX_BYTES = 20 * 1024 * 1024;
const FFT_SIZE = 4096;
const BIN_HZ = RATE / FFT_SIZE;
const DUTIES = [0.125, 0.25, 0.5, 0.75];
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const round = Math.round;

export function readWav(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 44 || fourcc(view, 0) !== 'RIFF' || fourcc(view, 8) !== 'WAVE') {
    throw new Error('Choose an uncompressed RIFF/WAVE file.');
  }
  let format, audio;
  for (let at = 12; at + 8 <= view.byteLength;) {
    const id = fourcc(view, at);
    const size = view.getUint32(at + 4, true);
    const begin = at + 8;
    if (begin + size > view.byteLength) throw new Error('This WAV has a truncated chunk.');
    if (id === 'fmt ') {
      if (size < 16) throw new Error('The WAV format chunk is incomplete.');
      let code = view.getUint16(begin, true);
      // WAVE_FORMAT_EXTENSIBLE wraps the usual PCM/float subtype in a GUID.
      if (code === 0xfffe && size >= 40) {
        const suffix = Array.from(new Uint8Array(buffer, begin + 26, 14));
        const expected = [0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
        if (suffix.every((byte, index) => byte === expected[index])) code = view.getUint16(begin + 24, true);
      }
      format = {
        code,
        channels: view.getUint16(begin + 2, true),
        rate: view.getUint32(begin + 4, true),
        align: view.getUint16(begin + 12, true),
        bits: view.getUint16(begin + 14, true),
      };
    }
    if (id === 'data' && !audio) audio = { begin, size };
    at = begin + size + (size & 1);
  }
  if (!format || !audio) throw new Error('The WAV needs format and audio data chunks.');
  const { code, channels, rate, align, bits } = format;
  if (![1, 3].includes(code) || (code === 1 && ![8, 16, 24, 32].includes(bits)) ||
      (code === 3 && ![32, 64].includes(bits)) || channels < 1 || channels > 8 ||
      rate < 4000 || rate > 192000 || align !== channels * bits / 8) {
    throw new Error('Supported WAV: PCM 8/16/24/32-bit or float 32/64-bit, up to 8 channels.');
  }
  const count = Math.floor(audio.size / align);
  if (!count) throw new Error('The WAV contains no audio samples.');
  const mono = new Float64Array(count);
  const width = bits / 8;
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) {
      const offset = audio.begin + i * align + ch * width;
      let value;
      if (code === 3) value = bits === 32 ? view.getFloat32(offset, true) : view.getFloat64(offset, true);
      else if (bits === 8) value = (view.getUint8(offset) - 128) / 128;
      else if (bits === 16) value = view.getInt16(offset, true) / 32768;
      else if (bits === 24) {
        let raw = view.getUint8(offset) | view.getUint8(offset + 1) << 8 | view.getUint8(offset + 2) << 16;
        if (raw & 0x800000) raw -= 0x1000000;
        value = raw / 8388608;
      } else value = view.getInt32(offset, true) / 2147483648;
      if (!Number.isFinite(value)) throw new Error('The WAV contains invalid floating-point samples.');
      sum += clamp(value, -1, 1);
    }
    mono[i] = sum / channels;
  }
  return { samples: mono, rate, channels, duration: count / rate };
}

function fourcc(view, at) {
  return String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
}

export function prepareWav(source, startSeconds = 0, endSeconds = Math.min(source.duration, MAX_SECONDS)) {
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) ||
      startSeconds < 0 || endSeconds > source.duration + 0.0005 || endSeconds - startSeconds < 0.02 ||
      endSeconds - startSeconds > MAX_SECONDS + 1e-6) {
    throw new Error(`Choose a segment from 0.02 to ${MAX_SECONDS} seconds within the file.`);
  }
  const first = Math.floor(startSeconds * source.rate);
  const last = Math.min(source.samples.length, Math.ceil(Math.min(endSeconds, source.duration) * source.rate));
  const count = Math.max(1, round((last - first) * RATE / source.rate));
  const samples = new Float64Array(count);
  // Same linear interpolation as the reference Python converter.
  for (let i = 0; i < count; i++) {
    const x = first + i * source.rate / RATE;
    const a = Math.floor(x), b = Math.min(source.samples.length - 1, a + 1);
    samples[i] = a >= source.samples.length ? 0 : source.samples[a] * (1 - (x - a)) + source.samples[b] * (x - a);
  }
  return { samples, rate: RATE, duration: count / RATE, wav: encodeWav(samples, RATE) };
}

export function encodeWav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset, string) => { for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + 2 * i, round(clamp(samples[i], -1, 1) * 32767), true);
  return buffer;
}

function fftMagnitude(samples) {
  const real = new Float64Array(FFT_SIZE), imag = new Float64Array(FFT_SIZE);
  for (let i = 0; i < samples.length; i++) real[i] = samples[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (samples.length - 1)));
  for (let i = 1, j = 0; i < FFT_SIZE; i++) {
    let bit = FFT_SIZE >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; }
  }
  for (let length = 2; length <= FFT_SIZE; length *= 2) {
    const theta = -2 * Math.PI / length;
    for (let block = 0; block < FFT_SIZE; block += length) {
      for (let j = 0; j < length / 2; j++) {
        const angle = theta * j;
        const c = Math.cos(angle), s = Math.sin(angle), other = block + j + length / 2;
        const tr = real[other] * c - imag[other] * s;
        const ti = real[other] * s + imag[other] * c;
        real[other] = real[block + j] - tr; imag[other] = imag[block + j] - ti;
        real[block + j] += tr; imag[block + j] += ti;
      }
    }
  }
  const power = new Float64Array(FFT_SIZE / 2 + 1);
  for (let i = 0; i < power.length; i++) power[i] = Math.hypot(real[i], imag[i]);
  return power;
}

const BAND_EDGES = [64, 120, 180, 260, 380, 550, 800, 1100, 1550, 2200, 3100, 4200];
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function waveformWindow(samples, first, last) {
  const segment = samples.subarray(first, last);
  if (segment.length < 2) return { rms: 0, peakHz: 0, flatness: 1, lowShare: 0, bands: Array(11).fill(0) };
  let squared = 0;
  for (const sample of segment) squared += sample * sample;
  const power = fftMagnitude(segment);
  const bands = Array(BAND_EDGES.length - 1).fill(0);
  let sum = 0, logSum = 0, count = 0, low = 0, total = 0, peak = 0, peakValue = 0;
  for (let bin = 1; bin < power.length; bin++) {
    const hz = bin * BIN_HZ;
    if (hz < 64 || hz >= 4200) continue;
    const value = power[bin] + 1e-5;
    if (value > peakValue) { peak = bin; peakValue = value; }
    if (hz < 4000) { sum += value; logSum += Math.log(value); count++; }
    const energy = value * value;
    total += energy;
    if (hz < 120) low += energy;
    for (let b = 0; b < bands.length; b++) {
      if (hz >= BAND_EDGES[b] && hz < BAND_EDGES[b + 1]) { bands[b] += energy; break; }
    }
  }
  return {
    rms: Math.sqrt(squared / segment.length), peakHz: peak * BIN_HZ,
    flatness: Math.exp(logSum / Math.max(count, 1)) / Math.max(sum / Math.max(count, 1), 1e-9),
    lowShare: low / Math.max(total, 1e-9), bands,
  };
}

export function analyzeWaveform(samples) {
  const windows = [];
  for (let first = 0; first + 352 < samples.length; first += 352)
    windows.push(waveformWindow(samples, first, Math.min(samples.length, first + 704)));
  if (!windows.length) windows.push(waveformWindow(samples, 0, samples.length));
  const peakRms = Math.max(...windows.map(item => item.rms));
  const active = windows.filter(item => item.rms > Math.max(0.025, peakRms * 0.2));
  const chosen = active.length ? active : windows;
  const jumps = [];
  for (let i = 1; i < chosen.length; i++)
    if (chosen[i - 1].peakHz && chosen[i].peakHz)
      jumps.push(Math.abs(Math.log2(chosen[i].peakHz / chosen[i - 1].peakHz)));
  return {
    peakHz: median(chosen.map(item => item.peakHz)),
    flatness: median(chosen.map(item => item.flatness)),
    lowShare: median(chosen.map(item => item.lowShare)),
    pitchJitter: median(jumps),
  };
}

function spectrum(samples, frame, fast = false) {
  const lo = Math.max(0, (frame - (fast ? 0 : 1)) * FRAME_SAMPLES);
  const hi = Math.min(samples.length, (frame + (fast ? 2 : 3)) * FRAME_SAMPLES);
  const power = fftMagnitude(samples.subarray(lo, hi));
  const residual = new Float64Array(power.length);
  let sum = 0;
  for (let i = 0; i < power.length + 25; i++) {
    if (i < power.length) sum += power[i];
    if (i >= 51) sum -= power[i - 51];
    const at = i - 25;
    if (at >= 0 && at < power.length) residual[at] = Math.max(0, power[at] - sum / 51);
  }
  return residual;
}

const ATOMS = [];
// The Game Boy's lowest square pitch is about 64 Hz. Other profiles need a
// wider search than the original 120–1100 Hz range.
for (let hz = 64; hz <= 1800; hz += 2) {
  for (let duty = 0; duty < 4; duty++) {
    const indexes = [], weights = [];
    for (let k = 1; k <= 8; k++) {
      if (k * hz > 3500) break;
      const weight = Math.abs(Math.sin(Math.PI * k * DUTIES[duty])) / k ** 1.2;
      if (weight < 0.05) continue;
      indexes.push(round(k * hz / BIN_HZ)); weights.push(weight);
    }
    ATOMS.push({ hz, duty, indexes, weights, norm: Math.hypot(...weights) + 1e-9 });
  }
}

function scoreAtoms(residual, minHz = 120, maxHz = 1100) {
  const scores = new Float64Array(ATOMS.length);
  for (let n = 0; n < ATOMS.length; n++) {
    const atom = ATOMS[n];
    if (atom.hz < minHz || atom.hz > maxHz) continue;
    let raw = 0, max = 0, fundamental = 0;
    for (let k = 0; k < atom.indexes.length; k++) {
      const index = atom.indexes[k];
      let value = 0;
      for (let offset = -2; offset <= 2; offset++) value = Math.max(value, residual[clamp(index + offset, 0, residual.length - 1)]);
      if (k === 0) fundamental = value;
      max = Math.max(max, value); raw += value * atom.weights[k];
    }
    scores[n] = raw / atom.norm * (0.55 + 0.45 * Math.min(1, fundamental / (max + 1e-9)));
  }
  return scores;
}

function bestIndex(scores) {
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  return best;
}

function suppress(residual, index, score) {
  const atom = ATOMS[index];
  for (let k = 0; k < atom.indexes.length; k++) {
    const bin = atom.indexes[k], weight = atom.weights[k];
    for (let offset = -10; offset <= 10; offset++) {
      const position = bin + offset;
      if (position >= 0 && position < residual.length)
        residual[position] = Math.max(0, residual[position] - score * weight * Math.exp(-0.5 * (offset / 3) ** 2));
    }
  }
}

function secondCandidates(residual, firstHz, minHz, maxHz) {
  const scores = scoreAtoms(residual, minHz, maxHz);
  const order = Array.from(scores.keys()).filter(index => {
    const hz = ATOMS[index].hz;
    return scores[index] > 0 && Math.abs(hz - firstHz) >= Math.max(28, firstHz * 0.09) &&
      Math.abs(hz - firstHz / 2) >= Math.max(18, firstHz * 0.04) &&
      Math.abs(hz - firstHz * 2) >= Math.max(28, firstHz * 0.08) &&
      hz >= (minHz === 120 && maxHz === 1100 ? Math.max(180, firstHz * 0.65) : Math.max(minHz, firstHz * 0.55));
  }).sort((a, b) => scores[b] - scores[a] || b - a);
  const chosen = [];
  for (const index of order) {
    if (chosen.every(item => Math.abs(ATOMS[index].hz - ATOMS[item.index].hz) > Math.max(16, ATOMS[item.index].hz * 0.06))) {
      chosen.push({ index, score: scores[index] });
      if (chosen.length === 12) break;
    }
  }
  // A second voice can be absent in a very low or narrow-band source.
  return chosen.length ? chosen : [{ index: bestIndex(scores), score: 0 }];
}

function coherentSecond(candidates, rms) {
  let previous = candidates[0].map(option => ({ total: option.score / Math.max(candidates[0][0].score, 1e-9), path: [option] }));
  for (let frame = 1; frame < candidates.length; frame++) {
    const smooth = Math.min(1, Math.max(0.25, Math.min(rms[frame], rms[frame - 1]) / 0.17));
    previous = candidates[frame].map(option => {
      let best = null;
      for (let i = 0; i < previous.length; i++) {
        const jump = Math.abs(Math.log2(ATOMS[option.index].hz / ATOMS[candidates[frame - 1][i].index].hz));
        const total = previous[i].total + option.score / Math.max(candidates[frame][0].score, 1e-9) - 0.55 * smooth * jump;
        if (!best || total > best.total) best = { total, path: [...previous[i].path, option] };
      }
      return best;
    });
  }
  return previous.reduce((best, item) => item.total > best.total ? item : best).path;
}

function register(hz) { return clamp(round(2048 - 131072 / hz), 0, 2047); }
function volume(rms, score, reference, secondary = false) {
  if (rms < 0.025 || score < reference * 0.3) return 0;
  const amplitude = Math.min(1, rms / 0.27);
  const relative = Math.min(1, score / Math.max(reference, 1e-9));
  return clamp(round((secondary ? 10 : 13) * amplitude * relative ** 0.55), 1, 15);
}
function smooth(notes) {
  const result = notes.map(note => ({ ...note }));
  for (let i = 1; i < notes.length - 1; i++) {
    const a = notes[i - 1], b = notes[i], c = notes[i + 1];
    if (a.volume && b.volume && c.volume && Math.abs(a.frequency - c.frequency) < 8 && Math.abs(b.frequency - a.frequency) > 30)
      result[i].frequency = Math.floor((a.frequency + c.frequency) / 2);
  }
  return result;
}

export function convert(samples, {
  noisePitch = 92, noiseGain = 1, minHz = 120, maxHz = 1100,
  stepFrames = 2, secondGain = 1, noiseMode = 'fixed', smoothing = 'legacy',
} = {}) {
  if (!samples.length) throw new Error('There are no samples to convert.');
  if (![1, 2].includes(stepFrames)) throw new Error('Step size must be one or two frames.');
  const frames = Math.ceil(samples.length / FRAME_SAMPLES);
  const first = [], candidates = [], rms = [], texture = [];
  for (let start = 0; start < frames; start += stepFrames) {
    const residual = spectrum(samples, start, stepFrames === 1);
    const scores = scoreAtoms(residual, minHz, maxHz), index = bestIndex(scores);
    first.push({ index, score: scores[index] });
    suppress(residual, index, scores[index]);
    candidates.push(secondCandidates(residual, ATOMS[index].hz, minHz, maxHz));
    let sum = 0, length = 0;
    for (let i = start * FRAME_SAMPLES; i < Math.min(samples.length, (start + stepFrames) * FRAME_SAMPLES); i++) { sum += samples[i] ** 2; length++; }
    rms.push(Math.sqrt(sum / Math.max(1, length)));
    if (noiseMode === 'texture') texture.push(waveformWindow(samples, start * FRAME_SAMPLES, Math.min(samples.length, (start + 3) * FRAME_SAMPLES)).flatness);
  }
  const second = coherentSecond(candidates, rms);
  const channels = { ch5: [], ch6: [], ch8: [] };
  for (let i = 0; i < first.length; i++) {
    const a = ATOMS[first[i].index], b = ATOMS[second[i].index];
    const duration = i === first.length - 1 && frames % stepFrames ? 0 : stepFrames - 1;
    channels.ch5.push({ duration, volume: volume(rms[i], first[i].score, first[i].score), envelope: 8, frequency: register(a.hz), duty: a.duty });
    channels.ch6.push({ duration, volume: clamp(round(volume(rms[i], second[i].score, first[i].score, true) * secondGain), 0, 15), envelope: 8, frequency: register(b.hz), duty: b.duty });
    const base = clamp(round(5 * Math.min(1, rms[i] / 0.25)), 0, 12);
    const noiseFactor = noiseMode === 'texture' ? clamp((texture[i] - 0.27) / 0.38, 0, 1) : 1;
    channels.ch8.push({ duration, volume: clamp(round(base * noiseGain * noiseFactor), 0, 15), envelope: 8, frequency: noisePitch });
  }
  if (smoothing !== 'none') {
    channels.ch5 = smooth(channels.ch5); channels.ch6 = smooth(channels.ch6);
  }
  return { channels, frames, sourceDuration: samples.length / RATE };
}

export function makeAsm(project, sourceName = 'source.wav') {
  const label = project.label;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(label)) throw new Error('Cry label must start with a letter and use letters, numbers, or underscores.');
  const lines = [
    '; Generated by Siren',
    `; Source: ${sourceName.replace(/[^A-Za-z0-9_. -]/g, '_')}`,
    '; Play with pitch 0, length 256.',
    '; Approximation with two PSG square channels and PSG noise.',
    '', `Cry_${label}:`, '\tchannel_count 3',
    `\tchannel 5, Cry_${label}_Ch5`, `\tchannel 6, Cry_${label}_Ch6`,
    `\tchannel 8, Cry_${label}_Ch8`, '',
  ];
  for (const [key, kind] of [['ch5', 'square'], ['ch6', 'square'], ['ch8', 'noise']]) {
    lines.push(`Cry_${label}_${key[0].toUpperCase()}${key.slice(1)}:`);
    let previousDuty = -1;
    for (const note of project.channels[key]) {
      validateNote(note, kind);
      if (kind === 'square' && note.duty !== previousDuty) {
        lines.push(`\tduty_cycle ${note.duty}`); previousDuty = note.duty;
      }
      const frequency = kind === 'square' && note.volume === 0 ? 0 : note.frequency;
      lines.push(`\t${kind}_note ${note.duration}, ${note.volume}, ${note.envelope}, ${frequency}`);
    }
    lines.push('\tsound_ret', '');
  }
  return lines.join('\n');
}

export function validateNote(note, kind) {
  for (const [name, low, high] of [
    ['duration', 0, 255], ['volume', 0, 15], ['envelope', -7, 8],
    ['frequency', 0, kind === 'noise' ? 255 : 2047],
    ...(kind === 'square' ? [['duty', 0, 3]] : []),
  ]) {
    if (!Number.isInteger(note[name]) || note[name] < low || note[name] > high)
      throw new Error(`${kind} ${name} must be a whole number from ${low} to ${high}.`);
  }
}

export function suggestedLabel(filename) {
  let label = filename.replace(/\.wav$/i, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[A-Za-z]/.test(label)) label = `Custom_${label}`;
  return label || 'Custom';
}
