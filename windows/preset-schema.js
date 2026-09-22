const LIMITS = { id: 32, name: 32, description: 255, type: 32, noiseMode: 32, tracking: 16 };
const PROFILE_FIELDS = new Set([
  'noisePitch', 'noiseGain', 'minHz', 'maxHz', 'stepFrames',
  'secondGain', 'noiseMode', 'smoothing',
  'precise', 'tracking', 'pitchShift',
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
  const ranges = {
    noisePitch: [0, 255], noiseGain: [0, 4], minHz: [64, 1800],
    maxHz: [64, 1800], stepFrames: [1, 2], secondGain: [0, 1],
    pitchShift: [-24, 24],
  };
  for (const key of Object.keys(preset.options)) {
    if (key.length > 16 || !PROFILE_FIELDS.has(key))
      throw new Error(`${filename}: unknown or too-long profile parameter “${key}”.`);
  }
  for (const [key, [low, high]] of Object.entries(ranges)) {
    if (preset.options[key] !== undefined) boundedNumber(preset.options[key], key, filename, low, high);
  }
  if (preset.options.stepFrames !== undefined && ![1, 2].includes(preset.options.stepFrames))
    throw new Error(`${filename}: stepFrames must be 1 or 2.`);
  if (preset.options.precise !== undefined && typeof preset.options.precise !== 'boolean')
    throw new Error(`${filename}: precise must be true or false.`);
  if (preset.options.noisePitch !== undefined && !Number.isInteger(preset.options.noisePitch))
    throw new Error(`${filename}: noisePitch must be a whole number.`);
  if (preset.options.noiseMode !== undefined) {
    boundedString(preset.options.noiseMode, 'noiseMode', filename);
    if (!['fixed', 'texture'].includes(preset.options.noiseMode))
      throw new Error(`${filename}: noiseMode must be “fixed” or “texture”.`);
  }
  if (preset.options.smoothing !== undefined) {
    boundedString(preset.options.smoothing, 'smoothing', filename);
    if (!['legacy', 'none'].includes(preset.options.smoothing))
      throw new Error(`${filename}: smoothing must be “legacy” or “none”.`);
  }
  if (preset.options.tracking !== undefined) {
    boundedString(preset.options.tracking, 'tracking', filename);
    if (!['tremolo', 'sustain', 'bulky'].includes(preset.options.tracking))
      throw new Error(`${filename}: tracking must be “tremolo”, “sustain”, or “bulky”.`);
  }
  if (preset.options.pitchShift !== undefined && preset.options.tracking === undefined)
    throw new Error(`${filename}: pitchShift requires a tracking profile.`);
  if ((preset.options.minHz ?? 120) > (preset.options.maxHz ?? 1100))
    throw new Error(`${filename}: minHz cannot exceed maxHz.`);
}

function validateAuto(preset, filename) {
  if (!preset.search || !Array.isArray(preset.search.noiseGainFactors) ||
      !Array.isArray(preset.search.noisePitches))
    throw new Error(`${filename}: the Auto preset needs both search arrays.`);
  for (const key of Object.keys(preset.search)) {
    if (key.length > 16 || !['noiseGainFactors', 'noisePitches'].includes(key))
      throw new Error(`${filename}: unknown Auto parameter “${key}”.`);
  }
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

export function validatePreset(preset, filename) {
  if (!preset || typeof preset !== 'object') throw new Error(`${filename}: expected a JSON object.`);
  for (const key of Object.keys(preset)) {
    if (key.length > 16 || !['schemaVersion', 'id', 'name', 'description', 'type', 'order', 'options', 'search'].includes(key))
      throw new Error(`${filename}: unknown preset parameter “${key}”.`);
  }
  boundedString(preset.id, 'id', filename);
  boundedString(preset.name, 'name', filename);
  boundedString(preset.description, 'description', filename);
  boundedString(preset.type, 'type', filename);
  if (!/^[a-z][a-z0-9_]*$/.test(preset.id))
    throw new Error(`${filename}: id must use lowercase letters, numbers, and underscores.`);
  if (preset.schemaVersion !== undefined && preset.schemaVersion !== 1)
    throw new Error(`${filename}: schemaVersion must be 1.`);
  if (preset.order !== undefined) boundedNumber(preset.order, 'order', filename, 0, 10000);
  if (!['profile', 'auto'].includes(preset.type))
    throw new Error(`${filename}: type must be “profile” or “auto”.`);
  if (preset.type === 'profile') validateProfile(preset, filename);
  else validateAuto(preset, filename);
  return preset;
}

function comparePresets(a, b) {
  if (a.id === 'auto') return b.id === 'auto' ? 0 : -1;
  if (b.id === 'auto') return 1;
  if (a.id === 'precise') return b.id === 'precise' ? 0 : 1;
  if (b.id === 'precise') return -1;
  const byName = a.name.localeCompare(b.name);
  return byName || a.id.localeCompare(b.id);
}

export function parsePresetDirectories(directories) {
  const byId = new Map();
  for (const files of directories) {
    const directoryIds = new Set();
    for (const file of files) {
      let preset;
      try { preset = validatePreset(JSON.parse(file.json), file.filename); }
      catch (error) { throw new Error(`Could not load ${file.filename}: ${error.message}`); }
      if (directoryIds.has(preset.id)) throw new Error(`Preset id “${preset.id}” is duplicated.`);
      directoryIds.add(preset.id);
      byId.set(preset.id, preset);
    }
  }
  const presets = [...byId.values()].sort(comparePresets);
  if (!presets.some(preset => preset.type === 'profile'))
    throw new Error('No profile presets were found in the Presets folders.');
  return presets;
}
