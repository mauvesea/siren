import { LENGTH_MAX, LENGTH_MIN, PITCH_MAX, PITCH_MIN } from './cry-asm.js';

export function parseAsmInteger(token, lineNumber = 0) {
  const value = String(token).trim();
  let result;
  if (/^-?\$[0-9a-f]+$/i.test(value))
    result = (value.startsWith('-') ? -1 : 1) * parseInt(value.replace(/^-?\$/, ''), 16);
  else if (/^-?0x[0-9a-f]+$/i.test(value)) result = Number.parseInt(value, 16);
  else if (/^-?\d+$/.test(value)) result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new Error(`${lineNumber ? `Line ${lineNumber}: ` : ''}expected a decimal or hexadecimal integer, got “${value}”.`);
  return result;
}

function bounded(value, low, high, label, lineNumber) {
  if (value < low || value > high)
    throw new Error(`Line ${lineNumber}: ${label} must be ${low}–${high}.`);
  return value;
}

export function parseCryConstants(source) {
  if (typeof source !== 'string') throw new Error('Cry constants must be text.');
  const constants = [];
  const seen = new Set();
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.split(';', 1)[0];
    for (const match of line.matchAll(/\bCRY_[A-Za-z0-9_]+\b/g)) {
      const name = match[0];
      const key = name.toUpperCase();
      if (!seen.has(key)) { seen.add(key); constants.push(name); }
    }
  }
  if (!constants.length) throw new Error('constants/cry_constants.asm has no CRY_* constants.');
  return constants;
}

export function parseCryPointers(source) {
  if (typeof source !== 'string') throw new Error('Cry pointers must be text.');
  const pointers = [];
  for (const raw of source.split(/\r?\n/)) {
    const code = raw.split(';', 1)[0].trim();
    const match = /^[A-Za-z_][\w.]*\s+(Cry_[A-Za-z0-9_.]+)/i.exec(code);
    if (match) pointers.push(match[1]);
  }
  if (!pointers.length) throw new Error('audio/cry_pointers.asm has no Cry_* pointers.');
  return pointers;
}

export function parseCryDefinitionLabels(source) {
  if (typeof source !== 'string') throw new Error('Cry definitions must be text.');
  const labels = new Map();
  let pending = null;
  for (const raw of source.split(/\r?\n/)) {
    const code = raw.split(';', 1)[0].trim();
    const label = /^([A-Za-z_.][\w.]*):{1,2}\s*(.*)$/.exec(code);
    if (label) {
      pending = label[1];
      if (label[2] && /^channel_count\b/i.test(label[2]) && /^Cry_/i.test(pending))
        labels.set(`CRY_${pending.replace(/^Cry_/i, '').toUpperCase()}`, pending);
      if (label[2]) pending = null;
      continue;
    }
    if (!code) continue;
    if (pending && /^channel_count\b/i.test(code) && /^Cry_/i.test(pending))
      labels.set(`CRY_${pending.replace(/^Cry_/i, '').toUpperCase()}`, pending);
    pending = null;
  }
  if (!labels.size) throw new Error('audio/cries.asm has no playable Cry_* definitions.');
  return labels;
}

export function indexCryDefinitionSources(sources) {
  const result = new Map();
  for (const source of sources) {
    let labels;
    try { labels = parseCryDefinitionLabels(source); }
    catch (_) { continue; }
    for (const [constant, label] of labels) result.set(constant, { label, source });
  }
  if (!result.size) throw new Error('No playable cry definitions were found in the project audio files.');
  return result;
}

export function resolveCryDefinitionSources(constants, pointers, sources) {
  if (constants.length !== pointers.length)
    throw new Error(`constants/cry_constants.asm has ${constants.length} entries, but audio/cry_pointers.asm has ${pointers.length}.`);
  const byLabel = indexCryDefinitionSources(sources);
  const result = new Map();
  for (let index = 0; index < constants.length; index++) {
    const pointerKey = `CRY_${pointers[index].replace(/^Cry_/i, '').toUpperCase()}`;
    const definition = byLabel.get(pointerKey);
    if (definition) result.set(constants[index].toUpperCase(), definition);
  }
  return result;
}

export function parseCryList(source) {
  if (typeof source !== 'string' || source.length > 2 * 1024 * 1024)
    throw new Error('Choose a cries.asm file smaller than 2 MB.');
  const lines = [], endings = [];
  const matcher = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  let part;
  while ((part = matcher.exec(source)) && part[0]) {
    lines.push(part[1]); endings.push(part[2]);
  }
  if (!lines.length) { lines.push(''); endings.push(''); }
  const entries = [];
  for (const [index, raw] of lines.entries()) {
    const match = /^(\s*)([A-Za-z_][\w.]*)\s+([A-Za-z_][\w.]*)\s*,\s*([^,;\s]+)\s*,\s*([^;\s]+)(?:\s*;(.*))?$/.exec(raw);
    if (!match || !/^CRY_/i.test(match[3])) continue;
    let pitch = parseAsmInteger(match[4], index + 1);
    if (/^(?:\$|0x)[0-9a-f]+$/i.test(match[4]) && pitch > PITCH_MAX && pitch <= 0xffff) pitch -= 0x10000;
    pitch = bounded(pitch, PITCH_MIN, PITCH_MAX, 'pitch', index + 1);
    const length = bounded(parseAsmInteger(match[5], index + 1), LENGTH_MIN, LENGTH_MAX, 'length', index + 1);
    const entry = {
      lineIndex: index,
      lineNumber: index + 1,
      indent: match[1],
      macro: match[2],
      constant: match[3],
      pitch,
      length,
      species: (match[6] ?? '').trim(),
      original: null,
    };
    entry.original = { macro: entry.macro, constant: entry.constant, pitch, length, species: entry.species };
    entries.push(entry);
  }
  if (!entries.length)
    throw new Error('This is not data/pokemon/cries.asm: no cry-list entries were found.');
  return { source, lines, endings, entries };
}

export function renderCryList(document, values) {
  if (!document?.entries || values.length !== document.entries.length)
    throw new Error('The cry-list rows do not match the opened document.');
  const lines = [...document.lines];
  for (let index = 0; index < document.entries.length; index++) {
    const entry = document.entries[index];
    const value = values[index];
    const macro = String(value.macro ?? '').trim();
    const constant = String(value.constant ?? '').trim();
    const pitch = Number(value.pitch);
    const length = Number(value.length);
    const species = String(value.species ?? '').trim();
    if (!/^[A-Za-z_][\w.]*$/.test(macro)) throw new Error(`Line ${entry.lineNumber}: invalid macro name.`);
    if (!/^CRY_[A-Za-z0-9_]+$/i.test(constant)) throw new Error(`Line ${entry.lineNumber}: invalid cry constant.`);
    bounded(pitch, PITCH_MIN, PITCH_MAX, 'pitch', entry.lineNumber);
    bounded(length, LENGTH_MIN, LENGTH_MAX, 'length', entry.lineNumber);
    if (!Number.isInteger(pitch) || !Number.isInteger(length))
      throw new Error(`Line ${entry.lineNumber}: pitch and length must be integers.`);
    const unchanged = macro === entry.original.macro && constant === entry.original.constant &&
      pitch === entry.original.pitch && length === entry.original.length && species === entry.original.species;
    if (!unchanged)
      lines[entry.lineIndex] = `${entry.indent}${macro} ${constant}, ${pitch}, ${length}${species ? ` ; ${species}` : ''}`;
  }
  return lines.map((line, index) => line + (document.endings[index] ?? '')).join('');
}
