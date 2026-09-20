#!/usr/bin/env -S gjs -m

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gst from 'gi://Gst?version=1.0';
import Gtk from 'gi://Gtk?version=4.0';

import { MAX_BYTES, MAX_SECONDS, makeAsm, prepareWav, readWav, suggestedLabel, convert } from './converter.js';
import { fitAutoPreset, suggestPreset } from './preset-engine.js';
import { loadPresetDirectories } from './preset-loader.js';
import { renderPreview } from './preview.js';

const APP_ID = 'io.github.mauvesea.Siren';
const VERSION = '1.0.0';
const REPOSITORY_URL = 'https://github.com/mauvesea/pokecry';
const encoder = new TextEncoder();

function formatDuration(seconds) {
  return `${seconds.toFixed(seconds < 1 ? 2 : 1)} seconds`;
}

function arrayBuffer(contents) {
  return Uint8Array.from(contents).buffer;
}

class AudioPlayer {
  constructor(button, onStarted, onError) {
    this.button = button;
    this.onStarted = onStarted;
    this.onError = onError;
    this.uri = null;
    this.playing = false;
    this.player = Gst.ElementFactory.make('playbin', null);
    const bus = this.player.get_bus();
    bus.add_signal_watch();
    bus.connect('message', (_bus, message) => {
      if (message.type === Gst.MessageType.EOS) this.stop();
      if (message.type === Gst.MessageType.ERROR) {
        const [error] = message.parse_error();
        this.stop();
        this.onError(`Could not play audio: ${error.message}`);
      }
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
    if (!this.uri) return;
    this.onStarted(this);
    this.player.uri = this.uri;
    const result = this.player.set_state(Gst.State.PLAYING);
    if (result === Gst.StateChangeReturn.FAILURE) {
      this.onError('Could not start audio playback.');
      return;
    }
    this.playing = true;
    this.updateButton();
  }

  stop() {
    this.player.set_state(Gst.State.NULL);
    this.playing = false;
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
    this.previewFile = null;
    this.conversionSerial = 0;
    this.ignorePresetChanges = false;

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
      default_width: 720,
      default_height: 620,
      width_request: 420,
      height_request: 480,
    });

    this.toastOverlay = new Adw.ToastOverlay();
    this.stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE });
    this.toastOverlay.child = this.stack;

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
    toolbar.content = this.toastOverlay;
    this.window.content = toolbar;

    this.buildEmptyPage();
    this.buildContentPage();
    this.stack.visible_child_name = 'empty';

    const dropTarget = Gtk.DropTarget.new(Gio.File.$gtype, Gdk.DragAction.COPY);
    dropTarget.connect('drop', (_target, file) => {
      this.loadFile(file);
      return true;
    });
    this.window.add_controller(dropTarget);

    this.window.connect('close-request', () => {
      this.originalPlayer.stop();
      this.convertedPlayer.stop();
      this.removePreviewFile();
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
      description: 'Select an up to 5 seconds long .wav file.',
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

    const presetGroup = new Adw.PreferencesGroup({
      title: 'Conversion',
      description: 'The recommended preset is selected automatically. Switch it at any time to compare results.',
    });
    this.presetRow = new Adw.ComboRow({
      title: 'Preset',
      model: Gtk.StringList.new(this.presets.map(preset => preset.name)),
    });
    this.presetRow.connect('notify::selected', () => {
      if (this.ignorePresetChanges || !this.sourceFile) return;
      const preset = this.presets[this.presetRow.selected];
      this.presetRow.subtitle = preset.description;
      this.beginConversion(preset);
    });
    presetGroup.add(this.presetRow);
    body.append(presetGroup);

    const soundGroup = new Adw.PreferencesGroup({
      title: 'Sound Check',
      description: 'Compare the original recording with the synthesized Game Boy channels.',
    });
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
      label: 'Export',
      tooltip_text: 'Create an ASM file in the source WAV folder',
      sensitive: false,
    });
    exportFullButton.add_css_class('suggested-action');
    exportFullButton.add_css_class('pill');
    exportFullButton.connect('clicked', () => this.exportAsm());
    this.exportButton = exportFullButton;
    body.append(exportFullButton);

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

  present() {
    this.window.present();
  }

  showToast(message) {
    this.toastOverlay.add_toast(new Adw.Toast({ title: message, timeout: 4 }));
  }

  chooseFile() {
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
      this.project = null;
      this.fileRow.title = file.get_basename();
      this.fileRow.subtitle = `${source.channels} channel${source.channels === 1 ? '' : 's'} · ${source.rate.toLocaleString()} Hz · ${formatDuration(source.duration)}`;
      this.originalRow.subtitle = formatDuration(source.duration);
      this.originalPlayer.setUri(file.get_uri());
      this.stack.visible_child_name = 'content';

      const suggestion = suggestPreset(preparedSamples);
      let selected = this.presets.findIndex(preset => preset.id === suggestion.id);
      if (selected < 0) selected = this.presets.findIndex(preset => preset.type === 'profile');
      this.ignorePresetChanges = true;
      this.presetRow.selected = selected;
      this.ignorePresetChanges = false;
      const preset = this.presets[selected];
      this.presetRow.subtitle = `${preset.description} Recommended for this WAV.`;
      this.beginConversion(preset);
    } catch (error) {
      this.showToast(error.message);
    }
  }

  setBusy(busy, message = '') {
    this.spinner.visible = busy;
    this.spinner.spinning = busy;
    this.presetRow.sensitive = !busy;
    this.exportButton.sensitive = !busy && Boolean(this.project);
    this.convertedButton.sensitive = !busy && Boolean(this.previewFile);
    if (message) this.convertedRow.subtitle = message;
  }

  beginConversion(preset) {
    const serial = ++this.conversionSerial;
    this.convertedPlayer.stop();
    this.setBusy(true, preset.type === 'auto' ? 'Testing conversion profiles…' : 'Converting…');
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (serial !== this.conversionSerial) return GLib.SOURCE_REMOVE;
      try {
        let result;
        let detail = preset.name;
        if (preset.type === 'auto') {
          const fitted = fitAutoPreset(this.preparedSamples, this.profilePresets, preset,
            (current, total) => { this.convertedRow.subtitle = `Testing profile ${current} of ${total}…`; });
          result = fitted.result;
          const basis = this.presets.find(item => item.id === fitted.basis);
          detail = `${preset.name} · based on ${basis?.name ?? fitted.basis}`;
        } else {
          result = convert(this.preparedSamples, preset.options);
        }
        if (serial !== this.conversionSerial) return GLib.SOURCE_REMOVE;
        this.project = { ...result, label: suggestedLabel(this.sourceFile.get_basename()) };
        const preview = renderPreview(this.project);
        this.writePreview(preview);
        this.convertedRow.subtitle = `${detail} · ${formatDuration(result.sourceDuration)}`;
        this.setBusy(false);
      } catch (error) {
        this.project = null;
        this.setBusy(false, 'Conversion failed');
        this.showToast(error.message);
      }
      return GLib.SOURCE_REMOVE;
    });
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

  removePreviewFile() {
    this.convertedPlayer?.stop();
    if (this.previewFile) {
      try { this.previewFile.delete(null); } catch (_) { /* Already removed. */ }
      this.previewFile = null;
    }
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
      comments: 'Convert WAV audio into pokecrystal cries.',
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
    if (files.length) window.loadFile(files[0]);
  });
  application.run(ARGV);
}
