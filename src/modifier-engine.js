export const DEFAULT_VOICE_CONTROLS = Object.freeze({
  pitch: 0,
  resonance: 0,
  weight: 0,
  intonation: 0,
});

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

function changeResonance(project, amount) {
  const map = amount < 0 ? [1, 2, 2, 2] : [0, 0, 1, 1];
  const strength = Math.abs(amount);
  const adjusted = duty => clamp(Math.round(duty + (map[duty] - duty) * strength), 0, 3);
  for (const channel of ['ch5', 'ch6']) {
    for (const note of project.channels[channel] ?? []) {
      if (note.duty !== undefined) note.duty = adjusted(note.duty);
      if (note.dutyPattern) note.dutyPattern = note.dutyPattern.map(adjusted);
    }
  }
}

function scaleVolume(note, factor, maximum = 15) {
  if (note.volume) note.volume = clamp(Math.round(note.volume * factor), 1, maximum);
}

function changeWeight(project, amount) {
  const supportFactor = amount >= 0 ? 1 + 0.35 * amount : 1 + 0.45 * amount;
  const noiseFactor = amount >= 0 ? 1 + 0.25 * amount : 1 + 0.55 * amount;
  for (const note of project.channels.ch6 ?? []) scaleVolume(note, supportFactor);
  for (const note of project.channels.ch8 ?? []) scaleVolume(note, noiseFactor);
  // Game Boy wave volume uses 1, 2, and 3 for 100%, 50%, and 25%.
  for (const note of project.channels.ch7 ?? []) {
    if (note.volume) note.volume = clamp(Math.round(note.volume - amount), 1, 3);
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

function controlValue(controls, name) {
  const value = controls?.[name] ?? 0;
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  return clamp(value, -1, 1);
}

export function applyVoiceControls(project, controls = DEFAULT_VOICE_CONTROLS) {
  const result = cloneProject(project);
  const normalized = Object.fromEntries(Object.keys(DEFAULT_VOICE_CONTROLS)
    .map(name => [name, controlValue(controls, name)]));
  if (normalized.pitch) transpose(result, 12 * normalized.pitch);
  if (normalized.resonance) changeResonance(result, normalized.resonance);
  if (normalized.weight) changeWeight(result, normalized.weight);
  if (normalized.intonation) changeContour(result,
    normalized.intonation >= 0 ? 1 + 0.5 * normalized.intonation : 1 + 0.45 * normalized.intonation);
  result.voiceControls = normalized;
  return result;
}
