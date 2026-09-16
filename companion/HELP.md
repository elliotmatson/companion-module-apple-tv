## Apple TV

Controls an Apple TV over the local network — no IR blaster, no HDMI-CEC. The module speaks
the same protocols Apple's own remote apps use: **AirPlay 2 / MRP** for remote keys and
now-playing information, and optionally **Companion Link** for launching apps.

Works with Apple TV 4K, Apple TV HD and the 4th-generation Apple TV on current tvOS releases.

### Setting it up

1. Make sure the Apple TV is awake and on the same network as Companion.
2. In the connection config, pick your Apple TV from the **Apple TV (AirPlay)** dropdown. The
   list is filtered to Apple TVs, so Macs, HomePods and smart TVs that also answer AirPlay are
   left out. If Bonjour discovery is blocked on your network, choose _Manual_ and type the IP.
3. Tick **Begin pairing** and press Save.
4. A four-digit PIN appears on the TV screen. Type it into **Pairing PIN** and press Save again.
5. A **second** PIN appears — this one is for Companion Link. Type it in and Save again.
6. The connection should go green. Pairing only has to be done once; the **Pairing** section
   shows which protocols have credentials stored.

Both protocols are paired in a single run, which is why there are two PINs: AirPlay first, then
Companion Link. The status line says which one it is waiting for. If the second pairing cannot
be started — usually because the Companion Link port could not be found — the AirPlay pairing is
still kept and the connection carries on without Companion Link.

If you already have credentials from the `node-appletv-remote` CLI (`atv pair`), you can paste
the contents of `~/.atv-credentials.json` straight into the **Credentials** field and skip the
pairing flow. Clearing that field unpairs the connection.

> The filter matches the Apple TV models that support these protocols: Apple TV HD (4th gen)
> and every Apple TV 4K. If Apple ships a model newer than this module knows about, it will not
> appear in the list — use _Manual_ and enter the IP.

### Using both protocols

The **Use** setting picks which connections to open:

| Setting                 | What you get                                                   |
| ----------------------- | -------------------------------------------------------------- |
| **Both** (default)      | AirPlay for everything, Companion Link for launching apps      |
| **AirPlay only**        | Remote keys, keyboard, now playing, wake/sleep                 |
| **Companion Link only** | App launching, plus the remote keys Companion Link can express |

With **Both**, the two connections are opened, retried and reported independently — if one
drops, the other keeps working and only the missing one reconnects. The status line names
whichever is unavailable.

The two sets of credentials are stored side by side, so re-running the pairing refreshes both.
If only AirPlay ended up paired, Companion Link is simply skipped — it is not an error — and
ticking **Begin pairing** again will run through both PINs.

Companion Link runs on a port the Apple TV picks fresh every time it restarts, so the module
always discovers it over Bonjour rather than remembering one. The **Companion Link port** field
under Advanced is a last resort for networks where Bonjour is blocked — if you set it, expect to
have to change it after the Apple TV reboots.

### Actions

| Action                            | Notes                                                                     |
| --------------------------------- | ------------------------------------------------------------------------- |
| Remote key                        | Every button on the Siri Remote, plus Turn on (wake) and Turn off (sleep) |
| On-screen keyboard                | Replace, append, clear or backspace in the focused text field             |
| Launch app                        | By bundle ID, e.g. `com.netflix.Netflix`. Needs Companion Link            |
| Companion Link request (advanced) | Raw OPACK message, for experimenting                                      |
| Refresh now playing               | Asks the Apple TV for the current item                                    |
| Reconnect                         | Drops the connection and reconnects                                       |

### Feedbacks

- **Connected to the Apple TV** / **Companion Link connected**
- **Playback state is** — playing, paused, stopped, interrupted, seeking or unknown
- **Now playing matches** — compare the title, artist, album, app name or app bundle ID against
  a value, either exactly or as a substring

### Variables

Connection: `connected`, `companion_connected`, `device_name`, `device_model`, `device_ip`

Playback: `playback_state`, `app_name`, `app_bundle_id`, `media_title`, `media_artist`,
`media_album`, `media_playback_rate`

Timing: `media_duration`, `media_elapsed`, `media_remaining` (seconds) and the matching
`_hms` variants, plus `media_percent`. The elapsed time is counted locally between the
updates the Apple TV sends, so it stays smooth while something is playing.

### Presets

Ready-made buttons for the full remote layout, transport controls, volume, power, keyboard
editing, now-playing text and a connection status button that reconnects when pressed.

### What each protocol can do

**Remote key** prefers AirPlay. When Companion Link is the only connection available it falls
back to Companion Link's HID commands, which cover up, down, left, right, select, menu, home
(including hold), volume up/down, play/pause, wake and sleep. The remaining keys — top menu,
play, pause, stop, next, previous and the skip keys — need AirPlay and will report an error.

The **on-screen keyboard** actions and all now-playing information come from AirPlay only.
**Launch app** and **Companion Link request (advanced)** need Companion Link.

### Things worth knowing

- **Not all apps report metadata.** Title, artist and artwork come from whatever the
  foreground app publishes. Some apps (YouTube is a common example) publish very little.
- **Turn off** puts the Apple TV to sleep; it does not power down the TV itself. Use your
  display's own module or HDMI-CEC for that.
- **Volume up/down** control whatever the Apple TV is set to control — often the connected
  AV receiver or TV over CEC, not the Apple TV.
- If the Apple TV sleeps, the connection drops and the module retries on the reconnect
  interval. Sending **Remote key → Turn on (wake)** only works once reconnected.
- **Refresh now playing** gets no answer when nothing is playing. That is normal, and the
  module only mentions it once in the debug log rather than on every poll.
- The protocol handshake trace from the underlying library is written to the connection log at
  **debug** level, so turn debug on if a pairing or connection problem needs diagnosing.
