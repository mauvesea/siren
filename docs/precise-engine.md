# Precise preset and pokecrystal audio limits

This note describes the stock pokecrystal sound engine examined for Precise.
The relevant sources are [the driver](https://github.com/pret/pokecrystal/blob/master/audio/engine.asm),
[wave patterns](https://github.com/pret/pokecrystal/blob/master/audio/wave_samples.asm),
[command macros](https://github.com/pret/pokecrystal/blob/master/macros/scripts/audio.asm),
[command reference](https://github.com/pret/pokecrystal/blob/master/docs/music_commands.md),
and [cry entry point](https://github.com/pret/pokecrystal/blob/master/home/audio.asm).
[Pan Docs audio](https://gbdev.io/pandocs/Audio.html) covers the underlying
Game Boy hardware. Precise produces ordinary cry ASM; it does not add a PCM
player or modify the game engine.

## Cry playback path

`PlayCry` in `home/audio.asm` supplies a cry ID, a signed 16-bit pitch offset,
and a 16-bit length. `_PlayCry` in `audio/engine.asm` reads a banked cry header,
starts up to four sound channels, applies the pitch offset, and uses `length`
as the tempo on channels 5–7. Channel 8 keeps its default tempo. A cry uses
sound-effect channels 5–8, which map to the Game Boy's four physical audio
channels and can temporarily displace music. Channel 5 is kept in Precise
outputs even when silent because the driver's volume restoration runs when
that channel ends. Generated cries expect pitch `0` and length `256`.

`_UpdateSound` advances each active channel once per video frame. Its note
delay is byte sized. For SFX and cry notes, the length byte normally yields
`length + 1` frames at tempo `256`; `$ff` wraps in `SetNoteDuration`, so Precise
limits a merged note to 255 frames. The frame cadence is
`4,194,304 / 70,224 ≈ 59.7275 Hz`, or about 16.74 ms per control step.
Sub-frame note starts, stops, volume moves, and pitch moves are unavailable
from a stock cry stream. A source duration is therefore rounded to the
nearest whole frame, and the preview uses that playable duration.

## What the four hardware channels can produce

| Cry channel | Hardware | Stock controls useful for reconstruction |
| --- | --- | --- |
| 5 | Pulse 1 | 11-bit period, four duty settings, 4-bit starting volume, simple timed increase/decrease envelope, hardware pitch sweep, four-frame duty pattern, pitch offset, vibrato and note-by-note retuning. |
| 6 | Pulse 2 | The same pulse and envelope controls, excluding pulse 1's hardware sweep. |
| 7 | Wave | One of ten fixed 32-step wave patterns stored in `audio/wave_samples.asm`; each step is 4-bit. Hardware output level is off, full, half, or quarter. Notes select the pattern and an 11-bit period. |
| 8 | Noise | A 15-bit or 7-bit LFSR, NR43 clock shift and divisor, 4-bit starting volume, and the same basic envelope. No arbitrary recorded noise sample is loaded by `noise_note`. |

Pulse frequency is approximately `131072 / (2048 - register)` Hz; wave
frequency is approximately `65536 / (2048 - register)` Hz. The wave pattern's
32 nibbles repeat once per wave period, so its internal sample clock is
`32 × wave frequency`, not the input WAV's sample rate. These formulas give
minimum pulse and wave fundamentals near 64 and 32 Hz respectively. Noise
uses an LFSR clock and has no single stable pitch in 15-bit mode.

The driver also understands `duty_cycle_pattern`, `pitch_sweep`, `vibrato`,
`pitch_slide`, `pitch_offset`, stereo routing, per-side master volume, and
finite `sound_loop`/`sound_call`/`sound_jump` patterns. They can approximate
pulse-width modulation, pitch bends, tremolo-like motion, echo-like repeated
events, and repeated phrase compression. They cannot provide an arbitrary
filter, impulse response, reverb tail, PCM playback rate, or free-form ADSR
curve. The pulse and noise envelopes have only a starting level, direction,
and hardware step period; Precise uses note-by-note volume changes for more
general envelopes. The stereo routing is on/off per side, while master volume
has eight nonzero levels per side. In-battle cry side masking and the user's
stereo setting can further affect actual playback.

## How Precise uses those limits

1. Siren decodes the accepted PCM/float WAV formats to floating-point samples,
   applies a band-limited downsample to its analysis rate of 10,512 Hz, and analyzes one Game Boy
   frame at a time. The analysis rate is an internal measurement grid, not a
   target hardware playback rate or bit depth.
2. It fits pulse frequencies and duty cycles to spectral peaks, then refines
   a strongly periodic fundamental with interpolated zero crossings. When a
   stable fundamental is below the pulse channel's 64 Hz floor, it uses the
   wave channel alone for that fundamental. The search reaches 4,200 Hz at
   the high end. A second
   pulse voice is kept only when its frequency persists into a neighboring
   frame, reducing isolated false harmonics.
3. It compares the first eight harmonic magnitudes against the exact ten
   built-in wave patterns. One candidate uses channel 7 to reinforce the
   dominant pulse voice. Another removes the two pulse voices and their
   nearby harmonics from the spectrum, then gives channel 7 a separate tone.
   The latter also estimates diffuse energy from spectral flatness and
   represents it with a 15-bit LFSR noise setting. A good wave fit receives
   the appropriate wave period and one of its three audible output levels.
4. Per-frame levels follow the source RMS envelope, including quiet active
   frames. For stereo WAVs, overall left/right RMS balance maps to the
   driver's per-side volume; strongly one-sided sound uses forced stereo
   routing. Multichannel WAVs are downmixed. Independent left/right spectral
   trajectories and moving pan are not reconstructed.
5. Both candidates are rendered through the same preview model. A
   phase-independent comparison of three spectral resolutions, frame-level
   envelope, overall level, and dominant pitch selects the closer candidate.
   This is a measurement within Siren's model, not a listening test on Game
   Boy hardware.
6. Consecutive identical hardware states are merged into one note, and
   channels that never sound are omitted from the header. Channel 5 stays
   present for correct cry cleanup. This saves ROM space without removing
   represented frame changes. Finite loop and call compression could shrink
   some repeated phrases further, but this exporter does not currently emit
   them.

## Fidelity boundary

An `.asm` cry stores commands, not PCM. The source's sample rate, PCM bit
depth, channel count, and sample encoding cannot be retained as output
properties. The closest stock equivalents are the pulse/noise volume steps,
the wave channel's 4-bit pattern values and discrete level settings, and the
hardware period registers. Filtering, spatial motion, and time effects can
only be suggested with these generators. The software preview models the
digital channels but is not a cycle-perfect or analog model; final listening
should use a pokecrystal build in an emulator or on hardware.
