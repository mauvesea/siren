# Siren

Siren converts WAV recordings into three-channel cries and lets you audition
the pitch and length of existing cry ASM files for
[pokecrystal](https://github.com/pret/pokecrystal). The cries use Game Boy
square-wave channels 5 and 6 and noise channel 8. Generated cries are intended
for **pitch 0** and **length 256**.

This tool is AI assisted.

## Using the app

Select **File Converter** at the top of the window, then choose or drop a WAV.
The application prepares the audio internally, recommends a preset, and
synthesizes a converted sound. Listen to the original and converted versions
in Sound Check, choose another preset to compare, then select **Export** to
create an `.asm` file beside the source WAV.

The intermediate prepared WAV is hidden and the former note editor has been
removed. Input stays on your computer. Siren accepts uncompressed PCM
8/16/24/32-bit and IEEE float 32/64-bit WAVs, including
WAVE_FORMAT_EXTENSIBLE, with up to eight channels. Files must be no larger than
20 MB or longer than five seconds. The preview approximates the Game Boy audio
hardware; an emulator or real hardware remains the final reference.
For reliable playback across Linux audio backends, Siren plays an internal
16-bit, 44.1 kHz copy that preserves the source duration and channel layout.
The source file is not changed.

Select **Parameter Validation** to open or drop a cry `.asm` file. If the file
contains several cries, choose one from the **Cry** list. Adjust **Pitch**
(−32768 to 32767) and **Length** (0 to 65535), then play the preview. If it is
already playing, changing either value restarts playback with the new value.
The controls mirror pokecrystal's signed 16-bit pitch offset and unsigned
16-bit length: pitch affects both square and noise frequencies, while length
changes the square-channel tempo and leaves the noise channel at its default.
Parameter Validation does not export or modify the ASM file.
Very long cries play their first 15 seconds so every allowed parameter value
can still be auditioned promptly.

The validator understands pokecrystal cry headers, square and noise notes,
duty cycles and patterns, pitch offsets and sweeps, and finite jumps, calls,
and loops within the chosen file. It reports unsupported commands instead of
silently playing them incorrectly. The preview simulates the Game Boy's
digital channels and timing; analog output coloration and playback hardware
can still sound different, so confirm final values in an emulator or on a
Game Boy.

## Running from source

Siren requires GJS, GTK 4, libadwaita, GStreamer, and standard GStreamer
playback plugins. On Fedora these are normally provided by `gjs`, `gtk4`,
`libadwaita`, `gstreamer1`, `gstreamer1-plugins-base`, and
`gstreamer1-plugins-good`.

```sh
./siren
./siren path/to/cry.wav
./siren path/to/cry.asm
```

## Presets

Every profile is a readable JSON file in [`Presets`](Presets). The **Auto**
preset searches the available profiles for a close match. The menu sorts
presets alphabetically by `id`.

See [`Presets/README.md`](Presets/README.md) for fields and limits. In a source
checkout, add files to `Presets/`. For an AppImage, add a `Presets` folder beside
the executable. Every installation also reads `~/.config/siren/Presets/`.
Custom presets with a new `id` add a choice; a matching `id` overrides a
bundled profile.

## Building packages

Run [`build.sh`](build.sh) with no arguments to build all three formats:

```sh
./build.sh
```

To build only selected formats, pass one or more of `appimage`, `deb`, or `rpm`:

```sh
./build.sh deb
./build.sh appimage rpm
```

`make`, `make appimage`, `make deb`, and `make rpm` are equivalent shortcuts.
The AppImage is self-contained and targets x86-64 Linux. DEB and RPM packages
install Siren under `/usr` and depend on the distribution's native GTK,
libadwaita, GJS, and GStreamer packages. Building requires Podman, or
[appimage-builder](https://appimage-builder.readthedocs.io/) for the AppImage
and [nFPM](https://nfpm.goreleaser.com/) for DEB/RPM. The recipes are
[`AppImageBuilder.yml`](AppImageBuilder.yml) and [`nfpm.yaml`](nfpm.yaml).

## Tests

```sh
make test
```

The [GJS integration test](tests/integration/conversion-workflow.test.js)
covers preset loading and validation, automatic selection, conversion, Auto,
ASM generation, and preview synthesis. The
[parameter validation test](tests/integration/parameter-validation.test.js)
covers ASM parsing, parameter limits, playback timing, pitch offsets, and
preview rendering.

## Adding generated ASM to pokecrystal

Copy the exported ASM into pokecrystal's `audio/` directory and include it in
the `SECTION "Cries", ROMX` block in `audio.asm`. Add a matching cry constant
to `constants/cry_constants.asm` and a `dba Cry_<Label>` pointer to
`audio/cry_pointers.asm` in the same position. Assign the species with
`mon_cry CRY_<LABEL>, 0, 256` in `data/pokemon/cries.asm`.

Arbitrary PCM cannot be represented exactly by two square waves and one noise
generator, so trying several presets is part of the intended workflow.
