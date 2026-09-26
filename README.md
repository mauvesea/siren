<p align="center">
  <img src="data/io.github.mauvesea.Siren.svg" alt="Siren logo" width="256" height="256">
</p>

# Siren

**Siren** is a tool designed to help convert .wav files into [pokecrystal](https://github.com/pret/pokecrystal)-compatible cries. It can also be used to edit cry properties, as well as edit the files directly.

The converted cries are designed with **pitch 0** and **length 256** as a baseline.

This tool is has been developed with AI assistance.

## Converter

The **Converter** tab can be used to input .wav files and output a compatible .asm file.
You can use a variety of effects and fine-tune it using the Modifier sliders.
The default Effect is **None**, which is the raw converted file.

Selecing an Effect will automatically set the Modifiers to positions based on the engine training data, but they can be adjusted as needed.

It's also possible to adjust the overall Volume, add a Fade in and/or Fade out effect, as well as disable specific channels.

The exported .asm files contain in their headers the Siren version and the selected Effect, Volume, Fades, Channels, Pitch, Resonance, Weight, Intonation, Texture, and Breathiness settings.

The intermediate prepared WAV is hidden and input stays on your computer. Siren accepts uncompressed PCM 8/16/24/32-bit and IEEE float 32/64-bit WAVs, including WAVE_FORMAT_EXTENSIBLE, with up to eight channels. Files must be no larger than 20 MB or longer than five seconds. The preview approximates the Game Boy audio hardware; an emulator or real hardware remains the final reference. For reliable playback across Linux audio backends, Siren plays an internal 16-bit, 44.1 kHz copy that preserves the source duration and channel layout. The source file is not changed.


## Editor

The **Editor** allows you to edit the cry list from `/data/pokemon/cries.asm`. Siren loads the available options from
`constants/cry_constants.asm` and the matching sound definitions from `audio/cries.asm` and cry-specific audio subdirectories. Every list entry exposes its macro, cry constant, decimal pitch, decimal length, and the Species name as a comment. The play button beside a row auditions its current constant and parameter values. Very long cries play their first 15 seconds.

Opening the list immediately writes `data/pokemon/cries.asm.backup`. Saving rewrites only changed cry-list rows, preserving every other source line and leaving the backup as the snapshot created at open time. Pitch uses the signed 16-bit range −32768 to 32767 and length uses the unsigned range 0 to 65535.

The validator understands pokecrystal cry headers, square, wave and noise notes, duty cycles and patterns, pitch offsets and sweeps, stereo routing and volume, and finite jumps, calls, and loops within the chosen file. It reports unsupported commands instead of silently playing them incorrectly. The preview simulates the Game Boy's digital channels and timing; analog output coloration and playback hardware can still sound different, so confirm final values in an emulator or on a Game Boy.


## Studio

The **Studio** is a sound editor for .asm cries. It can open a cry `.asm` file as a four-color MIDI-style timeline.
Pitch is defined by the piano row a note occupies and time runs from left to right. Notes can be drawn, box-selected, moved in time, transposed vertically, resized from their right edge, copied with Ctrl+C, pasted at the same timeline position on the active channel with Ctrl+V, cut, and deleted. A 100-step history supports Ctrl+Z and Ctrl+Shift+Z; X switches between the Move Notes and Draw Notes tools while no notes are selected. Delete removes selected notes, while Left and Right move a single-note selection through the active channel. Checked inactive channels remain visible as dim reference tracks but cannot be edited. New notes start at one frame long and then inherit the length of the last note clicked during the session.
The volume lane under the roll provides direct level editing, while the inspector exposes exact duration, envelope or wave, frequency, duty, and sweep commands. The roll scrolls in both directions and zooms with Ctrl+mouse wheel. The Shortcuts button beside the zoom controls opens the full shortcut reference. Click the frame ruler or transport bar to seek; channel visibility checkboxes also mute those channels in the live preview without deleting their notes. The transport previews the selected pokecrystal length. Editor audio is rendered in full when Play is pressed and cached until a note, channel, or playback setting changes.

Opening an ASM in the editor immediately preserves its original contents as a neighboring `.asm.backup` file, without replacing an existing backup. Saving rewrites the input ASM and exports the currently selected cry as a neighboring WAV using the current length and enabled-channel settings.

## Running from source

### Linux

Siren requires GJS, GTK 4, libadwaita, GStreamer, and standard GStreamer
playback plugins. On Fedora these are normally provided by `gjs`, `gtk4`,
`libadwaita`, `gstreamer1`, `gstreamer1-plugins-base`, and
`gstreamer1-plugins-good`.

```sh
./siren
./siren path/to/cry.wav
./siren path/to/cry.asm
```

### Windows 11

The Windows build provides WAV/ASM drag-and-drop, effects, modifiers, both
export formats, parameter validation, and Studio. It uses a
Windows-specific Fluent 2 interface with the native
Mica backdrop, layered translucent surfaces, Segoe UI Variable, and automatic
light, dark, contrast-theme, and reduced-motion support.

Install Node.js 22.12 or later, then run:

```powershell
npm install
npm run windows
```

Bundled presets are extended or overridden on Windows by JSON files in
`%APPDATA%\siren\Presets`, using the same schema and precedence rules as Linux.

## Effects

Every effect is a readable JSON file in [`Presets`](Presets). **None** is the
default, **Auto** searches the available profiles, named effects are sorted by
name, and **Precise** remains last.

**Precise** compares two reconstructions at each playable Game Boy frame and
keeps the closer measured fit. It uses pokecrystal's fixed wave patterns,
follows source dynamics, retains overall stereo balance from two-channel WAVs,
and merges repeated commands. A stock cry
cannot preserve arbitrary PCM samples, sample rate, or bit depth. See the
[engine analysis and fidelity limits](docs/precise-engine.md).

**Gen 3**, **Gen 4**, and **Gen 5** are generation-inspired category effects.
They retain the broad sonic direction of each source generation while emitting
only stock Game Boy hardware commands.

See [`Presets/README.md`](Presets/README.md) for fields and limits. In a source
checkout, add files to `Presets/`. For an AppImage, add a `Presets` folder beside
the executable. Every installation also reads `~/.config/siren/Presets/`.
Custom presets with a new `id` add a choice; a matching `id` overrides a
bundled profile.

## Building packages

### Linux packages

Run [`build.sh`](build.sh) with no arguments to build all three formats:

```sh
./build.sh
```

To build only selected formats, pass one or more of `appimage`, `deb`, or `rpm`:

```sh
./build.sh deb
./build.sh appimage rpm
```

`make` builds all three Linux packages and the Windows portable executable.
Use `make linux` to build only the Linux packages, or `make appimage`,
`make deb`, and `make rpm` to build individual Linux formats. `make windows`
builds only the Windows executable.
The AppImage is self-contained and targets x86-64 Linux. DEB and RPM packages
install Siren under `/usr` and depend on the distribution's native GTK,
libadwaita, GJS, and GStreamer packages. Building requires Podman, or
[appimage-builder](https://appimage-builder.readthedocs.io/) for the AppImage
and [nFPM](https://nfpm.goreleaser.com/) for DEB/RPM. The recipes are
[`AppImageBuilder.yml`](AppImageBuilder.yml) and [`nfpm.yaml`](nfpm.yaml).

### Windows executables

On Windows, install dependencies and build the standalone executables:

```powershell
npm install
npm run windows:pack
```

This produces one `Siren-2.0.0.exe` in `dist`, containing the x64 and Arm64
payloads. It is a self-contained portable app: it can be launched directly and
does not need an installer or adjacent runtime files. Use
`npm run windows:dir` for unpacked development builds.

An optional system-wide installer, including WAV and ASM file associations and
Start menu shortcuts, can be built with `npm run windows:installer`.

## Tests

```sh
make test
npm run test:windows
```

The [GJS integration test](tests/integration/conversion-workflow.test.js)
covers preset loading and validation, automatic selection, conversion, Auto,
ASM generation, and preview synthesis. The
[parameter validation test](tests/integration/parameter-validation.test.js)
covers ASM parsing, parameter limits, playback timing, pitch offsets, and
preview rendering.
The Windows parity tests execute the same conversion, preview, ASM parsing,
parameter, and preset modules under the Windows runtime and verify its system
theme and accessibility hooks.

## Adding generated ASM to pokecrystal

Copy the exported ASM into pokecrystal's `audio/` directory and include it in
the `SECTION "Cries", ROMX` block in `audio.asm`. Add a matching cry constant
to `constants/cry_constants.asm` and a `dba Cry_<Label>` pointer to
`audio/cry_pointers.asm` in the same position. Assign the species with
`mon_cry CRY_<LABEL>, 0, 256` in `data/pokemon/cries.asm`.

Arbitrary PCM cannot be represented exactly by two square waves and one noise
generator, so trying several effects is part of the intended workflow.
