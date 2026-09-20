import { FRAME_RATE, encodeWav } from './converter.js';

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
    end += note.duration + 1;
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

export function renderPreview(project) {
  const outputRate = OUTPUT_RATE;
  const { ch5, ch6, ch8 } = project.channels;
  const tracks = [timeline(ch5), timeline(ch6), timeline(ch8)];
  const totalFrames = Math.max(...tracks.map(track => track.at(-1)?.end ?? 0), 1);
  if (totalFrames / FRAME_RATE > 10) throw new Error('Preview is limited to 10 seconds. Shorten edited note lengths to play it.');
  const duration = project.previewDuration ?? project.sourceDuration ?? totalFrames / FRAME_RATE;
  const count = Math.ceil(Math.min(totalFrames / FRAME_RATE, duration) * outputRate);
  const samples = new Float64Array(count);
  const voices = [ch5, ch6].map(() => ({ index: -1, phase: 0 }));
  const noise = { index: -1, lfsr: 0x7fff, phase: 0 };
  const positions = [0, 0, 0];
  let peak = 0, filtered = 0;
  const filterAmount = 0.55;
  for (let i = 0; i < count; i++) {
    const time = i / outputRate;
    const frame = time * FRAME_RATE;
    for (let ch = 0; ch < 3; ch++) while (positions[ch] < tracks[ch].length && frame >= tracks[ch][positions[ch]].end) positions[ch]++;
    let mixed = 0;
    for (let ch = 0; ch < 2; ch++) {
      const current = tracks[ch][positions[ch]];
      if (!current) continue;
      const index = positions[ch];
      if (index !== voices[ch].index) { voices[ch].index = index; voices[ch].phase = 0; }
      const note = current.note;
      if (!note.volume) continue;
      const hz = 131072 / (2048 - note.frequency);
      voices[ch].phase = (voices[ch].phase + hz / outputRate) % 1;
      const dutyIndex = Math.floor(voices[ch].phase * 8) & 7;
      const bit = (DUTY_PATTERNS[note.duty] >> (7 - dutyIndex)) & 1;
      const noteTime = (frame - current.start) / FRAME_RATE;
      mixed += (bit ? 1 : -1) * envelopeVolume(note, noteTime) / 15 * 0.27;
    }
    const current = tracks[2][positions[2]];
    if (current) {
      const note = current.note;
      const index = positions[2];
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
      mixed += (noise.lfsr & 1 ? -1 : 1) * envelopeVolume(note, noteTime) / 15 * 0.32;
    }
    filtered += filterAmount * (mixed - filtered);
    samples[i] = filtered;
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  const gain = peak > 0.93 ? 0.93 / peak : 1;
  if (gain !== 1) for (let i = 0; i < count; i++) samples[i] *= gain;
  return encodeWav(samples, outputRate);
}
