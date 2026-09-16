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

The Companion Link port is deliberately _not_ a stored setting. The Apple TV assigns it afresh
on every restart, so `#discover()` looks it up over mDNS on each connect and the `companionPort`
config value is only consulted when discovery comes back empty. Storing it would leave the
connection retrying a dead port with no way to recover on its own.

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
step the user is actually on.

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

Companion Link pairs and connects against that same hardware. Its commands were timing out until
the message envelope was corrected; the wire format is now checked by a harness that round-trips
each request through the library's own OPACK codec and asserts the shape pyatv documents.

Not yet confirmed working on hardware: **Launch app**, the app list, and the Companion Link HID
fallback for remote keys — the messages are now provably the right shape, but the Apple TV's
responses have not been seen. Reports welcome.
