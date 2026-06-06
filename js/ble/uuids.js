// BLE GATT identifiers for the Cult Smart Scale (CF-header family).
//
// Reverse-engineered live — see research/cult_scale_protocol.md. The scale is
// NOT SIG Weight-Scale (0x181D) compliant: it uses a proprietary 0xfff0 service
// and streams all measurement frames on the 0xfff4 notify characteristic with
// NO handshake (subscribing is enough).

// Web Bluetooth accepts 16-bit UUIDs as plain numbers, but several stacks are
// happier with the full 128-bit base UUID string, so expose both forms.
export const uuid16 = (x) => `0000${x.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;

export const SCALE_SERVICE = 0xfff0;            // primary data service
export const MEASUREMENT_CHAR = 0xfff4;         // notify: 11-byte measurement frames
export const WRITE_CHAR = 0xfff1;               // write: profile/commands (unused so far)
export const BATTERY_SERVICE = 0x180f;          // standard battery
export const BATTERY_CHAR = 0x2a19;

export const SCALE_SERVICE_UUID = uuid16(SCALE_SERVICE);
export const MEASUREMENT_CHAR_UUID = uuid16(MEASUREMENT_CHAR);

// Name substrings the device advertises (used by requestDevice namePrefix).
export const NAME_PREFIXES = ['Cult', 'CULT'];
