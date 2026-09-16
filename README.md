# companion-module-apple-tv

A [Bitfocus Companion](https://bitfocus.io/companion) module for controlling an Apple TV over IP.

Addresses [bitfocus/companion-module-requests#671](https://github.com/bitfocus/companion-module-requests/issues/671).

See [HELP.md](./companion/HELP.md) for user documentation and [LICENSE](./LICENSE).

## How it works

All protocol work is done by [`node-appletv-remote`](https://github.com/energee/node-appletv-remote),
a pure-JavaScript implementation of Apple's pairing and remote-control protocols (MIT licensed,
no native dependencies, no Python). There are two transports:

- **AirPlay 2 / MRP** — HAP pair-setup over SRP, then an RTSP session carrying an MRP tunnel.
  This is the primary path: remote keys, media commands, the on-screen keyboard, wake/sleep and
  pushed now-playing updates all go over it.
- **Companion Link** — a separate TCP connection using OPACK-encoded frames. Launches apps, lists
  the installed ones, and supplies `_hidC` key presses as a fallback when AirPlay is unavailable.

The two are peers: `AppleTvDevice` connects, retries and reports each one independently, so
losing one does not disturb the other. The `transport` config picks which to open. Both sets of
credentials live in a single serialised `Credentials` blob in Companion's secrets store.

### Discovery

`bonjourQueries` in the manifest is an array of queries — one per Apple TV hardware identifier —
matching the AirPlay `model` txt record. Without it the picker lists every AirPlay receiver on
the network, including Macs, smart TVs and AirPlay emulators (which advertise themselves as
`AppleTV2,1`). The trade-off is that a hardware revision newer than the list will not appear and
has to be entered manually.

The Companion Link port is deliberately not a stored setting. The Apple TV assigns it afresh on
every restart, so it is looked up over mDNS on each connect. Storing it would leave the
connection retrying a dead port with no way to recover on its own.

`src/discovery.ts` does that lookup rather than the library's `scan()`, for two reasons. The
library only learns a companion-link port for a device it first saw on `_airplay._tcp`, so a
missed AirPlay announcement costs the Companion Link port as well; browsing both service types
and matching on address keeps them independent. And announcements simply go missing — measured
against real hardware, roughly one query in four came back empty however the socket was managed
— so a lookup makes several short passes and merges what each one saw. A connection that still
has no port re-runs discovery on every retry rather than looping on a port it never had.

## Source layout

| File               | Purpose                                                                              |
| ------------------ | ------------------------------------------------------------------------------------ |
| `src/main.ts`      | Instance lifecycle, config handling and the two-step pairing state machine           |
| `src/device.ts`    | Connection, reconnect, now-playing state and pairing, wrapping `node-appletv-remote` |
| `src/config.ts`    | Config field definitions and address resolution                                      |
| `src/actions.ts`   | Action definitions                                                                   |
| `src/feedbacks.ts` | Feedback definitions                                                                 |
| `src/variables.ts` | Variable definitions and value updates                                               |
| `src/presets.ts`   | Preset buttons and their sections                                                    |

### Now-playing updates

Nothing is polled. `node-appletv-remote` sends `ClientUpdatesConfig` with `nowPlayingUpdates`
during MRP setup, so the Apple TV pushes a `SetState` message for every change and the module
just listens. The one explicit request is made shortly after connecting, because a subscription
says nothing about what was already playing before it existed.

An idle Apple TV never answers that request, so the timeout is expected and is logged at debug
level once rather than on repeat.

### Patches to node-appletv-remote

`.yarn/patches` carries two fixes to the library's Companion Link frame encryption. Both leave
the connection looking perfectly healthy while nothing it carries works, because pair-verify is
sent in the clear and only the traffic after it is affected.

1. **Framed length.** `CompanionSession.encrypt()` writes the plaintext length into the 4-byte
   header, but that header is also the AAD and the Apple TV computes it over the ciphertext
   _plus_ the 16-byte auth tag — see `CompanionConnection.send()` in pyatv. The short length
   both under-frames the message on the wire and makes the AAD disagree.
2. **Nonce layout.** Companion uses a 12-byte nonce that is the counter in little-endian, so the
   counter sits in the first 8 bytes. The library reuses the HAP/AirPlay helper, which left-pads
   an 8-byte counter and puts it at offset 4. pyatv makes the distinction explicit by building
   the companion cipher with `nonce_length=12` instead of the default 8. The two layouts agree
   only for counter 0, so the first frame of a session works and every frame after it is sealed
   with a nonce the device does not expect.

3. **Inbound framing.** `processEncryptedFrames()` reads the header length as a plaintext
   length and computes `4 + length + 16`, but the Apple TV declares the ciphertext and tag
   together, exactly as the library itself now sends. The parser therefore waits for 16 bytes
   that never arrive: the reply is sitting in the buffer, never handed to anyone, and the
   request times out. pyatv reads it as `HEADER_LENGTH + length`.

All three should go upstream; until then Yarn applies them at install time.

### The Companion Link handshake

`#startCompanionSession()` follows pyatv's `CompanionAPI.connect()`: `_systemInfo`, `_touchStart`,
`_sessionStart`, `TVRCSessionStart`, `_tiStart`, then an `_interest` event registering `_iMC`.
Only the session and the app list are needed for anything this module does, so each step is
best-effort — but a device that only hears some of them appears to treat the connection as idle
and closes it after roughly thirty seconds. `_interest` goes out as an event (`_t: 1`), which
nothing answers, rather than as a request.

### Companion Link message format

`node-appletv-remote` sends Companion Link requests as a flat OPACK dict — the caller's fields
alongside `_i` (identifier) and `_x` (transfer id). The Apple TV ignores those: it expects an
envelope of `_i`, `_x`, `_t` (message type, 2 = request) with the arguments nested under `_c`,
and replies with its payload under `_c` too. Without it every command times out while the
connection itself looks perfectly healthy.

`companionRequest()` builds that envelope and unwraps the reply. Because the library appends
`_i`/`_x` to whatever map it is handed, passing it `{_t, _c}` produces exactly the right shape
without patching the library.

### Pairing

There is no button to start pairing: a save with a device selected and nothing stored begins it,
so the flow is just pick device → PIN → PIN. `#completePairing()` chains straight into
`beginPairing('companion', …)` once AirPlay succeeds, and only connects after the second PIN (or
immediately, if the Companion Link pairing could not be started — the AirPlay credentials are
saved either way). `getConfigFields()` reads the current pairing state, so the page describes the
step the user is actually on. It has to cope with being called before `init()`: on a first init
the host calls it to harvest the fields' `default` values, so `this.config` is not set yet.

Two things keep that from looping, since a module's own `saveConfig()` comes back as a
`configUpdated`: an outstanding pairing is checked before anything that could start a new one,
and `#pairingInFlight` covers the window before there is a pending pairing to check against.

The credentials are stored in Companion's secrets store without a matching config field —
`setConnectionLabelAndConfig` assigns the secrets blob wholesale rather than filtering it against
declared fields, so the field would only be UI clutter.

The pairing socket has to stay open between saves, so `applyConfig()` checks for an outstanding
pairing before it does anything to the connection — otherwise the reconnect logic would tear the
socket down and invalidate the PIN.

Saving the config from inside the module (to store credentials and clear the pairing fields)
comes back as a `configUpdated`. `#connect()` therefore compares a signature of everything the
connection depends on and does nothing when it is unchanged, so a healthy connection is not
dropped and rebuilt moments after pairing succeeds.

## Getting started

```bash
yarn install
yarn build      # or `yarn dev` to watch
yarn lint
```

Point Companion's developer modules path at the folder containing this repository to load it.

## Testing status

Verified against an Apple TV HD (`AppleTV5,3`, tvOS 26.4): Bonjour discovery and filtering,
AirPlay pairing, connection and reconnection. Verified locally: the build, lint, packaging, and
a structural check over the action, feedback, variable, preset and config definitions.

Companion Link pairs and connects against that same hardware. Its commands went unanswered until
the message envelope and the frame encryption were both corrected. Two harnesses cover that now:
one round-trips each request through the library's own OPACK codec and asserts the shape pyatv
documents, the other checks a frame reframes cleanly and decrypts with an independent
ChaCha20-Poly1305 implementation using the header it would arrive with.

Not yet confirmed working on hardware: **Launch app**, the app list, and the Companion Link HID
fallback for remote keys — the messages are now provably the right shape and correctly sealed,
but a successful reply has not been seen. Reports welcome.
