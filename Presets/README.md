# Siren presets

Each JSON file appears as one choice in Siren's preset menu, sorted by `id`.
A normal preset
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
