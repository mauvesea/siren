import { FRAME_RATE, makeAsm, readWav } from '../src/converter.js';
import { applyCryParameters, LENGTH_MAX, LENGTH_MIN, parseCryAsm } from '../src/cry-asm.js';
import { editorDuration, editorNotePropertySpecs, frequencyToPitch, initializeEditorTimeline, materializeEditorCry,
  muteEditorChannels, parseDutyPattern, PIANO_HIGH, PIANO_LOW, pitchName, pitchToFrequency, setDutyPattern,
  setFixedDuty, setMasterVolume } from '../src/note-editor-model.js';
import { renderPreview } from '../src/preview.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const decoder = new TextDecoder('utf-8', { fatal: true });
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const channelKind = channel => channel === 'ch7' ? 'wave' : channel === 'ch8' ? 'noise' : 'square';
const channelNumber = channel => Number(channel.slice(2)) - 4;
const copyNote = note => ({ ...note, sweep: note.sweep && [...note.sweep],
  dutyPattern: note.dutyPattern && [...note.dutyPattern] });

export class StudioController {
  constructor(player, showToast) {
    this.player = player;
    this.showToast = showToast;
    this.cries = new Map();
    this.editor = null;
    this.path = null;
    this.selection = new Set();
    this.clipboard = [];
    this.nextId = 1;
    this.drawLength = 1;
    this.frameWidth = 12;
    this.rowHeight = 18;
    this.tool = 'move';
    this.drag = null;
    this.history = [];
    this.historyIndex = -1;
    this.restoringHistory = false;
    this.previewTimer = 0;
    this.previewDuration = 0;
    this.playheadFraction = 0;
    this.bind();
  }

  bind() {
    $('#editor-save').addEventListener('click', () => this.save());
    $('#editor-undo').addEventListener('click', () => this.undo());
    $('#editor-redo').addEventListener('click', () => this.redo());
    $('#editor-move-tool').addEventListener('click', () => this.setTool('move'));
    $('#editor-draw-tool').addEventListener('click', () => this.setTool('draw'));
    $('#editor-copy').addEventListener('click', () => this.copy());
    $('#editor-cut').addEventListener('click', () => this.cut());
    $('#editor-paste').addEventListener('click', () => this.paste());
    $('#editor-delete').addEventListener('click', () => this.delete());
    $('#editor-zoom-out').addEventListener('click', () => this.zoom(-1));
    $('#editor-zoom-in').addEventListener('click', () => this.zoom(1));
    $('#editor-shortcuts').addEventListener('click', () => $('#studio-shortcuts-dialog').showModal());
    $('#editor-length').addEventListener('change', () => {
      if (!this.restoringHistory) this.commitHistory();
      this.schedulePreview();
    });
    $('#editor-cry-choice').addEventListener('change', event => {
      const editor = this.cries.get(event.target.value);
      if (!editor) return;
      this.editor = editor;
      this.selection.clear();
      this.render();
      this.schedulePreview();
    });
    $('#editor-active-channel').addEventListener('change', () => {
      this.selection.clear();
      this.render();
    });
    for (const input of $$('[data-editor-channel]')) input.addEventListener('change', () => {
      if (!input.checked && input.dataset.editorChannel === this.activeChannel) this.selection.clear();
      this.render();
      this.schedulePreview();
    });
    for (const input of $$('[data-note-property]')) input.addEventListener('change', () =>
      this.changeProperty(input.dataset.noteProperty, input.value));
    for (const input of $$('[data-master-volume]')) input.addEventListener('change', () =>
      this.changeMasterVolume(input.dataset.masterVolume, input.value));
    $('#note-route').addEventListener('change', event => {
      for (const { note } of this.selectedNotes()) note.route = event.target.value;
      this.commitHistory(); this.render(); this.schedulePreview();
    });
    $('#note-duty-pattern').addEventListener('change', event => this.changeDutyPattern(event.target.value));

    const scroll = $('#timeline-scroll');
    scroll.addEventListener('scroll', () => this.syncScroll());
    scroll.addEventListener('wheel', event => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      this.zoom(event.deltaY < 0 ? 1 : -1, true);
    }, { passive: false });
    $('#timeline-ruler-viewport').addEventListener('pointerdown', event => {
      if (!this.editor) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left + scroll.scrollLeft;
      this.seek(x / Math.max(1, editorDuration(this.editor) * this.frameWidth));
    });
    const roll = $('#note-timeline');
    roll.addEventListener('pointerdown', event => this.beginPointer(event));
    roll.addEventListener('pointermove', event => this.movePointer(event));
    roll.addEventListener('pointerup', event => this.endPointer(event));
    roll.addEventListener('pointercancel', event => this.endPointer(event));
    $('#velocity-lane').addEventListener('pointerdown', event => this.editVolume(event));
    $('#editor-transport').addEventListener('input', event => this.seek(Number(event.target.value) / 1000));
    $('#editor-audio').addEventListener('timeupdate', event => this.updateTransport(event.currentTarget.currentTime));
    $('#editor-audio').addEventListener('ended', () => this.seek(1, false));
    document.addEventListener('keydown', event => this.keyDown(event));
  }

  get activeChannel() { return $('#editor-active-channel').value; }

  normalizeNote(note, channel) {
    const kind = channelKind(channel);
    const result = { ...note, _editorId: note._editorId ?? this.nextId++,
      duration: clamp(Math.round(note.duration ?? 0), 0, 255),
      volume: clamp(Math.round(note.volume ?? (kind === 'wave' ? 2 : 10)), 0, kind === 'wave' ? 3 : 15),
      envelope: clamp(Math.round(note.envelope ?? (kind === 'wave' ? 1 : 8)), kind === 'wave' ? 0 : -7, kind === 'wave' ? 9 : 8),
      frequency: clamp(Math.round(note.frequency ?? (kind === 'noise' ? 75 : 1600)), 0, kind === 'noise' ? 255 : 2047) };
    if (kind === 'square') result.duty = clamp(Math.round(note.duty ?? 2), 0, 3);
    else { delete result.duty; delete result.sweep; delete result.dutyPattern; }
    return result;
  }

  load(file) {
    try {
      const bytes = file.bytes instanceof ArrayBuffer ? file.bytes :
        file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength);
      const source = decoder.decode(new Uint8Array(bytes));
      const first = parseCryAsm(source);
      this.cries = new Map(first.availableCries.map(name => {
        const cry = parseCryAsm(source, name);
        const normalized = { ...cry, channels: Object.fromEntries(Object.entries(cry.channels).map(([channel, notes]) =>
          [channel, notes.map(note => this.normalizeNote(note, channel))])) };
        return [name, initializeEditorTimeline(normalized, () => this.nextId++)];
      }));
      this.path = file.path;
      this.editor = this.cries.values().next().value;
      this.selection.clear();
      this.clipboard = [];
      this.playheadFraction = 0;
      this.previewDuration = 0;
      this.player.clear();
      $('#editor-length').value = '256';
      $('#editor-file-name').textContent = file.name;
      $('#editor-cry-choice').replaceChildren(...[...this.cries.keys()].map(name => new Option(name, name)));
      $('#editor-cry-choice').hidden = this.cries.size <= 1;
      $('#editor-empty').hidden = true;
      $('#editor-content').hidden = false;
      $('#editor-save').disabled = false;
      this.resetHistory();
      this.render();
      this.schedulePreview();
      requestAnimationFrame(() => {
        $('#timeline-scroll').scrollTop = Math.max(0, (PIANO_HIGH - 60) * this.rowHeight - 180);
        this.syncScroll();
      });
    } catch (error) { this.showToast(`Could not open cry in the editor: ${error.message}`); }
  }

  selectedNotes() {
    const result = [];
    if (!this.editor) return result;
    for (const [channel, notes] of Object.entries(this.editor.channels))
      for (const note of notes) if (this.selection.has(note._editorId)) result.push({ channel, note });
    return result;
  }

  visibleNotes() {
    const result = [];
    if (!this.editor) return result;
    for (const [channel, notes] of Object.entries(this.editor.channels)) {
      if (!$(`[data-editor-channel="${channel}"]`).checked) continue;
      for (const note of notes) {
        if (!note.volume) continue;
        const pitch = frequencyToPitch(channel, note.frequency);
        result.push({ channel, note, pitch,
          x: (note._editorStart ?? 0) * this.frameWidth,
          y: (PIANO_HIGH - pitch) * this.rowHeight,
          width: Math.max(this.frameWidth - 2, (note.duration + 1) * this.frameWidth - 2),
          height: this.rowHeight - 2 });
      }
    }
    return result;
  }

  render() {
    const roll = $('#note-timeline');
    if (!this.editor) { roll.replaceChildren(); return; }
    const frames = editorDuration(this.editor);
    const width = Math.max(900, (frames + 16) * this.frameWidth);
    const height = (PIANO_HIGH - PIANO_LOW + 1) * this.rowHeight;
    for (const element of [roll, $('#timeline-ruler'), $('#velocity-lane')]) element.style.width = `${width}px`;
    roll.style.height = `${height}px`;
    $('#piano-keyboard').style.height = `${height}px`;

    const ruler = [];
    for (let frame = 0; frame <= Math.ceil(width / this.frameWidth); frame += 4) {
      const mark = document.createElement('span');
      mark.className = `ruler-mark${frame % 16 ? ' minor' : ''}`;
      mark.style.left = `${frame * this.frameWidth}px`;
      if (frame % 16 === 0) { const label = document.createElement('span'); label.textContent = `${frame}f`; mark.append(label); }
      ruler.push(mark);
    }
    const rulerPlayhead = document.createElement('span');
    rulerPlayhead.className = 'tracker-playhead';
    rulerPlayhead.style.left = `${this.playheadFraction * frames * this.frameWidth}px`;
    $('#timeline-ruler').replaceChildren(...ruler, rulerPlayhead);

    const keys = [];
    const rows = [];
    const black = new Set([1, 3, 6, 8, 10]);
    for (let pitch = PIANO_HIGH; pitch >= PIANO_LOW; pitch--) {
      const y = (PIANO_HIGH - pitch) * this.rowHeight;
      const isBlack = black.has(pitch % 12);
      const key = document.createElement('div');
      key.className = `piano-key${isBlack ? ' black' : ''}`;
      key.style.cssText = `top:${y}px;height:${this.rowHeight}px`;
      if (pitch % 12 === 0) { const label = document.createElement('span'); label.textContent = pitchName(pitch); key.append(label); }
      keys.push(key);
      const row = document.createElement('span');
      row.className = `pitch-row${isBlack ? ' black' : ''}`;
      row.style.cssText = `top:${y}px;height:${this.rowHeight}px`;
      rows.push(row);
    }
    $('#piano-keyboard').replaceChildren(...keys);
    const frameLines = [];
    for (let frame = 0; frame <= Math.ceil(width / this.frameWidth); frame += 4) {
      const line = document.createElement('span');
      line.className = `frame-line${frame % 16 === 0 ? ' strong' : ' medium'}`;
      line.style.left = `${frame * this.frameWidth}px`;
      frameLines.push(line);
    }
    const notes = this.visibleNotes().map(item => {
      const note = document.createElement('button');
      note.type = 'button';
      note.className = `piano-note${item.channel === this.activeChannel ? '' : ' inactive'}${this.selection.has(item.note._editorId) ? ' selected' : ''}`;
      note.dataset.channel = item.channel;
      note.dataset.noteId = String(item.note._editorId);
      note.style.cssText = `left:${item.x + 1}px;top:${item.y + 1}px;width:${item.width}px;height:${item.height}px`;
      note.textContent = item.channel === 'ch8' ? `N$${item.note.frequency.toString(16)}` : pitchName(item.pitch);
      note.title = `${note.textContent} · ${item.note.duration + 1} frames · volume ${item.note.volume}`;
      return note;
    });
    const playhead = document.createElement('span');
    playhead.className = 'tracker-playhead';
    playhead.style.left = `${this.playheadFraction * frames * this.frameWidth}px`;
    const selectionBox = this.selectionBox();
    roll.replaceChildren(...rows, ...frameLines, ...notes, playhead, ...(selectionBox ? [selectionBox] : []));

    const velocity = [];
    for (const value of [0, 5, 10, 15]) {
      const guide = document.createElement('span'); guide.className = 'velocity-guide';
      guide.style.bottom = `${2 + value / 15 * 80}px`; velocity.push(guide);
    }
    for (const item of this.visibleNotes()) {
      const max = item.channel === 'ch7' ? 3 : 15;
      const bar = document.createElement('span');
      bar.className = `velocity-bar${item.channel === this.activeChannel ? ' active' : ''}`;
      bar.dataset.channel = item.channel; bar.dataset.noteId = String(item.note._editorId);
      bar.style.left = `${item.x + 2}px`; bar.style.width = `${Math.max(4, Math.min(item.width - 3, this.frameWidth - 4))}px`;
      bar.style.height = `${Math.max(2, item.note.volume / max * 80)}px`;
      velocity.push(bar);
    }
    $('#velocity-lane').replaceChildren(...velocity);
    this.updateProperties();
    this.syncScroll();
  }

  selectionBox() {
    if (this.drag?.mode !== 'select' || this.drag.currentX === undefined) return null;
    const box = document.createElement('span');
    box.className = 'selection-box';
    const left = Math.min(this.drag.startX, this.drag.currentX);
    const top = Math.min(this.drag.startY, this.drag.currentY);
    box.style.cssText = `left:${left}px;top:${top}px;width:${Math.abs(this.drag.currentX - this.drag.startX)}px;height:${Math.abs(this.drag.currentY - this.drag.startY)}px`;
    return box;
  }

  syncScroll() {
    const scroll = $('#timeline-scroll');
    $('#timeline-ruler').style.transform = `translateX(${-scroll.scrollLeft}px)`;
    $('#velocity-lane').style.transform = `translateX(${-scroll.scrollLeft}px)`;
    $('#piano-keyboard').style.transform = `translateY(${-scroll.scrollTop}px)`;
  }

  point(event, element = $('#note-timeline')) {
    const rect = element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  noteById(id) {
    for (const [channel, notes] of Object.entries(this.editor?.channels ?? {})) {
      const note = notes.find(item => item._editorId === id);
      if (note) return { channel, note };
    }
    return null;
  }

  beginPointer(event) {
    if (!this.editor || event.button !== 0) return;
    const roll = $('#note-timeline');
    const point = this.point(event, roll);
    const element = event.target.closest('.piano-note:not(.inactive)');
    const hit = element ? this.noteById(Number(element.dataset.noteId)) : null;
    if (hit) this.drawLength = hit.note.duration + 1;
    if ((this.tool === 'draw' && !hit) || (!hit && event.detail === 2)) {
      this.addNoteAt(point.x, point.y);
      return;
    }
    if (hit) {
      if (event.ctrlKey) {
        if (this.selection.has(hit.note._editorId)) this.selection.delete(hit.note._editorId);
        else this.selection.add(hit.note._editorId);
        this.render();
        return;
      }
      if (!this.selection.has(hit.note._editorId)) this.selection = new Set([hit.note._editorId]);
      const item = this.visibleNotes().find(value => value.note === hit.note);
      const resizeHandle = Math.min(6, Math.max(2, item.width * .2));
      this.drag = { mode: point.x >= item.x + item.width - resizeHandle ? 'resize' : 'move',
        startX: point.x, startY: point.y, currentX: point.x, currentY: point.y,
        originals: this.selectedNotes().filter(value => value.channel === this.activeChannel).map(value => ({
          channel: value.channel, note: value.note, start: value.note._editorStart ?? 0,
          frequency: value.note.frequency, duration: value.note.duration,
        })) };
    } else {
      this.selection.clear();
      this.drag = { mode: 'select', startX: point.x, startY: point.y, currentX: point.x, currentY: point.y };
    }
    roll.setPointerCapture(event.pointerId);
    this.render();
  }

  movePointer(event) {
    if (!this.drag || !this.editor) return;
    const point = this.point(event);
    this.drag.currentX = point.x; this.drag.currentY = point.y;
    const dx = point.x - this.drag.startX, dy = point.y - this.drag.startY;
    if (this.drag.mode === 'move') {
      const frameDelta = Math.round(dx / this.frameWidth);
      const pitchDelta = -Math.round(dy / this.rowHeight);
      for (const original of this.drag.originals) {
        original.note._editorStart = Math.max(0, original.start + frameDelta);
        original.note.frequency = pitchToFrequency(original.channel,
          frequencyToPitch(original.channel, original.frequency) + pitchDelta);
      }
    } else if (this.drag.mode === 'resize') {
      const frameDelta = Math.round(dx / this.frameWidth);
      for (const original of this.drag.originals)
        original.note.duration = clamp(original.duration + frameDelta, 0, 255);
    }
    this.render();
  }

  endPointer(event) {
    if (!this.drag || !this.editor) return;
    const drag = this.drag;
    if (drag.mode === 'select') {
      const left = Math.min(drag.startX, drag.currentX), right = Math.max(drag.startX, drag.currentX);
      const top = Math.min(drag.startY, drag.currentY), bottom = Math.max(drag.startY, drag.currentY);
      this.selection.clear();
      for (const item of this.visibleNotes().filter(value => value.channel === this.activeChannel))
        if (item.x < right && item.x + item.width > left && item.y < bottom && item.y + item.height > top)
          this.selection.add(item.note._editorId);
    }
    const changed = drag.mode === 'move' || drag.mode === 'resize';
    this.drag = null;
    this.resolveOverlaps();
    if (changed) { this.commitHistory(); this.schedulePreview(); }
    if ($('#note-timeline').hasPointerCapture?.(event.pointerId)) $('#note-timeline').releasePointerCapture(event.pointerId);
    this.render();
  }

  editVolume(event) {
    if (!this.editor || event.button !== 0) return;
    const point = this.point(event, $('#velocity-lane'));
    const hit = this.visibleNotes().filter(item => item.channel === this.activeChannel && point.x >= item.x && point.x <= item.x + item.width).at(-1);
    if (!hit) return;
    const max = hit.channel === 'ch7' ? 3 : 15;
    hit.note.volume = clamp(Math.round((1 - point.y / 90) * max), 0, max);
    this.selection = new Set([hit.note._editorId]);
    this.commitHistory(); this.render(); this.schedulePreview();
  }

  addNoteAt(x, y) {
    const channel = this.activeChannel;
    const pitch = clamp(PIANO_HIGH - Math.floor(y / this.rowHeight), PIANO_LOW, PIANO_HIGH);
    const note = this.normalizeNote({ duration: this.drawLength - 1, frequency: pitchToFrequency(channel, pitch),
      _editorStart: Math.max(0, Math.floor(x / this.frameWidth)) }, channel);
    this.editor.channels[channel].push(note);
    this.selection = new Set([note._editorId]);
    this.resolveOverlaps(); this.commitHistory(); this.render(); this.schedulePreview();
  }

  resolveOverlaps() {
    if (!this.editor) return;
    for (const notes of Object.values(this.editor.channels)) {
      notes.sort((left, right) => (left._editorStart ?? 0) - (right._editorStart ?? 0) || left._editorId - right._editorId);
      let cursor = 0;
      for (const note of notes) {
        note._editorStart = Math.max(cursor, Math.round(note._editorStart ?? cursor));
        cursor = note._editorStart + note.duration + 1;
      }
    }
  }

  updateProperties() {
    const selected = this.selectedNotes();
    $('#editor-selection-label').textContent = selected.length ? `${selected.length} note${selected.length === 1 ? '' : 's'} selected` : 'No notes selected';
    const first = selected[0];
    $('#editor-pitch-label').textContent = !first ? 'Pitch —' : first.channel === 'ch8'
      ? `Noise register $${first.note.frequency.toString(16).padStart(2, '0')}`
      : `Pitch ${pitchName(frequencyToPitch(first.channel, first.note.frequency))}`;
    $('#editor-master-volume').disabled = !this.editor;
    $('#editor-volume-left').value = String(this.editor?.pan?.left ?? 7);
    $('#editor-volume-right').value = String(this.editor?.pan?.right ?? 7);
    $('#note-properties').disabled = !selected.length;
    const same = getter => selected.every(item => getter(item) === getter(first));
    const specs = editorNotePropertySpecs(first?.channel ?? this.activeChannel);
    for (const input of $$('[data-note-property]')) {
      const property = input.dataset.noteProperty;
      const spec = specs[property];
      input.min = String(spec.min); input.max = String(spec.max);
      const label = $(`[data-note-label="${property}"]`);
      if (label) label.textContent = spec.label;
      const getter = item => property === 'duration' ? item.note.duration :
        property === 'sweepPeriod' ? item.note.sweep?.[0] ?? 0 :
        property === 'sweepShift' ? item.note.sweep?.[1] ?? 0 : item.note[property] ?? 0;
      input.value = first && same(getter) ? String(getter(first)) : '';
    }
    const channels = new Set(selected.map(item => item.channel));
    const square = channels.size === 1 && channelKind(first?.channel) === 'square';
    $('#note-duty-row').hidden = !square;
    $('#note-pattern-row').hidden = !square;
    $('#note-sweep-row').hidden = !(square && first?.channel === 'ch5');
    $('#note-sweep-shift-row').hidden = !(square && first?.channel === 'ch5');
    $('#note-route').value = first?.note.route ?? 'both';
    const patterns = selected.map(item => item.note.dutyPattern?.join(', ') ?? '');
    $('#note-duty-pattern').value = first && patterns.every(pattern => pattern === patterns[0]) ? patterns[0] : '';
    $('#editor-move-tool').disabled = Boolean(selected.length);
    $('#editor-draw-tool').disabled = Boolean(selected.length);
  }

  changeProperty(property, rawValue) {
    const value = Number(rawValue);
    if (!Number.isInteger(value)) return;
    for (const { channel, note } of this.selectedNotes()) {
      if (property === 'sweepPeriod' || property === 'sweepShift') {
        if (channel !== 'ch5') continue;
        note.sweep ??= [0, 0];
        note.sweep[property === 'sweepPeriod' ? 0 : 1] = value;
      } else if (property === 'duty') {
        if (channelKind(channel) !== 'square') continue;
        setFixedDuty(note, value);
      } else note[property] = value;
      Object.assign(note, this.normalizeNote(note, channel));
    }
    this.resolveOverlaps(); this.commitHistory(); this.render(); this.schedulePreview();
  }

  changeMasterVolume(side, rawValue) {
    const value = Number(rawValue);
    if (!this.editor || !Number.isInteger(value)) return;
    try { setMasterVolume(this.editor, side, value); }
    catch (error) { this.showToast(error.message); this.render(); return; }
    this.commitHistory(); this.render(); this.schedulePreview();
  }

  changeDutyPattern(rawValue) {
    let pattern;
    try { pattern = parseDutyPattern(rawValue); }
    catch (error) { this.showToast(error.message); this.render(); return; }
    const selected = this.selectedNotes().filter(({ channel }) => channelKind(channel) === 'square');
    const patternId = pattern ? this.nextId++ : undefined;
    for (const { note } of selected) setDutyPattern(note, pattern, patternId);
    this.commitHistory(); this.render(); this.schedulePreview();
  }

  setTool(tool) {
    if (this.selection.size) return;
    this.tool = tool;
    $('#editor-move-tool').setAttribute('aria-pressed', String(tool === 'move'));
    $('#editor-draw-tool').setAttribute('aria-pressed', String(tool === 'draw'));
  }

  cycleTool() { if (!this.selection.size) this.setTool(this.tool === 'move' ? 'draw' : 'move'); }

  copy() { this.clipboard = this.selectedNotes().map(item => ({ channel: item.channel, note: copyNote(item.note) })); }
  cut() { this.copy(); this.delete(); }

  delete() {
    if (!this.editor || !this.selection.size) return;
    for (const channel of Object.keys(this.editor.channels))
      this.editor.channels[channel] = this.editor.channels[channel].filter(note => !this.selection.has(note._editorId));
    this.selection.clear(); this.commitHistory(); this.render(); this.schedulePreview();
  }

  paste() {
    if (!this.editor || !this.clipboard.length) return;
    const channel = this.activeChannel;
    const notes = this.clipboard.map(item => this.normalizeNote({ ...copyNote(item.note), _editorId: null,
      frequency: pitchToFrequency(channel, frequencyToPitch(item.channel, item.note.frequency)),
      _editorStart: item.note._editorStart ?? 0 }, channel));
    const overlaps = (left, right) => {
      const leftStart = left._editorStart ?? 0, rightStart = right._editorStart ?? 0;
      return leftStart < rightStart + right.duration + 1 && rightStart < leftStart + left.duration + 1;
    };
    this.editor.channels[channel] = this.editor.channels[channel].filter(existing => !notes.some(note => overlaps(existing, note)));
    this.editor.channels[channel].push(...notes);
    this.selection = new Set(notes.map(note => note._editorId));
    this.resolveOverlaps(); this.commitHistory(); this.render(); this.schedulePreview();
  }

  navigate(direction) {
    const selected = this.selectedNotes();
    if (selected.length !== 1 || selected[0].channel !== this.activeChannel) return false;
    const notes = this.editor.channels[this.activeChannel].filter(note => note.volume)
      .sort((left, right) => (left._editorStart ?? 0) - (right._editorStart ?? 0) || left._editorId - right._editorId);
    const target = notes[notes.indexOf(selected[0].note) + direction];
    if (!target) return false;
    this.selection = new Set([target._editorId]);
    this.render();
    const scroll = $('#timeline-scroll');
    const x = (target._editorStart ?? 0) * this.frameWidth;
    const y = (PIANO_HIGH - frequencyToPitch(this.activeChannel, target.frequency)) * this.rowHeight;
    if (x < scroll.scrollLeft) scroll.scrollLeft = x;
    else if (x + this.frameWidth > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = x + this.frameWidth - scroll.clientWidth;
    if (y < scroll.scrollTop) scroll.scrollTop = y;
    else if (y + this.rowHeight > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = y + this.rowHeight - scroll.clientHeight;
    return true;
  }

  zoom(direction, preserveViewport = true) {
    const scroll = $('#timeline-scroll');
    const centerFrame = (scroll.scrollLeft + scroll.clientWidth / 2) / this.frameWidth;
    const centerRow = (scroll.scrollTop + scroll.clientHeight / 2) / this.rowHeight;
    this.frameWidth = clamp(this.frameWidth + direction * 2, 5, 28);
    this.rowHeight = clamp(this.rowHeight + direction, 12, 28);
    this.render();
    if (preserveViewport) {
      scroll.scrollLeft = centerFrame * this.frameWidth - scroll.clientWidth / 2;
      scroll.scrollTop = centerRow * this.rowHeight - scroll.clientHeight / 2;
      this.syncScroll();
    }
  }

  captureHistory() {
    if (!this.editor) return null;
    const currentName = [...this.cries].find(([, cry]) => cry === this.editor)?.[0] ?? [...this.cries.keys()][0];
    return { cries: JSON.parse(JSON.stringify([...this.cries])), currentName,
      selection: [...this.selection], nextId: this.nextId, length: Number($('#editor-length').value) };
  }

  resetHistory() { this.history = []; this.historyIndex = -1; this.commitHistory(); }

  commitHistory() {
    if (this.restoringHistory) return;
    const state = this.captureHistory();
    if (!state) return;
    const serialized = JSON.stringify(state);
    if (this.history[this.historyIndex]?.serialized === serialized) return;
    this.history.splice(this.historyIndex + 1);
    this.history.push({ state, serialized });
    if (this.history.length > 101) this.history.shift();
    this.historyIndex = this.history.length - 1;
    this.updateHistoryButtons();
  }

  restoreHistory(index) {
    const entry = this.history[index];
    if (!entry) return;
    this.restoringHistory = true;
    const saved = JSON.parse(JSON.stringify(entry.state));
    this.cries = new Map(saved.cries);
    this.editor = this.cries.get(saved.currentName) ?? this.cries.values().next().value;
    this.selection = new Set(saved.selection);
    this.nextId = saved.nextId;
    $('#editor-length').value = String(saved.length);
    $('#editor-cry-choice').replaceChildren(...[...this.cries.keys()].map(name => new Option(name, name)));
    $('#editor-cry-choice').value = saved.currentName;
    this.restoringHistory = false;
    this.historyIndex = index;
    this.updateHistoryButtons(); this.render(); this.schedulePreview();
  }

  updateHistoryButtons() {
    $('#editor-undo').disabled = this.historyIndex <= 0;
    $('#editor-redo').disabled = this.historyIndex < 0 || this.historyIndex >= this.history.length - 1;
  }

  undo() { if (this.historyIndex > 0) this.restoreHistory(this.historyIndex - 1); }
  redo() { if (this.historyIndex < this.history.length - 1) this.restoreHistory(this.historyIndex + 1); }

  schedulePreview() {
    if (!this.editor) return;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = 0;
      try {
        const materialized = materializeEditorCry(this.editor);
        const enabled = $$('[data-editor-channel]:checked').map(input => input.dataset.editorChannel);
        const audible = muteEditorChannels(materialized, enabled);
        const length = Number($('#editor-length').value);
        if (!Number.isInteger(length) || length < LENGTH_MIN || length > LENGTH_MAX)
          throw new Error(`Length must be ${LENGTH_MIN}–${LENGTH_MAX}.`);
        const project = applyCryParameters(audible, 0, length);
        const frames = Math.max(1, ...Object.values(project.channels)
          .map(notes => notes.reduce((sum, note) => sum + (note.frames ?? note.duration + 1), 0)));
        const expectedDuration = frames / FRAME_RATE;
        if (expectedDuration > 300) throw new Error('The edited cry is longer than the 5-minute preview limit.');
        const buffer = renderPreview(project, expectedDuration + 1);
        this.player.setBuffer(buffer);
        this.previewDuration = readWav(buffer).duration;
        this.seek(this.playheadFraction, false);
      } catch (error) {
        this.player.clear();
        this.showToast(`Could not prepare preview: ${error.message}`);
      }
    }, 90);
  }

  seek(fraction, updateAudio = true) {
    this.playheadFraction = clamp(Number(fraction) || 0, 0, 1);
    const seconds = this.previewDuration * this.playheadFraction;
    $('#editor-transport').value = String(Math.round(this.playheadFraction * 1000));
    $('#editor-transport').disabled = !this.previewDuration;
    $('#editor-time').textContent = `${seconds.toFixed(2)} / ${this.previewDuration.toFixed(2)} seconds`;
    if (updateAudio && Number.isFinite($('#editor-audio').duration)) $('#editor-audio').currentTime = seconds;
    this.render();
  }

  updateTransport(seconds) {
    if (!this.previewDuration) return;
    this.playheadFraction = clamp(seconds / this.previewDuration, 0, 1);
    $('#editor-transport').value = String(Math.round(this.playheadFraction * 1000));
    $('#editor-time').textContent = `${seconds.toFixed(2)} / ${this.previewDuration.toFixed(2)} seconds`;
    this.render();
  }

  async save() {
    if (!this.editor || !this.path) return;
    try {
      const asm = [...this.cries.values()].map(sourceCry => {
        const cry = materializeEditorCry(sourceCry);
        const enabledChannels = Object.entries(cry.channels).filter(([, notes]) => notes.length).map(([channel]) => channel);
        const label = cry.label.replace(/^Cry_/, '') || 'Edited';
        return makeAsm({ ...cry, label, precise: true, enabledChannels }, this.path.split(/[\\/]/).at(-1));
      }).join('\n\n');
      const current = materializeEditorCry(this.editor);
      const enabled = $$('[data-editor-channel]:checked').map(input => input.dataset.editorChannel);
      const audible = muteEditorChannels(current, enabled);
      const project = applyCryParameters(audible, 0, Number($('#editor-length').value));
      const frames = Math.max(1, ...Object.values(project.channels)
        .map(notes => notes.reduce((sum, note) => sum + (note.frames ?? note.duration + 1), 0)));
      const duration = frames / FRAME_RATE;
      if (duration > 300) throw new Error('The edited cry is longer than the 5-minute WAV export limit.');
      const wav = renderPreview(project, duration + 1);
      const saved = await window.siren.saveStudio(this.path, asm, wav);
      this.showToast(`Saved ${saved.asm.split(/[\\/]/).at(-1)} and ${saved.wav.split(/[\\/]/).at(-1)}`);
    } catch (error) { this.showToast(`Could not save project: ${error.message}`); }
  }

  keyDown(event) {
    if ($('#editor-page').hidden || event.altKey || ['INPUT', 'SELECT'].includes(document.activeElement?.tagName)) return;
    const key = event.key.toLowerCase();
    let handled = false;
    if (event.ctrlKey && key === 'z') { event.shiftKey ? this.redo() : this.undo(); handled = true; }
    else if (event.ctrlKey && key === 's') { this.save(); handled = true; }
    else if (event.ctrlKey && key === 'c') { this.copy(); handled = Boolean(this.selection.size); }
    else if (event.ctrlKey && key === 'x') { this.cut(); handled = Boolean(this.selection.size); }
    else if (event.ctrlKey && key === 'v') { this.paste(); handled = Boolean(this.clipboard.length); }
    else if (event.ctrlKey && ['+', '=', 'add'].includes(key)) { this.zoom(1); handled = true; }
    else if (event.ctrlKey && ['-', 'subtract'].includes(key)) { this.zoom(-1); handled = true; }
    else if (!event.ctrlKey && (event.key === 'Delete' || event.key === 'Backspace')) { this.delete(); handled = Boolean(this.selection.size); }
    else if (!event.ctrlKey && event.key === 'ArrowLeft') handled = this.navigate(-1);
    else if (!event.ctrlKey && event.key === 'ArrowRight') handled = this.navigate(1);
    else if (!event.ctrlKey && key === 'x') { this.cycleTool(); handled = true; }
    if (handled) { event.preventDefault(); event.stopImmediatePropagation(); }
  }

  destroy() { if (this.previewTimer) clearTimeout(this.previewTimer); }
}
