## Apple TV

Controls an Apple TV over the local network — no IR blaster, no HDMI-CEC. The module speaks
the same protocols Apple's own remote apps use: **AirPlay 2 / MRP** for remote keys and
now-playing information, and optionally **Companion Link** for launching apps.

Works with Apple TV 4K, Apple TV HD and the 4th-generation Apple TV on current tvOS releases.

### Setting it up

1. Make sure the Apple TV is awake and on the same network as Companion.
2. In the connection config, pick your Apple TV from the **Apple TV** dropdown. If Bonjour
   discovery is blocked on your network, choose _Manual_ and type the IP address instead.
3. Leave **Pair with** on _AirPlay_, tick **Begin pairing**, and press Save.
4. A four-digit PIN appears on the TV screen. Type it into **Pairing PIN** and press Save again.
5. The connection should go green. Pairing only has to be done once — the credentials are
   stored with the connection.

If you already have credentials from the `node-appletv-remote` CLI (`atv pair`), you can paste
the contents of `~/.atv-credentials.json` straight into the **Credentials** field and skip the
pairing flow. Clearing that field unpairs the connection.

> The Bonjour dropdown lists every AirPlay receiver it can see, which on a typical network
> includes Macs, HomePods and smart TVs. Pick the one that is actually an Apple TV — the module
> logs a warning if it connects to something else.

### Companion Link (optional)

Companion Link is a second connection used for **Launch app**. It needs its own pairing:

1. Set **Pair with** to _Companion Link_, tick **Begin pairing**, save, and enter the PIN as before.
2. Tick **Enable Companion Link** and save.

Both sets of credentials are kept side by side, so pairing with Companion Link does not
undo the AirPlay pairing.

Companion Link support is less exercised than the AirPlay path. **Companion Link request
(advanced)** is provided as an escape hatch for experimenting with undocumented messages;
the response is written to the connection log at debug level.

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

### Things worth knowing

- **Not all apps report metadata.** Title, artist and artwork come from whatever the
  foreground app publishes. Some apps (YouTube is a common example) publish very little.
- **Turn off** puts the Apple TV to sleep; it does not power down the TV itself. Use your
  display's own module or HDMI-CEC for that.
- **Volume up/down** control whatever the Apple TV is set to control — often the connected
  AV receiver or TV over CEC, not the Apple TV.
- If the Apple TV sleeps, the connection drops and the module retries on the reconnect
  interval. Sending **Remote key → Turn on (wake)** only works once reconnected.
