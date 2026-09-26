import { analyzeWaveform, convert, prepareWav, readWav, waveformWindow } from './converter.js';
import { renderPreview } from './preview.js';
import { scorePrecisePreview } from './quality.js';

export function suggestPreset(samples) {
  const features = analyzeWaveform(samples);
  let id = 'none';
  if (features.peakHz < 220 && features.flatness > 0.18) id = 'fry';
  else if (features.peakHz < 300 || features.lowShare > 0.05) id = 'deep';
  else if (features.flatness > 0.65) id = 'breathy';
  else if (features.pitchJitter > 0.18) id = 'vibrato';
  else if (features.peakHz > 1100) id = 'falsetto';
  return { id, features };
}

export function suggestModifiers(samples) {
  const features = analyzeWaveform(samples);
  return {
    pitch: features.peakHz < 150 ? 8 : features.peakHz > 1100 ? -8 : 0,
    resonance: Math.max(-35, Math.min(35, Math.round((0.22 - features.flatness) * 100))),
    weight: Math.max(-30, Math.min(30, Math.round((300 - features.peakHz) / 12))),
    intonation: Math.max(0, Math.min(70, Math.round((0.2 - features.pitchJitter) * 180))),
    texture: Math.max(-60, Math.min(70, Math.round((features.flatness - 0.25) * 140))),
    breathiness: Math.max(-70, Math.min(70, Math.round((0.18 - features.flatness) * 180))),
  };
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

// Batch scoring keeps the source signature shared between candidates. This is
// used by the offline generation trainer and is intentionally the same metric
// Auto uses, so learned effects optimize what the application will audition.
export function scoreProfilePresets(samples, candidates) {
  if (!Array.isArray(candidates) || !candidates.length)
    throw new Error('Profile scoring needs at least one candidate.');
  const reference = signature(samples);
  return candidates.map(candidate => ({
    id: candidate.id,
    ...renderDifference(samples, reference, candidate.options ?? candidate),
  }));
}

const PRECISE_CANDIDATES = [
  { strategy: 'focused', tuning: { waveMode: 'shared' } },
  { strategy: 'layered', tuning: {
    waveMode: 'independent', waveExclusionBins: 12, waveHighBias: 0,
    waveMinHz: 70, primaryMinHz: 120, secondStability: 0.12,
    waveFitThreshold: 0.65, noiseStrength: 1.5, noisePitch: 100,
  } },
];

export function fitPrecisePreset(samples, stereoBalance = null, onProgress = () => {}) {
  let best = null;
  for (const [index, candidate] of PRECISE_CANDIDATES.entries()) {
    const result = convert(samples, {
      precise: true, stereoBalance, preciseTuning: candidate.tuning,
    });
    const preview = renderPreview(result);
    const quality = scorePrecisePreview(samples, preview);
    if (!best || quality.score < best.score)
      best = { result, preview, score: quality.score, strategy: candidate.strategy };
    onProgress(index + 1, PRECISE_CANDIDATES.length);
  }
  return { ...best, modifiers: suggestModifiers(samples) };
}

export function fitAutoPreset(samples, profiles, autoPreset, onProgress = () => {}) {
  const reference = signature(samples);
  let best = null;
  let tried = 0;
  const total = profiles.length + autoPreset.search.noiseGainFactors.length + autoPreset.search.noisePitches.length;
  const tryOptions = (options, basis) => {
    let candidate;
    if (options.precise) {
      const fitted = fitPrecisePreset(samples);
      candidate = { result: fitted.result,
        score: difference(reference, signature(prepareWav(readWav(fitted.preview)).samples)) };
    } else candidate = renderDifference(samples, reference, options);
    tried++;
    onProgress(tried, total);
    if (!best || candidate.score < best.score) best = { ...candidate, options, basis };
  };
  for (const preset of profiles) tryOptions(preset.options, preset.id);
  if (best.options.precise) { onProgress(total, total); return { ...best, modifiers: suggestModifiers(samples) }; }
  const seed = { ...best.options };
  for (const factor of autoPreset.search.noiseGainFactors)
    tryOptions({ ...seed, noiseGain: Math.min(4, (seed.noiseGain ?? 1) * factor) }, best.basis);
  for (const noisePitch of autoPreset.search.noisePitches)
    tryOptions({ ...seed, noisePitch }, best.basis);
  return { ...best, modifiers: suggestModifiers(samples) };
}
