# Siren effects

Each JSON file appears as one choice in Siren's Effect menu. None is first,
Auto follows it, named effects are sorted by name, and Precise is last.
A normal effect
uses `"type": "profile"` and passes its `options` directly to the converter.
Copy an existing file, give it a unique lowercase `id`, change its `name`, and
adjust only the options you need. Omitted options retain the converter defaults.

Supported profile options:

- `minHz` and `maxHz`: square-wave pitch search range, from 64 to 1800 Hz.
- `stepFrames`: `1` tracks every Game Boy frame; `2` produces steadier notes.
- `noisePitch`: Game Boy NR43 noise register, from 0 to 255.
- `noiseGain`: noise loudness multiplier, from 0 to 4.
- `secondGain`: secondary square-wave loudness multiplier, from 0 to 1.
- `noiseMode`: `"fixed"` or source-dependent `"texture"`.
- `smoothing`: `"legacy"` or `"none"`.
- `precise`: `true` enables per-frame matching with the built-in wave channel
  and combines identical consecutive commands. The app's preset engine
  compares two hardware-valid fits for this special profile. Other profile
  options are ignored when `precise` is true.
- `effect`: one of `none`, `deep`, `tremolo`, `vibrato`, `glissando`,
  `portamento`, `digital`, `fry`, `breathy`, or `falsetto`. These transformations
  use stock pitch, duty, envelope, wave, and noise registers.

See [`docs/precise-engine.md`](../docs/precise-engine.md) for the hardware
limits and the Precise conversion method.

`auto.json` searches the available effects and adjusts noise settings and
modifiers for the selected WAV. It is special and should remain the only file with
`"type": "auto"`.

`gen3.json`, `gen4.json`, and `gen5.json` are generation-inspired category
effects tuned for the broad sonic character of their respective source games.

The `id` and `name` must be at most 32 characters; `description` at most 255;
`type` and `noiseMode` at most 32; and all other parameter names or string
values at most 16. Numeric values must be finite and within the documented
ranges. Each JSON file must be smaller than 16 KiB.

When running the AppImage, keep a `Presets` folder beside it. For any
installation, place custom files in `~/.config/siren/Presets/`. A new `id`
adds a preset; a matching `id` overrides the bundled version without
rebuilding the application.
