import { analyzeWaveform, convert, prepareWav, readWav, waveformWindow } from './converter.js';
import { renderPreview } from './preview.js';

export function suggestPreset(samples) {
  const features = analyzeWaveform(samples);
  let id = 'clean';
  if (features.peakHz < 240 && features.pitchJitter > 0.18) id = 'bass_vibrato';
  else if (features.peakHz < 240 && features.flatness > 0.12) id = 'raspy_bass';
  else if (features.peakHz < 240 || features.lowShare > 0.08) id = 'deep_roar';
  else if (features.peakHz < 360 || features.lowShare > 0.035) id = 'deep';
  else if (features.flatness > 0.74) id = 'textured';
  else if (features.pitchJitter > 0.18) id = 'vibrating';
  else if (features.peakHz > 1100) id = 'bright';
  return { id, features };
}

function signature(samples) {
  const windows = [];
  for (let first = 0; first + 352 < samples.length; first += 352)
    windows.push(waveformWindow(samples, first, Math.min(samples.length, first + 704)));
  if (!windows.length) windows.push(waveformWindow(samples, 0, samples.length));
  return windows;
}

function difference(source, rendered) {
  let total = 0;
  let count = 0;
  const sourcePeak = Math.max(...source.map(item => item.rms), 1e-6);
  const renderedPeak = Math.max(...rendered.map(item => item.rms), 1e-6);
  for (let i = 0; i < Math.min(source.length, rendered.length); i++) {
    const a = source[i];
    const b = rendered[i];
    if (a.rms < sourcePeak * 0.1) continue;
    const aTotal = a.bands.reduce((sum, value) => sum + value, 0) + 1e-6;
    const bTotal = b.bands.reduce((sum, value) => sum + value, 0) + 1e-6;
    for (let band = 0; band < a.bands.length; band++) {
      const left = Math.log1p(a.bands[band] / aTotal * 100);
      const right = Math.log1p(b.bands[band] / bTotal * 100);
      total += (left - right) ** 2 * (band < 8 ? 1 : 0.45);
    }
    const envelope = Math.log((a.rms / sourcePeak + 0.04) / (b.rms / renderedPeak + 0.04));
    total += 2 * envelope * envelope;
    count++;
  }
  return total / Math.max(count, 1);
}

function renderDifference(samples, reference, options) {
  const result = convert(samples, options);
  const synthesized = readWav(renderPreview(result));
  const prepared = prepareWav(synthesized);
  return { result, score: difference(reference, signature(prepared.samples)) };
}

export function fitForcingPreset(samples, profiles, forcing, onProgress = () => {}) {
  const reference = signature(samples);
  let best = null;
  let tried = 0;
  const total = profiles.length + forcing.search.noiseGainFactors.length + forcing.search.noisePitches.length;
  const tryOptions = (options, basis) => {
    const candidate = renderDifference(samples, reference, options);
    tried++;
    onProgress(tried, total);
    if (!best || candidate.score < best.score) best = { ...candidate, options, basis };
  };
  for (const preset of profiles) tryOptions(preset.options, preset.id);
  const seed = { ...best.options };
  for (const factor of forcing.search.noiseGainFactors)
    tryOptions({ ...seed, noiseGain: Math.min(4, seed.noiseGain * factor) }, best.basis);
  for (const noisePitch of forcing.search.noisePitches)
    tryOptions({ ...seed, noisePitch }, best.basis);
  return best;
}
