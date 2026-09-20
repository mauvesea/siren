import Gio from 'gi://Gio';

const textDecoder = new TextDecoder('utf-8');
const MAX_PRESET_BYTES = 16 * 1024;
const LIMITS = { id: 32, name: 32, description: 255, type: 32, noiseMode: 32 };
const PROFILE_FIELDS = new Set([
  'noisePitch', 'noiseGain', 'minHz', 'maxHz', 'stepFrames',
  'secondGain', 'noiseMode', 'smoothing',
]);

function boundedString(value, field, filename) {
  const limit = LIMITS[field] ?? 16;
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw new Error(`${filename}: ${field} must be a nonempty string of at most ${limit} characters.`);
}

function boundedNumber(value, field, filename, low, high) {
  if (typeof value !== 'number' || !Number.isFinite(value) ||
      String(value).length > 16 || value < low || value > high)
    throw new Error(`${filename}: ${field} must be a finite number between ${low} and ${high}, at most 16 characters long.`);
}

function validateProfile(preset, filename) {
  if (!preset.options || typeof preset.options !== 'object' || Array.isArray(preset.options))
    throw new Error(`${filename}: profile presets need an options object.`);
  const options = preset.options;
  const ranges = {
    noisePitch: [0, 255], noiseGain: [0, 4], minHz: [64, 1800],
    maxHz: [64, 1800], stepFrames: [1, 2], secondGain: [0, 1],
  };
  for (const key of Object.keys(options)) {
    if (key.length > 16 || !PROFILE_FIELDS.has(key))
      throw new Error(`${filename}: unknown or too-long profile parameter “${key}”.`);
  }
  for (const [key, [low, high]] of Object.entries(ranges)) {
    if (options[key] !== undefined) boundedNumber(options[key], key, filename, low, high);
  }
  if (options.stepFrames !== undefined && ![1, 2].includes(options.stepFrames))
    throw new Error(`${filename}: stepFrames must be 1 or 2.`);
  if (options.noisePitch !== undefined && !Number.isInteger(options.noisePitch))
    throw new Error(`${filename}: noisePitch must be a whole number.`);
  if (options.noiseMode !== undefined) {
    boundedString(options.noiseMode, 'noiseMode', filename);
    if (!['fixed', 'texture'].includes(options.noiseMode))
      throw new Error(`${filename}: noiseMode must be “fixed” or “texture”.`);
  }
  if (options.smoothing !== undefined) {
    boundedString(options.smoothing, 'smoothing', filename);
    if (!['legacy', 'none'].includes(options.smoothing))
      throw new Error(`${filename}: smoothing must be “legacy” or “none”.`);
  }
  if ((options.minHz ?? 120) > (options.maxHz ?? 1100))
    throw new Error(`${filename}: minHz cannot exceed maxHz.`);
}

function validateForcing(preset, filename) {
  if (!preset.search || !Array.isArray(preset.search.noiseGainFactors) ||
      !Array.isArray(preset.search.noisePitches))
    throw new Error(`${filename}: the Forcing preset needs both search arrays.`);
  for (const key of Object.keys(preset.search))
    if (key.length > 16 || !['noiseGainFactors', 'noisePitches'].includes(key))
      throw new Error(`${filename}: unknown Forcing parameter “${key}”.`);
  for (const [key, values, high] of [
    ['noiseGainFactors', preset.search.noiseGainFactors, 8],
    ['noisePitches', preset.search.noisePitches, 255],
  ]) {
    if (values.length < 1 || values.length > 16)
      throw new Error(`${filename}: ${key} needs 1–16 values.`);
    for (const value of values) {
      boundedNumber(value, key, filename, 0, high);
      if (key === 'noisePitches' && !Number.isInteger(value))
        throw new Error(`${filename}: noisePitches must contain whole numbers.`);
    }
  }
}

function validatePreset(preset, filename) {
  if (!preset || typeof preset !== 'object') throw new Error(`${filename}: expected a JSON object.`);
  for (const key of Object.keys(preset))
    if (key.length > 16 || !['schemaVersion', 'id', 'name', 'description', 'type', 'order', 'options', 'search'].includes(key))
      throw new Error(`${filename}: unknown preset parameter “${key}”.`);
  boundedString(preset.id, 'id', filename);
  boundedString(preset.name, 'name', filename);
  boundedString(preset.description, 'description', filename);
  boundedString(preset.type, 'type', filename);
  if (!/^[a-z][a-z0-9_]*$/.test(preset.id))
    throw new Error(`${filename}: id must use lowercase letters, numbers, and underscores.`);
  if (preset.schemaVersion !== undefined && preset.schemaVersion !== 1)
    throw new Error(`${filename}: schemaVersion must be 1.`);
  if (preset.order !== undefined) boundedNumber(preset.order, 'order', filename, 0, 10000);
  if (!['profile', 'forcing'].includes(preset.type))
    throw new Error(`${filename}: type must be “profile” or “forcing”.`);
  if (preset.type === 'profile') validateProfile(preset, filename);
  else validateForcing(preset, filename);
  return preset;
}

export function loadPresets(directoryPath) {
  const directory = Gio.File.new_for_path(directoryPath);
  const presets = [];
  let enumerator;
  try {
    enumerator = directory.enumerate_children(
      'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
  } catch (error) {
    throw new Error(`Could not open the Presets folder at ${directoryPath}: ${error.message}`);
  }
  let info;
  while ((info = enumerator.next_file(null)) !== null) {
    const name = info.get_name();
    if (!name.toLowerCase().endsWith('.json')) continue;
    if (info.get_file_type() !== Gio.FileType.REGULAR) continue;
    const file = directory.get_child(name);
    try {
      const fileInfo = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
      if (fileInfo.get_size() > MAX_PRESET_BYTES)
        throw new Error(`preset files must be at most ${MAX_PRESET_BYTES} bytes.`);
      const [, contents] = file.load_contents(null);
      presets.push(validatePreset(JSON.parse(textDecoder.decode(contents)), name));
    } catch (error) {
      throw new Error(`Could not load ${name}: ${error.message}`);
    }
  }
  enumerator.close(null);
  presets.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const ids = new Set();
  for (const preset of presets) {
    if (ids.has(preset.id)) throw new Error(`Preset id “${preset.id}” is duplicated.`);
    ids.add(preset.id);
  }
  return presets;
}

export function loadPresetDirectories(directoryPaths) {
  const byId = new Map();
  for (const directoryPath of directoryPaths) {
    if (!Gio.File.new_for_path(directoryPath).query_exists(null)) continue;
    for (const preset of loadPresets(directoryPath)) byId.set(preset.id, preset);
  }
  const presets = [...byId.values()];
  presets.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (!presets.some(preset => preset.type === 'profile'))
    throw new Error('No profile presets were found in the Presets folders.');
  return presets;
}
