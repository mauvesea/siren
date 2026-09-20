<p align="center">
  <img src="data/io.github.mauvesea.Siren.svg" alt="Siren logo" width="256" height="256">
</p>

# Siren

Siren is an application that turns a WAV into a three-channel cry
for [pokecrystal](https://github.com/pret/pokecrystal). It uses two Game Boy
square-wave channels (5 and 6) and one noise channel (8). Generated cries are
intended for **pitch 0** and **length 256**.

This tool is AI assisted.

## Using the app

Open Siren and choose or drop a WAV. The application prepares the audio
internally, recommends a preset, and synthesizes a converted sound. Listen to
the original and converted versions in Sound Check, choose another preset to
compare, then select **Export** to create an `.asm` file beside the source WAV.

The intermediate prepared WAV is hidden and the former note editor has been
removed. Input stays on your computer. Siren accepts uncompressed PCM
8/16/24/32-bit and IEEE float 32/64-bit WAVs, including
WAVE_FORMAT_EXTENSIBLE, with up to eight channels. Files must be no larger than
20 MB or longer than five seconds. The preview approximates the Game Boy audio
hardware; an emulator or real hardware remains the final reference.

## Running from source

Siren requires GJS, GTK 4, libadwaita, GStreamer, and standard GStreamer
playback plugins. On Fedora these are normally provided by `gjs`, `gtk4`,
`libadwaita`, `gstreamer1`, `gstreamer1-plugins-base`, and
`gstreamer1-plugins-good`.

```sh
./siren
./siren path/to/cry.wav
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
ASM generation, and preview synthesis.

## Adding generated ASM to pokecrystal

Copy the exported ASM into pokecrystal's `audio/` directory and include it in
the `SECTION "Cries", ROMX` block in `audio.asm`. Add a matching cry constant
to `constants/cry_constants.asm` and a `dba Cry_<Label>` pointer to
`audio/cry_pointers.asm` in the same position. Assign the species with
`mon_cry CRY_<LABEL>, 0, 256` in `data/pokemon/cries.asm`.

Arbitrary PCM cannot be represented exactly by two square waves and one noise
generator, so trying several presets is part of the intended workflow.
