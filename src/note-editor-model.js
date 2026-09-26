const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export const PIANO_LOW = 24;  // C1
export const PIANO_HIGH = 108; // C8

export function editorNotePropertySpecs(channel) {
  const wave = channel === 'ch7';
  const noise = channel === 'ch8';
  return {
    duration: { label: 'Length', min: 0, max: 255 },
    volume: { label: wave ? 'Wave volume' : 'Volume', min: 0, max: wave ? 3 : 15 },
    envelope: { label: wave ? 'Wave sample' : 'Envelope fade', min: wave ? 0 : -7, max: wave ? 9 : 8 },
    frequency: { label: noise ? 'Noise register' : 'Frequency register', min: 0, max: noise ? 255 : 2047 },
    offsetOverride: { label: 'Pitch offset', min: -32768, max: 65535 },
    duty: { label: 'Duty cycle', min: 0, max: 3 },
    sweepPeriod: { label: 'Sweep length', min: 0, max: 15 },
    sweepShift: { label: 'Sweep change', min: -7, max: 8 },
  };
}

export function setMasterVolume(cry, side, value) {
  if (!['left', 'right'].includes(side) || !Number.isInteger(value) || value < 0 || value > 7)
    throw new Error('Master volume needs left and right values from 0 to 7.');
  cry.pan = { left: cry.pan?.left ?? 7, right: cry.pan?.right ?? 7,
    route: cry.pan?.route ?? 'both', [side]: value };
}

export function frequencyToPitch(channel, frequency) {
  if (channel === 'ch8') return clamp(PIANO_LOW + Math.round((255 - frequency) * 60 / 255), PIANO_LOW, PIANO_HIGH);
  const clock = channel === 'ch7' ? 65536 : 131072;
  const hz = clock / Math.max(1, 2048 - frequency);
  return clamp(Math.round(69 + 12 * Math.log2(hz / 440)), PIANO_LOW, PIANO_HIGH);
}

export function pitchToFrequency(channel, pitch) {
  pitch = clamp(Math.round(pitch), PIANO_LOW, PIANO_HIGH);
  if (channel === 'ch8') return clamp(Math.round(255 - (pitch - PIANO_LOW) * 255 / 60), 0, 255);
  const hz = 440 * 2 ** ((pitch - 69) / 12);
  const clock = channel === 'ch7' ? 65536 : 131072;
  return clamp(Math.round(2048 - clock / hz), 0, 2047);
}

export function pitchName(pitch) {
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  return `${names[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}

export function parseDutyPattern(value) {
  const text = String(value).trim();
  if (!text) return null;
  const values = text.split(',').map(item => item.trim());
  if (values.length !== 4 || values.some(item => !/^[0-3]$/.test(item)))
    throw new Error('Duty pattern needs four values from 0 to 3.');
  return values.map(Number);
}

export function isDutyPatternDraft(value) {
  return /^\s*[0-3]?(?:\s*,\s*[0-3]?){0,3}\s*$/.test(String(value));
}

export function setFixedDuty(note, duty) {
  if (!Number.isInteger(duty) || duty < 0 || duty > 3)
    throw new Error('Duty cycle needs a value from 0 to 3.');
  note.duty = duty;
  delete note.dutyPattern;
  delete note.patternId;
  delete note.patternStart;
}

export function setDutyPattern(note, pattern, patternId = note.patternId) {
  if (pattern === null) {
    delete note.dutyPattern;
    delete note.patternId;
    delete note.patternStart;
    return;
  }
  if (!Array.isArray(pattern) || pattern.length !== 4 ||
      pattern.some(item => !Number.isInteger(item) || item < 0 || item > 3))
    throw new Error('Duty pattern needs four values from 0 to 3.');
  note.dutyPattern = [...pattern];
  note.duty = pattern[0];
  delete note.patternStart;
  if (patternId === undefined) delete note.patternId;
  else note.patternId = patternId;
}

export function initializeEditorTimeline(cry, nextId = () => 0) {
  const channels = {};
  for (const [channel, notes] of Object.entries(cry.channels)) {
    let start = 0;
    channels[channel] = [];
    for (const note of notes) {
      if (note.volume) channels[channel].push({
        ...note,
        _editorId: note._editorId ?? nextId(),
        _editorStart: start,
      });
      start += note.duration + 1;
    }
  }
  return { ...cry, channels };
}

function restNote(channel, duration) {
  if (channel === 'ch7') return { duration, volume: 0, envelope: 0, frequency: 0 };
  if (channel === 'ch8') return { duration, volume: 0, envelope: 8, frequency: 0 };
  return { duration, volume: 0, envelope: 8, frequency: 0, duty: 2 };
}

function cleanNote(note) {
  const result = { ...note };
  delete result._editorId;
  delete result._editorStart;
  return result;
}

export function materializeEditorCry(cry) {
  const channels = {};
  for (const [channel, source] of Object.entries(cry.channels)) {
    const notes = [...source].sort((a, b) => (a._editorStart ?? 0) - (b._editorStart ?? 0) || a._editorId - b._editorId);
    const result = [];
    let cursor = 0;
    for (const note of notes) {
      let start = Math.max(cursor, Math.round(note._editorStart ?? cursor));
      let gap = start - cursor;
      while (gap > 0) {
        const frames = Math.min(gap, 256);
        result.push(restNote(channel, frames - 1));
        gap -= frames;
        cursor += frames;
      }
      const cleaned = cleanNote(note);
      cleaned.duration = clamp(Math.round(cleaned.duration), 0, 255);
      result.push(cleaned);
      cursor += cleaned.duration + 1;
    }
    channels[channel] = result;
  }
  return { ...cry, channels };
}

export function editorDuration(cry) {
  return Math.max(1, ...Object.values(cry.channels).map(notes =>
    Math.max(0, ...notes.map(note => (note._editorStart ?? 0) + note.duration + 1))));
}

export function muteEditorChannels(cry, enabledChannels) {
  const enabled = new Set(enabledChannels);
  return { ...cry, channels: Object.fromEntries(Object.entries(cry.channels).map(([channel, notes]) =>
    [channel, enabled.has(channel) ? notes : notes.map(note => ({ ...note, volume: 0 }))])) };
}
