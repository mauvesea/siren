import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyConversionEffects, convert, detectConversionVolume, encodeWav, makeAsm, prepareWav, readWav, suggestedLabel } from '../../src/converter.js';
import { applyCryParameters, parseCryAsm } from '../../src/cry-asm.js';
import { fitAutoPreset, suggestPreset } from '../../src/preset-engine.js';
import { renderPreview } from '../../src/preview.js';
import { editorNotePropertySpecs, frequencyToPitch, initializeEditorTimeline, isDutyPatternDraft,
  materializeEditorCry, muteEditorChannels, parseDutyPattern, pitchToFrequency, setDutyPattern, setFixedDuty,
  setMasterVolume } from '../../src/note-editor-model.js';
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
  assert.equal(presets[0].id, 'none');
  assert.equal(presets[1].id, 'auto');
  assert.equal(presets.at(-1).id, 'precise');
  assert.ok(presets.slice(2, -1).every((preset, index, middle) =>
    index === 0 || middle[index - 1].name.localeCompare(preset.name) <= 0));

  const rate = 10512;
  const samples = Float64Array.from({ length: 17 * 176 }, (_, i) => {
    const time = i / rate;
    return 0.34 * Math.sin(2 * Math.PI * 256 * time) +
      0.24 * Math.sin(2 * Math.PI * 372 * time);
  });
  const source = readWav(encodeWav(samples, rate));
  const prepared = prepareWav(source);
  const clean = presets.find(preset => preset.id === 'none');
  const project = {
    ...convert(readWav(prepared.wav).samples, clean.options),
    label: suggestedLabel('two_tones.wav'),
  };
  assert.equal(project.frames, 17);
  assert.equal(project.channels.ch5.length, 9);
  assert.ok(makeAsm(project, 'two_tones.wav').includes(`Cry_${project.label}_Ch7:`));
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
  assert.equal(loud.channels.ch5[0].volume, 10);
  assert.equal(loud.channels.ch7[0].volume, 2);
  assert.equal(loud.channels.ch8[0].volume, 15);
  const faded = applyConversionEffects(source, { volumePercent: 80, fadeIn: true, fadeOut: true });
  assert.equal(faded.channels.ch5[0].volume, 0);
  assert.equal(faded.channels.ch5.at(-1).volume, 0);
  assert.equal(faded.channels.ch5.reduce((sum, note) => sum + note.duration + 1, 0), 8);
  assert.doesNotThrow(() => parseCryAsm(makeAsm(faded)));
});

test('custom Windows presets override bundled presets by id', async () => {
  const bundled = await bundledPresets();
  const clean = bundled.find(preset => preset.id === 'none');
  const custom = { ...clean, name: 'My clean effect' };
  const merged = parsePresetDirectories([
    bundled.map((preset, index) => ({ filename: `bundled-${index}.json`, json: JSON.stringify(preset) })),
    [{ filename: 'none.json', json: JSON.stringify(custom) }],
  ]);
  assert.equal(merged.find(preset => preset.id === 'none').name, 'My clean effect');
});

test('effects use four channels and modifiers can tune or disable them', async () => {
  const presets = await bundledPresets();
  const none = presets.find(preset => preset.id === 'none');
  const samples = Float64Array.from({ length: 20 * 176 }, (_, i) =>
    0.4 * Math.sin(2 * Math.PI * 330 * i / 10512));
  const project = convert(samples, none.options);
  assert.deepEqual(Object.keys(project.channels), ['ch5', 'ch6', 'ch7', 'ch8']);
  assert.ok(project.channels.ch7.some(note => note.volume));
  const tuned = applyConversionEffects(project, {
    pitch: 30, resonance: 20, weight: -15, intonation: 60, texture: 25, breathiness: -20,
    enabledChannels: ['ch5', 'ch7'],
  });
  assert.equal(tuned.channels.ch6.length, 0);
  assert.equal(tuned.channels.ch8.length, 0);
  assert.notEqual(tuned.channels.ch5[0].frequency, project.channels.ch5[0].frequency);
});

test('editor note commands survive an ASM serialization round trip', () => {
  const project = { label: 'Editor', precise: true, channels: {
    ch5: [{ duration: 2, volume: 10, envelope: 8, frequency: 1500, duty: 2,
      dutyPattern: [0, 1, 2, 3], offsetOverride: -12, sweep: [3, -2], route: 'left' }],
    ch6: [], ch7: [], ch8: [],
  } };
  const parsed = parseCryAsm(makeAsm(project));
  assert.deepEqual(parsed.channels.ch5[0].dutyPattern, [0, 1, 2, 3]);
  assert.deepEqual(parsed.channels.ch5[0].sweep, [3, -2]);
  assert.equal(parsed.channels.ch5[0].offsetOverride, -12);
  assert.equal(parsed.channels.ch5[0].route, 'left');
});

test('Studio duty controls switch cleanly between fixed duty and a four-frame pattern', () => {
  const note = { duty: 2, dutyPattern: [0, 1, 2, 3], patternId: 4 };
  setFixedDuty(note, 3);
  assert.deepEqual(note, { duty: 3 });

  const pattern = parseDutyPattern('1, 2, 0, 3');
  setDutyPattern(note, pattern, 5);
  assert.equal(note.duty, 1);
  assert.deepEqual(note.dutyPattern, [1, 2, 0, 3]);
  assert.equal(note.patternId, 5);
  setDutyPattern(note, parseDutyPattern(''));
  assert.deepEqual(note, { duty: 1 });
  assert.throws(() => parseDutyPattern('0, 1, 2'), /four values from 0 to 3/);
  assert.throws(() => parseDutyPattern('0, 1, , 3'), /four values from 0 to 3/);
  assert.throws(() => parseDutyPattern('0, 1, 2, 4'), /four values from 0 to 3/);
  assert.equal(isDutyPatternDraft('0, 0, 0, 0'), true);
  assert.equal(isDutyPatternDraft('0, 0, 0, 0, 0'), false);
  assert.equal(isDutyPatternDraft('0, 0, 4, 0'), false);
  assert.equal(isDutyPatternDraft('0, 00, 0, 0'), false);

  const asm = makeAsm({ label: 'Patterns', precise: true, channels: {
    ch5: [
      { duration: 0, volume: 10, envelope: 8, frequency: 1500, duty: 1,
        dutyPattern: [1, 2, 0, 3], patternId: 1 },
      { duration: 0, volume: 10, envelope: 8, frequency: 1500, duty: 1,
        dutyPattern: [1, 2, 0, 3], patternId: 2 },
    ], ch6: [], ch7: [], ch8: [],
  } });
  assert.equal(asm.match(/duty_cycle_pattern/g)?.length, 2,
    'A repeated pattern command must retain its phase restart.');
});

test('Studio exposes the command ranges and master volume used by pokecrystal cries', () => {
  assert.deepEqual(editorNotePropertySpecs('ch5').duration, { label: 'Length', min: 0, max: 255 });
  assert.deepEqual(editorNotePropertySpecs('ch7').volume, { label: 'Wave volume', min: 0, max: 3 });
  assert.deepEqual(editorNotePropertySpecs('ch7').envelope, { label: 'Wave sample', min: 0, max: 9 });
  assert.deepEqual(editorNotePropertySpecs('ch8').frequency, { label: 'Noise register', min: 0, max: 255 });

  const project = { label: 'Master', channels: { ch5: [], ch6: [], ch7: [],
    ch8: [{ duration: 0, volume: 8, envelope: 8, frequency: 75 }] } };
  setMasterVolume(project, 'left', 3);
  setMasterVolume(project, 'right', 5);
  const asm = makeAsm(project);
  assert.match(asm, /volume 3, 5/);
  assert.deepEqual(parseCryAsm(asm).pan, { left: 3, right: 5, route: 'both' });
  assert.throws(() => setMasterVolume(project, 'left', 8), /values from 0 to 7/);
});

test('piano-roll pitches round-trip and timeline gaps become rests', () => {
  for (const channel of ['ch5', 'ch6', 'ch7']) {
    const register = pitchToFrequency(channel, 69);
    assert.ok(Math.abs(frequencyToPitch(channel, register) - 69) <= 1);
  }
  let id = 0;
  const cry = initializeEditorTimeline({ label: 'Roll', channels: {
    ch5: [{ duration: 1, volume: 10, envelope: 8, frequency: 1600, duty: 2 }], ch6: [], ch7: [], ch8: [],
  } }, () => ++id);
  cry.channels.ch5[0]._editorStart = 5;
  const materialized = materializeEditorCry(cry);
  assert.equal(materialized.channels.ch5[0].volume, 0);
  assert.equal(materialized.channels.ch5[0].duration, 4);
  assert.equal(materialized.channels.ch5[1].frequency, 1600);
  assert.equal(materialized.channels.ch5[1]._editorStart, undefined);

  const withRest = initializeEditorTimeline({ label: 'Rest', channels: {
    ch5: [
      { duration: 2, volume: 0, envelope: 8, frequency: 0, duty: 2 },
      { duration: 1, volume: 10, envelope: 8, frequency: 1500, duty: 2 },
    ], ch6: [], ch7: [], ch8: [],
  } }, () => ++id);
  assert.equal(withRest.channels.ch5.length, 1);
  assert.equal(withRest.channels.ch5[0]._editorStart, 3);
  assert.equal(materializeEditorCry(withRest).channels.ch5[0].duration, 2);
});

test('editor channel switches mute preview notes without changing their timing', () => {
  const cry = { channels: {
    ch5: [{ duration: 3, volume: 12, frequency: 1600 }],
    ch6: [{ duration: 7, volume: 9, frequency: 1500 }], ch7: [], ch8: [],
  } };
  const preview = muteEditorChannels(cry, ['ch5']);
  assert.equal(preview.channels.ch5[0].volume, 12);
  assert.equal(preview.channels.ch6[0].volume, 0);
  assert.equal(preview.channels.ch6[0].duration, 7);
  assert.equal(cry.channels.ch6[0].volume, 9);
});

test('ASM headers preserve Siren conversion settings', () => {
  const asm = makeAsm({
    label: 'Metadata', enabledChannels: ['ch5'], channels: {
      ch5: [{ duration: 0, volume: 10, envelope: 8, frequency: 1600, duty: 2 }],
      ch6: [], ch7: [], ch8: [],
    },
    conversionMetadata: {
      effect: 'Deep', volume: 72, fadeIn: true, fadeOut: false, channels: [1, 3],
      pitch: 4, resonance: -5, weight: 6, intonation: 7, texture: -8, breathiness: 9,
    },
  }, 'voice.wav');
  for (const line of [
    '; Generated by Siren 2.0.0', '; Effect: Deep', '; Volume: 72%', '; Fade In: Yes',
    '; Fade Out: No', '; Channels: 1, 3', '; Pitch Level: 4', '; Resonance Level: -5',
    '; Weight Level: 6', '; Intonation Level: 7', '; Texture Level: -8', '; Breathiness Level: 9',
  ]) assert.ok(asm.includes(line), `Missing header line: ${line}`);
});

test('Linux editor exposes bounded history and tool shortcuts without a note context menu', async () => {
  const main = await readFile(join(ROOT, 'src', 'main.js'), 'utf8');
  assert.match(main, /editorHistory\.length > 101/);
  assert.match(main, /Gdk\.KEY_z/);
  assert.match(main, /Gdk\.KEY_x/);
  assert.match(main, /Gdk\.KEY_Delete/);
  assert.match(main, /Gdk\.KEY_Left/);
  assert.match(main, /Gdk\.KEY_c/);
  assert.match(main, /Gdk\.KEY_v/);
  assert.match(main, /navigateEditorNote/);
  assert.match(main, /finishEditorPlayback/);
  assert.match(main, /editorDrawLength = 1/);
  assert.match(main, /duration: this\.editorDrawLength - 1/);
  assert.match(main, /cycleEditorTool\(\)/);
  assert.match(main, /const tools = \['move', 'draw'\]/);
  assert.doesNotMatch(main, /editorToolButtons\.erase|editorTool === 'erase'/);
  assert.match(main, /new Adw\.ShortcutsDialog\(\)/);
  assert.match(main, /Gtk\.IconPaintable\.new_for_file\(shortcutsIcon/);
  assert.match(main, /hicolor\/symbolic\/actions\/questionmark-symbolic\.svg/);
  assert.match(main, /new Gtk\.DropDown\(\{ width_request: 210/);
  assert.doesNotMatch(main, /editorCryChoice = new Adw\.ComboRow/);
  assert.match(main, /Cut selected notes', '<Primary>x'/);
  assert.match(main, /Gdk\.KEY_KP_Add/);
  assert.match(main, /this\.editorLengthSpin\.set_value\(256\)/);
  assert.match(main, /label: 'Duty pattern'/);
  assert.match(main, /new Gtk\.SizeGroup\(\{ mode: Gtk\.SizeGroupMode\.HORIZONTAL \}\)/);
  assert.match(main, /isDutyPatternDraft\(entry\.text\)/);
  assert.match(main, /max_width_chars: 7, max_length: 10/);
  assert.match(main, /label: 'Stereo route'/);
  assert.match(main, /label: 'Master volume'/);
  assert.match(main, /editorNotePropertySpecs/);
  assert.match(main, /parseDutyPattern\(rawValue\)/);
  assert.match(main, /setFixedDuty\(note, value\)/);
  assert.doesNotMatch(main, /showEditorTypeMenu/);
  assert.match(main, /if \(!backup\.query_exists\(null\)\) file\.copy/);
  assert.match(main, /Saved \$\{this\.editorFile\.get_basename\(\)\} and \$\{wavFile\.get_basename\(\)\}/);
  assert.doesNotMatch(main, /editorHintLabel/);
  const windows = await readFile(join(ROOT, 'windows', 'renderer.js'), 'utf8');
  assert.match(windows, /editorDrawLength: 1/);
  assert.match(windows, /duration: state\.editorDrawLength - 1/);
  assert.match(windows, /\$\('#editor-length'\)\.value = '256'/);
});

test('Windows Studio matches the piano-roll workflow and hides completed open surfaces', async () => {
  const packageDocument = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const html = await readFile(join(ROOT, 'windows', 'index.html'), 'utf8');
  const css = await readFile(join(ROOT, 'windows', 'styles.css'), 'utf8');
  const studio = await readFile(join(ROOT, 'windows', 'studio.js'), 'utf8');
  const windowsMain = await readFile(join(ROOT, 'windows', 'main.mjs'), 'utf8');
  const preload = await readFile(join(ROOT, 'windows', 'preload.cjs'), 'utf8');

  for (const removed of [
    'Pokémon cry studio',
    'Shape a WAV recording',
    'Open the full cry list',
    'Select data/pokemon/cries.asm. Siren will load',
    'Edit pokecrystal cry commands',
    'Arrange notes on a four-channel timeline',
  ]) assert.doesNotMatch(html, new RegExp(removed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(html.indexOf('id="validation-open-header"') < html.indexOf('id="validation-save"'));
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(html, /id="piano-keyboard"/);
  assert.match(html, /id="velocity-lane"/);
  assert.match(html, /id="editor-move-tool"/);
  assert.match(html, /id="editor-draw-tool"/);
  assert.match(html, /id="editor-undo"/);
  assert.match(html, /id="editor-redo"/);
  assert.match(studio, /initializeEditorTimeline/);
  assert.match(studio, /materializeEditorCry/);
  assert.match(studio, /muteEditorChannels/);
  assert.match(studio, /this\.history\.length > 101/);
  assert.match(studio, /mode: 'select'/);
  assert.match(studio, /mode: point\.x .* 'resize' : 'move'/);
  assert.match(studio, /pitchToFrequency\(original\.channel/);
  assert.match(studio, /this\.zoom\(event\.deltaY < 0 \? 1 : -1/);
  assert.match(html, /id="note-pattern-row">Duty pattern/);
  assert.match(html, /id="editor-master-volume"/);
  assert.match(html, /data-note-label="envelope">Envelope fade/);
  assert.match(studio, /editorNotePropertySpecs/);
  assert.match(studio, /setMasterVolume/);
  assert.match(studio, /parseDutyPattern\(rawValue\)/);
  assert.match(studio, /setFixedDuty\(note, value\)/);
  assert.match(studio, /window\.siren\.saveStudio/);
  assert.match(windowsMain, /function readStudioAsm/);
  assert.match(windowsMain, /file:save-studio/);
  assert.match(preload, /saveStudio/);
  assert.ok(packageDocument.build.files.includes('src/note-editor-model.js'),
    'The packaged Studio must include its shared piano-roll model.');
});

test('Editor edits the project cry list and snapshots it when opened', async () => {
  const linux = await readFile(join(ROOT, 'src', 'main.js'), 'utf8');
  const renderer = await readFile(join(ROOT, 'windows', 'renderer.js'), 'utf8');
  const windowsMain = await readFile(join(ROOT, 'windows', 'main.mjs'), 'utf8');
  const preload = await readFile(join(ROOT, 'windows', 'preload.cjs'), 'utf8');
  const html = await readFile(join(ROOT, 'windows', 'index.html'), 'utf8');
  assert.match(linux, /data\/pokemon\/cries\.asm/);
  assert.match(linux, /constants\/cry_constants\.asm/);
  assert.match(linux, /audio\/cry_pointers\.asm/);
  assert.match(linux, /loadCryDefinitionSources\(projectRoot, pointers\)/);
  assert.match(linux, /pitch\.set_value\(entry\.pitch\)/);
  assert.match(linux, /length\.set_value\(entry\.length\)/);
  assert.match(linux, /Gtk\.SizeGroup/);
  assert.match(linux, /label: 'Editor'/);
  assert.doesNotMatch(linux, /Pitch \(decimal\)|Length \(decimal\)|No cry open/);
  assert.match(linux, /new Gtk\.GestureClick\(\{ button: 2 \}\)/);
  assert.match(linux, /systemInterfaceSettings\(\)/);
  assert.match(linux, /Gio\.FileCopyFlags\.OVERWRITE/);
  assert.match(linux, /renderCryList\(this\.validationDocument/);
  assert.match(renderer, /function renderCryListRows\(\)/);
  assert.match(renderer, /playCryListRow/);
  assert.match(renderer, /window\.siren\.saveCryList/);
  assert.match(windowsMain, /const backup = `\$\{resolved\}\.backup`/);
  assert.match(windowsMain, /pointersBytes/);
  assert.match(renderer, /event\.button !== 1/);
  assert.match(windowsMain, /file:save-cry-list/);
  assert.match(preload, /saveCryList/);
  assert.match(html, /id="cry-list-rows"/);
  assert.match(html, />Pitch</);
  assert.match(html, />Cry Constant</);
  assert.doesNotMatch(html, /Parameter validation|Fine-tune the converted voice|Sound check/);
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
  assert.match(html, /id="editor-page"/);
  assert.match(html, /Export \.wav/);
  assert.match(html, /data-modifier="texture"/);
});

test('the Windows release does not expose a New Window command', async () => {
  const html = await readFile(join(ROOT, 'windows', 'index.html'), 'utf8');
  const renderer = await readFile(join(ROOT, 'windows', 'renderer.js'), 'utf8');
  const main = await readFile(join(ROOT, 'windows', 'main.mjs'), 'utf8');
  const preload = await readFile(join(ROOT, 'windows', 'preload.cjs'), 'utf8');
  assert.doesNotMatch(html, /new-window-button|New window/i);
  assert.doesNotMatch(renderer, /newWindow|key\.toLowerCase\(\) === 'n'/);
  assert.doesNotMatch(main, /app:new-window/);
  assert.doesNotMatch(preload, /newWindow|app:new-window/);
});

test('the Windows window is revealed after loading if ready-to-show is missed', async () => {
  const main = await readFile(join(ROOT, 'windows', 'main.mjs'), 'utf8');
  assert.match(main, /window\.once\('ready-to-show', revealWindow\)/);
  assert.match(main, /window\.loadFile\(INDEX\)\.then\(\(\) => \{\s*\/\/[^\n]+\n\s*\/\/[^\n]+\n\s*revealWindow\(\)/);
});
