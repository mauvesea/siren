import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { convert, encodeWav, makeAsm, prepareWav, readWav } from '../src/converter.js';
import { fitAutoPreset, suggestPreset } from '../src/preset-engine.js';
import { loadPresets } from '../src/preset-loader.js';
import { renderPreview } from '../src/preview.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = GLib.get_current_dir();
const presets = loadPresets(GLib.build_filenamev([root, 'Presets']));
const profiles = presets.filter(preset => preset.type === 'profile');
const autoPreset = presets.find(preset => preset.type === 'auto');

assert(presets.length === 19, 'Expected all 19 presets.');
assert(profiles.length === 18, 'Expected 18 fixed conversion profiles.');
assert(presets.every((preset, index) => index === 0 || presets[index - 1].id < preset.id),
  'Presets must be ordered alphabetically by id.');
assert(presets.find(preset => preset.id === 'clean')?.name === 'Clean',
  'The former Default preset must be called Clean.');
assert(['airy', 'percussive', 'pure_tone'].every(id => profiles.some(preset => preset.id === id)),
  'Expected the three new profile presets.');
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
const prepared = prepareWav(source);
const cleanPreset = presets.find(preset => preset.id === 'clean');
const project = { ...convert(readWav(prepared.wav).samples, cleanPreset.options), label: 'TwoTones' };
assert(project.frames === 17, 'Conversion frame count changed.');
assert(project.channels.ch5.length === 9, 'Primary channel note count changed.');
assert(project.channels.ch6.length === 9, 'Secondary channel note count changed.');
assert(project.channels.ch8.length === 9, 'Noise channel note count changed.');
assert(makeAsm(project, 'two_tones.wav').includes('Cry_TwoTones_Ch8:'), 'ASM output is incomplete.');
assert(readWav(renderPreview(project)).rate === 44100, 'Preview sample rate changed.');

const suggestion = suggestPreset(source.samples);
assert(profiles.some(preset => preset.id === suggestion.id),
  'Automatic recommendation should choose an available profile.');
assert(Number.isFinite(suggestion.features.peakHz) && suggestion.features.peakHz > 0,
  'Automatic recommendation should analyze the WAV samples.');
const tone = hz => Float64Array.from({ length: 17 * 176 },
  (_, i) => 0.5 * Math.sin(2 * Math.PI * hz * i / rate));
assert(suggestPreset(tone(120)).id !== suggestPreset(tone(1400)).id,
  'Automatic recommendation should respond to the WAV spectrum.');

const shortSamples = samples.subarray(0, 5 * 176);
const fitted = fitAutoPreset(shortSamples, profiles, autoPreset);
assert(Number.isFinite(fitted.score), 'Auto did not produce a finite match score.');
assert(profiles.some(preset => preset.id === fitted.basis), 'Auto chose an unknown profile.');
assert(readWav(renderPreview(fitted.result)).rate === 44100, 'Auto preview is not playable.');

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
} finally {
  testFile.delete(null);
  testDirectory.delete(null);
}

print('Siren core tests passed.');
