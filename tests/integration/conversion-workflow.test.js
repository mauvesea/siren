import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { applyConversionEffects, convert, encodeWav, makeAsm, makePlaybackWav, prepareWav, readWav } from '../../src/converter.js';
import { parseCryAsm } from '../../src/cry-asm.js';
import { fitAutoPreset, fitPrecisePreset, suggestPreset } from '../../src/preset-engine.js';
import { applyModifier, MODIFIERS } from '../../src/modifier-engine.js';
import { loadPresets } from '../../src/preset-loader.js';
import { renderPreview } from '../../src/preview.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function encodeUnsigned8Wav(samples, rate, channels = 1) {
  const buffer = new ArrayBuffer(44 + samples.length);
  const view = new DataView(buffer);
  const write = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels, true);
  view.setUint16(32, channels, true); view.setUint16(34, 8, true);
  write(36, 'data'); view.setUint32(40, samples.length, true);
  new Uint8Array(buffer, 44).set(samples);
  return buffer;
}

const root = GLib.get_current_dir();
const presets = loadPresets(GLib.build_filenamev([root, 'Presets']));
const profiles = presets.filter(preset => preset.type === 'profile');
const autoPreset = presets.find(preset => preset.type === 'auto');

assert(presets.length === 15, 'Expected all 15 base presets.');
assert(profiles.length === 14, 'Expected 14 fixed conversion profiles.');
assert(presets[0].id === 'auto', 'Auto must be the first preset.');
assert(presets.at(-1).id === 'precise', 'Precise must be the last preset.');
assert(presets.slice(1, -1).every((preset, index, middle) =>
  index === 0 || middle[index - 1].name.localeCompare(preset.name) <= 0),
  'Other presets must be ordered alphabetically by name.');
assert(presets.find(preset => preset.id === 'clean')?.name === 'Clean',
  'The former Default preset must be called Clean.');
assert([
  'airy', 'bright', 'bulky', 'clean', 'hollow', 'long_notes', 'noisy', 'precise',
  'punchy', 'raspy', 'roar', 'textured', 'tremolo', 'vibrato',
].every(id => profiles.some(preset => preset.id === id)), 'Expected the revised profile presets.');
assert(presets.every(preset => !preset.id.startsWith('deep_') && !preset.id.startsWith('bass_')),
  'Prefixed presets must be represented by modifiers instead.');
assert(presets.every(preset => !/^(Bass \(|Deep )/.test(preset.name)),
  'Bundled preset names must not contain baked-in modifiers.');
assert(JSON.stringify(MODIFIERS.map(modifier => modifier.id)) ===
  JSON.stringify(['none', 'dark', 'bright', 'low', 'high', 'heavy', 'light', 'wide', 'shallow']),
  'Modifier choices changed.');
assert(Boolean(autoPreset), 'Expected the Auto preset.');
assert(JSON.stringify(autoPreset.search.noiseGainFactors) === JSON.stringify([0, 0.5, 1.5, 2.5]),
  'Auto noise gain search changed.');
assert(JSON.stringify(autoPreset.search.noisePitches) === JSON.stringify([44, 75, 92]),
  'Auto noise pitch search changed.');

const rate = 10512;
const samples = Float64Array.from({ length: 17 * 176 }, (_, i) => {
  const time = i / rate;
  return 0.34 * Math.sin(2 * Math.PI * 256 * time) +
    0.24 * Math.sin(2 * Math.PI * 372 * time);
});
const source = readWav(encodeWav(samples, rate));
const uncommonSource = readWav(encodeUnsigned8Wav(
  Uint8Array.from({ length: rate }, (_, i) => 128 + Math.round(80 * Math.sin(2 * Math.PI * 220 * i / rate))),
  rate));
const playback = readWav(makePlaybackWav(uncommonSource));
assert(playback.rate === 44100 && playback.samples.length === 44100,
  'Unsigned 8-bit low-rate WAV playback should be normalized to 16-bit 44.1 kHz.');
const stereoSource = readWav(encodeUnsigned8Wav(
  Uint8Array.from({ length: rate * 2 }, (_, i) =>
    128 + Math.round(70 * Math.sin(2 * Math.PI * (i % 2 ? 330 : 220) * Math.floor(i / 2) / rate))),
  rate, 2));
const stereoPlayback = readWav(makePlaybackWav(stereoSource));
assert(stereoPlayback.channels === 2 && stereoPlayback.samples.length === 44100,
  'Playback normalization should preserve the source channel layout.');
const prepared = prepareWav(source);
const cleanPreset = presets.find(preset => preset.id === 'clean');
const project = { ...convert(readWav(prepared.wav).samples, cleanPreset.options), label: 'TwoTones' };
assert(project.frames === 17, 'Conversion frame count changed.');
assert(project.channels.ch5.length === 9, 'Primary channel note count changed.');
assert(project.channels.ch6.length === 9, 'Secondary channel note count changed.');
assert(project.channels.ch8.length === 9, 'Noise channel note count changed.');
assert(makeAsm(project, 'two_tones.wav').includes('Cry_TwoTones_Ch8:'), 'ASM output is incomplete.');
assert(readWav(renderPreview(project)).rate === 44100, 'Preview sample rate changed.');
const louder = applyConversionEffects(project, { volumePercent: 100 });
assert(louder.channels.ch5.every((note, index) => note.volume >= project.channels.ch5[index].volume),
  'Volume boost should not lower pulse notes.');
const faded = applyConversionEffects(project, { fadeIn: true, fadeOut: true });
assert(faded.channels.ch5[0].volume === 0 && faded.channels.ch5.at(-1).volume === 0,
  'Fades should reach silence at both edges.');
assert(faded.channels.ch5.reduce((sum, note) => sum + note.duration + 1, 0) === project.frames,
  'Effects must preserve the cry duration.');
parseCryAsm(makeAsm(faded, 'two_tones.wav'));

const suggestion = suggestPreset(source.samples);
assert(profiles.some(preset => preset.id === suggestion.id),
  'Automatic recommendation should choose an available profile.');
assert(Number.isFinite(suggestion.features.peakHz) && suggestion.features.peakHz > 0,
  'Automatic recommendation should analyze the WAV samples.');
assert(MODIFIERS.some(modifier => modifier.id === suggestion.modifierId),
  'Automatic recommendation should choose an available modifier.');
const tone = hz => Float64Array.from({ length: 17 * 176 },
  (_, i) => 0.5 * Math.sin(2 * Math.PI * hz * i / rate));
assert(suggestPreset(tone(120)).id !== suggestPreset(tone(1400)).id,
  'Automatic recommendation should respond to the WAV spectrum.');

const shortSamples = samples.subarray(0, 5 * 176);
const fitted = fitAutoPreset(shortSamples, profiles, autoPreset, 'low');
assert(Number.isFinite(fitted.score), 'Auto did not produce a finite match score.');
assert(profiles.some(preset => preset.id === fitted.basis), 'Auto chose an unknown profile.');
assert(readWav(renderPreview(fitted.result)).rate === 44100, 'Auto preview is not playable.');
assert(fitted.result.modifier === 'low', 'Auto should apply the selected modifier.');

const regular = convert(tone(440), cleanPreset.options);
const low = applyModifier(regular, 'low');
const high = applyModifier(regular, 'high');
const firstHz = result => 131072 / (2048 - result.channels.ch5.find(note => note.volume).frequency);
assert(Math.abs(firstHz(low) / firstHz(regular) - 0.5) < 0.03,
  'Low should transpose tonal voices down one octave.');
assert(Math.abs(firstHz(high) / firstHz(regular) - 2) < 0.06,
  'High should transpose tonal voices up one octave.');
const dark = applyModifier(regular, 'dark');
const bright = applyModifier(regular, 'bright');
assert(dark.channels.ch5.every(note => note.duty === undefined || note.duty >= 1),
  'Dark should avoid the thinnest pulse resonance.');
assert(bright.channels.ch5.every(note => note.duty === undefined || note.duty <= 1),
  'Bright should favor narrow pulse resonance.');
const heavy = applyModifier(regular, 'heavy');
const light = applyModifier(regular, 'light');
assert(heavy.channels.ch6.reduce((sum, note) => sum + note.volume, 0) >=
  regular.channels.ch6.reduce((sum, note) => sum + note.volume, 0),
  'Heavy should strengthen the supporting pulse layer.');
assert(light.channels.ch6.reduce((sum, note) => sum + note.volume, 0) <=
  regular.channels.ch6.reduce((sum, note) => sum + note.volume, 0),
  'Light should reduce the supporting pulse layer.');
const contour = {
  channels: {
    ch5: [
      { duration: 3, volume: 10, envelope: 8, frequency: 1452, duty: 2 },
      { duration: 3, volume: 10, envelope: 8, frequency: 1750, duty: 2 },
    ], ch6: [], ch7: [], ch8: [],
  },
};
const contourRatio = result => {
  const notes = result.channels.ch5;
  return (131072 / (2048 - notes[1].frequency)) / (131072 / (2048 - notes[0].frequency));
};
assert(contourRatio(applyModifier(contour, 'wide')) > contourRatio(contour),
  'Wide should expand the pitch contour.');
assert(contourRatio(applyModifier(contour, 'shallow')) < contourRatio(contour),
  'Shallow should compress the pitch contour.');
for (const modifier of MODIFIERS)
  parseCryAsm(makeAsm({ ...applyModifier(regular, modifier.id), label: 'Modified' }));

const precise = fitPrecisePreset(shortSamples);
assert(Number.isFinite(precise.score) && readWav(precise.preview).rate === 44100,
  'Precise should choose a playable measured fit.');

const testDirectory = Gio.File.new_for_path(GLib.dir_make_tmp('siren-presets-test-XXXXXX'));
const testFile = testDirectory.get_child('test.json');
const basePreset = {
  schemaVersion: 1, id: 'test', name: 'Test', description: 'Test preset',
  type: 'profile', options: { noisePitch: 75, noiseGain: 1 },
};
const writeTestPreset = preset => testFile.replace_contents(
  new TextEncoder().encode(JSON.stringify(preset)), null, false,
  Gio.FileCreateFlags.REPLACE_DESTINATION, null);
const rejects = (preset, message) => {
  writeTestPreset(preset);
  let rejected = false;
  try { loadPresets(testDirectory.get_path()); } catch (_) { rejected = true; }
  assert(rejected, message);
};
try {
  writeTestPreset(basePreset);
  assert(loadPresets(testDirectory.get_path()).length === 1, 'A valid added preset should load.');
  rejects({ ...basePreset, id: 'x'.repeat(33) }, 'Ids over 32 characters must be rejected.');
  rejects({ ...basePreset, name: 'x'.repeat(33) }, 'Names over 32 characters must be rejected.');
  rejects({ ...basePreset, description: 'x'.repeat(256) }, 'Descriptions over 255 characters must be rejected.');
  rejects({ ...basePreset, type: 'x'.repeat(33) }, 'Types over 32 characters must be rejected.');
  rejects({ ...basePreset, options: { noiseMode: 'x'.repeat(33) } },
    'Noise modes over 32 characters must be rejected.');
  rejects({ ...basePreset, options: { smoothing: 'x'.repeat(17) } },
    'Other string parameters over 16 characters must be rejected.');
  rejects({ ...basePreset, options: { noiseGain: 1e309 } },
    'Nonfinite numeric parameters must be rejected.');
  rejects({ ...basePreset, options: { pitchShift: -25 } },
    'Tracking pitch shifts below two octaves must be rejected.');
  rejects({ ...basePreset, options: { pitchShift: -12 } },
    'Pitch shifts without a tracking engine must be rejected.');
} finally {
  testFile.delete(null);
  testDirectory.delete(null);
}

print('Siren conversion workflow tests passed.');
