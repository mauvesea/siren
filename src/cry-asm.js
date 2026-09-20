import { validateNote } from './converter.js';

export const PITCH_MIN = -32768;
export const PITCH_MAX = 32767;
export const LENGTH_MIN = 0;
export const LENGTH_MAX = 65535;

function number(token, line) {
  const value = token.trim();
  let result;
  if (/^-?\$[0-9a-f]+$/i.test(value))
    result = (value[0] === '-' ? -1 : 1) * parseInt(value.replace(/^-?\$/, ''), 16);
  else if (/^-?%[01]+$/.test(value))
    result = (value[0] === '-' ? -1 : 1) * parseInt(value.replace(/^-?%/, ''), 2);
  else if (/^-?\d+$/.test(value)) result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`Line ${line}: expected an integer, got “${value}”.`);
  return result;
}

function range(value, low, high, label, line) {
  if (value < low || value > high)
    throw new Error(`Line ${line}: ${label} must be ${low}–${high}.`);
  return value;
}

// Interpret the cry commands as an ordered stream, including finite loops and calls.
// Labels and channel references must be in this file; external includes are not loaded.
export function parseCryAsm(source, selectedCry = null) {
  if (typeof source !== 'string' || source.length > 2 * 1024 * 1024)
    throw new Error('Choose an ASM file smaller than 2 MB.');
  const instructions = [];
  const labels = new Map();
  let scope = '';
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    let line = raw.split(';', 1)[0].trim();
    if (!line) continue;
    const match = /^([A-Za-z_.][\w.]*):{1,2}\s*(.*)$/.exec(line);
    if (match) {
      if (!match[1].startsWith('.')) scope = match[1];
      const label = match[1].startsWith('.') ? `${scope}${match[1]}` : match[1];
      if (labels.has(label)) throw new Error(`Line ${index + 1}: duplicate label ${label}.`);
      labels.set(label, instructions.length);
      line = match[2].trim();
      if (!line) continue;
    }
    const command = /^([A-Za-z_][\w]*)\s*(.*)$/.exec(line);
    if (!command) throw new Error(`Line ${index + 1}: unsupported syntax.`);
    instructions.push({ op: command[1].toLowerCase(), args: command[2] ? command[2].split(',').map(s => s.trim()) : [], line: index + 1, scope });
  }
  const availableCries = [...new Set(instructions.filter(item => item.op === 'channel_count').map(item => item.scope))];
  const header = instructions.findIndex(item => item.op === 'channel_count' &&
    (selectedCry === null || item.scope === selectedCry));
  if (header < 0) throw new Error('This file has no cry channel_count header.');
  const count = number(instructions[header].args[0] ?? '', instructions[header].line);
  range(count, 1, 4, 'channel_count', instructions[header].line);
  const targets = new Map();
  for (let i = 0; i < count; i++) {
    const item = instructions[header + 1 + i];
    if (!item || item.op !== 'channel' || item.args.length !== 2)
      throw new Error(`Cry header needs ${count} channel entries.`);
    const channel = number(item.args[0], item.line);
    if (![5, 6, 8].includes(channel) || targets.has(channel))
      throw new Error(`Line ${item.line}: only unique cry channels 5, 6 and 8 are supported.`);
    targets.set(channel, item.args[1]);
  }
  const channels = { ch5: [], ch6: [], ch8: [] };
  for (const [channel, label] of targets) {
    if (!labels.has(label)) throw new Error(`Missing channel label ${label}.`);
    const notes = channels[`ch${channel}`];
    const kind = channel === 8 ? 'noise' : 'square';
    let pc = labels.get(label), duty = 2, pattern = null, patternId = 0, offset = null, sweep = null;
    const calls = [];
    let activeLoop = null, loopLeft = 0;
    let steps = 0;
    while (pc < instructions.length) {
      if (++steps > 10000 || notes.length > 4000)
        throw new Error('Cry has too many commands or an endless loop.');
      const item = instructions[pc++];
      const arg = i => number(item.args[i] ?? '', item.line);
      const target = i => {
        const name = item.args[i]?.startsWith('.') ? `${item.scope}${item.args[i]}` : item.args[i];
        const address = labels.get(name);
        if (address === undefined) throw new Error(`Line ${item.line}: missing label ${item.args[i]}.`);
        return address;
      };
      switch (item.op) {
        case 'square_note':
        case 'noise_note': {
          if ((item.op === 'noise_note') !== (kind === 'noise') || item.args.length !== 4)
            throw new Error(`Line ${item.line}: wrong note type or number of arguments.`);
          const note = { duration: arg(0), volume: arg(1), envelope: arg(2), frequency: arg(3) };
          if (kind === 'square') {
            note.duty = duty;
            if (pattern) { note.dutyPattern = pattern.slice(); note.patternId = patternId; }
            if (channel === 5 && sweep) note.sweep = sweep;
          }
          if (offset !== null) note.offsetOverride = offset;
          try { validateNote(note, kind); } catch (error) { throw new Error(`Line ${item.line}: ${error.message}`); }
          notes.push(note);
          break;
        }
        case 'duty_cycle':
          if (kind !== 'square') throw new Error(`Line ${item.line}: duty_cycle requires a square channel.`);
          duty = range(arg(0), 0, 3, 'duty_cycle', item.line);
          pattern = null;
          break;
        case 'duty_cycle_pattern':
          if (kind !== 'square' || item.args.length !== 4)
            throw new Error(`Line ${item.line}: duty_cycle_pattern needs four square duties.`);
          pattern = item.args.map((_, i) => range(arg(i), 0, 3, 'duty', item.line));
          duty = pattern[0];
          patternId++;
          break;
        case 'pitch_offset':
          offset = range(arg(0), -32768, 65535, 'pitch_offset', item.line);
          break;
        case 'pitch_sweep':
          if (channel !== 5 || item.args.length !== 2)
            throw new Error(`Line ${item.line}: pitch_sweep requires channel 5 and two arguments.`);
          sweep = [range(arg(0), 0, 15, 'sweep period', item.line),
            range(arg(1), -7, 8, 'sweep shift', item.line)];
          break;
        case 'sound_jump': pc = target(0); break;
        case 'sound_call':
          if (calls.length) throw new Error(`Line ${item.line}: nested sound_call is not supported by pokecrystal.`);
          calls.push(pc); pc = target(0); break;
        case 'sound_loop': {
          const count = range(arg(0), 0, 255, 'loop count', item.line);
          if (count === 0) throw new Error(`Line ${item.line}: infinite sound_loop cannot be previewed.`);
          if (activeLoop === null) { activeLoop = pc - 1; loopLeft = count; }
          if (activeLoop !== pc - 1)
            throw new Error(`Line ${item.line}: nested sound_loop is not supported by pokecrystal.`);
          if (loopLeft > 1) { loopLeft--; pc = target(1); }
          else activeLoop = null;
          break;
        }
        case 'sound_ret':
          if (calls.length) { pc = calls.pop(); break; }
          pc = instructions.length; break;
        default:
          throw new Error(`Line ${item.line}: ${item.op} cannot be previewed accurately.`);
      }
    }
  }
  if (!Object.values(channels).some(notes => notes.length)) throw new Error('No playable cry notes found.');
  return { channels, label: instructions[header].scope || 'Cry', availableCries };
}

// Pokecrystal SetNoteDuration: byte-sized delay, 16-bit tempo and an 8-bit
// remainder carried across notes. Noise channel retains the default $100 tempo.
export function applyCryParameters(cry, pitch, length) {
  if (!Number.isInteger(pitch) || pitch < PITCH_MIN || pitch > PITCH_MAX)
    throw new Error(`Pitch must be ${PITCH_MIN}–${PITCH_MAX}.`);
  if (!Number.isInteger(length) || length < LENGTH_MIN || length > LENGTH_MAX)
    throw new Error(`Length must be ${LENGTH_MIN}–${LENGTH_MAX}.`);
  const channels = {};
  for (const key of ['ch5', 'ch6', 'ch8']) {
    let remainder = 0;
    let elapsed = 0, previousPattern = null, patternStart = 0;
    channels[key] = cry.channels[key].map(note => {
      const tempo = key === 'ch8' ? 256 : length;
      // The duration multiplier wraps to 16 bits before its high byte is used.
      const product = (tempo * ((note.duration + 1) & 255) + remainder) & 65535;
      remainder = product & 255;
      if (note.patternId !== undefined && note.patternId !== previousPattern) {
        previousPattern = note.patternId;
        patternStart = elapsed;
      }
      const adjusted = {
        ...note,
        frequency: (note.frequency + (note.offsetOverride ?? pitch)) & (key === 'ch8' ? 255 : 2047),
        frames: Math.max(1, product >> 8),
      };
      if (note.dutyPattern) adjusted.patternStart = patternStart;
      elapsed += adjusted.frames;
      return adjusted;
    });
  }
  return { channels };
}
