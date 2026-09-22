import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyConversionEffects, convert, detectConversionVolume, encodeWav, makeAsm, prepareWav, readWav, suggestedLabel } from '../../src/converter.js';
import { applyCryParameters, parseCryAsm } from '../../src/cry-asm.js';
import { fitAutoPreset, suggestPreset } from '../../src/preset-engine.js';
import { applyModifier, MODIFIERS } from '../../src/modifier-engine.js';
import { renderPreview } from '../../src/preview.js';
import { parsePresetDirectories } from '../../windows/preset-schema.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function bundledPresets() {
  const directory = join(ROOT, 'Presets');
  const names = (await readdir(directory)).filter(name => name.endsWith('.json'));
  const files = await Promise.all(names.map(async filename => ({
    filename,
    json: await readFile(join(directory, filename), 'utf8'),
  })));
  return parsePresetDirectories([files, []]);
}

test('Windows uses the shared converter and preview behavior', async () => {
  const presets = await bundledPresets();
  const profiles = presets.filter(preset => preset.type === 'profile');
  const auto = presets.find(preset => preset.type === 'auto');
  assert.equal(presets.length, 15);
  assert.equal(profiles.length, 14);
  assert.ok(auto);
  assert.equal(presets.find(preset => preset.id === 'tremolo')?.options.tracking, 'tremolo');
  assert.equal(presets.find(preset => preset.id === 'long_notes')?.options.tracking, 'sustain');
  assert.equal(presets.find(preset => preset.id === 'bulky')?.options.tracking, 'bulky');
  assert.ok(presets.every(preset => !preset.id.startsWith('bass_') && !preset.id.startsWith('deep_')));
  assert.ok(presets.every(preset => !/^(Bass \(|Deep )/.test(preset.name)));
  assert.deepEqual(MODIFIERS.map(modifier => modifier.name),
    ['None', 'Dark', 'Bright', 'Low', 'High', 'Heavy', 'Light', 'Wide', 'Shallow']);
  assert.equal(presets[0].id, 'auto');
  assert.equal(presets.at(-1).id, 'precise');
  assert.ok(presets.slice(1, -1).every((preset, index, middle) =>
    index === 0 || middle[index - 1].name.localeCompare(preset.name) <= 0));

  const rate = 10512;
  const samples = Float64Array.from({ length: 17 * 176 }, (_, i) => {
    const time = i / rate;
    return 0.34 * Math.sin(2 * Math.PI * 256 * time) +
      0.24 * Math.sin(2 * Math.PI * 372 * time);
  });
  const source = readWav(encodeWav(samples, rate));
  const prepared = prepareWav(source);
  const clean = presets.find(preset => preset.id === 'clean');
  const project = {
    ...convert(readWav(prepared.wav).samples, clean.options),
    label: suggestedLabel('two_tones.wav'),
  };
  assert.equal(project.frames, 17);
  assert.equal(project.channels.ch5.length, 9);
  assert.ok(makeAsm(project, 'two_tones.wav').includes(`Cry_${project.label}_Ch8:`));
  assert.equal(readWav(renderPreview(project)).rate, 44100);
  assert.ok(profiles.some(preset => preset.id === suggestPreset(source.samples).id));
  assert.ok(MODIFIERS.some(modifier => modifier.id === suggestPreset(source.samples).modifierId));

  const low = applyModifier(project, 'low');
  assert.equal(low.modifier, 'low');
  assert.notEqual(low.channels.ch5[0].frequency, project.channels.ch5[0].frequency);

  const fitted = fitAutoPreset(samples.subarray(0, 5 * 176), profiles, auto);
  assert.ok(Number.isFinite(fitted.score));
  assert.ok(profiles.some(preset => preset.id === fitted.basis));
});

test('Windows uses the shared ASM parser and parameter semantics', () => {
  const asm = makeAsm({
    label: 'Test',
    channels: {
      ch5: [{ duration: 1, volume: 10, envelope: 8, frequency: 1600, duty: 2 }],
      ch6: [{ duration: 1, volume: 8, envelope: 8, frequency: 1400, duty: 1 }],
      ch8: [{ duration: 1, volume: 5, envelope: 8, frequency: 75 }],
    },
  });
  const cry = parseCryAsm(asm);
  const changed = applyCryParameters(cry, -100, 512);
  assert.equal(changed.channels.ch5[0].frequency, 1500);
  assert.equal(changed.channels.ch8[0].frequency, 231);
  assert.equal(changed.channels.ch5[0].frames, 4);
  assert.equal(changed.channels.ch8[0].frames, 2);
  assert.equal(readWav(renderPreview(changed)).rate, 44100);
});

test('conversion volume and fades use pokecrystal-compatible note levels', () => {
  const source = {
    label: 'Effects', frames: 8,
    channels: {
      ch5: [{ duration: 7, volume: 8, envelope: 8, frequency: 1600, duty: 2 }],
      ch7: [{ duration: 7, volume: 2, envelope: 1, frequency: 1200 }],
      ch8: [{ duration: 7, volume: 12, envelope: 8, frequency: 75 }],
    },
  };
  const unchanged = applyConversionEffects(source);
  assert.deepEqual(unchanged.channels, source.channels);
  assert.equal(detectConversionVolume(source), 80);
  const loud = applyConversionEffects(source, { volumePercent: 100 });
  assert.equal(loud.channels.ch5[0].volume, 15);
  assert.equal(loud.channels.ch7[0].volume, 1);
  assert.equal(loud.channels.ch8[0].volume, 15);
  const faded = applyConversionEffects(source, { volumePercent: 80, fadeIn: true, fadeOut: true });
  assert.equal(faded.channels.ch5[0].volume, 0);
  assert.equal(faded.channels.ch5.at(-1).volume, 0);
  assert.equal(faded.channels.ch5.reduce((sum, note) => sum + note.duration + 1, 0), 8);
  assert.doesNotThrow(() => parseCryAsm(makeAsm(faded)));
});

test('custom Windows presets override bundled presets by id', async () => {
  const bundled = await bundledPresets();
  const clean = bundled.find(preset => preset.id === 'clean');
  const custom = { ...clean, name: 'My clean preset' };
  const merged = parsePresetDirectories([
    bundled.map((preset, index) => ({ filename: `bundled-${index}.json`, json: JSON.stringify(preset) })),
    [{ filename: 'clean.json', json: JSON.stringify(custom) }],
  ]);
  assert.equal(merged.find(preset => preset.id === 'clean').name, 'My clean preset');
});

test('the Windows surface declares system theming and accessibility hooks', async () => {
  const css = await readFile(join(ROOT, 'windows', 'styles.css'), 'utf8');
  const html = await readFile(join(ROOT, 'windows', 'index.html'), 'utf8');
  assert.match(css, /prefers-color-scheme:\s*dark/);
  assert.match(css, /forced-colors:\s*active/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /Segoe UI Variable/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-label="Main navigation"/);
});

test('the Windows window is revealed after loading if ready-to-show is missed', async () => {
  const main = await readFile(join(ROOT, 'windows', 'main.mjs'), 'utf8');
  assert.match(main, /window\.once\('ready-to-show', revealWindow\)/);
  assert.match(main, /window\.loadFile\(INDEX\)\.then\(\(\) => \{\s*\/\/[^\n]+\n\s*\/\/[^\n]+\n\s*revealWindow\(\)/);
});
