import { analyzeWaveform } from './converter.js';

export const MODIFIERS = Object.freeze([
  { id: 'none', name: 'None', description: 'Keeps the preset\'s original tone.' },
  { id: 'dark', name: 'Dark', description: 'Rounds the pulse resonance for a darker voice.' },
  { id: 'bright', name: 'Bright', description: 'Narrows the pulse resonance for a brighter voice.' },
  { id: 'low', name: 'Low', description: 'Moves tonal voices down one octave.' },
  { id: 'high', name: 'High', description: 'Moves tonal voices up one octave.' },
  { id: 'heavy', name: 'Heavy', description: 'Strengthens supporting tonal and noise layers.' },
  { id: 'light', name: 'Light', description: 'Pulls back supporting layers for a lighter voice.' },
  { id: 'wide', name: 'Wide', description: 'Expands the source pitch contour.' },
  { id: 'shallow', name: 'Shallow', description: 'Compresses the source pitch contour.' },
]);

const MODIFIER_IDS = new Set(MODIFIERS.map(modifier => modifier.id));
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function cloneProject(project) {
  return {
    ...project,
    channels: Object.fromEntries(Object.entries(project.channels).map(([channel, notes]) =>
      [channel, notes.map(note => ({
        ...note,
        ...(note.dutyPattern ? { dutyPattern: [...note.dutyPattern] } : {}),
        ...(note.sweep ? { sweep: [...note.sweep] } : {}),
      }))])),
  };
}

function tonalHz(note, channel) {
  if (!note.volume || note.frequency >= 2048) return null;
  return (channel === 'ch7' ? 65536 : 131072) / (2048 - note.frequency);
}

function tonalRegister(hz, channel) {
  const clock = channel === 'ch7' ? 65536 : 131072;
  return clamp(Math.round(2048 - clock / hz), 0, 2047);
}

function transpose(project, semitones) {
  const scale = 2 ** (semitones / 12);
  for (const channel of ['ch5', 'ch6', 'ch7']) {
    for (const note of project.channels[channel] ?? []) {
      const hz = tonalHz(note, channel);
      if (hz !== null) note.frequency = tonalRegister(hz * scale, channel);
    }
  }
}

function changeResonance(project, dark) {
  const map = dark ? [1, 2, 2, 2] : [0, 0, 1, 1];
  for (const channel of ['ch5', 'ch6']) {
    for (const note of project.channels[channel] ?? []) {
      if (note.duty !== undefined) note.duty = map[note.duty];
      if (note.dutyPattern) note.dutyPattern = note.dutyPattern.map(duty => map[duty]);
    }
  }
}

function scaleVolume(note, factor, maximum = 15) {
  if (note.volume) note.volume = clamp(Math.round(note.volume * factor), 1, maximum);
}

function changeWeight(project, heavy) {
  const supportFactor = heavy ? 1.35 : 0.55;
  const noiseFactor = heavy ? 1.25 : 0.45;
  for (const note of project.channels.ch6 ?? []) scaleVolume(note, supportFactor);
  for (const note of project.channels.ch8 ?? []) scaleVolume(note, noiseFactor);
  // Game Boy wave volume uses 1, 2, and 3 for 100%, 50%, and 25%.
  for (const note of project.channels.ch7 ?? []) {
    if (note.volume) note.volume = heavy ? Math.max(1, note.volume - 1) : Math.min(3, note.volume + 1);
  }
}

function weightedMedian(entries) {
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const halfway = sorted.reduce((sum, entry) => sum + entry.weight, 0) / 2;
  let total = 0;
  for (const entry of sorted) {
    total += entry.weight;
    if (total >= halfway) return entry.value;
  }
  return sorted.at(-1)?.value ?? 0;
}

function changeContour(project, amount) {
  for (const channel of ['ch5', 'ch6', 'ch7']) {
    const pitches = [];
    for (const note of project.channels[channel] ?? []) {
      const hz = tonalHz(note, channel);
      if (hz !== null) pitches.push({ value: Math.log(hz), weight: note.frames ?? note.duration + 1 });
    }
    if (!pitches.length) continue;
    const center = weightedMedian(pitches);
    for (const note of project.channels[channel] ?? []) {
      const hz = tonalHz(note, channel);
      if (hz !== null) note.frequency = tonalRegister(Math.exp(center + (Math.log(hz) - center) * amount), channel);
    }
  }
}

export function applyModifier(project, modifierId = 'none') {
  if (!MODIFIER_IDS.has(modifierId)) throw new Error(`Unknown modifier “${modifierId}”.`);
  const result = cloneProject(project);
  if (modifierId === 'dark') changeResonance(result, true);
  if (modifierId === 'bright') changeResonance(result, false);
  if (modifierId === 'low') transpose(result, -12);
  if (modifierId === 'high') transpose(result, 12);
  if (modifierId === 'heavy') changeWeight(result, true);
  if (modifierId === 'light') changeWeight(result, false);
  if (modifierId === 'wide') changeContour(result, 1.5);
  if (modifierId === 'shallow') changeContour(result, 0.55);
  result.modifier = modifierId;
  return result;
}

export function suggestModifier(samples, suppliedFeatures = null) {
  const features = suppliedFeatures ?? analyzeWaveform(samples);
  if (!features.peakHz) return { id: 'none', features };
  const candidates = [
    { id: 'low', score: (260 - features.peakHz) / 100 },
    { id: 'high', score: (features.peakHz - 1050) / 500 },
    { id: 'heavy', score: (features.lowShare - 0.08) / 0.12 },
    { id: 'light', score: (0.004 - features.lowShare) / 0.006 },
    { id: 'dark', score: (0.035 - features.flatness) / 0.04 },
    { id: 'bright', score: (features.flatness - 0.68) / 0.22 },
    { id: 'wide', score: (features.pitchJitter - 0.16) / 0.22 },
    { id: 'shallow', score: (0.008 - features.pitchJitter) / 0.014 },
  ];
  const best = candidates.reduce((winner, candidate) =>
    candidate.score > winner.score ? candidate : winner, { id: 'none', score: 0.5 });
  return { id: best.id, features };
}
