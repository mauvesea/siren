import {
  applyConversionEffects, detectConversionVolume, FRAME_RATE, MAX_SECONDS, makeAsm, prepareWav, readWav, suggestedLabel, convert,
} from '../src/converter.js';
import { applyCryParameters, parseCryAsm, PITCH_MIN, PITCH_MAX, LENGTH_MIN, LENGTH_MAX } from '../src/cry-asm.js';
import { parseCryConstants, parseCryList, parseCryPointers, renderCryList,
  resolveCryDefinitionSources } from '../src/cry-list.js';
import { fitAutoPreset, fitPrecisePreset } from '../src/preset-engine.js';
import { renderPreview } from '../src/preview.js';
import { parsePresetDirectories } from './preset-schema.js';
import { StudioController } from './studio.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const decoder = new TextDecoder('utf-8', { fatal: true });
const state = {
  presets: [],
  profiles: [],
  sourcePath: null,
  sourceName: null,
  preparedSamples: null,
  project: null,
  baseProject: null,
  currentEffectName: 'None',
  validationPath: null,
  validationDocument: null,
  validationConstants: [],
  validationDefinitions: new Map(),
  validationActiveButton: null,
  conversionSerial: 0,
  ignorePresetChange: false,
  effectTimer: 0,
  convertedWav: null,
  editor: null,
  editorCries: new Map(),
  editorPath: null,
  editorSource: null,
  editorSelection: new Set(),
  editorClipboard: [],
  editorDrawLength: 1,
  editorRenderTimer: 0,
  editorFrameWidth: 12,
  editorRowHeight: 18,
  editorTool: 'move',
  editorDrag: null,
  editorHistory: [],
  editorHistoryIndex: -1,
  editorRestoringHistory: false,
  editorPreviewDuration: 0,
  editorPlayheadFraction: 0,
};

function bytesToArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function formatDuration(seconds) {
  return `${seconds.toFixed(seconds < 1 ? 2 : 1)} seconds`;
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  $('#toast-region').append(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

class AudioPlayer {
  constructor(audio, button) {
    this.audio = audio;
    this.button = button;
    this.objectUrl = null;
    this.button.addEventListener('click', () => this.toggle());
    this.audio.addEventListener('play', () => {
      for (const player of players) if (player !== this) player.stop();
      this.update();
    });
    for (const event of ['pause', 'ended']) this.audio.addEventListener(event, () => this.update());
    this.audio.addEventListener('error', () => {
      this.stop();
      showToast('Could not play audio.');
    });
  }

  get playing() { return !this.audio.paused && !this.audio.ended; }

  setBuffer(buffer, mime = 'audio/wav') {
    this.stop();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(new Blob([buffer], { type: mime }));
    this.audio.src = this.objectUrl;
    this.button.disabled = false;
    this.update();
  }

  clear() {
    this.stop();
    this.audio.removeAttribute('src');
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.button.disabled = true;
    this.update();
  }

  async toggle() {
    if (this.playing) this.stop();
    else {
      try { await this.audio.play(); }
      catch (error) { showToast(`Could not play audio: ${error.message}`); }
    }
  }

  async play() {
    try { await this.audio.play(); }
    catch (error) { showToast(`Could not play audio: ${error.message}`); }
  }

  stop() {
    this.audio.pause();
    this.audio.currentTime = 0;
    this.update();
  }

  update() {
    const playing = this.playing;
    this.button.querySelector('.fluent-icon').textContent = playing ? '\uE769' : '\uE768';
    const subject = this.button.id === 'original-play' ? 'original WAV' :
      this.button.id === 'converted-play' ? 'converted cry' :
      this.button.id === 'editor-play' ? 'edited cry' : 'cry preview';
    this.button.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${subject}`);
  }
}

const originalPlayer = new AudioPlayer($('#original-audio'), $('#original-play'));
const convertedPlayer = new AudioPlayer($('#converted-audio'), $('#converted-play'));
const validationPlayer = new AudioPlayer($('#validation-audio'), $('#validation-play'));
const editorPlayer = new AudioPlayer($('#editor-audio'), $('#editor-play'));
const players = [originalPlayer, convertedPlayer, validationPlayer, editorPlayer];
const studio = new StudioController(editorPlayer, showToast);

function stopAll() { for (const player of players) player.stop(); }

function setPage(name) {
  stopAll();
  $$('.page').forEach(page => {
    const active = page.id === `${name}-page`;
    page.hidden = !active;
    page.classList.toggle('active', active);
  });
  $$('.nav-item[data-page]').forEach(button => {
    const active = button.dataset.page === name;
    button.classList.toggle('selected', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('#main-content').scrollTop = 0;
}

function setConversionBusy(busy, message = '') {
  $('#conversion-progress').hidden = !busy;
  $('#preset-select').disabled = busy;
  $('#volume-input').disabled = busy;
  $('#fade-in-button').disabled = busy;
  $('#fade-out-button').disabled = busy;
  $$('[data-conversion-channel], [data-modifier]').forEach(control => { control.disabled = busy; });
  $('#export-button').disabled = busy || !state.project;
  $('#export-wav-button').disabled = busy || !state.project;
  $('#converted-play').disabled = busy || !convertedPlayer.objectUrl;
  if (message) $('#converted-detail').textContent = message;
}

async function chooseFile(kind) {
  try {
    const file = await window.siren.openFile(kind);
    if (file) await loadOpenedFile(file, kind);
  } catch (error) { showToast(error.message); }
}

async function loadPath(filePath) {
  const kind = /\.asm$/i.test(filePath) ? ($('#editor-page').hidden ? 'cry-list' : 'asm') : 'wav';
  try {
    const file = await window.siren.readFile(filePath, kind);
    await loadOpenedFile(file, kind);
  } catch (error) { showToast(error.message); }
}

async function loadOpenedFile(file, kind) {
  if (kind === 'asm' || kind === 'cry-list') {
    if (kind === 'asm' && !$('#editor-page').hidden) studio.load(file);
    else { loadCryList(file); setPage('validation'); }
  } else {
    loadWav(file);
    setPage('converter');
  }
}

function loadWav(file) {
  try {
    const buffer = bytesToArrayBuffer(file.bytes);
    const source = readWav(buffer);
    if (source.duration > MAX_SECONDS + 0.0005)
      throw new Error(`Choose a WAV no longer than ${MAX_SECONDS} seconds.`);
    const prepared = prepareWav(source, 0, source.duration);
    state.sourcePath = file.path;
    state.sourceName = file.name;
    state.preparedSamples = readWav(prepared.wav).samples;
    state.stereoBalance = prepared.stereoBalance;
    state.project = null;
    state.baseProject = null;
    convertedPlayer.clear();
    originalPlayer.setBuffer(buffer);
    $('#source-name').textContent = file.name;
    $('#source-detail').textContent = `${source.channels} channel${source.channels === 1 ? '' : 's'} · ${source.rate.toLocaleString()} Hz · ${formatDuration(source.duration)}`;
    $('#original-detail').textContent = formatDuration(source.duration);
    $('#converter-empty').hidden = true;
    $('#converter-content').hidden = false;

    let selected = state.presets.findIndex(preset => preset.id === 'none');
    if (selected < 0) selected = state.presets.findIndex(preset => preset.type === 'profile');
    state.ignorePresetChange = true;
    $('#preset-select').selectedIndex = selected;
    state.ignorePresetChange = false;
    const preset = state.presets[selected];
    setModifierValues({ pitch: 0, resonance: 0, weight: 0, intonation: 0, texture: 0, breathiness: 0 });
    beginConversion(preset);
  } catch (error) { showToast(error.message); }
}

function beginConversion(preset) {
  const serial = ++state.conversionSerial;
  if (state.effectTimer) {
    window.clearTimeout(state.effectTimer);
    state.effectTimer = 0;
  }
  convertedPlayer.clear();
  setConversionBusy(true, preset.type === 'auto' ? 'Testing conversion profiles…' :
    preset.options?.precise ? 'Comparing hardware fits…' : 'Converting…');
  window.setTimeout(() => {
    if (serial !== state.conversionSerial) return;
    try {
      let result, preview;
      let detail = preset.name;
      let fittedModifiers = null;
      if (preset.type === 'auto') {
        const fitted = fitAutoPreset(state.preparedSamples, state.profiles, preset, (current, total) => {
          $('#converted-detail').textContent = `Testing profile ${current} of ${total}…`;
        });
        result = fitted.result;
        const basis = state.presets.find(item => item.id === fitted.basis);
        detail = `${preset.name} · based on ${basis?.name ?? fitted.basis}`;
        fittedModifiers = fitted.modifiers;
      } else if (preset.options?.precise) {
        const fitted = fitPrecisePreset(state.preparedSamples, state.stereoBalance);
        result = fitted.result;
        preview = fitted.preview;
        fittedModifiers = fitted.modifiers;
      } else {
        result = convert(state.preparedSamples, { ...preset.options, stereoBalance: state.stereoBalance });
      }
      if (serial !== state.conversionSerial) return;
      state.baseProject = { ...result, label: suggestedLabel(state.sourceName) };
      if (fittedModifiers) setModifierValues(fittedModifiers);
      $('#volume-input').value = String(detectConversionVolume(state.baseProject));
      $('#volume-value').textContent = `${$('#volume-input').value}%`;
      state.currentEffectName = detail;
      applyEffects(preview);
      $('#converted-detail').textContent = `${detail} · ${formatDuration(result.previewDuration ?? result.sourceDuration)}`;
      setConversionBusy(false);
    } catch (error) {
      state.project = null;
      state.baseProject = null;
      setConversionBusy(false, 'Conversion failed');
      showToast(error.message);
    }
  }, 0);
}

function effectOptions() {
  const modifiers = Object.fromEntries($$('[data-modifier]').map(input => [input.dataset.modifier, Number(input.value)]));
  return {
    volumePercent: Number($('#volume-input').value),
    fadeIn: $('#fade-in-button').getAttribute('aria-pressed') === 'true',
    fadeOut: $('#fade-out-button').getAttribute('aria-pressed') === 'true',
    enabledChannels: $$('[data-conversion-channel]:checked').map(input => input.dataset.conversionChannel),
    ...modifiers,
  };
}

function setModifierValues(values) {
  for (const input of $$('[data-modifier]')) {
    input.value = String(values[input.dataset.modifier] ?? 0);
    input.closest('.range-control').querySelector('output').textContent = input.value;
  }
}

function applyEffects(defaultPreview = null) {
  if (!state.baseProject) return;
  const options = effectOptions();
  state.project = {
    ...applyConversionEffects(state.baseProject, options),
    conversionMetadata: {
      effect: state.currentEffectName,
      volume: options.volumePercent,
      fadeIn: options.fadeIn,
      fadeOut: options.fadeOut,
      channels: options.enabledChannels.map(key => Number(key.slice(2)) - 4),
      pitch: options.pitch,
      resonance: options.resonance,
      weight: options.weight,
      intonation: options.intonation,
      texture: options.texture,
      breathiness: options.breathiness,
    },
  };
  const unchanged = options.volumePercent === detectConversionVolume(state.baseProject) &&
    !options.fadeIn && !options.fadeOut &&
    ['pitch', 'resonance', 'weight', 'intonation', 'texture', 'breathiness'].every(key => options[key] === 0) &&
    options.enabledChannels.length === 4;
  state.convertedWav = unchanged && defaultPreview ? defaultPreview : renderPreview(state.project);
  convertedPlayer.setBuffer(state.convertedWav);
}

function scheduleEffects() {
  $('#volume-value').textContent = `${$('#volume-input').value}%`;
  if (!state.baseProject) return;
  if (state.effectTimer) window.clearTimeout(state.effectTimer);
  state.effectTimer = window.setTimeout(() => {
    state.effectTimer = 0;
    try { applyEffects(); }
    catch (error) { showToast(error.message); }
  }, 100);
}

function toggleEffect(button) {
  const active = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed', String(active));
  scheduleEffects();
}

async function exportAsm() {
  if (!state.project || !state.sourcePath) return;
  try {
    const output = await window.siren.exportAsm(state.sourcePath, makeAsm(state.project, state.sourceName));
    if (output) showToast(`Exported ${output.split(/[\\/]/).at(-1)}`);
  } catch (error) { showToast(`Could not export ASM: ${error.message}`); }
}

async function exportWav() {
  if (!state.convertedWav || !state.sourcePath) return;
  try {
    const output = await window.siren.exportWav(state.sourcePath, state.convertedWav);
    if (output) showToast(`Exported ${output.split(/[\\/]/).at(-1)}`);
  } catch (error) { showToast(`Could not export WAV: ${error.message}`); }
}

let nextEditorNoteId = 1;
const editorChannelKind = key => key === 'ch7' ? 'wave' : key === 'ch8' ? 'noise' : 'square';
const editorChannelNumber = key => Number(key.slice(2)) - 4;
const selectedEditorNotes = () => {
  if (!state.editor) return [];
  const selected = [];
  for (const [channel, notes] of Object.entries(state.editor.channels))
    for (const note of notes) if (state.editorSelection.has(note._editorId)) selected.push({ channel, note });
  return selected;
};

function normalizeEditorNote(note, channel) {
  const kind = editorChannelKind(channel);
  const normalized = {
    ...note,
    _editorId: note._editorId ?? nextEditorNoteId++,
    duration: Math.max(0, Math.min(255, Math.round(note.duration ?? 0))),
    volume: Math.max(0, Math.min(kind === 'wave' ? 3 : 15, Math.round(note.volume ?? (kind === 'wave' ? 2 : 10)))),
    envelope: Math.max(kind === 'wave' ? 0 : -7, Math.min(kind === 'wave' ? 9 : 8, Math.round(note.envelope ?? (kind === 'wave' ? 1 : 8)))),
    frequency: Math.max(0, Math.min(kind === 'noise' ? 255 : 2047, Math.round(note.frequency ?? (kind === 'noise' ? 75 : 1600)))),
  };
  if (kind === 'square') normalized.duty = Math.max(0, Math.min(3, Math.round(note.duty ?? 2)));
  else { delete normalized.duty; delete normalized.sweep; }
  return normalized;
}

function loadEditorAsm(file) {
  try {
    const source = decoder.decode(new Uint8Array(bytesToArrayBuffer(file.bytes)));
    const first = parseCryAsm(source);
    const cries = new Map(first.availableCries.map(name => {
      const cry = parseCryAsm(source, name);
      return [name, { ...cry, channels: Object.fromEntries(Object.entries(cry.channels).map(([key, notes]) =>
        [key, notes.map(note => normalizeEditorNote(note, key))])) }];
    }));
    state.editorPath = file.path;
    state.editorSource = source;
    state.editorCries = cries;
    state.editor = cries.values().next().value;
    state.editorSelection.clear();
    editorPlayer.clear();
    $('#editor-length').value = '256';
    $('#editor-file-name').textContent = file.name;
    $('#editor-cry-choice').replaceChildren(...[...cries.keys()].map(name => new Option(name, name)));
    $('#editor-cry-choice-row').hidden = cries.size <= 1;
    $('#editor-empty').hidden = true;
    $('#editor-content').hidden = false;
    setPage('editor');
    renderEditorTimeline();
    scheduleEditorPreview();
  } catch (error) { showToast(`Could not open cry in the editor: ${error.message}`); }
}

function editorDurationFrames() {
  if (!state.editor) return 0;
  return Math.max(0, ...Object.values(state.editor.channels).map(notes =>
    notes.reduce((sum, note) => sum + note.duration + 1, 0)));
}

function renderEditorTimeline() {
  const timeline = $('#note-timeline');
  const ruler = $('#timeline-ruler');
  if (!state.editor) { timeline.replaceChildren(); ruler.replaceChildren(); return; }
  const pixelsPerFrame = 9;
  const totalFrames = Math.max(32, editorDurationFrames());
  timeline.style.width = `${totalFrames * pixelsPerFrame}px`;
  ruler.style.width = timeline.style.width;
  ruler.replaceChildren();
  for (let frame = 0; frame <= totalFrames; frame += 8) {
    const mark = document.createElement('span');
    mark.style.left = `${frame * pixelsPerFrame}px`;
    mark.textContent = String(frame);
    ruler.append(mark);
  }
  timeline.replaceChildren();
  const active = $('#editor-active-channel').value;
  for (const [channel, notes] of Object.entries(state.editor.channels)) {
    const visible = $(`[data-editor-channel="${channel}"]`).checked;
    const lane = document.createElement('div');
    lane.className = `timeline-lane channel-${editorChannelNumber(channel)}${active === channel ? ' active' : ' muted'}`;
    lane.dataset.channel = channel;
    lane.hidden = !visible;
    const label = document.createElement('span');
    label.className = 'lane-label'; label.textContent = `CH ${editorChannelNumber(channel)}`; lane.append(label);
    let frame = 0;
    notes.forEach((note, index) => {
      const block = document.createElement('button');
      block.type = 'button'; block.className = 'timeline-note';
      block.classList.toggle('selected', state.editorSelection.has(note._editorId));
      block.style.left = `${frame * pixelsPerFrame}px`;
      block.style.width = `${Math.max(12, (note.duration + 1) * pixelsPerFrame - 2)}px`;
      block.dataset.channel = channel; block.dataset.index = String(index); block.dataset.noteId = String(note._editorId);
      block.textContent = note.volume ? `${note.frequency}` : 'rest';
      block.title = `Duration ${note.duration} · Volume ${note.volume} · Envelope ${note.envelope} · Frequency ${note.frequency}`;
      block.addEventListener('click', event => selectEditorNote(note._editorId, event.ctrlKey || event.metaKey));
      block.addEventListener('contextmenu', event => openNoteContextMenu(event, note._editorId));
      block.addEventListener('pointerdown', event => beginEditorDrag(event, channel, index));
      lane.append(block);
      frame += note.duration + 1;
    });
    timeline.append(lane);
  }
  updateNoteProperties();
}

function selectEditorNote(id, additive = false) {
  for (const notes of Object.values(state.editor?.channels ?? {})) {
    const clicked = notes.find(note => note._editorId === id);
    if (clicked) { state.editorDrawLength = clicked.duration + 1; break; }
  }
  if (!additive) state.editorSelection.clear();
  if (additive && state.editorSelection.has(id)) state.editorSelection.delete(id);
  else state.editorSelection.add(id);
  renderEditorTimeline();
}

function updateNoteProperties() {
  const selected = selectedEditorNotes();
  const fieldset = $('#note-properties');
  fieldset.disabled = !selected.length;
  const first = selected[0];
  const same = property => selected.every(item => (item.note[property] ?? '') === (first?.note[property] ?? ''));
  for (const input of $$('[data-note-property]')) {
    const property = input.dataset.noteProperty;
    let value;
    if (property === 'sweepPeriod') value = first?.note.sweep?.[0] ?? 0;
    else if (property === 'sweepShift') value = first?.note.sweep?.[1] ?? 0;
    else value = first?.note[property] ?? '';
    input.value = same(property) ? String(value) : '';
  }
  const channels = new Set(selected.map(item => item.channel));
  const square = channels.size === 1 && editorChannelKind(first?.channel) === 'square';
  $('#note-duty-row').hidden = !square;
  $('#note-pattern-row').hidden = !square;
  $('#note-sweep-row').hidden = !(square && first?.channel === 'ch5');
  $('#note-sweep-shift-row').hidden = !(square && first?.channel === 'ch5');
  $('#note-route').value = first?.note.route ?? 'both';
  $('#note-duty-pattern').value = first?.note.dutyPattern?.join(', ') ?? '';
}

function scheduleEditorPreview() {
  if (!state.editor) return;
  if (state.editorRenderTimer) window.clearTimeout(state.editorRenderTimer);
  state.editorRenderTimer = window.setTimeout(() => {
    state.editorRenderTimer = 0;
    try {
      const length = boundedInput($('#editor-length'), LENGTH_MIN, LENGTH_MAX, 'Length');
      const project = applyCryParameters(state.editor, 0, length);
      project.allowTruncatedPreview = true;
      const buffer = renderPreview(project, 30);
      editorPlayer.setBuffer(buffer);
      const duration = readWav(buffer).duration;
      $('#editor-time').textContent = `0.00 / ${duration.toFixed(2)} seconds · length ${length}`;
      $('#editor-playhead').style.width = '0%';
    } catch (error) {
      editorPlayer.clear();
      showToast(error.message);
    }
  }, 90);
}

function mutateSelectedNotes(property, rawValue) {
  const value = Number(rawValue);
  if (!Number.isInteger(value)) return;
  for (const { channel, note } of selectedEditorNotes()) {
    if (property === 'sweepPeriod' || property === 'sweepShift') {
      if (channel !== 'ch5') continue;
      const sweep = note.sweep ? [...note.sweep] : [0, 0];
      sweep[property === 'sweepPeriod' ? 0 : 1] = value;
      note.sweep = sweep;
    } else note[property] = value;
    Object.assign(note, normalizeEditorNote(note, channel));
  }
  renderEditorTimeline(); scheduleEditorPreview();
}

function addEditorNote() {
  if (!state.editor) return;
  const channel = $('#editor-active-channel').value;
  const note = normalizeEditorNote({ duration: state.editorDrawLength - 1 }, channel);
  state.editor.channels[channel].push(note);
  state.editorSelection.clear(); state.editorSelection.add(note._editorId);
  renderEditorTimeline(); scheduleEditorPreview();
}

function copyEditorNotes() {
  state.editorClipboard = selectedEditorNotes().map(({ channel, note }) => ({ channel, note: { ...note, sweep: note.sweep && [...note.sweep] } }));
}

function deleteEditorNotes() {
  if (!state.editorSelection.size || !state.editor) return;
  for (const key of Object.keys(state.editor.channels))
    state.editor.channels[key] = state.editor.channels[key].filter(note => !state.editorSelection.has(note._editorId));
  state.editorSelection.clear(); renderEditorTimeline(); scheduleEditorPreview();
}

function cutEditorNotes() { copyEditorNotes(); deleteEditorNotes(); }

function pasteEditorNotes() {
  if (!state.editor || !state.editorClipboard.length) return;
  const target = $('#editor-active-channel').value;
  const pasted = state.editorClipboard.map(item => normalizeEditorNote({ ...item.note, _editorId: null }, target));
  state.editor.channels[target].push(...pasted);
  state.editorSelection = new Set(pasted.map(note => note._editorId));
  renderEditorTimeline(); scheduleEditorPreview();
}

function moveSelectedToChannel(target) {
  if (!state.editor) return;
  const selected = selectedEditorNotes();
  if (!selected.length) return;
  for (const { channel, note } of selected) {
    state.editor.channels[channel] = state.editor.channels[channel].filter(item => item !== note);
    state.editor.channels[target].push(normalizeEditorNote(note, target));
  }
  $('#editor-active-channel').value = target;
  $('#note-context-menu').hidden = true;
  renderEditorTimeline(); scheduleEditorPreview();
}

function openNoteContextMenu(event, id) {
  event.preventDefault();
  if (!state.editorSelection.has(id)) { state.editorSelection.clear(); state.editorSelection.add(id); renderEditorTimeline(); }
  const menu = $('#note-context-menu');
  menu.hidden = false; menu.style.left = `${Math.min(event.clientX, innerWidth - 230)}px`; menu.style.top = `${Math.min(event.clientY, innerHeight - 170)}px`;
}

function beginEditorDrag(event, channel, index) {
  if (event.button !== 0) return;
  const id = state.editor?.channels[channel]?.[index]?._editorId;
  if (id && !state.editorSelection.has(id) && !event.ctrlKey && !event.metaKey) {
    state.editorSelection.clear(); state.editorSelection.add(id);
  }
  state.editorDragging = { channel, index, startX: event.clientX };
  event.currentTarget.setPointerCapture(event.pointerId);
  event.currentTarget.addEventListener('pointerup', finishEditorDrag, { once: true });
}

function finishEditorDrag(event) {
  const drag = state.editorDragging; state.editorDragging = null;
  if (!drag || !state.editor) return;
  const notes = state.editor.channels[drag.channel];
  const delta = Math.round((event.clientX - drag.startX) / 45);
  const target = Math.max(0, Math.min(notes.length - 1, drag.index + delta));
  if (target === drag.index) return;
  const moving = notes.filter(note => state.editorSelection.has(note._editorId));
  const group = moving.includes(notes[drag.index]) ? moving : [notes[drag.index]];
  const remaining = notes.filter(note => !group.includes(note));
  remaining.splice(Math.max(0, Math.min(remaining.length, target)), 0, ...group);
  state.editor.channels[drag.channel] = remaining;
  renderEditorTimeline(); scheduleEditorPreview();
}

async function saveEditorAsm() {
  if (!state.editor || !state.editorPath) return;
  try {
    const contents = [...state.editorCries.values()].map(cry => {
      const enabledChannels = Object.entries(cry.channels).filter(([, notes]) => notes.length).map(([key]) => key);
      const label = cry.label.replace(/^Cry_/, '') || 'Edited';
      return makeAsm({ ...cry, label, precise: true, enabledChannels }, state.editorPath.split(/[\\/]/).at(-1));
    }).join('\n\n');
    const saved = await window.siren.saveAsm(state.editorPath, contents);
    state.editorSource = contents;
    showToast(`Saved ${saved.path.split(/[\\/]/).at(-1)} · backup: ${saved.backup.split(/[\\/]/).at(-1)}`);
  } catch (error) { showToast(`Could not save ASM: ${error.message}`); }
}

function loadCryList(file) {
  try {
    const source = decoder.decode(new Uint8Array(bytesToArrayBuffer(file.bytes)));
    const constantsText = decoder.decode(new Uint8Array(bytesToArrayBuffer(file.constantsBytes)));
    const pointersText = decoder.decode(new Uint8Array(bytesToArrayBuffer(file.pointersBytes)));
    const definitionSources = file.definitionFiles.map(bytes => decoder.decode(new Uint8Array(bytesToArrayBuffer(bytes))));
    const document = parseCryList(source);
    const constants = parseCryConstants(constantsText);
    const pointers = parseCryPointers(pointersText);
    const definitions = resolveCryDefinitionSources(constants, pointers, definitionSources);
    const known = new Set(constants.map(value => value.toUpperCase()));
    const unknown = document.entries.find(entry => !known.has(entry.constant.toUpperCase()));
    if (unknown) throw new Error(`Line ${unknown.lineNumber}: ${unknown.constant} is missing from constants/cry_constants.asm.`);
    validationPlayer.clear();
    state.validationPath = file.path;
    state.validationDocument = document;
    state.validationConstants = constants;
    state.validationDefinitions = definitions;
    $('#asm-name').textContent = file.name;
    $('#asm-detail').textContent = `${document.entries.length} entries · backup: ${file.backup.split(/[\\/]/).at(-1)}`;
    $('#validation-empty').hidden = true;
    $('#validation-content').hidden = false;
    $('#validation-save').disabled = false;
    renderCryListRows();
  } catch (error) { showToast(`Could not open cry list: ${error.message}`); }
}

function renderCryListRows() {
  const rows = state.validationDocument.entries.map((entry, index) => {
    const row = document.createElement('div');
    row.className = 'cry-list-grid'; row.setAttribute('role', 'row'); row.dataset.index = String(index);
    const play = document.createElement('button');
    play.type = 'button'; play.className = 'play-button'; play.title = `Play ${entry.species || entry.constant}`;
    play.setAttribute('aria-label', play.title); play.innerHTML = '<span class="fluent-icon" aria-hidden="true">&#xE768;</span>';
    const macro = document.createElement('input'); macro.type = 'text'; macro.value = entry.macro; macro.dataset.field = 'macro';
    macro.setAttribute('aria-label', `Macro for row ${index + 1}`);
    const constant = document.createElement('select'); constant.dataset.field = 'constant';
    constant.setAttribute('aria-label', `Cry constant for row ${index + 1}`);
    constant.replaceChildren(...state.validationConstants.map(value => new Option(value, value)));
    constant.value = state.validationConstants.find(value => value.toUpperCase() === entry.constant.toUpperCase());
    const pitch = document.createElement('input'); pitch.type = 'number'; pitch.min = String(PITCH_MIN); pitch.max = String(PITCH_MAX);
    pitch.step = '1'; pitch.value = String(entry.pitch); pitch.dataset.field = 'pitch';
    pitch.setAttribute('aria-label', `Pitch for row ${index + 1}`);
    const length = document.createElement('input'); length.type = 'number'; length.min = String(LENGTH_MIN); length.max = String(LENGTH_MAX);
    length.step = '1'; length.value = String(entry.length); length.dataset.field = 'length';
    length.setAttribute('aria-label', `Length for row ${index + 1}`);
    const species = document.createElement('input'); species.type = 'text'; species.value = entry.species;
    species.placeholder = 'Optional comment'; species.dataset.field = 'species';
    species.setAttribute('aria-label', `Species comment for row ${index + 1}`);
    row.append(play, macro, constant, pitch, length, species);
    play.addEventListener('click', () => playCryListRow(row));
    return row;
  });
  $('#cry-list-rows').replaceChildren(...rows);
}

function boundedInput(input, low, high, label) {
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < low || value > high)
    throw new Error(`${label} must be ${low}–${high}.`);
  return value;
}

function cryListRowValues() {
  return $$('#cry-list-rows .cry-list-grid').map(row => ({
    macro: row.querySelector('[data-field="macro"]').value,
    constant: row.querySelector('[data-field="constant"]').value,
    pitch: boundedInput(row.querySelector('[data-field="pitch"]'), PITCH_MIN, PITCH_MAX, 'Pitch'),
    length: boundedInput(row.querySelector('[data-field="length"]'), LENGTH_MIN, LENGTH_MAX, 'Length'),
    species: row.querySelector('[data-field="species"]').value,
  }));
}

function resetValidationRowButton() {
  if (state.validationActiveButton)
    state.validationActiveButton.querySelector('.fluent-icon').textContent = '\uE768';
  state.validationActiveButton = null;
}

async function playCryListRow(row) {
  const button = row.querySelector('.play-button');
  if (state.validationActiveButton === button && validationPlayer.playing) {
    validationPlayer.stop(); resetValidationRowButton(); return;
  }
  validationPlayer.stop(); resetValidationRowButton();
  $('#validation-progress').hidden = false;
  try {
    const constant = row.querySelector('[data-field="constant"]').value;
    const definition = state.validationDefinitions.get(constant.toUpperCase());
    if (!definition) throw new Error(`${constant} has no matching definition in the project audio files.`);
    const cry = parseCryAsm(definition.source, definition.label);
    const pitch = boundedInput(row.querySelector('[data-field="pitch"]'), PITCH_MIN, PITCH_MAX, 'Pitch');
    const length = boundedInput(row.querySelector('[data-field="length"]'), LENGTH_MIN, LENGTH_MAX, 'Length');
    const project = applyCryParameters(cry, pitch, length); project.allowTruncatedPreview = true;
    validationPlayer.setBuffer(renderPreview(project, 15));
    state.validationActiveButton = button;
    button.querySelector('.fluent-icon').textContent = '\uE769';
    await validationPlayer.play();
  } catch (error) {
    validationPlayer.clear(); resetValidationRowButton(); showToast(`Could not preview cry: ${error.message}`);
  } finally { $('#validation-progress').hidden = true; }
}

async function saveCryList() {
  if (!state.validationPath || !state.validationDocument) return;
  try {
    const source = renderCryList(state.validationDocument, cryListRowValues());
    await window.siren.saveCryList(state.validationPath, source);
    state.validationDocument = parseCryList(source);
    $('#asm-detail').textContent = `${state.validationDocument.entries.length} entries · saved · backup: cries.asm.backup`;
    showToast('Saved cries.asm');
  } catch (error) { showToast(`Could not save cry list: ${error.message}`); }
}

async function initializePresets() {
  try {
    const files = await window.siren.loadPresets();
    state.presets = parsePresetDirectories([files.bundled, files.custom]);
    state.profiles = state.presets.filter(preset => preset.type === 'profile');
    const select = $('#preset-select');
    select.replaceChildren(...state.presets.map(preset => new Option(preset.name, preset.id)));
  } catch (error) {
    showToast(error.message);
    $('#converter-open').disabled = true;
    $('#converter-open-header').disabled = true;
  }
}

$$('.nav-item[data-page]').forEach(button => button.addEventListener('click', () => setPage(button.dataset.page)));
for (const id of ['converter-open', 'converter-open-header', 'converter-change'])
  $(`#${id}`).addEventListener('click', () => chooseFile('wav'));
for (const id of ['validation-open', 'validation-open-header'])
  $(`#${id}`).addEventListener('click', () => chooseFile('cry-list'));
$('#validation-save').addEventListener('click', saveCryList);
$('#export-button').addEventListener('click', exportAsm);
$('#export-wav-button').addEventListener('click', exportWav);
$('#about-button').addEventListener('click', () => $('#about-dialog').showModal());
$$('#about-dialog [data-url]').forEach(button => button.addEventListener('click', () => window.siren.openExternal(button.dataset.url)));

$('#preset-select').addEventListener('change', event => {
  if (state.ignorePresetChange || !state.sourcePath) return;
  const preset = state.presets[event.target.selectedIndex];
  beginConversion(preset);
});
$('#volume-input').addEventListener('input', scheduleEffects);
$('#fade-in-button').addEventListener('click', event => toggleEffect(event.currentTarget));
$('#fade-out-button').addEventListener('click', event => toggleEffect(event.currentTarget));
for (const input of $$('[data-modifier]')) input.addEventListener('input', () => {
  input.closest('.range-control').querySelector('output').textContent = input.value;
  scheduleEffects();
});
for (const input of $$('[data-modifier]')) input.addEventListener('auxclick', event => {
  if (event.button !== 1) return;
  event.preventDefault();
  input.value = '0';
  input.closest('.range-control').querySelector('output').textContent = '0';
  scheduleEffects();
});
for (const input of $$('[data-conversion-channel]')) input.addEventListener('change', scheduleEffects);

for (const id of ['editor-open', 'editor-open-header'])
  $(`#${id}`).addEventListener('click', () => chooseFile('asm'));

for (const eventName of ['pause', 'ended']) $('#validation-audio').addEventListener(eventName, () => {
  if (!validationPlayer.playing) resetValidationRowButton();
});

document.addEventListener('keydown', event => {
  const editorActive = !$('#editor-page').hidden;
  if (!event.ctrlKey || event.altKey) return;
  if (event.key.toLowerCase() === 'o') {
    event.preventDefault();
    chooseFile(editorActive ? 'asm' : !$('#validation-page').hidden ? 'cry-list' : 'wav');
  } else if (!editorActive && !$('#validation-page').hidden && event.key.toLowerCase() === 's') {
    event.preventDefault(); saveCryList();
  }
});

let dragDepth = 0;
document.addEventListener('dragenter', event => {
  event.preventDefault();
  dragDepth++;
  $('#drop-overlay').hidden = false;
});
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('dragleave', event => {
  event.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true; }
});
document.addEventListener('drop', async event => {
  event.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const filePath = window.siren.pathForFile(file);
  await loadPath(filePath);
});

window.addEventListener('beforeunload', () => {
  studio.destroy();
  for (const player of players) player.clear();
});
window.siren.onOpenPath(loadPath);
await initializePresets();
