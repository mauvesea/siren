#!/usr/bin/env -S gjs -m

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gst from 'gi://Gst?version=1.0';
import Gtk from 'gi://Gtk?version=4.0';

import { applyConversionEffects, detectConversionVolume, FRAME_RATE, MAX_BYTES, MAX_SECONDS, makeAsm, makePlaybackWav, prepareWav, readWav, SIREN_VERSION, suggestedLabel, convert } from './converter.js';
import { fitAutoPreset, fitPrecisePreset } from './preset-engine.js';
import { loadPresetDirectories } from './preset-loader.js';
import { renderPreview } from './preview.js';
import { applyCryParameters, parseCryAsm, PITCH_MIN, PITCH_MAX, LENGTH_MIN, LENGTH_MAX } from './cry-asm.js';
import { parseCryConstants, parseCryDefinitionLabels, parseCryList, parseCryPointers,
  renderCryList, resolveCryDefinitionSources } from './cry-list.js';
import { editorDuration, editorNotePropertySpecs, frequencyToPitch, initializeEditorTimeline, materializeEditorCry,
  isDutyPatternDraft, muteEditorChannels, parseDutyPattern, PIANO_HIGH, PIANO_LOW, pitchName, pitchToFrequency, setDutyPattern,
  setFixedDuty, setMasterVolume } from './note-editor-model.js';

const APP_ID = 'io.github.mauvesea.Siren';
const VERSION = SIREN_VERSION;
const REPOSITORY_URL = 'https://github.com/mauvesea/siren';
const encoder = new TextEncoder();
const ACCENT_COLORS = {
  blue: ['#3584e4', .208, .518, .894], teal: ['#2190a4', .129, .565, .643],
  green: ['#3a944a', .227, .580, .290], yellow: ['#c88800', .784, .533, 0],
  orange: ['#ed5b00', .929, .357, 0], red: ['#e62d42', .902, .176, .259],
  pink: ['#d56199', .835, .380, .600], purple: ['#9141ac', .569, .255, .675],
  slate: ['#6f8396', .435, .514, .588],
};

function systemInterfaceSettings() {
  const sources = [];
  const fallback = Gio.SettingsSchemaSource.get_default();
  if (GLib.getenv('APPDIR')) {
    try { sources.push(Gio.SettingsSchemaSource.new_from_directory('/usr/share/glib-2.0/schemas', fallback, false)); }
    catch (_) { /* The host may not expose its schema directory. */ }
  }
  sources.push(fallback);
  for (const source of sources) {
    try {
      const schema = source?.lookup('org.gnome.desktop.interface', true);
      if (schema?.has_key('accent-color')) return Gio.Settings.new_full(schema, null, null);
    } catch (_) { /* Try the next available schema source. */ }
  }
  return null;
}

function mixColor(base, accent, amount) {
  return base.map((value, index) => value * (1 - amount) + accent[index] * amount);
}

function formatDuration(seconds) {
  return `${seconds.toFixed(seconds < 1 ? 2 : 1)} seconds`;
}

function arrayBuffer(contents) {
  return Uint8Array.from(contents).buffer;
}

function questionmarkIconFile() {
  const relative = 'hicolor/symbolic/actions/questionmark-symbolic.svg';
  const source = Gio.File.new_for_uri(import.meta.url).get_parent()?.get_parent()
    ?.resolve_relative_path(`data/icons/${relative}`);
  const appDir = GLib.getenv('APPDIR');
  const candidates = [source];
  if (appDir) candidates.push(Gio.File.new_for_path(GLib.build_filenamev([appDir, 'usr', 'share', 'icons', relative])));
  candidates.push(Gio.File.new_for_path(GLib.build_filenamev(['/usr', 'share', 'icons', relative])));
  return candidates.find(file => file?.query_exists(null)) ?? null;
}

function loadCryDefinitionSources(projectRoot, pointerLabels) {
  const sources = [];
  const wanted = new Set(pointerLabels.map(label => `CRY_${label.replace(/^Cry_/i, '').toUpperCase()}`));
  let fileCount = 0;
  const skippedDirectories = new Set(['.git', '.hg', '.svn', 'node_modules', 'build', 'dist']);
  const visit = (directory, depth) => {
    if (depth > 12 || !wanted.size) return;
    const enumerator = directory.enumerate_children('standard::name,standard::type,standard::size',
      Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = enumerator.next_file(null))) {
      const name = info.get_name();
      const child = directory.get_child(name);
      if (info.get_file_type() === Gio.FileType.DIRECTORY) {
        if (!skippedDirectories.has(name) && !name.startsWith('.')) visit(child, depth + 1);
      } else if (/\.asm$/i.test(name) && !/(?:^|[-_.])backup(?:[-_.]|$)/i.test(name)) {
        if (++fileCount > 25000) throw new Error('The project contains too many ASM files to search safely.');
        if (info.get_size() > 2 * 1024 * 1024) continue;
        const [, contents] = child.load_contents(null);
        const source = new TextDecoder('utf-8', { fatal: true }).decode(contents);
        let labels;
        try { labels = parseCryDefinitionLabels(source); }
        catch (_) { continue; }
        const found = [...labels.keys()].filter(label => wanted.has(label));
        if (found.length) {
          sources.push(source);
          for (const label of found) wanted.delete(label);
        }
      }
    }
    enumerator.close(null);
  };
  visit(projectRoot, 0);
  return sources;
}

class AudioPlayer {
  constructor(button, onStarted, onError, onEnded = null, beforePlay = null) {
    this.button = button;
    this.onStarted = onStarted;
    this.onError = onError;
    this.onEnded = onEnded;
    this.beforePlay = beforePlay;
    this.uri = null;
    this.playing = false;
    this.pendingSeek = null;
    this.player = Gst.ElementFactory.make('playbin', null);
    const bus = this.player.get_bus();
    bus.add_signal_watch();
    bus.connect('message', (_bus, message) => {
      if (message.type === Gst.MessageType.EOS) {
        this.stop();
        this.onEnded?.();
      }
      if (message.type === Gst.MessageType.ERROR) {
        const [error] = message.parse_error();
        this.stop();
        this.onError(`Could not play audio: ${error.message}`);
      }
      if (message.type === Gst.MessageType.ASYNC_DONE) this.applyPendingSeek();
    });
    this.button.connect('clicked', () => this.toggle());
    this.updateButton();
  }

  setUri(uri) {
    this.stop();
    this.uri = uri;
    this.button.sensitive = Boolean(uri);
  }

  toggle() {
    if (this.playing) this.stop();
    else this.play();
  }

  play() {
    if (this.beforePlay && !this.beforePlay()) return;
    if (!this.uri) return;
    this.onStarted(this);
    this.player.uri = this.uri;
    const result = this.player.set_state(Gst.State.PLAYING);
    if (result === Gst.StateChangeReturn.FAILURE) {
      this.onError('Could not start audio playback.');
      return;
    }
    this.playing = true;
    this.applyPendingSeek();
    this.updateButton();
  }

  seek(position) {
    this.pendingSeek = Math.max(0, Math.round(position));
    if (this.playing) this.applyPendingSeek();
  }

  applyPendingSeek() {
    if (this.pendingSeek === null) return;
    const position = this.pendingSeek;
    if (this.player.seek_simple(Gst.Format.TIME,
      Gst.SeekFlags.FLUSH | Gst.SeekFlags.ACCURATE, position)) this.pendingSeek = null;
  }

  stop() {
    this.player.set_state(Gst.State.NULL);
    this.playing = false;
    this.pendingSeek = null;
    this.updateButton();
  }

  updateButton() {
    this.button.icon_name = this.playing
      ? 'media-playback-pause-symbolic'
      : 'media-playback-start-symbolic';
    this.button.tooltip_text = this.playing ? 'Pause' : 'Play';
  }
}

class SirenWindow {
  constructor(application, menuModel) {
    this.sourceFile = null;
    this.project = null;
    this.baseProject = null;
    this.previewFile = null;
    this.originalPreviewFile = null;
    this.validationFile = null;
    this.validationListFile = null;
    this.validationDocument = null;
    this.validationConstants = [];
    this.validationConstantModel = null;
    this.validationDefinitions = new Map();
    this.validationRows = [];
    this.validationActiveButton = null;
    this.conversionSerial = 0;
    this.effectTimer = 0;
    this.ignoreEffectChanges = false;
    this.ignorePresetChanges = false;
    this.editorFile = null;
    this.editorCries = new Map();
    this.editor = null;
    this.editorSelection = new Set();
    this.editorClipboard = [];
    this.editorDrawLength = 1;
    this.editorPreviewFile = null;
    this.editorPreviewDirty = true;
    this.editorTimer = 0;
    this.nextEditorNoteId = 1;
    this.editorHistory = [];
    this.editorHistoryIndex = -1;
    this.editorRestoringHistory = false;
    this.editorScrollRestoreId = 0;
    this.editorViewportGuardId = 0;
    this.editorViewportGuard = null;
    this.editorPlaybackAnchorPosition = 0;
    this.editorPlaybackAnchorTime = 0;
    this.editorPlaybackLastQuery = 0;

    let presetDirectories = (GLib.getenv('SIREN_PRESETS_DIRS') ||
      GLib.getenv('SIREN_PRESETS_DIR') || '')
      .split(GLib.SEARCHPATH_SEPARATOR_S).filter(Boolean);
    const appDir = GLib.getenv('APPDIR');
    const appImage = GLib.getenv('APPIMAGE');
    if (appDir) {
      presetDirectories.unshift(GLib.build_filenamev([appDir, 'usr', 'share', 'siren', 'Presets']));
      if (appImage) presetDirectories.push(GLib.build_filenamev([GLib.path_get_dirname(appImage), 'Presets']));
    }
    if (!presetDirectories.length)
      presetDirectories.push(GLib.build_filenamev([GLib.get_current_dir(), 'Presets']));
    presetDirectories.push(GLib.build_filenamev([GLib.get_user_config_dir(), 'siren', 'Presets']));
    this.presets = loadPresetDirectories(presetDirectories);
    this.profilePresets = this.presets.filter(preset => preset.type === 'profile');

    this.window = new Adw.ApplicationWindow({
      application,
      title: 'Siren',
      default_width: 1050,
      default_height: 650,
      width_request: 640,
      height_request: 480,
    });
    this.editorCss = new Gtk.CssProvider();
    Gtk.StyleContext.add_provider_for_display(this.window.get_display(), this.editorCss,
      Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    const sourceIcons = Gio.File.new_for_uri(import.meta.url).get_parent()?.get_parent()?.resolve_relative_path('data/icons');
    if (sourceIcons?.query_exists(null))
      Gtk.IconTheme.get_for_display(this.window.get_display()).add_search_path(sourceIcons.get_path());
    this.systemAccentSettings = systemInterfaceSettings();
    this.systemAccentSettings?.connect('changed::accent-color', () => this.updateSystemAccent());
    this.updateSystemAccent();
    this.buildWindowContent(menuModel);
  }

  updateSystemAccent() {
    let name = 'blue';
    try { name = this.systemAccentSettings?.get_string('accent-color') ?? name; }
    catch (_) { /* Older desktops use libadwaita's blue fallback. */ }
    const [hex, red, green, blue] = ACCENT_COLORS[name] ?? ACCENT_COLORS.blue;
    this.editorAccent = [red, green, blue];
    const foreground = name === 'yellow' || name === 'orange' ? '#000000' : '#ffffff';
    this.editorCss.load_from_string(`
      @define-color accent_color ${hex};
      @define-color accent_bg_color ${hex};
      @define-color accent_fg_color ${foreground};
      .siren-ch1 { background: #4f8edc; color: white; }
      .siren-ch2 { background: #68a45f; color: white; }
      .siren-ch3 { background: #a777d1; color: white; }
      .siren-ch4 { background: #d2814d; color: white; }
      .siren-muted { opacity: .30; }
    `);
    this.editorCanvas?.queue_draw();
    this.editorRulerArea?.queue_draw();
    this.editorVelocityArea?.queue_draw();
  }

  buildWindowContent(menuModel) {

    this.toastOverlay = new Adw.ToastOverlay();
    this.stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE });
    this.modeStack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE });
    this.modeStack.add_titled(this.stack, 'converter', 'Converter');
    this.toastOverlay.child = this.modeStack;

    const toolbar = new Adw.ToolbarView();
    const header = new Adw.HeaderBar();
    header.title_widget = new Adw.WindowTitle({ title: 'Siren' });
    this.spinner = new Gtk.Spinner({ visible: false, valign: Gtk.Align.CENTER });
    header.pack_start(this.spinner);
    const menuButton = new Gtk.MenuButton({
      icon_name: 'open-menu-symbolic',
      tooltip_text: 'Main Menu',
      menu_model: menuModel,
    });
    header.pack_end(menuButton);
    toolbar.add_top_bar(header);

    const modeButtons = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 12,
      halign: Gtk.Align.CENTER,
      margin_top: 4,
      margin_bottom: 10,
    });
    this.converterModeButton = new Gtk.ToggleButton({ label: 'Converter', active: true });
    this.validationModeButton = new Gtk.ToggleButton({ label: 'Editor' });
    this.validationModeButton.set_group(this.converterModeButton);
    this.editorModeButton = new Gtk.ToggleButton({ label: 'Studio' });
    this.editorModeButton.set_group(this.converterModeButton);
    this.converterModeButton.add_css_class('flat');
    this.validationModeButton.add_css_class('flat');
    this.editorModeButton.add_css_class('flat');
    this.converterModeButton.connect('toggled', () => {
      if (this.converterModeButton.active) this.modeStack.visible_child_name = 'converter';
    });
    this.validationModeButton.connect('toggled', () => {
      if (this.validationModeButton.active) this.modeStack.visible_child_name = 'validation';
    });
    this.editorModeButton.connect('toggled', () => {
      if (this.editorModeButton.active) this.modeStack.visible_child_name = 'editor';
    });
    modeButtons.append(this.converterModeButton);
    modeButtons.append(this.validationModeButton);
    modeButtons.append(this.editorModeButton);
    toolbar.add_top_bar(modeButtons);
    toolbar.content = this.toastOverlay;
    this.window.content = toolbar;

    this.buildEmptyPage();
    this.buildContentPage();
    this.buildValidationPage();
    this.buildEditorPage();
    this.stack.visible_child_name = 'empty';
    this.modeStack.connect('notify::visible-child-name', () => {
      this.converterModeButton.active = this.modeStack.visible_child_name === 'converter';
      this.validationModeButton.active = this.modeStack.visible_child_name === 'validation';
      this.editorModeButton.active = this.modeStack.visible_child_name === 'editor';
      this.originalPlayer.stop();
      this.convertedPlayer.stop();
      this.validationPlayer.stop();
      this.resetValidationPlayButton();
      this.editorPlayer.stop();
    });

    const dropTarget = Gtk.DropTarget.new(Gio.File.$gtype, Gdk.DragAction.COPY);
    dropTarget.connect('drop', (_target, file) => {
      if (/\.asm$/i.test(file.get_basename())) {
        if (this.modeStack.visible_child_name === 'editor') this.loadEditorAsm(file);
        else { this.modeStack.visible_child_name = 'validation'; this.loadAsm(file); }
      } else {
        this.modeStack.visible_child_name = 'converter';
        this.loadFile(file);
      }
      return true;
    });
    this.window.add_controller(dropTarget);

    this.window.connect('close-request', () => {
      this.originalPlayer.stop();
      this.convertedPlayer.stop();
      this.validationPlayer.stop();
      this.editorPlayer.stop();
      if (this.effectTimer) GLib.source_remove(this.effectTimer);
      if (this.editorTimer) GLib.source_remove(this.editorTimer);
      if (this.editorTransportTimer) GLib.source_remove(this.editorTransportTimer);
      if (this.editorScrollRestoreId) GLib.source_remove(this.editorScrollRestoreId);
      if (this.editorViewportGuardId) GLib.source_remove(this.editorViewportGuardId);
      this.removePreviewFile();
      this.removeOriginalPreviewFile();
      this.removeValidationFile();
      this.removeEditorPreviewFile();
      return false;
    });
  }

  buildEmptyPage() {
    const openButton = new Gtk.Button({ label: 'Open...', halign: Gtk.Align.CENTER });
    openButton.add_css_class('suggested-action');
    openButton.add_css_class('pill');
    openButton.connect('clicked', () => this.chooseFile());
    const page = new Adw.StatusPage({
      icon_name: 'audio-x-generic-symbolic',
      title: 'Select a File',
      child: openButton,
    });
    this.stack.add_named(page, 'empty');
  }

  buildContentPage() {
    const body = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 24,
      margin_top: 24,
      margin_bottom: 32,
      margin_start: 12,
      margin_end: 12,
    });

    const sourceGroup = new Adw.PreferencesGroup({ title: 'Source' });
    this.fileRow = new Adw.ActionRow();
    this.fileRow.add_prefix(new Gtk.Image({ icon_name: 'audio-x-generic-symbolic' }));
    const changeButton = new Gtk.Button({ label: 'Change…', valign: Gtk.Align.CENTER });
    changeButton.connect('clicked', () => this.chooseFile());
    this.fileRow.add_suffix(changeButton);
    sourceGroup.add(this.fileRow);
    body.append(sourceGroup);

    const presetGroup = new Adw.PreferencesGroup({ title: 'Conversion' });
    this.presetRow = new Adw.ComboRow({
      title: 'Effect',
      model: Gtk.StringList.new(this.presets.map(preset => preset.name)),
    });
    this.presetRow.connect('notify::selected', () => {
      if (this.ignorePresetChanges || !this.sourceFile) return;
      const preset = this.presets[this.presetRow.selected];
      this.beginConversion(preset);
    });
    presetGroup.add(this.presetRow);

    const volumeRow = new Adw.ActionRow({ title: 'Volume' });
    this.volumeScale = new Gtk.Scale({
      orientation: Gtk.Orientation.HORIZONTAL,
      adjustment: new Gtk.Adjustment({ value: 0, lower: 0, upper: 100, step_increment: 1, page_increment: 10 }),
      digits: 0, draw_value: true, value_pos: Gtk.PositionType.RIGHT, width_request: 260,
      valign: Gtk.Align.CENTER,
    });
    this.volumeScale.connect('value-changed', () => this.scheduleEffects());
    volumeRow.add_suffix(this.volumeScale);
    presetGroup.add(volumeRow);

    const fadeRow = new Adw.ActionRow({ title: 'Fades' });
    const fadeButtons = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, valign: Gtk.Align.CENTER });
    this.fadeInButton = new Gtk.ToggleButton({ label: 'Fade In' });
    this.fadeOutButton = new Gtk.ToggleButton({ label: 'Fade Out' });
    this.fadeInButton.connect('toggled', () => this.scheduleEffects());
    this.fadeOutButton.connect('toggled', () => this.scheduleEffects());
    fadeButtons.append(this.fadeInButton);
    fadeButtons.append(this.fadeOutButton);
    fadeRow.add_suffix(fadeButtons);
    presetGroup.add(fadeRow);

    const channelRow = new Adw.ActionRow({ title: 'Channels' });
    const channelButtons = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, valign: Gtk.Align.CENTER });
    this.channelChecks = {};
    for (const [key, label] of [['ch5', '1'], ['ch6', '2'], ['ch7', '3'], ['ch8', '4']]) {
      const check = new Gtk.CheckButton({ label, active: true });
      check.connect('toggled', () => this.scheduleEffects());
      this.channelChecks[key] = check;
      channelButtons.append(check);
    }
    channelRow.add_suffix(channelButtons);
    presetGroup.add(channelRow);
    body.append(presetGroup);

    const modifierGroup = new Adw.PreferencesGroup();
    const modifierExpander = new Adw.ExpanderRow({ title: 'Modifiers', expanded: true });
    this.modifierScales = {};
    for (const [key, title, subtitle] of [
      ['pitch', 'Pitch', 'Lower to higher'], ['resonance', 'Resonance', 'Dry to resonant'],
      ['weight', 'Weight', 'Light to heavy'], ['intonation', 'Intonation', 'Loose to tuned'],
      ['texture', 'Texture', 'Raspy to smooth'], ['breathiness', 'Breathiness', 'Whispery to clear'],
    ]) {
      const row = new Adw.ActionRow({ title, subtitle });
      const scale = new Gtk.Scale({ orientation: Gtk.Orientation.HORIZONTAL,
        adjustment: new Gtk.Adjustment({ value: 0, lower: -100, upper: 100, step_increment: 1, page_increment: 10 }),
        digits: 0, draw_value: true, width_request: 240, valign: Gtk.Align.CENTER });
      scale.connect('value-changed', () => this.scheduleEffects());
      const reset = new Gtk.GestureClick({ button: 2 });
      reset.connect('pressed', () => scale.set_value(0));
      scale.add_controller(reset);
      row.add_suffix(scale); modifierExpander.add_row(row); this.modifierScales[key] = scale;
    }
    modifierGroup.add(modifierExpander);
    body.append(modifierGroup);

    const soundGroup = new Adw.PreferencesGroup({ title: 'Comparison' });
    this.originalButton = new Gtk.Button({
      icon_name: 'media-playback-start-symbolic',
      valign: Gtk.Align.CENTER,
      sensitive: false,
    });
    this.originalButton.add_css_class('circular');
    this.originalRow = new Adw.ActionRow({ title: 'Original WAV' });
    this.originalRow.add_prefix(new Gtk.Image({ icon_name: 'audio-speakers-symbolic' }));
    this.originalRow.add_suffix(this.originalButton);
    soundGroup.add(this.originalRow);

    this.convertedButton = new Gtk.Button({
      icon_name: 'media-playback-start-symbolic',
      valign: Gtk.Align.CENTER,
      sensitive: false,
    });
    this.convertedButton.add_css_class('circular');
    this.convertedRow = new Adw.ActionRow({ title: 'Converted cry' });
    this.convertedRow.add_prefix(new Gtk.Image({ icon_name: 'audio-speakers-symbolic' }));
    this.convertedRow.add_suffix(this.convertedButton);
    soundGroup.add(this.convertedRow);
    body.append(soundGroup);

    const exportFullButton = new Gtk.Button({
      label: 'Export .asm',
      tooltip_text: 'Create an ASM file in the source WAV folder',
      sensitive: false,
    });
    exportFullButton.add_css_class('suggested-action');
    exportFullButton.add_css_class('pill');
    exportFullButton.connect('clicked', () => this.exportAsm());
    this.exportButton = exportFullButton;
    this.exportWavButton = new Gtk.Button({ label: 'Export .wav', sensitive: false });
    this.exportWavButton.add_css_class('pill');
    this.exportWavButton.connect('clicked', () => this.exportWav());
    const exportButtons = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, homogeneous: true });
    exportButtons.append(exportFullButton); exportButtons.append(this.exportWavButton);
    body.append(exportButtons);

    const clamp = new Adw.Clamp({ maximum_size: 640, tightening_threshold: 520, child: body });
    const scroll = new Gtk.ScrolledWindow({
      child: clamp,
      hscrollbar_policy: Gtk.PolicyType.NEVER,
      propagate_natural_height: true,
    });
    this.stack.add_named(scroll, 'content');

    const started = active => {
      for (const player of [this.originalPlayer, this.convertedPlayer])
        if (player && player !== active) player.stop();
    };
    const playbackError = message => this.showToast(message);
    this.originalPlayer = new AudioPlayer(this.originalButton, started, playbackError);
    this.convertedPlayer = new AudioPlayer(this.convertedButton, started, playbackError);
  }

  buildValidationPage() {
    const body = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL, spacing: 12,
      margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12,
    });
    const source = new Adw.PreferencesGroup();
    this.validationRow = new Adw.ActionRow({
      title: 'Select data/pokemon/cries.asm',
    });
    this.validationRow.add_prefix(new Gtk.Image({ icon_name: 'text-x-generic-symbolic' }));
    const open = new Gtk.Button({ label: 'Open…', valign: Gtk.Align.CENTER });
    open.connect('clicked', () => this.chooseAsm());
    this.validationRow.add_suffix(open);
    this.validationSaveButton = new Gtk.Button({ label: 'Save', valign: Gtk.Align.CENTER, sensitive: false });
    this.validationSaveButton.add_css_class('suggested-action');
    this.validationSaveButton.connect('clicked', () => this.saveCryList());
    this.validationRow.add_suffix(this.validationSaveButton);
    source.add(this.validationRow);
    body.append(source);

    this.validationColumnGroups = Array.from({ length: 6 }, () => new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.HORIZONTAL }));
    const headings = new Gtk.Grid({ column_spacing: 8, margin_start: 8, margin_end: 8, hexpand: true });
    for (const [column, title, width] of [[0, '', 38], [1, 'Macro', 125], [2, 'Cry Constant', 220],
      [3, 'Pitch', 105], [4, 'Length', 105], [5, 'Species', 180]]) {
      const label = new Gtk.Label({ label: title, xalign: 0, width_request: width, hexpand: column === 5 });
      this.validationColumnGroups[column].add_widget(label);
      label.add_css_class('heading'); headings.attach(label, column, 0, 1, 1);
    }
    body.append(headings);
    this.validationList = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
    this.validationList.add_css_class('boxed-list');
    const scroll = new Gtk.ScrolledWindow({ child: this.validationList, hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
      vscrollbar_policy: Gtk.PolicyType.AUTOMATIC, min_content_height: 320, hexpand: true, vexpand: true });
    body.append(scroll);
    this.modeStack.add_titled(body, 'validation', 'Editor');
    this.validationButton = new Gtk.Button({ visible: false, sensitive: false });
    this.validationPlayer = new AudioPlayer(this.validationButton, active => {
      for (const player of [this.originalPlayer, this.convertedPlayer, this.validationPlayer, this.editorPlayer])
        if (player && player !== active) player.stop();
      if (this.validationActiveButton) this.validationActiveButton.icon_name = 'media-playback-pause-symbolic';
    }, message => {
      this.resetValidationPlayButton();
      this.showToast(message);
    }, () => this.resetValidationPlayButton());
  }

  buildEditorPage() {
    this.editorFrameWidth = 12;
    this.editorRowHeight = 18;
    this.editorTool = 'move';
    const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8,
      margin_top: 10, margin_bottom: 10, margin_start: 10, margin_end: 10 });

    const toolbar = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 5 });
    const command = (label, callback, icon = null) => {
      const button = new Gtk.Button(icon ? { icon_name: icon, tooltip_text: label } : { label });
      button.connect('clicked', callback); toolbar.append(button); return button;
    };
    command('Open', () => this.chooseEditorAsm(), 'document-open-symbolic');
    this.editorSaveButton = command('Save ASM and WAV', () => this.saveEditorAsm(), 'document-save-symbolic');
    this.editorSaveButton.sensitive = false;
    this.editorUndoButton = command('Undo (Ctrl+Z)', () => this.undoEditor(), 'edit-undo-symbolic');
    this.editorRedoButton = command('Redo (Ctrl+Shift+Z)', () => this.redoEditor(), 'edit-redo-symbolic');
    this.editorUndoButton.sensitive = false; this.editorRedoButton.sensitive = false;
    toolbar.append(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL }));
    this.editorToolButtons = {
      move: new Gtk.ToggleButton({ icon_name: 'input-mouse-symbolic', active: true, tooltip_text: 'Move notes (X)' }),
      draw: new Gtk.ToggleButton({ icon_name: 'document-edit-symbolic', tooltip_text: 'Draw notes (X)' }),
    };
    this.editorToolButtons.draw.set_group(this.editorToolButtons.move);
    for (const [tool, button] of Object.entries(this.editorToolButtons)) {
      button.connect('toggled', () => { if (button.active) this.editorTool = tool; });
      toolbar.append(button);
    }
    toolbar.append(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL }));
    command('Copy', () => this.copyEditorNotes(), 'edit-copy-symbolic');
    command('Cut', () => this.cutEditorNotes(), 'edit-cut-symbolic');
    command('Paste', () => this.pasteEditorNotes(), 'edit-paste-symbolic');
    command('Delete', () => this.deleteEditorNotes(), 'edit-delete-symbolic');
    toolbar.append(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL }));
    command('Zoom out', () => this.changeEditorZoom(-1), 'zoom-out-symbolic');
    command('Zoom in', () => this.changeEditorZoom(1), 'zoom-in-symbolic');
    const shortcutsIcon = questionmarkIconFile();
    const shortcutsButton = new Gtk.Button({ tooltip_text: 'Shortcuts' });
    if (shortcutsIcon) {
      shortcutsButton.child = new Gtk.Image({
        paintable: Gtk.IconPaintable.new_for_file(shortcutsIcon, 16, this.window.get_scale_factor()),
        pixel_size: 16,
      });
    } else {
      shortcutsButton.icon_name = 'help-about-symbolic';
    }
    shortcutsButton.connect('clicked', () => this.showStudioShortcuts());
    toolbar.append(shortcutsButton);
    this.editorCryChoice = new Gtk.DropDown({ width_request: 210, visible: false,
      tooltip_text: 'Select the cry pointer to edit' });
    this.editorCryChoice.connect('notify::selected', () => {
      if (this.editorRestoringHistory) return;
      const name = this.editorCryNames?.[this.editorCryChoice.selected];
      if (!name || !this.editorCries.has(name)) return;
      this.editor = this.editorCries.get(name); this.editorSelection.clear();
      this.renderEditorTimeline(); this.scheduleEditorPreview();
    });
    toolbar.append(this.editorCryChoice);
    body.append(toolbar);

    const transport = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    this.editorButton = new Gtk.Button({ icon_name: 'media-playback-start-symbolic', sensitive: false, tooltip_text: 'Play or pause' });
    this.editorButton.add_css_class('circular'); transport.append(this.editorButton);
    this.editorTimeLabel = new Gtk.Label({ label: '0.00 / 0.00 seconds', width_chars: 18, xalign: 0 });
    transport.append(this.editorTimeLabel);
    this.editorTransportScale = new Gtk.Scale({ orientation: Gtk.Orientation.HORIZONTAL, hexpand: true, draw_value: false,
      adjustment: new Gtk.Adjustment({ lower: 0, upper: 1, value: 0, step_increment: .01 }) });
    this.editorTransportScale.sensitive = false;
    this.editorTransportScale.connect('change-value', (_scale, _scroll, value) => {
      this.seekEditorFraction(value);
      return false;
    });
    transport.append(this.editorTransportScale);
    transport.append(new Gtk.Label({ label: 'Length' }));
    this.editorLengthSpin = new Gtk.SpinButton({ adjustment: new Gtk.Adjustment({ value: 256, lower: LENGTH_MIN,
      upper: LENGTH_MAX, step_increment: 1, page_increment: 16 }), digits: 0, numeric: true, width_chars: 7 });
    transport.append(this.editorLengthSpin); body.append(transport);

    const piano = new Gtk.Grid({ column_spacing: 0, row_spacing: 0, hexpand: true, vexpand: true });
    this.editorCornerLabel = new Gtk.Label({ label: 'Pitch', width_request: 76 });
    piano.attach(this.editorCornerLabel, 0, 0, 1, 1);
    this.editorRulerArea = new Gtk.DrawingArea({ height_request: 30 });
    this.editorRulerArea.set_draw_func((area, cr, width, height) => this.drawEditorRuler(cr, width, height));
    const rulerClick = new Gtk.GestureClick({ button: 1 });
    rulerClick.connect('pressed', (_gesture, _presses, x) => {
      if (!this.editor) return;
      const timelineWidth = editorDuration(this.editor) * this.editorFrameWidth;
      this.seekEditorFraction(x / Math.max(1, timelineWidth));
    });
    this.editorRulerArea.add_controller(rulerClick);
    this.editorRulerScroll = new Gtk.ScrolledWindow({ child: this.editorRulerArea,
      hscrollbar_policy: Gtk.PolicyType.EXTERNAL, vscrollbar_policy: Gtk.PolicyType.NEVER,
      propagate_natural_width: false, hexpand: true });
    piano.attach(this.editorRulerScroll, 1, 0, 1, 1);
    this.editorKeyboardArea = new Gtk.DrawingArea({ width_request: 76 });
    this.editorKeyboardArea.set_draw_func((area, cr, width, height) => this.drawEditorKeyboard(cr, width, height));
    this.editorKeyboardScroll = new Gtk.ScrolledWindow({ child: this.editorKeyboardArea,
      hscrollbar_policy: Gtk.PolicyType.NEVER, vscrollbar_policy: Gtk.PolicyType.EXTERNAL,
      propagate_natural_height: false });
    piano.attach(this.editorKeyboardScroll, 0, 1, 1, 1);
    this.editorCanvas = new Gtk.DrawingArea({ hexpand: true, vexpand: true });
    this.editorCanvas.set_draw_func((area, cr, width, height) => this.drawEditorPianoRoll(cr, width, height));
    this.installEditorCanvasControllers();
    this.editorPianoScroll = new Gtk.ScrolledWindow({ child: this.editorCanvas,
      hscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
      min_content_height: 240, overlay_scrolling: false, kinetic_scrolling: true,
      propagate_natural_width: false, propagate_natural_height: false,
      hexpand: true, vexpand: true });
    piano.attach(this.editorPianoScroll, 1, 1, 1, 1);
    this.editorKeyboardScroll.set_vadjustment(this.editorPianoScroll.get_vadjustment());
    this.editorRulerScroll.set_hadjustment(this.editorPianoScroll.get_hadjustment());
    this.editorVelocityLabel = new Gtk.Label({ label: 'Volume', width_request: 76 });
    piano.attach(this.editorVelocityLabel, 0, 2, 1, 1);
    this.editorVelocityArea = new Gtk.DrawingArea({ height_request: 80 });
    this.editorVelocityArea.set_draw_func((area, cr, width, height) => this.drawEditorVelocity(cr, width, height));
    this.installEditorVelocityController();
    this.editorVelocityScroll = new Gtk.ScrolledWindow({ child: this.editorVelocityArea,
      hscrollbar_policy: Gtk.PolicyType.EXTERNAL, vscrollbar_policy: Gtk.PolicyType.NEVER,
      propagate_natural_width: false, hexpand: true });
    this.editorVelocityScroll.set_hadjustment(this.editorPianoScroll.get_hadjustment());
    piano.attach(this.editorVelocityScroll, 1, 2, 1, 1);

    const inspector = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10,
      margin_top: 10, margin_bottom: 10, margin_start: 8, margin_end: 8, width_request: 205 });
    this.editorPropertyInputSizeGroup = new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.HORIZONTAL });
    const fileTitle = new Gtk.Label({ label: 'No file open', xalign: 0, wrap: true });
    fileTitle.add_css_class('title-4'); this.editorSourceLabel = fileTitle; inspector.append(fileTitle);
    inspector.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL }));
    const channelTitle = new Gtk.Label({ label: 'Channels', xalign: 0 }); channelTitle.add_css_class('heading'); inspector.append(channelTitle);
    this.editorChannelChecks = {}; this.editorChannelButtons = {}; this.editorActiveChannel = 'ch5';
    for (const [key, label, name] of [['ch5', '1', 'Pulse 1'], ['ch6', '2', 'Pulse 2'], ['ch7', '3', 'Wave'], ['ch8', '4', 'Noise']]) {
      const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
      const check = new Gtk.CheckButton({ active: true, tooltip_text: `Show and play Channel ${label}` });
      check.connect('toggled', () => {
        if (!check.active && key === this.editorActiveChannel) this.editorSelection.clear();
        this.renderEditorTimeline(); this.scheduleEditorPreview();
      });
      this.editorChannelChecks[key] = check; row.append(check);
      const active = new Gtk.ToggleButton({ label: `Channel ${label} · ${name}`, hexpand: true });
      if (key !== 'ch5') active.set_group(this.editorChannelButtons.ch5);
      else active.active = true;
      active.connect('toggled', () => {
        if (!active.active) return;
        this.editorActiveChannel = key;
        this.editorSelection.clear();
        for (const [channel, button] of Object.entries(this.editorChannelButtons)) {
          if (channel === key) button.remove_css_class('siren-muted');
          else button.add_css_class('siren-muted');
        }
        this.renderEditorTimeline();
      });
      active.add_css_class(`siren-ch${label}`);
      if (key !== 'ch5') active.add_css_class('siren-muted');
      this.editorChannelButtons[key] = active; row.append(active); inspector.append(row);
    }
    const masterTitle = new Gtk.Label({ label: 'Master volume', xalign: 0 });
    masterTitle.add_css_class('heading'); inspector.append(masterTitle);
    this.editorMasterVolumeSpins = {};
    for (const [side, title] of [['left', 'Left'], ['right', 'Right']]) {
      const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
      row.append(new Gtk.Label({ label: title, xalign: 0, hexpand: true }));
      const spin = new Gtk.SpinButton({ adjustment: new Gtk.Adjustment({ value: 7, lower: 0, upper: 7,
        step_increment: 1, page_increment: 1 }), digits: 0, numeric: true, width_chars: 7, sensitive: false });
      this.editorPropertyInputSizeGroup.add_widget(spin);
      spin.connect('value-changed', () => this.changeEditorMasterVolume(side, spin.get_value_as_int()));
      row.append(spin); inspector.append(row); this.editorMasterVolumeSpins[side] = spin;
    }
    inspector.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL }));
    this.editorSelectionLabel = new Gtk.Label({ label: 'No notes selected', xalign: 0 });
    this.editorSelectionLabel.add_css_class('heading'); inspector.append(this.editorSelectionLabel);
    this.editorPitchLabel = new Gtk.Label({ label: 'Pitch —', xalign: 0 }); inspector.append(this.editorPitchLabel);
    this.editorPropertySpins = {}; this.editorPropertyRows = {}; this.editorPropertyLabels = {};
    const defaultSpecs = editorNotePropertySpecs('ch5');
    for (const key of ['duration', 'volume', 'envelope', 'frequency', 'offsetOverride', 'duty', 'sweepPeriod', 'sweepShift']) {
      const { label: title, min: low, max: high } = defaultSpecs[key];
      const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
      const label = new Gtk.Label({ label: title, xalign: 0, hexpand: true }); row.append(label);
      const spin = new Gtk.SpinButton({ adjustment: new Gtk.Adjustment({ value: 0, lower: low, upper: high,
        step_increment: 1, page_increment: 8 }), digits: 0, numeric: true, width_chars: 7, sensitive: false });
      this.editorPropertyInputSizeGroup.add_widget(spin);
      spin.connect('value-changed', () => this.changeEditorProperty(key, spin.get_value_as_int()));
      row.append(spin); inspector.append(row); this.editorPropertySpins[key] = spin;
      this.editorPropertyRows[key] = row; this.editorPropertyLabels[key] = label;
    }
    this.editorRouteRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    this.editorRouteRow.append(new Gtk.Label({ label: 'Stereo route', xalign: 0, hexpand: true }));
    this.editorRouteChoice = new Gtk.DropDown({ model: Gtk.StringList.new(['Both', 'Left', 'Right', 'Muted']), sensitive: false });
    this.editorRouteChoice.connect('notify::selected', () => this.changeEditorRoute(this.editorRouteChoice.selected));
    this.editorRouteRow.append(this.editorRouteChoice); inspector.append(this.editorRouteRow);
    inspector.reorder_child_after(this.editorRouteRow, this.editorPropertyRows.offsetOverride);
    this.editorDutyPatternRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    this.editorDutyPatternRow.append(new Gtk.Label({ label: 'Duty pattern', xalign: 0, hexpand: true }));
    this.editorDutyPatternEntry = new Gtk.Entry({ placeholder_text: '0,1,2,3', width_chars: 7,
      max_width_chars: 7, max_length: 10, sensitive: false });
    this.editorPropertyInputSizeGroup.add_widget(this.editorDutyPatternEntry);
    this.editorDutyPatternDraft = '';
    this.editorDutyPatternEntry.connect('changed', entry => {
      if (this.editorDutyPatternFiltering) return;
      if (isDutyPatternDraft(entry.text)) { this.editorDutyPatternDraft = entry.text; return; }
      this.editorDutyPatternFiltering = true;
      entry.text = this.editorDutyPatternDraft;
      entry.set_position(-1);
      this.editorDutyPatternFiltering = false;
    });
    this.editorDutyPatternEntry.connect('activate', () => this.changeEditorDutyPattern(this.editorDutyPatternEntry.text));
    this.editorDutyPatternEntry.connect('notify::has-focus', entry => {
      const hasFocus = entry.has_focus();
      if (hasFocus) this.editorDutyPatternFocusText = entry.text;
      else if (this.editorDutyPatternFocusText !== undefined && entry.text !== this.editorDutyPatternFocusText)
        this.changeEditorDutyPattern(entry.text);
      if (!hasFocus) this.editorDutyPatternFocusText = undefined;
    });
    this.editorDutyPatternRow.append(this.editorDutyPatternEntry); inspector.append(this.editorDutyPatternRow);
    inspector.reorder_child_after(this.editorDutyPatternRow, this.editorPropertyRows.duty);
    const viewportGuard = new Gtk.EventControllerLegacy();
    viewportGuard.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    viewportGuard.connect('event', (_controller, event) => {
      if (event.get_event_type() !== Gdk.EventType.BUTTON_PRESS) return false;
      const horizontal = this.editorPianoScroll.get_hadjustment();
      const vertical = this.editorPianoScroll.get_vadjustment();
      this.editorViewportGuard = { horizontal: horizontal.get_value(), vertical: vertical.get_value() };
      if (this.editorViewportGuardId) GLib.source_remove(this.editorViewportGuardId);
      this.editorViewportGuardId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
        this.editorViewportGuardId = 0;
        horizontal.set_value(this.editorViewportGuard.horizontal);
        vertical.set_value(this.editorViewportGuard.vertical);
        this.editorViewportGuard = null;
        return GLib.SOURCE_REMOVE;
      });
      return false;
    });
    inspector.add_controller(viewportGuard);
    const inspectorScroll = new Gtk.ScrolledWindow({ child: inspector, hscrollbar_policy: Gtk.PolicyType.NEVER });
    const split = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL, position: 830, wide_handle: true,
      start_child: piano, end_child: inspectorScroll, hexpand: true, vexpand: true });
    body.append(split);
    this.modeStack.add_titled(body, 'editor', 'Studio');
    this.editorPlayer = new AudioPlayer(this.editorButton, active => {
      for (const player of [this.originalPlayer, this.convertedPlayer, this.validationPlayer, this.editorPlayer])
        if (player && player !== active) player.stop();
      let start = this.editorPlayheadFraction ?? 0;
      if (start >= .999) {
        start = 0;
        this.seekEditorFraction(0);
      }
      this.setEditorPlaybackAnchor((this.editorPreviewDuration ?? 0) * start);
      if (start > 0 && start < 1 && this.editorPreviewDuration)
        active.seek(this.editorPreviewDuration * start * Gst.SECOND);
    }, message => this.showToast(message), () => this.finishEditorPlayback(),
    () => this.prepareEditorPreview());
    this.editorLengthSpin.connect('value-changed', () => {
      if (!this.editorRestoringHistory) this.commitEditorHistory();
      this.scheduleEditorPreview();
    });
    const keyController = new Gtk.EventControllerKey();
    keyController.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    keyController.connect('key-pressed', (_controller, keyval, _keycode, state) => {
      if (this.modeStack.visible_child_name !== 'editor') return false;
      const control = Boolean(state & Gdk.ModifierType.CONTROL_MASK);
      const shift = Boolean(state & Gdk.ModifierType.SHIFT_MASK);
      if (control && (keyval === Gdk.KEY_z || keyval === Gdk.KEY_Z)) {
        if (shift) this.redoEditor(); else this.undoEditor();
        return true;
      }
      const focus = this.window.get_focus();
      const editingText = focus instanceof Gtk.Text || focus instanceof Gtk.TextView || focus instanceof Gtk.SpinButton;
      if (control && !(state & Gdk.ModifierType.ALT_MASK) && !editingText) {
        if ([Gdk.KEY_plus, Gdk.KEY_equal, Gdk.KEY_KP_Add].includes(keyval)) {
          this.changeEditorZoom(1, true);
          return true;
        }
        if ([Gdk.KEY_minus, Gdk.KEY_KP_Subtract].includes(keyval)) {
          this.changeEditorZoom(-1, true);
          return true;
        }
        if (keyval === Gdk.KEY_c || keyval === Gdk.KEY_C) {
          if (this.editorSelection.size) this.copyEditorNotes();
          return this.editorSelection.size > 0;
        }
        if (keyval === Gdk.KEY_x || keyval === Gdk.KEY_X) {
          if (this.editorSelection.size) this.cutEditorNotes();
          return this.editorSelection.size > 0;
        }
        if (keyval === Gdk.KEY_v || keyval === Gdk.KEY_V) {
          const canPaste = this.editorClipboard.length > 0;
          if (canPaste) this.pasteEditorNotes();
          return canPaste;
        }
      }
      if (!control && !(state & Gdk.ModifierType.ALT_MASK) && !editingText) {
        if (keyval === Gdk.KEY_Delete || keyval === Gdk.KEY_KP_Delete) {
          const hadSelection = this.editorSelection.size > 0;
          if (hadSelection) this.deleteEditorNotes();
          return hadSelection;
        }
        if (keyval === Gdk.KEY_Left || keyval === Gdk.KEY_Right) {
          return this.navigateEditorNote(keyval === Gdk.KEY_Left ? -1 : 1);
        }
        if (keyval === Gdk.KEY_x || keyval === Gdk.KEY_X) {
          this.cycleEditorTool();
          return true;
        }
      }
      return false;
    });
    this.window.add_controller(keyController);
    this.editorTransportTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
      if (this.editorPlayer.playing) {
        const now = GLib.get_monotonic_time();
        const total = this.editorPreviewDuration ?? 0;
        if (!this.editorPlaybackAnchorTime) this.setEditorPlaybackAnchor(total * (this.editorPlayheadFraction ?? 0));
        if (now - this.editorPlaybackLastQuery >= 250000) {
          const [hasPosition, position] = this.editorPlayer.player.query_position(Gst.Format.TIME);
          if (hasPosition) {
            const interpolated = this.editorPlaybackAnchorPosition + (now - this.editorPlaybackAnchorTime) / 1000000;
            const measured = position / Gst.SECOND;
            this.editorPlaybackAnchorPosition = Math.abs(measured - interpolated) > .12
              ? measured : interpolated + (measured - interpolated) * .2;
            this.editorPlaybackAnchorTime = now;
          }
          this.editorPlaybackLastQuery = now;
        }
        if (total > 0) {
          const seconds = Math.min(total, this.editorPlaybackAnchorPosition +
            (now - this.editorPlaybackAnchorTime) / 1000000);
          this.editorTransportScale.set_value(seconds / total);
          this.editorTimeLabel.label = `${seconds.toFixed(2)} / ${total.toFixed(2)} seconds`;
          this.editorPlayheadFraction = seconds / total;
          this.editorCanvas.queue_draw(); this.editorRulerArea.queue_draw();
        }
      }
      return GLib.SOURCE_CONTINUE;
    });
  }

  present() {
    this.window.present();
  }

  showToast(message) {
    this.toastOverlay.add_toast(new Adw.Toast({ title: message, timeout: 4 }));
  }

  chooseFile() {
    if (this.modeStack.visible_child_name === 'validation') { this.chooseAsm(); return; }
    if (this.modeStack.visible_child_name === 'editor') { this.chooseEditorAsm(); return; }
    const filter = new Gtk.FileFilter({ name: 'WAV audio' });
    filter.add_mime_type('audio/wav');
    filter.add_mime_type('audio/x-wav');
    filter.add_pattern('*.wav');
    filter.add_pattern('*.WAV');
    const filters = new Gio.ListStore({ item_type: Gtk.FileFilter });
    filters.append(filter);
    const dialog = new Gtk.FileDialog({ title: 'Open WAV', filters, default_filter: filter });
    dialog.open(this.window, null, (source, result) => {
      try {
        this.loadFile(source.open_finish(result));
      } catch (error) {
        if (!error.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)) this.showToast(error.message);
      }
    });
  }

  chooseAsm() {
    const filter = new Gtk.FileFilter({ name: 'pokecrystal cry list (cries.asm)' });
    filter.add_pattern('cries.asm');
    filter.add_pattern('CRIES.ASM');
    const filters = new Gio.ListStore({ item_type: Gtk.FileFilter });
    filters.append(filter);
    const dialog = new Gtk.FileDialog({ title: 'Open data/pokemon/cries.asm', filters, default_filter: filter });
    dialog.open(this.window, null, (source, result) => {
      try { this.loadAsm(source.open_finish(result)); }
      catch (error) {
        if (!error.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)) this.showToast(error.message);
      }
    });
  }

  chooseEditorAsm() {
    const filter = new Gtk.FileFilter({ name: 'Cry ASM' });
    filter.add_pattern('*.asm'); filter.add_pattern('*.ASM');
    const filters = new Gio.ListStore({ item_type: Gtk.FileFilter }); filters.append(filter);
    const dialog = new Gtk.FileDialog({ title: 'Open Cry ASM in Studio', filters, default_filter: filter });
    dialog.open(this.window, null, (source, result) => {
      try { this.loadEditorAsm(source.open_finish(result)); }
      catch (error) { if (!error.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)) this.showToast(error.message); }
    });
  }

  editorKind(channel) { return channel === 'ch7' ? 'wave' : channel === 'ch8' ? 'noise' : 'square'; }

  normalizeEditorNote(note, channel) {
    const kind = this.editorKind(channel);
    const clamp = (value, low, high) => Math.max(low, Math.min(high, Math.round(value)));
    const result = { ...note, _editorId: note._editorId ?? this.nextEditorNoteId++,
      duration: clamp(note.duration ?? 0, 0, 255), volume: clamp(note.volume ?? (kind === 'wave' ? 2 : 10), 0, kind === 'wave' ? 3 : 15),
      envelope: clamp(note.envelope ?? (kind === 'wave' ? 1 : 8), kind === 'wave' ? 0 : -7, kind === 'wave' ? 9 : 8),
      frequency: clamp(note.frequency ?? (kind === 'noise' ? 75 : 1600), 0, kind === 'noise' ? 255 : 2047) };
    if (kind === 'square') result.duty = clamp(note.duty ?? 2, 0, 3);
    else { delete result.duty; delete result.sweep; delete result.dutyPattern; }
    return result;
  }

  captureEditorHistoryState() {
    if (!this.editor) return null;
    const currentName = [...this.editorCries].find(([, cry]) => cry === this.editor)?.[0] ?? this.editorCryNames?.[0];
    return {
      cries: JSON.parse(JSON.stringify([...this.editorCries])),
      currentName,
      selection: [...this.editorSelection],
      nextEditorNoteId: this.nextEditorNoteId,
      length: this.editorLengthSpin.get_value_as_int(),
    };
  }

  resetEditorHistory() {
    this.editorHistory = []; this.editorHistoryIndex = -1;
    this.commitEditorHistory();
  }

  commitEditorHistory() {
    if (this.editorRestoringHistory) return;
    const state = this.captureEditorHistoryState();
    if (!state) return;
    const serialized = JSON.stringify(state);
    if (this.editorHistory[this.editorHistoryIndex]?.serialized === serialized) return;
    this.editorHistory.splice(this.editorHistoryIndex + 1);
    this.editorHistory.push({ state, serialized });
    if (this.editorHistory.length > 101) this.editorHistory.shift();
    this.editorHistoryIndex = this.editorHistory.length - 1;
    this.updateEditorHistoryButtons();
  }

  restoreEditorHistory(index) {
    const entry = this.editorHistory[index];
    if (!entry) return;
    this.editorRestoringHistory = true;
    const state = JSON.parse(JSON.stringify(entry.state));
    this.editorCries = new Map(state.cries);
    this.editorCryNames = [...this.editorCries.keys()];
    this.editor = this.editorCries.get(state.currentName) ?? this.editorCries.values().next().value;
    this.editorSelection = new Set(state.selection);
    this.nextEditorNoteId = state.nextEditorNoteId;
    const selected = Math.max(0, this.editorCryNames.indexOf(state.currentName));
    this.editorCryChoice.model = Gtk.StringList.new(this.editorCryNames);
    this.editorCryChoice.selected = selected;
    this.editorLengthSpin.set_value(state.length);
    this.editorRestoringHistory = false;
    this.editorHistoryIndex = index;
    this.updateEditorHistoryButtons(); this.renderEditorTimeline(); this.scheduleEditorPreview();
  }

  updateEditorHistoryButtons() {
    if (!this.editorUndoButton) return;
    this.editorUndoButton.sensitive = this.editorHistoryIndex > 0;
    this.editorRedoButton.sensitive = this.editorHistoryIndex >= 0 && this.editorHistoryIndex < this.editorHistory.length - 1;
  }

  undoEditor() { if (this.editorHistoryIndex > 0) this.restoreEditorHistory(this.editorHistoryIndex - 1); }
  redoEditor() { if (this.editorHistoryIndex < this.editorHistory.length - 1) this.restoreEditorHistory(this.editorHistoryIndex + 1); }

  cycleEditorTool() {
    if (this.editorSelection.size) return;
    const tools = ['move', 'draw'];
    const next = tools[(tools.indexOf(this.editorTool) + 1) % tools.length];
    this.editorToolButtons[next].active = true;
  }

  showStudioShortcuts() {
    const sections = [
      ['Editing', [
        ['Undo', '<Primary>z'],
        ['Redo', '<Primary><Shift>z'],
        ['Cut selected notes', '<Primary>x'],
        ['Copy selected notes', '<Primary>c'],
        ['Paste on the active channel', '<Primary>v'],
        ['Delete selected notes', 'Delete'],
        ['Select the previous note', 'Left', 'Available when one note is selected'],
        ['Select the next note', 'Right', 'Available when one note is selected'],
      ]],
      ['Tools', [
        ['Switch between Move Notes and Draw Notes', 'x', 'Available when no notes are selected'],
      ]],
      ['View', [
        ['Zoom in', '<Primary>plus <Primary>equal <Primary>KP_Add'],
        ['Zoom out', '<Primary>minus <Primary>KP_Subtract', 'Ctrl + mouse wheel also zooms the piano roll'],
      ]],
    ];
    if (Adw.ShortcutsDialog) {
      const dialog = new Adw.ShortcutsDialog();
      for (const [title, shortcuts] of sections) {
        const section = Adw.ShortcutsSection.new(title);
        for (const [itemTitle, accelerator, subtitle = null] of shortcuts) {
          const item = Adw.ShortcutsItem.new(itemTitle, accelerator);
          if (subtitle) item.subtitle = subtitle;
          section.add(item);
        }
        dialog.add(section);
      }
      dialog.present(this.window);
      return;
    }

    // libadwaita before 1.8: retain the native GNOME shortcuts presentation.
    const dialog = new Gtk.ShortcutsWindow({ transient_for: this.window, modal: true });
    const section = new Gtk.ShortcutsSection({ section_name: 'studio', title: 'Studio' });
    for (const [title, shortcuts] of sections) {
      const group = new Gtk.ShortcutsGroup({ title });
      for (const [itemTitle, accelerator] of shortcuts)
        group.add_shortcut(new Gtk.ShortcutsShortcut({ title: itemTitle, accelerator }));
      section.add_group(group);
    }
    dialog.add_section(section);
    dialog.present();
  }

  navigateEditorNote(direction) {
    const selected = this.selectedEditorNotes();
    if (selected.length !== 1 || selected[0].channel !== this.editorActiveChannel) return false;
    const notes = this.editor.channels[this.editorActiveChannel]
      .filter(note => note.volume)
      .sort((a, b) => (a._editorStart ?? 0) - (b._editorStart ?? 0) || a._editorId - b._editorId);
    const index = notes.indexOf(selected[0].note);
    const target = notes[index + direction];
    if (!target) return false;
    this.editorSelection = new Set([target._editorId]);
    this.renderEditorTimeline();
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      const horizontal = this.editorPianoScroll.get_hadjustment();
      const vertical = this.editorPianoScroll.get_vadjustment();
      const x = (target._editorStart ?? 0) * this.editorFrameWidth;
      const y = (PIANO_HIGH - frequencyToPitch(this.editorActiveChannel, target.frequency)) * this.editorRowHeight;
      if (x < horizontal.get_value()) horizontal.set_value(x);
      else if (x + this.editorFrameWidth > horizontal.get_value() + horizontal.get_page_size())
        horizontal.set_value(x + this.editorFrameWidth - horizontal.get_page_size());
      if (y < vertical.get_value()) vertical.set_value(y);
      else if (y + this.editorRowHeight > vertical.get_value() + vertical.get_page_size())
        vertical.set_value(y + this.editorRowHeight - vertical.get_page_size());
      return GLib.SOURCE_REMOVE;
    });
    return true;
  }

  loadEditorAsm(file) {
    try {
      if (!/\.asm$/i.test(file.get_basename())) throw new Error('Choose a .asm file.');
      const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
      if (info.get_size() > 2 * 1024 * 1024) throw new Error('Choose an ASM file smaller than 2 MB.');
      const [, contents] = file.load_contents(null);
      const source = new TextDecoder('utf-8', { fatal: true }).decode(contents);
      const first = parseCryAsm(source);
      this.editorCries = new Map(first.availableCries.map(name => {
        const cry = parseCryAsm(source, name);
        const normalized = { ...cry, channels: Object.fromEntries(Object.entries(cry.channels).map(([key, notes]) =>
          [key, notes.map(note => this.normalizeEditorNote(note, key))])) };
        return [name, initializeEditorTimeline(normalized, () => this.nextEditorNoteId++)];
      }));
      this.editorCryNames = [...this.editorCries.keys()]; this.editor = this.editorCries.values().next().value;
      const backup = file.get_parent().get_child(file.get_basename().replace(/\.asm$/i, '-backup.asm'));
      if (!backup.query_exists(null)) file.copy(backup, Gio.FileCopyFlags.NONE, null, null);
      this.editorFile = file; this.editorSelection.clear();
      this.editorPlayheadFraction = 0; this.editorPreviewDuration = 0;
      this.editorRestoringHistory = true;
      this.editorLengthSpin.set_value(256);
      this.editorRestoringHistory = false;
      this.editorCryChoice.model = Gtk.StringList.new(this.editorCryNames); this.editorCryChoice.selected = 0;
      this.editorCryChoice.visible = this.editorCryNames.length > 1;
      this.editorSourceLabel.label = file.get_basename();
      this.editorSaveButton.sensitive = true; this.modeStack.visible_child_name = 'editor';
      this.resetEditorHistory();
      this.renderEditorTimeline(); this.scheduleEditorPreview();
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        const middlePitch = 60;
        this.editorPianoScroll.get_vadjustment().set_value((PIANO_HIGH - middlePitch) * this.editorRowHeight - 180);
        return GLib.SOURCE_REMOVE;
      });
    } catch (error) { this.showToast(`Could not open cry in the editor: ${error.message}`); }
  }

  selectedEditorNotes() {
    const result = [];
    if (!this.editor) return result;
    for (const [channel, notes] of Object.entries(this.editor.channels))
      for (const note of notes) if (this.editorSelection.has(note._editorId)) result.push({ channel, note });
    return result;
  }

  renderEditorTimeline() {
    if (!this.editorCanvas) return;
    const horizontal = this.editorPianoScroll?.get_hadjustment();
    const vertical = this.editorPianoScroll?.get_vadjustment();
    const horizontalPosition = this.editorViewportGuard?.horizontal ?? horizontal?.get_value() ?? 0;
    const verticalPosition = this.editorViewportGuard?.vertical ?? vertical?.get_value() ?? 0;
    const frames = this.editor ? editorDuration(this.editor) : 64;
    const width = Math.max(900, (frames + 16) * this.editorFrameWidth);
    const height = (PIANO_HIGH - PIANO_LOW + 1) * this.editorRowHeight;
    this.editorCanvas.set_size_request(width, height);
    this.editorRulerArea.set_size_request(width, 30);
    this.editorVelocityArea.set_size_request(width, 100);
    this.editorKeyboardArea.set_size_request(76, height);
    this.editorCanvas.queue_draw(); this.editorRulerArea.queue_draw();
    this.editorKeyboardArea.queue_draw(); this.editorVelocityArea.queue_draw();
    this.updateEditorProperties();
    if (horizontal && vertical) {
      if (this.editorScrollRestoreId) GLib.source_remove(this.editorScrollRestoreId);
      this.editorScrollRestoreId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this.editorScrollRestoreId = 0;
        horizontal.set_value(horizontalPosition); vertical.set_value(verticalPosition);
        return GLib.SOURCE_REMOVE;
      });
    }
  }

  editorVisibleNotes() {
    const result = [];
    if (!this.editor) return result;
    for (const [channel, notes] of Object.entries(this.editor.channels)) {
      if (!this.editorChannelChecks[channel]?.active) continue;
      for (const note of notes) {
        if (!note.volume) continue;
        const pitch = frequencyToPitch(channel, note.frequency);
        result.push({ channel, note, pitch,
          x: (note._editorStart ?? 0) * this.editorFrameWidth,
          y: (PIANO_HIGH - pitch) * this.editorRowHeight,
          width: Math.max(this.editorFrameWidth - 2, (note.duration + 1) * this.editorFrameWidth - 2),
          height: this.editorRowHeight - 2 });
      }
    }
    return result;
  }

  editorNoteAt(x, y, velocity = false) {
    const notes = this.editorVisibleNotes().filter(item => item.channel === this.editorActiveChannel &&
      x >= item.x && x <= item.x + item.width &&
      (velocity || (y >= item.y && y <= item.y + item.height)));
    return notes.at(-1) ?? null;
  }

  drawEditorRuler(cr, width, height) {
    const dark = Adw.StyleManager.get_default().dark;
    cr.setSourceRGB(...(dark ? [.13, .13, .13] : [.94, .94, .94])); cr.paint();
    cr.selectFontFace('Sans', 0, 0); cr.setFontSize(10);
    const frames = Math.ceil(width / this.editorFrameWidth);
    for (let frame = 0; frame <= frames; frame += 4) {
      const x = frame * this.editorFrameWidth + .5;
      cr.setSourceRGBA(...(dark ? [1, 1, 1, frame % 16 ? .14 : .3] : [0, 0, 0, frame % 16 ? .14 : .3]));
      cr.moveTo(x, frame % 16 ? 18 : 13); cr.lineTo(x, height); cr.stroke();
      if (frame % 16 === 0) {
        cr.setSourceRGBA(...(dark ? [1, 1, 1, .75] : [0, 0, 0, .7]));
        cr.moveTo(x + 4, 11); cr.showText(`${frame}f`);
      }
    }
    const playhead = (this.editorPlayheadFraction ?? 0) * (this.editor ? editorDuration(this.editor) : 1) * this.editorFrameWidth;
    cr.setSourceRGBA(1, .25, .2, .95); cr.setLineWidth(2);
    cr.moveTo(playhead, 0); cr.lineTo(playhead, height); cr.stroke(); cr.setLineWidth(1);
  }

  drawEditorKeyboard(cr, width, height) {
    const dark = Adw.StyleManager.get_default().dark;
    const black = new Set([1, 3, 6, 8, 10]);
    cr.selectFontFace('Sans', 0, 0); cr.setFontSize(10);
    for (let pitch = PIANO_HIGH; pitch >= PIANO_LOW; pitch--) {
      const y = (PIANO_HIGH - pitch) * this.editorRowHeight;
      const isBlack = black.has(pitch % 12);
      cr.setSourceRGB(...(isBlack ? (dark ? [.08, .08, .08] : [.12, .12, .12]) : (dark ? [.78, .78, .78] : [.98, .98, .98])));
      cr.rectangle(0, y, isBlack ? width * .68 : width, this.editorRowHeight); cr.fill();
      cr.setSourceRGBA(...(dark ? [0, 0, 0, .45] : [0, 0, 0, .28])); cr.rectangle(0, y, width, this.editorRowHeight); cr.stroke();
      if (pitch % 12 === 0) {
        cr.setSourceRGB(...(isBlack ? [1, 1, 1] : [0.15, 0.15, 0.15]));
        cr.moveTo(width - 24, y + 12); cr.showText(pitchName(pitch));
      }
    }
  }

  drawEditorPianoRoll(cr, width, height) {
    const dark = Adw.StyleManager.get_default().dark;
    const accent = this.editorAccent ?? ACCENT_COLORS.blue.slice(1);
    const black = new Set([1, 3, 6, 8, 10]);
    for (let pitch = PIANO_HIGH; pitch >= PIANO_LOW; pitch--) {
      const y = (PIANO_HIGH - pitch) * this.editorRowHeight;
      const shade = black.has(pitch % 12);
      const base = dark ? (shade ? [.105, .11, .12] : [.135, .14, .15]) : (shade ? [.91, .91, .91] : [.97, .97, .97]);
      cr.setSourceRGB(...mixColor(base, accent, dark ? .045 : .075));
      cr.rectangle(0, y, width, this.editorRowHeight); cr.fill();
      cr.setSourceRGBA(accent[0], accent[1], accent[2], dark ? .12 : .18);
      cr.moveTo(0, y + .5); cr.lineTo(width, y + .5); cr.stroke();
    }
    const frames = Math.ceil(width / this.editorFrameWidth);
    for (let frame = 0; frame <= frames; frame++) {
      const x = frame * this.editorFrameWidth + .5;
      const strong = frame % 16 === 0, medium = frame % 4 === 0;
      cr.setSourceRGBA(accent[0], accent[1], accent[2],
        strong ? (dark ? .34 : .30) : medium ? (dark ? .18 : .17) : (dark ? .07 : .065));
      cr.moveTo(x, 0); cr.lineTo(x, height); cr.stroke();
    }
    const colors = { ch5: [.31, .56, .86], ch6: [.41, .64, .37], ch7: [.65, .47, .82], ch8: [.82, .50, .30] };
    for (const item of this.editorVisibleNotes()) {
      const color = colors[item.channel]; const active = item.channel === this.editorActiveChannel;
      cr.setSourceRGBA(color[0], color[1], color[2], active ? .96 : .22);
      cr.rectangle(item.x + 1, item.y + 1, item.width, item.height); cr.fill();
      cr.setLineWidth(this.editorSelection.has(item.note._editorId) ? 2.5 : 1);
      cr.setSourceRGBA(...(this.editorSelection.has(item.note._editorId) ? (dark ? [1, 1, 1, .95] : [0, 0, 0, .85]) : [0, 0, 0, active ? .36 : .14]));
      cr.rectangle(item.x + 1, item.y + 1, item.width, item.height); cr.stroke(); cr.setLineWidth(1);
      if (item.width > 34) {
        cr.setSourceRGBA(1, 1, 1, active ? .94 : .38); cr.setFontSize(9); cr.moveTo(item.x + 5, item.y + 12);
        cr.showText(item.channel === 'ch8' ? `N$${item.note.frequency.toString(16)}` : pitchName(item.pitch));
      }
    }
    if (this.editorDrag?.mode === 'select' && this.editorDrag.currentX !== undefined) {
      const x = Math.min(this.editorDrag.startX, this.editorDrag.currentX), y = Math.min(this.editorDrag.startY, this.editorDrag.currentY);
      const w = Math.abs(this.editorDrag.currentX - this.editorDrag.startX), h = Math.abs(this.editorDrag.currentY - this.editorDrag.startY);
      cr.setSourceRGBA(accent[0], accent[1], accent[2], .18); cr.rectangle(x, y, w, h); cr.fillPreserve();
      cr.setSourceRGBA(accent[0], accent[1], accent[2], .9); cr.stroke();
    }
    const playhead = (this.editorPlayheadFraction ?? 0) * (this.editor ? editorDuration(this.editor) : 1) * this.editorFrameWidth;
    cr.setSourceRGBA(1, .25, .2, .9); cr.setLineWidth(2); cr.moveTo(playhead, 0); cr.lineTo(playhead, height); cr.stroke(); cr.setLineWidth(1);
  }

  drawEditorVelocity(cr, width, height) {
    const dark = Adw.StyleManager.get_default().dark;
    const accent = this.editorAccent ?? ACCENT_COLORS.blue.slice(1);
    cr.setSourceRGB(...mixColor(dark ? [.10, .11, .12] : [.96, .96, .96], accent, dark ? .04 : .06)); cr.paint();
    const colors = { ch5: [.31, .56, .86], ch6: [.41, .64, .37], ch7: [.65, .47, .82], ch8: [.82, .50, .30] };
    for (const item of this.editorVisibleNotes()) {
      const maximum = item.channel === 'ch7' ? 3 : 15;
      const bar = Math.max(2, item.note.volume / maximum * (height - 8));
      const color = colors[item.channel]; cr.setSourceRGBA(color[0], color[1], color[2], item.channel === this.editorActiveChannel ? .92 : .20);
      cr.rectangle(item.x + 2, height - bar - 2, Math.max(4, Math.min(item.width - 3, this.editorFrameWidth - 4)), bar); cr.fill();
    }
    cr.setSourceRGBA(...(dark ? [1, 1, 1, .12] : [0, 0, 0, .12]));
    for (let value = 0; value <= 15; value += 5) { const y = height - value / 15 * (height - 8) - 2; cr.moveTo(0, y); cr.lineTo(width, y); cr.stroke(); }
  }

  installEditorCanvasControllers() {
    const scroll = Gtk.EventControllerScroll.new(Gtk.EventControllerScrollFlags.BOTH_AXES);
    scroll.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    scroll.connect('scroll', (controller, dx, dy) => {
      let state = controller.get_current_event_state();
      if (Array.isArray(state)) state = state.at(-1);
      if (!(state & Gdk.ModifierType.CONTROL_MASK)) return false;
      const delta = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
      if (delta) this.changeEditorZoom(delta < 0 ? 1 : -1, true);
      return true;
    });
    this.editorCanvas.add_controller(scroll);

    const click = new Gtk.GestureClick({ button: 1 });
    click.connect('pressed', (gesture, presses, x, y) => {
      if (!this.editor) return;
      const hit = this.editorNoteAt(x, y);
      if (hit) this.editorDrawLength = hit.note.duration + 1;
      if (!hit && this.editorSelection.size) {
        this.editorSelection.clear(); this.renderEditorTimeline(); return;
      }
      if (this.editorTool === 'draw' || (!hit && presses === 2)) {
        this.addEditorNoteAt(x, y); return;
      }
      if (hit) {
        let additive = false;
        try {
          const state = gesture.get_current_event_state();
          const flags = Array.isArray(state) ? state.at(-1) : state;
          additive = Boolean(flags & Gdk.ModifierType.CONTROL_MASK);
        } catch (_) { /* No modifier state. */ }
        const selected = this.editorSelection.has(hit.note._editorId);
        if (additive && selected) this.editorSelection.delete(hit.note._editorId);
        else if (!selected) {
          if (!additive) this.editorSelection.clear();
          this.editorSelection.add(hit.note._editorId);
        }
      } else this.editorSelection.clear();
      this.renderEditorTimeline();
    });
    this.editorCanvas.add_controller(click);

    const drag = new Gtk.GestureDrag({ button: 1 });
    drag.connect('drag-begin', (_gesture, x, y) => {
      if (!this.editor || this.editorTool !== 'move') return;
      const hit = this.editorNoteAt(x, y);
      if (hit) {
        if (!this.editorSelection.has(hit.note._editorId)) this.editorSelection = new Set([hit.note._editorId]);
        const resizeHandle = Math.min(6, Math.max(2, hit.width * .2));
        this.editorDrag = { mode: x >= hit.x + hit.width - resizeHandle ? 'resize' : 'move', startX: x, startY: y,
          currentX: x, currentY: y, hit, originals: this.selectedEditorNotes().map(item => ({
            note: item.note, start: item.note._editorStart ?? 0, frequency: item.note.frequency, duration: item.note.duration,
          })) };
      } else this.editorDrag = { mode: 'select', startX: x, startY: y, currentX: x, currentY: y };
      this.renderEditorTimeline();
    });
    drag.connect('drag-update', (_gesture, dx, dy) => {
      if (!this.editorDrag) return;
      this.editorDrag.currentX = this.editorDrag.startX + dx; this.editorDrag.currentY = this.editorDrag.startY + dy;
      if (this.editorDrag.mode === 'move') {
        const frameDelta = Math.round(dx / this.editorFrameWidth), pitchDelta = -Math.round(dy / this.editorRowHeight);
        for (const original of this.editorDrag.originals) {
          original.note._editorStart = Math.max(0, original.start + frameDelta);
          const channel = this.selectedEditorNotes().find(item => item.note === original.note)?.channel;
          if (channel) original.note.frequency = pitchToFrequency(channel, frequencyToPitch(channel, original.frequency) + pitchDelta);
        }
      } else if (this.editorDrag.mode === 'resize') {
        const frameDelta = Math.round(dx / this.editorFrameWidth);
        for (const original of this.editorDrag.originals) original.note.duration = Math.max(0, Math.min(255, original.duration + frameDelta));
      }
      this.renderEditorTimeline();
    });
    drag.connect('drag-end', () => {
      if (!this.editorDrag) return;
      if (this.editorDrag.mode === 'select') {
        const x = Math.min(this.editorDrag.startX, this.editorDrag.currentX), y = Math.min(this.editorDrag.startY, this.editorDrag.currentY);
        const right = Math.max(this.editorDrag.startX, this.editorDrag.currentX), bottom = Math.max(this.editorDrag.startY, this.editorDrag.currentY);
        this.editorSelection.clear();
        for (const item of this.editorVisibleNotes().filter(item => item.channel === this.editorActiveChannel))
          if (item.x < right && item.x + item.width > x && item.y < bottom && item.y + item.height > y)
            this.editorSelection.add(item.note._editorId);
      }
      const changed = this.editorDrag.mode === 'move' || this.editorDrag.mode === 'resize';
      this.editorDrag = null; this.resolveEditorOverlaps();
      if (changed) { this.commitEditorHistory(); this.scheduleEditorPreview(); }
      this.renderEditorTimeline();
    });
    this.editorCanvas.add_controller(drag);
  }

  installEditorVelocityController() {
    const click = new Gtk.GestureClick({ button: 1 });
    click.connect('pressed', (_gesture, _presses, x, y) => {
      const hit = this.editorNoteAt(x, 0, true); if (!hit) return;
      this.editorDrawLength = hit.note.duration + 1;
      const maximum = hit.channel === 'ch7' ? 3 : 15;
      const height = Math.max(1, this.editorVelocityArea.get_height());
      hit.note.volume = Math.max(0, Math.min(maximum, Math.round((1 - y / height) * maximum)));
      this.editorSelection = new Set([hit.note._editorId]); this.commitEditorHistory();
      this.renderEditorTimeline(); this.scheduleEditorPreview();
    });
    this.editorVelocityArea.add_controller(click);
  }

  addEditorNoteAt(x, y) {
    if (!this.editor) return;
    const channel = this.editorActiveChannel;
    const pitch = Math.max(PIANO_LOW, Math.min(PIANO_HIGH, PIANO_HIGH - Math.floor(y / this.editorRowHeight)));
    const note = this.normalizeEditorNote({ duration: this.editorDrawLength - 1, frequency: pitchToFrequency(channel, pitch),
      _editorStart: Math.max(0, Math.floor(x / this.editorFrameWidth)) }, channel);
    this.editor.channels[channel].push(note); this.editorSelection.clear();
    this.resolveEditorOverlaps(); this.commitEditorHistory(); this.renderEditorTimeline(); this.scheduleEditorPreview();
  }

  changeEditorZoom(direction, preserveViewport = false) {
    const horizontal = this.editorPianoScroll?.get_hadjustment();
    const vertical = this.editorPianoScroll?.get_vadjustment();
    const viewportWidth = this.editorPianoScroll?.get_width() ?? 0;
    const viewportHeight = this.editorPianoScroll?.get_height() ?? 0;
    const centerFrame = horizontal
      ? (horizontal.get_value() + viewportWidth / 2) / this.editorFrameWidth
      : 0;
    const centerRow = vertical
      ? (vertical.get_value() + viewportHeight / 2) / this.editorRowHeight
      : 0;
    this.editorFrameWidth = Math.max(5, Math.min(28, this.editorFrameWidth + direction * 2));
    this.editorRowHeight = Math.max(12, Math.min(28, this.editorRowHeight + direction));
    this.renderEditorTimeline();
    if (preserveViewport && horizontal && vertical) {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        horizontal.set_value(centerFrame * this.editorFrameWidth - viewportWidth / 2);
        vertical.set_value(centerRow * this.editorRowHeight - viewportHeight / 2);
        return GLib.SOURCE_REMOVE;
      });
    }
  }

  resolveEditorOverlaps() {
    if (!this.editor) return;
    for (const notes of Object.values(this.editor.channels)) {
      notes.sort((a, b) => (a._editorStart ?? 0) - (b._editorStart ?? 0) || a._editorId - b._editorId);
      let cursor = 0;
      for (const note of notes) {
        note._editorStart = Math.max(cursor, Math.round(note._editorStart ?? cursor));
        cursor = note._editorStart + note.duration + 1;
      }
    }
  }

  updateEditorProperties() {
    const selected = this.selectedEditorNotes(); this.ignoreEditorProperties = true;
    for (const [side, spin] of Object.entries(this.editorMasterVolumeSpins)) {
      spin.sensitive = Boolean(this.editor);
      spin.set_value(this.editor?.pan?.[side] ?? 7);
    }
    this.editorSelectionLabel.label = selected.length ? `${selected.length} note${selected.length === 1 ? '' : 's'} selected` : 'No notes selected';
    if (selected.length) {
      const { channel, note } = selected[0];
      this.editorPitchLabel.label = channel === 'ch8'
        ? `Noise register $${note.frequency.toString(16).padStart(2, '0')}`
        : `Pitch ${pitchName(frequencyToPitch(channel, note.frequency))}`;
    } else this.editorPitchLabel.label = 'Pitch —';
    const channels = new Set(selected.map(item => item.channel));
    const square = channels.size === 1 && this.editorKind(selected[0]?.channel) === 'square';
    const specs = editorNotePropertySpecs(selected[0]?.channel ?? this.editorActiveChannel);
    this.editorPropertyRows.duty.visible = square;
    this.editorDutyPatternRow.visible = square;
    this.editorPropertyRows.sweepPeriod.visible = square && selected[0]?.channel === 'ch5';
    this.editorPropertyRows.sweepShift.visible = square && selected[0]?.channel === 'ch5';
    for (const [key, spin] of Object.entries(this.editorPropertySpins)) {
      spin.sensitive = selected.length > 0;
      const spec = specs[key], adjustment = spin.get_adjustment();
      adjustment.set_lower(spec.min); adjustment.set_upper(spec.max);
      this.editorPropertyLabels[key].label = spec.label;
      const note = selected[0]?.note;
      const value = key === 'duration' ? note?.duration ?? 0 :
        key === 'sweepPeriod' ? note?.sweep?.[0] ?? 0 : key === 'sweepShift' ? note?.sweep?.[1] ?? 0 : note?.[key] ?? 0;
      spin.set_value(value);
    }
    const routes = ['both', 'left', 'right', 'none'];
    this.editorRouteChoice.sensitive = selected.length > 0;
    this.editorRouteChoice.selected = Math.max(0, routes.indexOf(selected[0]?.note.route ?? 'both'));
    const patterns = selected.map(item => item.note.dutyPattern?.join(', ') ?? '');
    this.editorDutyPatternEntry.text = selected.length && patterns.every(pattern => pattern === patterns[0]) ? patterns[0] : '';
    this.editorDutyPatternEntry.sensitive = square;
    for (const button of Object.values(this.editorToolButtons)) button.sensitive = selected.length === 0;
    this.ignoreEditorProperties = false;
  }

  changeEditorProperty(property, value) {
    if (this.ignoreEditorProperties) return;
    for (const { channel, note } of this.selectedEditorNotes()) {
      if (property === 'sweepPeriod' || property === 'sweepShift') {
        if (channel !== 'ch5') continue;
        note.sweep ??= [0, 0]; note.sweep[property === 'sweepPeriod' ? 0 : 1] = value;
      } else if (property === 'duty') {
        if (this.editorKind(channel) !== 'square') continue;
        setFixedDuty(note, value);
      } else note[property] = value;
      Object.assign(note, this.normalizeEditorNote(note, channel));
    }
    this.resolveEditorOverlaps(); this.commitEditorHistory(); this.renderEditorTimeline(); this.scheduleEditorPreview();
  }

  changeEditorMasterVolume(side, value) {
    if (this.ignoreEditorProperties || !this.editor) return;
    try { setMasterVolume(this.editor, side, value); }
    catch (error) { this.showToast(error.message); this.updateEditorProperties(); return; }
    this.commitEditorHistory(); this.renderEditorTimeline(); this.scheduleEditorPreview();
  }

  changeEditorRoute(selected) {
    if (this.ignoreEditorProperties) return;
    const route = ['both', 'left', 'right', 'none'][selected];
    if (!route) return;
    for (const { note } of this.selectedEditorNotes()) note.route = route;
    this.commitEditorHistory(); this.renderEditorTimeline(); this.scheduleEditorPreview();
  }

  changeEditorDutyPattern(rawValue) {
    if (this.ignoreEditorProperties) return;
    let pattern;
    try { pattern = parseDutyPattern(rawValue); }
    catch (error) { this.showToast(error.message); this.updateEditorProperties(); return; }
    const selected = this.selectedEditorNotes().filter(({ channel }) => this.editorKind(channel) === 'square');
    const patternId = pattern ? this.nextEditorNoteId++ : undefined;
    for (const { note } of selected) setDutyPattern(note, pattern, patternId);
    this.commitEditorHistory(); this.renderEditorTimeline(); this.scheduleEditorPreview();
    if (this.editorDutyPatternEntry.has_focus()) this.editorDutyPatternFocusText = this.editorDutyPatternEntry.text;
  }

  copyEditorNotes() {
    this.editorClipboard = this.selectedEditorNotes().map(item => ({ ...item, note: {
      ...item.note,
      sweep: item.note.sweep && [...item.note.sweep],
      dutyPattern: item.note.dutyPattern && [...item.note.dutyPattern],
    } }));
  }
  cutEditorNotes() { this.copyEditorNotes(); this.deleteEditorNotes(); }
  deleteEditorNotes() {
    if (!this.editor) return;
    for (const key of Object.keys(this.editor.channels))
      this.editor.channels[key] = this.editor.channels[key].filter(note => !this.editorSelection.has(note._editorId));
    this.editorSelection.clear(); this.commitEditorHistory(); this.renderEditorTimeline(); this.scheduleEditorPreview();
  }
  pasteEditorNotes() {
    if (!this.editor || !this.editorClipboard.length) return;
    const notes = this.editorClipboard.map(item => this.normalizeEditorNote({ ...item.note, _editorId: null,
      frequency: pitchToFrequency(this.editorActiveChannel, frequencyToPitch(item.channel, item.note.frequency)),
      _editorStart: item.note._editorStart ?? 0 }, this.editorActiveChannel));
    const overlaps = (left, right) => {
      const leftStart = left._editorStart ?? 0, rightStart = right._editorStart ?? 0;
      return leftStart < rightStart + right.duration + 1 && rightStart < leftStart + left.duration + 1;
    };
    this.editor.channels[this.editorActiveChannel] = this.editor.channels[this.editorActiveChannel]
      .filter(existing => !notes.some(note => overlaps(existing, note)));
    this.editor.channels[this.editorActiveChannel].push(...notes);
    this.editorSelection = new Set(notes.map(note => note._editorId));
    this.resolveEditorOverlaps(); this.commitEditorHistory(); this.renderEditorTimeline(); this.scheduleEditorPreview();
  }

  setEditorPlaybackAnchor(seconds) {
    const now = GLib.get_monotonic_time();
    this.editorPlaybackAnchorPosition = Math.max(0, seconds);
    this.editorPlaybackAnchorTime = now;
    this.editorPlaybackLastQuery = now;
  }

  seekEditorFraction(fraction) {
    fraction = Math.max(0, Math.min(1, Number(fraction) || 0));
    this.editorPlayheadFraction = fraction;
    this.editorTransportScale.set_value(fraction);
    const duration = this.editorPreviewDuration ?? 0;
    this.setEditorPlaybackAnchor(duration * fraction);
    this.editorTimeLabel.label = `${(duration * fraction).toFixed(2)} / ${duration.toFixed(2)} seconds`;
    this.editorCanvas.queue_draw(); this.editorRulerArea.queue_draw();
    if (duration > 0) {
      const position = Math.round(duration * fraction * Gst.SECOND);
      this.editorPlayer.seek(position);
    }
  }

  finishEditorPlayback() {
    const duration = this.editorPreviewDuration ?? 0;
    this.setEditorPlaybackAnchor(duration);
    this.editorPlayheadFraction = 1;
    this.editorTransportScale.set_value(1);
    this.editorTimeLabel.label = `${duration.toFixed(2)} / ${duration.toFixed(2)} seconds`;
    this.editorCanvas.queue_draw(); this.editorRulerArea.queue_draw();
  }

  scheduleEditorPreview() {
    if (!this.editor) return;
    this.editorPreviewDirty = true;
    this.removeEditorPreviewFile(true);
  }

  prepareEditorPreview() {
    if (!this.editor) return false;
    if (!this.editorPreviewDirty && this.editorPreviewFile?.query_exists(null)) return true;
    try {
      const materialized = materializeEditorCry(this.editor);
      const enabledChannels = Object.entries(this.editorChannelChecks)
        .filter(([, check]) => check.active).map(([channel]) => channel);
      const audible = muteEditorChannels(materialized, enabledChannels);
      const project = applyCryParameters(audible, 0, this.editorLengthSpin.get_value_as_int());
      const frames = Math.max(1, ...Object.values(project.channels)
        .map(notes => notes.reduce((sum, note) => sum + (note.frames ?? note.duration + 1), 0)));
      const expectedDuration = frames / FRAME_RATE;
      if (expectedDuration > 300) throw new Error('The edited cry is longer than the 5-minute preview limit.');
      const wav = renderPreview(project, expectedDuration + 1);
      this.removeEditorPreviewFile();
      const [descriptor, path] = GLib.file_open_tmp('siren-editor-XXXXXX.wav'); GLib.close(descriptor);
      const file = Gio.File.new_for_path(path);
      file.replace_contents(new Uint8Array(wav), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
      this.editorPreviewFile = file;
      this.editorPreviewDirty = false;
      this.editorPreviewDuration = readWav(wav).duration;
      this.editorPlayer.setUri(file.get_uri());
      const fraction = Math.max(0, Math.min(1, this.editorPlayheadFraction ?? 0));
      this.editorTimeLabel.label = `${(this.editorPreviewDuration * fraction).toFixed(2)} / ${this.editorPreviewDuration.toFixed(2)} seconds`;
      this.editorTransportScale.sensitive = true;
      this.editorTransportScale.set_value(fraction);
      this.editorCanvas.queue_draw(); this.editorRulerArea.queue_draw();
      return true;
    } catch (error) {
      this.showToast(`Could not prepare preview: ${error.message}`);
      this.editorButton.sensitive = true;
      return false;
    }
  }

  removeEditorPreviewFile(keepPlayable = false) {
    this.editorPlayer?.stop();
    if (this.editorPreviewFile) { try { this.editorPreviewFile.delete(null); } catch (_) { /* Removed. */ } this.editorPreviewFile = null; }
    if (this.editorPlayer) this.editorPlayer.uri = null;
    if (this.editorButton) this.editorButton.sensitive = keepPlayable && Boolean(this.editor);
  }

  saveEditorAsm() {
    if (!this.editorFile || !this.editorCries.size) return;
    try {
      const asm = [...this.editorCries.values()].map(sourceCry => {
        const cry = materializeEditorCry(sourceCry);
        const enabledChannels = Object.entries(cry.channels).filter(([, notes]) => notes.length).map(([key]) => key);
        const label = cry.label.replace(/^Cry_/, '') || 'Edited';
        return makeAsm({ ...cry, label, precise: true, enabledChannels }, this.editorFile.get_basename());
      }).join('\n\n');

      const current = materializeEditorCry(this.editor);
      const audibleChannels = Object.entries(this.editorChannelChecks)
        .filter(([, check]) => check.active).map(([channel]) => channel);
      const audible = muteEditorChannels(current, audibleChannels);
      const project = applyCryParameters(audible, 0, this.editorLengthSpin.get_value_as_int());
      const frames = Math.max(1, ...Object.values(project.channels)
        .map(notes => notes.reduce((sum, note) => sum + (note.frames ?? note.duration + 1), 0)));
      const duration = frames / FRAME_RATE;
      if (duration > 300) throw new Error('The edited cry is longer than the 5-minute WAV export limit.');
      const wav = renderPreview(project, duration + 1);

      const parent = this.editorFile.get_parent();
      const wavFile = parent.get_child(this.editorFile.get_basename().replace(/\.asm$/i, '.wav'));
      this.editorFile.replace_contents(encoder.encode(asm), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
      wavFile.replace_contents(new Uint8Array(wav), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
      this.showToast(`Saved ${this.editorFile.get_basename()} and ${wavFile.get_basename()}`);
    } catch (error) { this.showToast(`Could not save project: ${error.message}`); }
  }

  loadAsm(file) {
    try {
      const parent = file.get_parent();
      const dataDirectory = parent?.get_parent();
      if (file.get_basename().toLowerCase() !== 'cries.asm' || parent?.get_basename().toLowerCase() !== 'pokemon' ||
          dataDirectory?.get_basename().toLowerCase() !== 'data')
        throw new Error('Choose the project file data/pokemon/cries.asm.');
      const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
      if (info.get_size() > 2 * 1024 * 1024) throw new Error('Choose a cries.asm file smaller than 2 MB.');
      const backup = parent.get_child(`${file.get_basename()}.backup`);
      file.copy(backup, Gio.FileCopyFlags.OVERWRITE, null, null);
      const [, contents] = file.load_contents(null);
      const source = new TextDecoder('utf-8', { fatal: true }).decode(contents);
      const projectRoot = dataDirectory.get_parent();
      const constantsFile = projectRoot.resolve_relative_path('constants/cry_constants.asm');
      const pointersFile = projectRoot.resolve_relative_path('audio/cry_pointers.asm');
      if (!constantsFile.query_exists(null)) throw new Error('Could not find constants/cry_constants.asm in this project.');
      if (!pointersFile.query_exists(null)) throw new Error('Could not find audio/cry_pointers.asm in this project.');
      const [, constantContents] = constantsFile.load_contents(null);
      const [, pointerContents] = pointersFile.load_contents(null);
      const constantsText = new TextDecoder('utf-8', { fatal: true }).decode(constantContents);
      const pointersText = new TextDecoder('utf-8', { fatal: true }).decode(pointerContents);
      const document = parseCryList(source);
      const constants = parseCryConstants(constantsText);
      const pointers = parseCryPointers(pointersText);
      const definitions = resolveCryDefinitionSources(constants, pointers,
        loadCryDefinitionSources(projectRoot, pointers));
      const known = new Set(constants.map(value => value.toUpperCase()));
      const unknown = document.entries.find(entry => !known.has(entry.constant.toUpperCase()));
      if (unknown) throw new Error(`Line ${unknown.lineNumber}: ${unknown.constant} is missing from constants/cry_constants.asm.`);
      this.removeValidationFile();
      this.validationListFile = file;
      this.validationDocument = document;
      this.validationConstants = constants;
      this.validationConstantModel = Gtk.StringList.new(constants);
      this.validationDefinitions = definitions;
      this.populateCryListRows();
      this.validationRow.title = file.get_basename();
      this.validationRow.subtitle = `${document.entries.length} entries · backup: ${backup.get_basename()}`;
      this.validationSaveButton.sensitive = true;
      this.modeStack.visible_child_name = 'validation';
    } catch (error) { this.showToast(`Could not open cry list: ${error.message}`); }
  }

  populateCryListRows() {
    while (this.validationList.get_first_child()) this.validationList.remove(this.validationList.get_first_child());
    this.validationRows = this.validationDocument.entries.map(entry => {
      const grid = new Gtk.Grid({ column_spacing: 8, margin_top: 5, margin_bottom: 5, margin_start: 8, margin_end: 8,
        hexpand: true });
      const play = new Gtk.Button({ icon_name: 'media-playback-start-symbolic', tooltip_text: `Play ${entry.species || entry.constant}`,
        width_request: 38, valign: Gtk.Align.CENTER });
      play.add_css_class('circular'); grid.attach(play, 0, 0, 1, 1);
      const macro = new Gtk.Entry({ text: entry.macro, width_request: 125, hexpand: false }); grid.attach(macro, 1, 0, 1, 1);
      macro.tooltip_text = `Macro for line ${entry.lineNumber}`;
      const constant = new Gtk.DropDown({ model: this.validationConstantModel, width_request: 220 });
      constant.tooltip_text = `Cry constant for line ${entry.lineNumber}`;
      constant.selected = Math.max(0, this.validationConstants.findIndex(value => value.toUpperCase() === entry.constant.toUpperCase()));
      grid.attach(constant, 2, 0, 1, 1);
      const pitch = new Gtk.SpinButton({ adjustment: new Gtk.Adjustment({ value: entry.pitch, lower: PITCH_MIN,
        upper: PITCH_MAX, step_increment: 1, page_increment: 16 }), numeric: true, width_chars: 9, width_request: 105 });
      pitch.set_value(entry.pitch);
      pitch.tooltip_text = `Decimal pitch for line ${entry.lineNumber}`;
      grid.attach(pitch, 3, 0, 1, 1);
      const length = new Gtk.SpinButton({ adjustment: new Gtk.Adjustment({ value: entry.length, lower: LENGTH_MIN,
        upper: LENGTH_MAX, step_increment: 1, page_increment: 16 }), numeric: true, width_chars: 9, width_request: 105 });
      length.set_value(entry.length);
      length.tooltip_text = `Decimal length for line ${entry.lineNumber}`;
      grid.attach(length, 4, 0, 1, 1);
      const species = new Gtk.Entry({ text: entry.species, placeholder_text: 'Optional comment', hexpand: true, width_request: 180 });
      species.tooltip_text = `Species comment for line ${entry.lineNumber}`;
      grid.attach(species, 5, 0, 1, 1);
      for (const [column, widget] of [play, macro, constant, pitch, length, species].entries())
        this.validationColumnGroups[column].add_widget(widget);
      const row = { entry, play, macro, constant, pitch, length, species };
      play.connect('clicked', () => this.playCryListRow(row));
      this.validationList.append(new Gtk.ListBoxRow({ child: grid, selectable: false, activatable: false }));
      return row;
    });
  }

  cryListValues() {
    return this.validationRows.map(row => ({
      macro: row.macro.text,
      constant: this.validationConstants[row.constant.selected],
      pitch: row.pitch.get_value_as_int(),
      length: row.length.get_value_as_int(),
      species: row.species.text,
    }));
  }

  resetValidationPlayButton() {
    if (this.validationActiveButton) this.validationActiveButton.icon_name = 'media-playback-start-symbolic';
    this.validationActiveButton = null;
  }

  playCryListRow(row) {
    if (this.validationActiveButton === row.play && this.validationPlayer.playing) {
      this.validationPlayer.stop(); this.resetValidationPlayButton(); return;
    }
    try {
      this.validationPlayer.stop(); this.resetValidationPlayButton();
      const constant = this.validationConstants[row.constant.selected];
      const definition = this.validationDefinitions.get(constant.toUpperCase());
      if (!definition) throw new Error(`${constant} has no matching definition in the project audio files.`);
      const cry = parseCryAsm(definition.source, definition.label);
      const project = applyCryParameters(cry, row.pitch.get_value_as_int(), row.length.get_value_as_int());
      project.allowTruncatedPreview = true;
      const wav = renderPreview(project, 15);
      this.removeValidationFile();
      const [descriptor, path] = GLib.file_open_tmp('siren-validation-XXXXXX.wav'); GLib.close(descriptor);
      const file = Gio.File.new_for_path(path);
      file.replace_contents(new Uint8Array(wav), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
      this.validationFile = file;
      this.validationActiveButton = row.play;
      this.validationPlayer.setUri(file.get_uri());
      this.validationPlayer.play();
      row.play.icon_name = 'media-playback-pause-symbolic';
    } catch (error) {
      this.resetValidationPlayButton();
      this.showToast(`Could not preview cry: ${error.message}`);
    }
  }

  saveCryList() {
    if (!this.validationListFile || !this.validationDocument) return;
    try {
      const source = renderCryList(this.validationDocument, this.cryListValues());
      this.validationListFile.replace_contents(encoder.encode(source), null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
      this.validationDocument = parseCryList(source);
      this.validationDocument.entries.forEach((entry, index) => { this.validationRows[index].entry = entry; });
      this.validationRow.subtitle = `${this.validationDocument.entries.length} entries · saved · backup: ${this.validationListFile.get_basename()}.backup`;
      this.showToast(`Saved ${this.validationListFile.get_basename()}`);
    } catch (error) { this.showToast(`Could not save cry list: ${error.message}`); }
  }

  removeValidationFile() {
    this.validationPlayer?.stop();
    this.resetValidationPlayButton();
    if (this.validationFile) {
      try { this.validationFile.delete(null); } catch (_) { /* Already removed. */ }
      this.validationFile = null;
    }
  }

  loadFile(file) {
    try {
      const info = file.query_info('standard::size,standard::name', Gio.FileQueryInfoFlags.NONE, null);
      if (info.get_size() > MAX_BYTES) throw new Error('Choose a WAV smaller than 20 MB.');
      const [, contents] = file.load_contents(null);
      const source = readWav(arrayBuffer(contents));
      if (source.duration > MAX_SECONDS + 0.0005)
        throw new Error(`Choose a WAV no longer than ${MAX_SECONDS} seconds.`);
      const prepared = prepareWav(source, 0, source.duration);
      const preparedSamples = readWav(prepared.wav).samples;

      this.originalPlayer.stop();
      this.convertedPlayer.stop();
      this.sourceFile = file;
      this.preparedSamples = preparedSamples;
      this.stereoBalance = prepared.stereoBalance;
      this.project = null;
      this.baseProject = null;
      this.fileRow.title = file.get_basename();
      this.fileRow.subtitle = `${source.channels} channel${source.channels === 1 ? '' : 's'} · ${source.rate.toLocaleString()} Hz · ${formatDuration(source.duration)}`;
      this.originalRow.subtitle = formatDuration(source.duration);
      this.writeOriginalPreview(makePlaybackWav(source));
      this.stack.visible_child_name = 'content';

      let selected = this.presets.findIndex(preset => preset.id === 'none');
      if (selected < 0) selected = this.presets.findIndex(preset => preset.type === 'profile');
      this.ignorePresetChanges = true;
      this.presetRow.selected = selected;
      this.ignorePresetChanges = false;
      for (const scale of Object.values(this.modifierScales)) scale.set_value(0);
      const preset = this.presets[selected];
      this.beginConversion(preset);
    } catch (error) {
      this.showToast(error.message);
    }
  }

  setBusy(busy, message = '') {
    this.spinner.visible = busy;
    this.spinner.spinning = busy;
    this.presetRow.sensitive = !busy;
    this.volumeScale.sensitive = !busy;
    this.fadeInButton.sensitive = !busy;
    this.fadeOutButton.sensitive = !busy;
    for (const check of Object.values(this.channelChecks)) check.sensitive = !busy;
    for (const scale of Object.values(this.modifierScales)) scale.sensitive = !busy;
    this.exportButton.sensitive = !busy && Boolean(this.project);
    this.exportWavButton.sensitive = !busy && Boolean(this.project);
    this.convertedButton.sensitive = !busy && Boolean(this.previewFile);
    if (message) this.convertedRow.subtitle = message;
  }

  beginConversion(preset) {
    const serial = ++this.conversionSerial;
    if (this.effectTimer) {
      GLib.source_remove(this.effectTimer);
      this.effectTimer = 0;
    }
    this.convertedPlayer.stop();
    this.setBusy(true, preset.type === 'auto' ? 'Testing conversion profiles…' :
      preset.options?.precise ? 'Comparing hardware fits…' : 'Converting…');
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (serial !== this.conversionSerial) return GLib.SOURCE_REMOVE;
      try {
        let result, preview, fittedModifiers = null;
        let detail = preset.name;
        if (preset.type === 'auto') {
          const fitted = fitAutoPreset(this.preparedSamples, this.profilePresets, preset,
            (current, total) => { this.convertedRow.subtitle = `Testing profile ${current} of ${total}…`; });
          result = fitted.result;
          const basis = this.presets.find(item => item.id === fitted.basis);
          detail = `${preset.name} · based on ${basis?.name ?? fitted.basis}`;
          fittedModifiers = fitted.modifiers;
        } else if (preset.options?.precise) {
          const fitted = fitPrecisePreset(this.preparedSamples, this.stereoBalance);
          result = fitted.result;
          preview = fitted.preview;
          fittedModifiers = fitted.modifiers;
        } else {
          result = convert(this.preparedSamples, { ...preset.options, stereoBalance: this.stereoBalance });
        }
        if (serial !== this.conversionSerial) return GLib.SOURCE_REMOVE;
        this.baseProject = { ...result, label: suggestedLabel(this.sourceFile.get_basename()) };
        this.ignoreEffectChanges = true;
        if (fittedModifiers) for (const [key, value] of Object.entries(fittedModifiers))
          this.modifierScales[key]?.set_value(value);
        this.volumeScale.set_value(detectConversionVolume(this.baseProject));
        this.ignoreEffectChanges = false;
        this.currentEffectName = detail;
        this.applyEffects(preview);
        this.convertedRow.subtitle = `${detail} · ${formatDuration(result.previewDuration ?? result.sourceDuration)}`;
        this.setBusy(false);
      } catch (error) {
        this.project = null;
        this.baseProject = null;
        this.setBusy(false, 'Conversion failed');
        this.showToast(error.message);
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  effectOptions() {
    return {
      volumePercent: Math.round(this.volumeScale.get_value()),
      fadeIn: this.fadeInButton.active,
      fadeOut: this.fadeOutButton.active,
      enabledChannels: Object.entries(this.channelChecks).filter(([, check]) => check.active).map(([key]) => key),
      ...Object.fromEntries(Object.entries(this.modifierScales).map(([key, scale]) => [key, Math.round(scale.get_value())])),
    };
  }

  scheduleEffects() {
    if (this.ignoreEffectChanges || !this.baseProject) return;
    if (this.effectTimer) GLib.source_remove(this.effectTimer);
    this.effectTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      this.effectTimer = 0;
      try { this.applyEffects(); }
      catch (error) { this.showToast(error.message); }
      return GLib.SOURCE_REMOVE;
    });
  }

  applyEffects(defaultPreview = null) {
    const options = this.effectOptions();
    this.project = {
      ...applyConversionEffects(this.baseProject, options),
      conversionMetadata: {
        effect: this.currentEffectName ?? this.presets[this.presetRow.selected]?.name ?? 'None',
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
    const unchanged = options.volumePercent === detectConversionVolume(this.baseProject) &&
      !options.fadeIn && !options.fadeOut && options.enabledChannels.length === 4 &&
      ['pitch', 'resonance', 'weight', 'intonation', 'texture', 'breathiness'].every(key => options[key] === 0);
    this.writePreview(unchanged && defaultPreview ? defaultPreview : renderPreview(this.project));
  }

  writePreview(buffer) {
    this.removePreviewFile();
    const [fileDescriptor, path] = GLib.file_open_tmp('siren-preview-XXXXXX.wav');
    GLib.close(fileDescriptor);
    const file = Gio.File.new_for_path(path);
    file.replace_contents(new Uint8Array(buffer), null, false,
      Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    this.previewFile = file;
    this.convertedPlayer.setUri(file.get_uri());
  }

  writeOriginalPreview(buffer) {
    this.removeOriginalPreviewFile();
    const [fileDescriptor, path] = GLib.file_open_tmp('siren-original-XXXXXX.wav');
    GLib.close(fileDescriptor);
    const file = Gio.File.new_for_path(path);
    file.replace_contents(new Uint8Array(buffer), null, false,
      Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    this.originalPreviewFile = file;
    this.originalPlayer.setUri(file.get_uri());
  }

  removePreviewFile() {
    this.convertedPlayer?.stop();
    if (this.previewFile) {
      try { this.previewFile.delete(null); } catch (_) { /* Already removed. */ }
      this.previewFile = null;
    }
  }

  removeOriginalPreviewFile() {
    this.originalPlayer?.stop();
    if (this.originalPreviewFile) {
      try { this.originalPreviewFile.delete(null); } catch (_) { /* Already removed. */ }
      this.originalPreviewFile = null;
    }
  }

  exportWav() {
    if (!this.previewFile || !this.sourceFile) return;
    const basename = this.sourceFile.get_basename().replace(/\.wav$/i, '-converted.wav');
    const output = this.sourceFile.get_parent().get_child(basename);
    const write = () => {
      try {
        const [, contents] = this.previewFile.load_contents(null);
        output.replace_contents(contents, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        this.showToast(`Exported ${basename}`);
      } catch (error) { this.showToast(`Could not export WAV: ${error.message}`); }
    };
    if (output.query_exists(null)) {
      const dialog = new Gtk.AlertDialog({ message: `Replace ${basename}?`,
        detail: 'A converted WAV with this name already exists in the source folder.',
        buttons: ['Cancel', 'Replace'], cancel_button: 0, default_button: 1 });
      dialog.choose(this.window, null, (source, result) => {
        try { if (source.choose_finish(result) === 1) write(); } catch (_) { /* Dismissed. */ }
      });
    } else write();
  }

  exportAsm() {
    if (!this.project || !this.sourceFile) return;
    const basename = this.sourceFile.get_basename().replace(/\.wav$/i, '.asm');
    const output = this.sourceFile.get_parent().get_child(basename);
    if (output.query_exists(null)) {
      const dialog = new Gtk.AlertDialog({
        message: `Replace ${basename}?`,
        detail: 'An ASM file with this name already exists in the source folder.',
        buttons: ['Cancel', 'Replace'],
        cancel_button: 0,
        default_button: 1,
      });
      dialog.choose(this.window, null, (source, result) => {
        try {
          if (source.choose_finish(result) === 1) this.writeAsm(output);
        } catch (_) { /* The dialog was dismissed. */ }
      });
    } else {
      this.writeAsm(output);
    }
  }

  writeAsm(output) {
    try {
      const asm = makeAsm(this.project, this.sourceFile.get_basename());
      output.replace_contents(encoder.encode(asm), null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
      this.showToast(`Exported ${output.get_basename()}`);
    } catch (error) {
      this.showToast(`Could not export ASM: ${error.message}`);
    }
  }
}

if (ARGV.includes('--check-icons')) {
  const appDir = GLib.getenv('APPDIR');
  if (!appDir) throw new Error('--check-icons is intended for an AppImage build.');
  const icons = [
    'usr/share/icons/Adwaita/symbolic/actions/open-menu-symbolic.svg',
    'usr/share/icons/Adwaita/symbolic/actions/media-playback-start-symbolic.svg',
    'usr/share/icons/hicolor/symbolic/actions/questionmark-symbolic.svg',
    'usr/share/icons/hicolor/scalable/apps/io.github.mauvesea.Siren.svg',
    'usr/share/icons/hicolor/symbolic/apps/io.github.mauvesea.Siren-symbolic.svg',
  ];
  for (const icon of icons) {
    const path = GLib.build_filenamev([appDir, icon]);
    GdkPixbuf.Pixbuf.new_from_file(path);
  }
  print(`Loaded ${icons.length} bundled SVG icons.`);
} else if (ARGV.includes('--version')) {
  print(`Siren ${VERSION}`);
} else {
  Gst.init(null);
  const application = new Adw.Application({
    application_id: APP_ID,
    flags: Gio.ApplicationFlags.HANDLES_OPEN,
  });
  const controllers = new Map();
  const firstSection = new Gio.Menu();
  firstSection.append('New Window', 'app.new-window');
  firstSection.append('Open', 'app.open');
  const lastSection = new Gio.Menu();
  lastSection.append('About Siren', 'app.about');
  const menu = new Gio.Menu();
  menu.append_section(null, firstSection);
  menu.append_section(null, lastSection);

  const createWindow = () => {
    const controller = new SirenWindow(application, menu);
    controllers.set(controller.window, controller);
    controller.window.connect('destroy', () => controllers.delete(controller.window));
    controller.present();
    return controller;
  };
  const activeWindow = () => {
    const current = application.get_active_window();
    return controllers.get(current) || createWindow();
  };
  const addAction = (name, callback) => {
    const action = new Gio.SimpleAction({ name });
    action.connect('activate', callback);
    application.add_action(action);
  };
  addAction('new-window', () => createWindow());
  addAction('open', () => activeWindow().chooseFile());
  addAction('about', () => {
    const about = new Adw.AboutDialog({
      application_name: 'Siren',
      application_icon: APP_ID,
      developer_name: 'Mauvesea',
      version: VERSION,
      comments: 'Convert WAV audio and audition pokecrystal cry parameters.',
    });
    about.add_link('Repository', REPOSITORY_URL);
    about.add_link('Report an Issue', `${REPOSITORY_URL}/issues/new`);
    about.present(activeWindow().window);
  });
  application.connect('activate', () => {
    const current = application.get_active_window();
    if (current) current.present();
    else createWindow();
  });
  application.connect('open', (_app, files) => {
    const window = activeWindow();
    if (files.length) {
      if (/\.asm$/i.test(files[0].get_basename())) window.loadAsm(files[0]);
      else window.loadFile(files[0]);
    }
  });
  application.run(ARGV);
}
