import { FRAME_RATE, encodeWav } from './converter.js';
import { WAVE_SAMPLES } from './wave-samples.js';

// Deterministic, sample-level preview of the two pulse channels and LFSR noise.
// The actual cartridge audio path can color the sound differently.
const OUTPUT_RATE = 44100;
const CPU_CLOCK = 4194304;
const DIVISORS = [8, 16, 32, 48, 64, 80, 96, 112];
const DUTY_PATTERNS = [0x01, 0x81, 0x87, 0x7e];

function timeline(notes) {
  let end = 0;
  return notes.map(note => {
    const start = end;
    end += note.frames ?? note.duration + 1;
    return { note, start, end };
  });
}

function envelopeVolume(note, noteTime) {
  const raw = note.envelope < 0 ? 8 - note.envelope : note.envelope;
  const period = raw & 7;
  if (!period) return note.volume;
  const steps = Math.floor(noteTime * 64 / period);
  return Math.max(0, Math.min(15, note.volume + (raw & 8 ? steps : -steps)));
}

function encodeStereoWav(left, right, rate) {
  const buffer = new ArrayBuffer(44 + left.length * 4);
  const view = new DataView(buffer);
  const write = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 2, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, left.length * 4, true);
  for (let i = 0; i < left.length; i++) {
    view.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), true);
    view.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), true);
  }
  return buffer;
}

export function renderPreview(project, maxSeconds = 10) {
  const outputRate = OUTPUT_RATE;
  const { ch5 = [], ch6 = [], ch7 = [], ch8 = [] } = project.channels;
  const tracks = [timeline(ch5), timeline(ch6), timeline(ch7), timeline(ch8)];
  const totalFrames = Math.max(...tracks.map(track => track.at(-1)?.end ?? 0), 1);
  if (totalFrames / FRAME_RATE > maxSeconds && !project.allowTruncatedPreview)
    throw new Error(`Preview is limited to ${maxSeconds} seconds.`);
  const duration = project.previewDuration ?? project.sourceDuration ?? totalFrames / FRAME_RATE;
  const count = Math.ceil(Math.min(totalFrames / FRAME_RATE, duration, maxSeconds) * outputRate);
  const samples = new Float64Array(count);
  const stereo = Boolean(project.pan) || Object.values(project.channels).some(notes =>
    notes.some(note => note.route && note.route !== 'both'));
  const rightSamples = stereo ? new Float64Array(count) : null;
  const leftGain = project.pan ? (project.pan.left + 1) / 8 : 1;
  const rightGain = project.pan ? (project.pan.right + 1) / 8 : 1;
  const voices = [ch5, ch6].map(() => ({ index: -1, phase: 0, frequency: 0, sweepStep: 0, silent: false }));
  const noise = { index: -1, lfsr: 0x7fff, phase: 0 };
  const wave = { index: -1, phase: 0 };
  const positions = [0, 0, 0, 0];
  let peak = 0, filteredLeft = 0, filteredRight = 0;
  const filterAmount = 0.55;
  for (let i = 0; i < count; i++) {
    const time = i / outputRate;
    const frame = time * FRAME_RATE;
    for (let ch = 0; ch < 4; ch++) while (positions[ch] < tracks[ch].length && frame >= tracks[ch][positions[ch]].end) positions[ch]++;
    let mixedLeft = 0, mixedRight = 0;
    for (let ch = 0; ch < 2; ch++) {
      const current = tracks[ch][positions[ch]];
      if (!current) continue;
      const index = positions[ch];
      if (index !== voices[ch].index) {
        voices[ch].index = index;
        voices[ch].phase = 0;
        voices[ch].frequency = current.note.frequency;
        voices[ch].sweepStep = 0;
        voices[ch].silent = false;
      }
      const note = current.note;
      if (!note.volume) continue;
      if (ch === 0 && note.sweep && note.sweep[1] !== 8) {
        const [period, signedShift] = note.sweep;
        const interval = ((period & 7) || 8) / 128;
        const expected = Math.floor((time - current.start / FRAME_RATE) / interval);
        while (voices[ch].sweepStep < expected && !voices[ch].silent) {
          const delta = voices[ch].frequency >> Math.abs(signedShift);
          voices[ch].frequency += signedShift < 0 ? -delta : delta;
          if (voices[ch].frequency < 0 || voices[ch].frequency > 2047) voices[ch].silent = true;
          voices[ch].sweepStep++;
        }
      }
      if (voices[ch].silent) continue;
      const hz = 131072 / (2048 - voices[ch].frequency);
      voices[ch].phase = (voices[ch].phase + hz / outputRate) % 1;
      const dutyIndex = Math.floor(voices[ch].phase * 8) & 7;
      const duty = note.dutyPattern?.[(Math.floor(frame) - (note.patternStart ?? 0)) & 3] ?? note.duty;
      const bit = (DUTY_PATTERNS[duty] >> (7 - dutyIndex)) & 1;
      const noteTime = (frame - current.start) / FRAME_RATE;
      const value = (bit ? 1 : -1) * envelopeVolume(note, noteTime) / 15 * 0.27;
      const route = note.route ?? project.pan?.route ?? 'both';
      if (route !== 'right' && route !== 'none') mixedLeft += value;
      if (route !== 'left' && route !== 'none') mixedRight += value;
    }
    const waveNote = tracks[2][positions[2]];
    if (waveNote) {
      if (wave.index !== positions[2]) { wave.index = positions[2]; wave.phase = 0; }
      const note = waveNote.note;
      if (note.volume && WAVE_SAMPLES[note.envelope]) {
        const hz = 65536 / (2048 - note.frequency);
        wave.phase = (wave.phase + hz / outputRate) % 1;
        const level = [0, 1, 0.5, 0.25][note.volume];
        const value = ((WAVE_SAMPLES[note.envelope][Math.floor(wave.phase * 32)] - 7.5) / 7.5) * level * 0.27;
        const route = note.route ?? project.pan?.route ?? 'both';
        if (route !== 'right' && route !== 'none') mixedLeft += value;
        if (route !== 'left' && route !== 'none') mixedRight += value;
      }
    }
    const current = tracks[3][positions[3]];
    if (current) {
      const note = current.note;
      const index = positions[3];
      if (index !== noise.index) { noise.index = index; noise.lfsr = 0x7fff; noise.phase = 0; }
      const shift = (note.frequency >> 4) & 15;
      const divisor = DIVISORS[note.frequency & 7];
      const width7 = !!(note.frequency & 8);
      noise.phase += CPU_CLOCK / (divisor * 2 ** shift * outputRate);
      let steps = Math.floor(noise.phase);
      noise.phase -= steps;
      while (steps-- > 0) {
        const feedback = (noise.lfsr ^ (noise.lfsr >> 1)) & 1;
        noise.lfsr = (noise.lfsr >> 1) | (feedback << 14);
        if (width7) noise.lfsr = (noise.lfsr & ~(1 << 6)) | (feedback << 6);
      }
      const noteTime = (frame - current.start) / FRAME_RATE;
      const value = (noise.lfsr & 1 ? -1 : 1) * envelopeVolume(note, noteTime) / 15 * 0.32;
      const route = note.route ?? project.pan?.route ?? 'both';
      if (route !== 'right' && route !== 'none') mixedLeft += value;
      if (route !== 'left' && route !== 'none') mixedRight += value;
    }
    filteredLeft += filterAmount * (mixedLeft - filteredLeft);
    filteredRight += filterAmount * (mixedRight - filteredRight);
    samples[i] = filteredLeft * leftGain;
    if (stereo) rightSamples[i] = filteredRight * rightGain;
    peak = Math.max(peak, Math.abs(samples[i]), stereo ? Math.abs(rightSamples[i]) : 0);
  }
  const gain = peak > 0.93 ? 0.93 / peak : 1;
  if (gain !== 1) for (let i = 0; i < count; i++) {
    samples[i] *= gain;
    if (stereo) rightSamples[i] *= gain;
  }
  return stereo ? encodeStereoWav(samples, rightSamples, outputRate) : encodeWav(samples, outputRate);
}
