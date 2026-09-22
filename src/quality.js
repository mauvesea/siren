import { FRAME_SAMPLES, prepareWav, readWav, RATE } from './converter.js';

// A phase-independent comparison for choosing between hardware-valid cries.
// Several FFT sizes capture short attacks and sustained pitch at once.
function magnitude(windowed) {
  const n = windowed.length;
  const real = Float64Array.from(windowed), imag = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; }
  }
  for (let length = 2; length <= n; length *= 2) {
    const half = length >> 1;
    const step = -2 * Math.PI / length;
    for (let start = 0; start < n; start += length) {
      for (let k = 0; k < half; k++) {
        const angle = step * k, c = Math.cos(angle), s = Math.sin(angle);
        const other = start + k + half;
        const tr = real[other] * c - imag[other] * s;
        const ti = real[other] * s + imag[other] * c;
        real[other] = real[start + k] - tr;
        imag[other] = imag[start + k] - ti;
        real[start + k] += tr;
        imag[start + k] += ti;
      }
    }
  }
  return Float64Array.from({ length: n / 2 + 1 }, (_, bin) => Math.hypot(real[bin], imag[bin]));
}

function rms(samples) {
  let sum = 0;
  for (const value of samples) sum += value * value;
  return Math.sqrt(sum / Math.max(samples.length, 1));
}

function spectrumAt(samples, frame, size, window) {
  const first = frame * FRAME_SAMPLES + FRAME_SAMPLES / 2 - size / 2;
  const segment = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const at = first + i;
    if (at >= 0 && at < samples.length) segment[i] = samples[at] * window[i];
  }
  return magnitude(segment);
}

export function scorePrecisePreview(sourceSamples, previewWav) {
  const rendered = prepareWav(readWav(previewWav)).samples;
  const frames = Math.max(1, Math.round(sourceSamples.length / FRAME_SAMPLES));
  const count = frames * FRAME_SAMPLES;
  const source = new Float64Array(count), preview = new Float64Array(count);
  source.set(sourceSamples.subarray(0, count));
  preview.set(rendered.subarray(0, count));
  const sourceRms = rms(source), previewRms = rms(preview);
  const envelopes = [source, preview].map(samples => {
    const levels = new Float64Array(frames);
    for (let frame = 0; frame < frames; frame++)
      levels[frame] = rms(samples.subarray(frame * FRAME_SAMPLES, (frame + 1) * FRAME_SAMPLES));
    return levels;
  });
  const peakSource = Math.max(...envelopes[0], 1e-9);
  const peakPreview = Math.max(...envelopes[1], 1e-9);
  const active = Array.from(envelopes[0], value => value > Math.max(0.001, peakSource * 0.05));
  let envelopeError = 0, activeCount = 0;
  for (let i = 0; i < frames; i++) if (active[i]) {
    envelopeError += Math.abs(envelopes[0][i] / peakSource - envelopes[1][i] / peakPreview);
    activeCount++;
  }
  envelopeError /= Math.max(activeCount, 1);
  const spectral = [], pitch = [];
  for (const size of [512, 1024, 2048]) {
    const window = Float64Array.from({ length: size }, (_, i) =>
      0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)));
    const low = Math.ceil(64 * size / RATE), high = Math.floor(4200 * size / RATE);
    const a = [], b = [];
    let maxSource = 1e-8;
    for (let frame = 0; frame < frames; frame++) {
      const left = spectrumAt(source, frame, size, window);
      const right = spectrumAt(preview, frame, size, window);
      for (let bin = low; bin <= high; bin++) {
        left[bin] /= Math.max(sourceRms, 1e-6);
        right[bin] /= Math.max(previewRms, 1e-6);
        maxSource = Math.max(maxSource, left[bin]);
      }
      a.push(left); b.push(right);
    }
    let weightedError = 0, totalWeight = 0;
    for (let frame = 0; frame < frames; frame++) {
      if (!active[frame]) continue;
      let bestSource = low, bestPreview = low;
      for (let bin = low; bin <= high; bin++) {
        const weight = Math.max(Math.sqrt(a[frame][bin] / maxSource), 0.02);
        weightedError += weight * Math.abs(Math.log1p(a[frame][bin]) - Math.log1p(b[frame][bin]));
        totalWeight += weight;
        if (size === 2048) {
          if (a[frame][bin] > a[frame][bestSource]) bestSource = bin;
          if (b[frame][bin] > b[frame][bestPreview]) bestPreview = bin;
        }
      }
      if (size === 2048) pitch.push(Math.abs(Math.log2(bestPreview / bestSource)));
    }
    spectral.push(weightedError / Math.max(totalWeight, 1e-9));
  }
  const gain = Math.abs(Math.log((previewRms + 1e-5) / (sourceRms + 1e-5)));
  const pitchError = pitch.reduce((sum, value) => sum + value, 0) / Math.max(pitch.length, 1);
  const score = 0.5 * spectral[0] + 0.3 * spectral[1] + 0.2 * spectral[2] +
    0.5 * envelopeError + 0.2 * gain + 0.1 * pitchError;
  return { score, spectral, envelope: envelopeError, gain, pitch: pitchError };
}
