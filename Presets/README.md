# Siren presets

Each JSON file appears as one choice in Siren's preset menu, sorted by name,
with Auto first and Precise last.
A normal preset
uses `"type": "profile"` and passes its `options` directly to the converter.
Copy an existing file, give it a unique lowercase `id`, change its `name`, and
adjust only the options you need. Omitted options retain the converter defaults.

Preset names should describe the conversion character without a modifier
prefix. The separate Pitch, Resonance, Weight, and Intonation controls can be
combined with any bundled or custom profile. These controls are built into the
shared conversion engine rather than duplicated as preset JSON files.

Supported profile options:

- `minHz` and `maxHz`: square-wave pitch search range, from 64 to 1800 Hz.
- `stepFrames`: `1` tracks every Game Boy frame; `2` produces steadier notes.
- `noisePitch`: Game Boy NR43 noise register, from 0 to 255.
- `noiseGain`: noise loudness multiplier, from 0 to 4.
- `secondGain`: secondary square-wave loudness multiplier, from 0 to 1.
- `noiseMode`: `"fixed"` or source-dependent `"texture"`.
- `smoothing`: `"legacy"` or `"none"`.
- `tracking`: `"tremolo"` separates a swept melody from its frame-level pulse;
  `"sustain"` keeps Precise's layered supporting channels while octave-locking
  and smoothing its main pulse melody; `"bulky"` assigns body, edge, sub-tone,
  and source-matched LFSR texture across all four channels. These specialized
  modes replace the other profile options.
- `pitchShift`: transposes all tonal channels in a tracking profile by -24 to
  24 semitones. Noise pitch is unchanged.
- `precise`: `true` enables per-frame matching with the built-in wave channel
  and combines identical consecutive commands. The app's preset engine
  compares two hardware-valid fits for this special profile. Other profile
  options are ignored when `precise` is true.

See [`docs/precise-engine.md`](../docs/precise-engine.md) for the hardware
limits and the Precise conversion method.

`auto.json` searches the available profiles and adjusts noise settings for the
selected WAV. It is a special preset and should remain the only file with
`"type": "auto"`.

The `id` and `name` must be at most 32 characters; `description` at most 255;
`type` and `noiseMode` at most 32; and all other parameter names or string
values at most 16. Numeric values must be finite and within the documented
ranges. Each JSON file must be smaller than 16 KiB.

When running the AppImage, keep a `Presets` folder beside it. For any
installation, place custom files in `~/.config/siren/Presets/`. A new `id`
adds a preset; a matching `id` overrides the bundled version without
rebuilding the application.
