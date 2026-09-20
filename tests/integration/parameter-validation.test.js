import { makeAsm, readWav } from '../../src/converter.js';
import { applyCryParameters, parseCryAsm } from '../../src/cry-asm.js';
import { renderPreview } from '../../src/preview.js';

function assert(condition, message) { if (!condition) throw new Error(message); }
function rejects(callback, fragment) {
  try { callback(); } catch (error) {
    assert(error.message.includes(fragment), `Expected “${fragment}”, got “${error.message}”.`);
    return;
  }
  throw new Error(`Expected failure containing “${fragment}”.`);
}

const generated = makeAsm({
  label: 'Test',
  channels: {
    ch5: [{ duration: 1, volume: 10, envelope: 8, frequency: 1600, duty: 2 }],
    ch6: [{ duration: 1, volume: 8, envelope: 8, frequency: 1400, duty: 1 }],
    ch8: [{ duration: 1, volume: 5, envelope: 8, frequency: 75 }],
  },
});
const cry = parseCryAsm(generated);
assert(cry.channels.ch5[0].frequency === 1600, 'Generated square note should parse.');
assert(cry.channels.ch8[0].frequency === 75, 'Generated noise note should parse.');
const defaultPlayback = applyCryParameters(cry, 0, 256);
assert(defaultPlayback.channels.ch5[0].frames === 2, 'Length 256 should preserve note timing.');
assert(defaultPlayback.channels.ch8[0].frames === 2, 'Noise should use its default tempo.');
const changed = applyCryParameters(cry, -100, 512);
assert(changed.channels.ch5[0].frequency === 1500, 'Pitch should change square frequency.');
assert(changed.channels.ch8[0].frequency === 231, 'Pitch should wrap the noise register byte.');
assert(changed.channels.ch5[0].frames === 4, 'Length should scale square timing.');
assert(changed.channels.ch8[0].frames === 2, 'Length should not alter noise timing.');
assert(readWav(renderPreview(changed)).rate === 44100, 'Adjusted cry must be a playable WAV.');
assert(readWav(renderPreview(changed)).samples.length > readWav(renderPreview(defaultPlayback)).samples.length,
  'Longer length should produce a longer preview.');

const native = `
Cry_Example:
  channel_count 2
  channel 5, Cry_Example_Ch5
  channel 8, Cry_Example_Ch8
Cry_Example_Ch5:
  pitch_sweep 15, -7
  duty_cycle_pattern 1, 2, 0, 3
.loop:
  square_note 1, 15, -7, $600
  sound_loop 2, .loop
  pitch_offset -16
  square_note 0, 12, 8, 1500
  sound_ret
Cry_Example_Ch8:
  noise_note 1, 10, 8, %1001011
  sound_ret
`;
const nativeCry = parseCryAsm(native);
assert(nativeCry.channels.ch5.length === 3, 'Finite ASM loop should expand twice.');
assert(nativeCry.channels.ch5[0].sweep[1] === -7, 'Sweep setting should be preserved.');
assert(nativeCry.channels.ch5[0].dutyPattern.join(',') === '1,2,0,3', 'Duty pattern should parse.');
assert(applyCryParameters(nativeCry, 20, 256).channels.ch5[2].frequency === 1484,
  'ASM pitch_offset should override the playback pitch.');
assert(readWav(renderPreview(applyCryParameters(nativeCry, 20, 256))).samples.length > 0,
  'Native style cry should render.');
const selected = parseCryAsm(`${native}\nCry_Other:\n  channel_count 1\n  channel 8, Cry_Other_Ch8\nCry_Other_Ch8:\n  noise_note 0, 15, 8, 75\n  sound_ret\n`, 'Cry_Other');
assert(selected.label === 'Cry_Other' && selected.availableCries.length === 2,
  'A file with several cry headers should allow selecting one.');
const longCry = parseCryAsm(generated.replace('square_note 1, 10, 8, 1600',
  Array(10).fill('square_note 0, 10, 8, 1600').join('\n\t')));
const longPlayback = applyCryParameters(longCry, 0, 60000);
longPlayback.allowTruncatedPreview = true;
assert(readWav(renderPreview(longPlayback, 15)).samples.length === 15 * 44100,
  'Long cries should be audible up to the validation preview cap.');
rejects(() => applyCryParameters(cry, 32768, 256), 'Pitch must');
assert(applyCryParameters(cry, 0, 0).channels.ch5[0].frames === 1,
  'Zero length should advance square notes each frame.');
rejects(() => applyCryParameters(cry, 0, -1), 'Length must');
rejects(() => parseCryAsm(native.replace('sound_loop 2', 'sound_loop 0')), 'infinite sound_loop');
rejects(() => parseCryAsm(native.replace('pitch_sweep 15, -7', 'vibrato 1, 2, 3')),
  'cannot be previewed accurately');

print('Siren parameter validation tests passed.');
