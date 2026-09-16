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
- **Companion Link** — a separate TCP connection using OPACK-encoded frames. Launches apps, and
  supplies `_hidC` key presses as a fallback when AirPlay is unavailable.

The two are peers: `AppleTvDevice` connects, retries and reports each one independently, so
losing one does not disturb the other. The `transport` config picks which to open. Both sets of
credentials live in a single serialised `Credentials` blob in Companion's secrets store.

### Bonjour filtering

`bonjourQueries` in the manifest is an array per config field — one query per Apple TV hardware
identifier — matching the AirPlay `model` txt record and the Companion Link `rpMd` record.
Without it the pickers list every AirPlay receiver on the network, including Macs, smart TVs and
AirPlay emulators (which advertise themselves as `AppleTV2,1`). The trade-off is that a hardware
revision newer than the list will not appear and has to be entered manually.

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

### Pairing

Pairing needs two round trips through the config UI: one save asks the Apple TV to show a PIN,
a second save carries the PIN back. The pairing socket has to stay open between those saves, so
`applyConfig()` checks for an outstanding pairing before it does anything to the connection —
otherwise the reconnect logic would tear the socket down and invalidate the PIN.

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

Not yet verified on hardware: Companion Link pairing and connection, **Launch app**, and the
Companion Link HID fallback for remote keys. These follow pyatv's documented message shapes but
have not been exercised end to end — reports welcome.
