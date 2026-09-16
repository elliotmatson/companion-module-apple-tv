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
- **Companion Link** — a separate TCP connection using OPACK-encoded frames. Used only for
  launching apps and the raw-request escape hatch. It is opt-in because it needs its own pairing.

Both sets of credentials live in a single serialised `Credentials` blob, stored in Companion's
secrets store rather than in the connection config.

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

## Getting started

```bash
yarn install
yarn build      # or `yarn dev` to watch
yarn lint
```

Point Companion's developer modules path at the folder containing this repository to load it.

## Testing status

Discovery, the build and the Companion API surface have been exercised locally. The pairing
handshake and the remote commands have **not** been verified against real Apple TV hardware by
the author — the underlying library reports them as tested against an Apple TV 4K. Reports from
anyone who can try it on hardware are very welcome.
