import {
  applyConversionEffects, detectConversionVolume, FRAME_RATE, MAX_SECONDS, makeAsm, prepareWav, readWav, suggestedLabel, convert,
} from '../src/converter.js';
import { applyCryParameters, parseCryAsm, PITCH_MIN, PITCH_MAX, LENGTH_MIN, LENGTH_MAX } from '../src/cry-asm.js';
import { fitAutoPreset, fitPrecisePreset, suggestPreset } from '../src/preset-engine.js';
import { applyVoiceControls } from '../src/modifier-engine.js';
import { renderPreview } from '../src/preview.js';
import { parsePresetDirectories } from './preset-schema.js';

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
  rawProject: null,
  asmText: null,
  cry: null,
  conversionSerial: 0,
  validationSerial: 0,
  validationTimer: 0,
  resumeValidation: false,
  ignorePresetChange: false,
  ignoreCryChange: false,
  effectTimer: 0,
  voiceTimer: 0,
  conversionDetail: '',
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
      this.button.id === 'converted-play' ? 'converted cry' : 'cry preview';
    this.button.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${subject}`);
  }
}

const originalPlayer = new AudioPlayer($('#original-audio'), $('#original-play'));
const convertedPlayer = new AudioPlayer($('#converted-audio'), $('#converted-play'));
const validationPlayer = new AudioPlayer($('#validation-audio'), $('#validation-play'));
const players = [originalPlayer, convertedPlayer, validationPlayer];

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
  for (const id of ['voice-pitch-input', 'voice-resonance-input', 'voice-weight-input', 'voice-intonation-input'])
    $(`#${id}`).disabled = busy;
  $('#volume-input').disabled = busy;
  $('#fade-in-button').disabled = busy;
  $('#fade-out-button').disabled = busy;
  $('#export-button').disabled = busy || !state.project;
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
  const kind = /\.asm$/i.test(filePath) ? 'asm' : 'wav';
  try {
    const file = await window.siren.readFile(filePath, kind);
    await loadOpenedFile(file, kind);
  } catch (error) { showToast(error.message); }
}

async function loadOpenedFile(file, kind) {
  if (kind === 'asm') {
    loadAsm(file);
    setPage('validation');
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
    state.rawProject = null;
    convertedPlayer.clear();
    originalPlayer.setBuffer(buffer);
    $('#source-name').textContent = file.name;
    $('#source-detail').textContent = `${source.channels} channel${source.channels === 1 ? '' : 's'} · ${source.rate.toLocaleString()} Hz · ${formatDuration(source.duration)}`;
    $('#original-detail').textContent = formatDuration(source.duration);
    $('#converter-empty').hidden = true;
    $('#converter-content').hidden = false;

    const suggestion = suggestPreset(state.preparedSamples);
    let selected = state.presets.findIndex(preset => preset.id === suggestion.id);
    if (selected < 0) selected = state.presets.findIndex(preset => preset.type === 'profile');
    state.ignorePresetChange = true;
    $('#preset-select').selectedIndex = selected;
    state.ignorePresetChange = false;
    for (const id of ['voice-pitch-input', 'voice-resonance-input', 'voice-weight-input', 'voice-intonation-input'])
      $(`#${id}`).value = '0';
    const preset = state.presets[selected];
    beginConversion(preset);
  } catch (error) { showToast(error.message); }
}

function beginConversion(preset) {
  const serial = ++state.conversionSerial;
  if (state.effectTimer) {
    window.clearTimeout(state.effectTimer);
    state.effectTimer = 0;
  }
  if (state.voiceTimer) {
    window.clearTimeout(state.voiceTimer);
    state.voiceTimer = 0;
  }
  convertedPlayer.clear();
  setConversionBusy(true, preset.type === 'auto' ? 'Testing conversion profiles…' :
    preset.options?.precise ? 'Comparing hardware fits…' : 'Converting…');
  window.setTimeout(() => {
    if (serial !== state.conversionSerial) return;
    try {
      let result, preview;
      let detail = preset.name;
      if (preset.type === 'auto') {
        const fitted = fitAutoPreset(state.preparedSamples, state.profiles, preset, (current, total) => {
          $('#converted-detail').textContent = `Testing profile ${current} of ${total}…`;
        });
        result = fitted.result;
        const basis = state.presets.find(item => item.id === fitted.basis);
        detail = `${detail} · based on ${basis?.name ?? fitted.basis}`;
      } else if (preset.options?.precise) {
        const fitted = fitPrecisePreset(state.preparedSamples, state.stereoBalance);
        result = fitted.result;
        preview = fitted.preview;
      } else {
        result = convert(state.preparedSamples, { ...preset.options, stereoBalance: state.stereoBalance });
      }
      if (serial !== state.conversionSerial) return;
      state.rawProject = { ...result, label: suggestedLabel(state.sourceName) };
      state.conversionDetail = detail;
      applyVoiceSettings(preview);
      setConversionBusy(false);
    } catch (error) {
      state.project = null;
      state.baseProject = null;
      state.rawProject = null;
      setConversionBusy(false, 'Conversion failed');
      showToast(error.message);
    }
  }, 0);
}

function effectOptions() {
  return {
    volumePercent: Number($('#volume-input').value),
    fadeIn: $('#fade-in-button').getAttribute('aria-pressed') === 'true',
    fadeOut: $('#fade-out-button').getAttribute('aria-pressed') === 'true',
  };
}

function voiceOptions() {
  return {
    pitch: Number($('#voice-pitch-input').value) / 100,
    resonance: Number($('#voice-resonance-input').value) / 100,
    weight: Number($('#voice-weight-input').value) / 100,
    intonation: Number($('#voice-intonation-input').value) / 100,
  };
}

function applyVoiceSettings(defaultPreview = null) {
  if (!state.rawProject) return;
  const options = voiceOptions();
  state.baseProject = applyVoiceControls(state.rawProject, options);
  $('#volume-input').value = String(detectConversionVolume(state.baseProject));
  $('#volume-value').textContent = `${$('#volume-input').value}%`;
  const neutral = Object.values(options).every(value => value === 0);
  applyEffects(neutral ? defaultPreview : null);
  $('#converted-detail').textContent = `${state.conversionDetail} · ${formatDuration(
    state.baseProject.previewDuration ?? state.baseProject.sourceDuration)}`;
}

function scheduleVoiceControls() {
  if (!state.rawProject) return;
  if (state.voiceTimer) window.clearTimeout(state.voiceTimer);
  state.voiceTimer = window.setTimeout(() => {
    state.voiceTimer = 0;
    try { applyVoiceSettings(); }
    catch (error) { showToast(error.message); }
  }, 100);
}

function applyEffects(defaultPreview = null) {
  if (!state.baseProject) return;
  const options = effectOptions();
  state.project = applyConversionEffects(state.baseProject, options);
  const unchanged = options.volumePercent === detectConversionVolume(state.baseProject) &&
    !options.fadeIn && !options.fadeOut;
  convertedPlayer.setBuffer(unchanged && defaultPreview ? defaultPreview : renderPreview(state.project));
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

function loadAsm(file) {
  try {
    const source = decoder.decode(new Uint8Array(bytesToArrayBuffer(file.bytes)));
    const cry = parseCryAsm(source);
    validationPlayer.clear();
    state.resumeValidation = false;
    state.asmText = source;
    state.cry = cry;
    $('#asm-name').textContent = file.name;
    updateCryDetail();
    const choice = $('#cry-choice');
    choice.replaceChildren(...cry.availableCries.map(name => new Option(name, name)));
    state.ignoreCryChange = true;
    choice.selectedIndex = 0;
    state.ignoreCryChange = false;
    $('#cry-choice-row').hidden = cry.availableCries.length <= 1;
    scheduleValidation();
  } catch (error) { showToast(`Could not open cry: ${error.message}`); }
}

function updateCryDetail() {
  const channelCount = Object.values(state.cry.channels).filter(notes => notes.length).length;
  $('#asm-detail').textContent = `${state.cry.label} · ${channelCount} channel${channelCount === 1 ? '' : 's'}`;
}

function boundedInput(input, low, high, label) {
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < low || value > high)
    throw new Error(`${label} must be ${low}–${high}.`);
  return value;
}

function scheduleValidation() {
  if (!state.cry) return;
  const serial = ++state.validationSerial;
  state.resumeValidation ||= validationPlayer.playing;
  validationPlayer.stop();
  $('#validation-play').disabled = true;
  $('#validation-progress').hidden = false;
  if (state.validationTimer) window.clearTimeout(state.validationTimer);
  state.validationTimer = window.setTimeout(async () => {
    state.validationTimer = 0;
    if (serial !== state.validationSerial) return;
    try {
      const pitch = boundedInput($('#pitch-input'), PITCH_MIN, PITCH_MAX, 'Pitch');
      const length = boundedInput($('#length-input'), LENGTH_MIN, LENGTH_MAX, 'Length');
      const project = applyCryParameters(state.cry, pitch, length);
      project.allowTruncatedPreview = true;
      validationPlayer.setBuffer(renderPreview(project, 15));
      const frames = Math.max(...Object.values(project.channels).map(notes =>
        notes.reduce((sum, note) => sum + note.frames, 0)));
      $('#validation-detail').textContent = `Pitch ${pitch} · Length ${length}${frames / FRAME_RATE > 15 ? ' · First 15 seconds' : ''}`;
      if (state.resumeValidation) await validationPlayer.play();
      state.resumeValidation = false;
    } catch (error) {
      state.resumeValidation = false;
      validationPlayer.clear();
      $('#validation-detail').textContent = error.message;
      showToast(error.message);
    } finally {
      $('#validation-progress').hidden = true;
    }
  }, 120);
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
  $(`#${id}`).addEventListener('click', () => chooseFile('asm'));
$('#export-button').addEventListener('click', exportAsm);
$('#new-window-button').addEventListener('click', () => window.siren.newWindow());
$('#about-button').addEventListener('click', () => $('#about-dialog').showModal());
$$('#about-dialog [data-url]').forEach(button => button.addEventListener('click', () => window.siren.openExternal(button.dataset.url)));

$('#preset-select').addEventListener('change', event => {
  if (state.ignorePresetChange || !state.sourcePath) return;
  const preset = state.presets[event.target.selectedIndex];
  beginConversion(preset);
});
for (const id of ['voice-pitch-input', 'voice-resonance-input', 'voice-weight-input', 'voice-intonation-input'])
  $(`#${id}`).addEventListener('input', scheduleVoiceControls);
$('#volume-input').addEventListener('input', scheduleEffects);
$('#fade-in-button').addEventListener('click', event => toggleEffect(event.currentTarget));
$('#fade-out-button').addEventListener('click', event => toggleEffect(event.currentTarget));

$('#cry-choice').addEventListener('change', event => {
  if (state.ignoreCryChange || !state.asmText) return;
  try {
    state.cry = parseCryAsm(state.asmText, event.target.value);
    updateCryDetail();
    scheduleValidation();
  } catch (error) { showToast(error.message); }
});
$('#pitch-input').addEventListener('input', scheduleValidation);
$('#length-input').addEventListener('input', scheduleValidation);

document.addEventListener('keydown', event => {
  if (!event.ctrlKey || event.altKey) return;
  if (event.key.toLowerCase() === 'n') {
    event.preventDefault();
    window.siren.newWindow();
  } else if (event.key.toLowerCase() === 'o') {
    event.preventDefault();
    chooseFile($('#validation-page').hidden ? 'wav' : 'asm');
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
  if (state.validationTimer) window.clearTimeout(state.validationTimer);
  if (state.voiceTimer) window.clearTimeout(state.voiceTimer);
  for (const player of players) player.clear();
});
window.siren.onOpenPath(loadPath);
await initializePresets();
