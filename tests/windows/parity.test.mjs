import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { convert, encodeWav, makeAsm, prepareWav, readWav, suggestedLabel } from '../../src/converter.js';
import { applyCryParameters, parseCryAsm } from '../../src/cry-asm.js';
import { fitAutoPreset, suggestPreset } from '../../src/preset-engine.js';
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
  assert.equal(presets.length, 19);
  assert.equal(profiles.length, 18);
  assert.ok(auto);

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
