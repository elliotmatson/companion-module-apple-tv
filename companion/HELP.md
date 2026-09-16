## Apple TV

Controls an Apple TV over the local network — no IR blaster, no HDMI-CEC. The module speaks
the same protocols Apple's own remote apps use: **AirPlay 2 / MRP** for remote keys and
now-playing information, and optionally **Companion Link** for launching apps.

Works with Apple TV 4K, Apple TV HD and the 4th-generation Apple TV on current tvOS releases.

### Setting it up

1. Make sure the Apple TV is awake and on the same network as Companion.
2. Pick it from the **Apple TV** dropdown and press Save. The list only contains Apple TVs, so
   Macs and smart TVs that also answer AirPlay are left out. If Bonjour discovery is blocked on
   your network, choose _Manual_ and type the IP.
3. Pairing starts by itself. A four-digit PIN appears on the TV — type it into **Pairing PIN**
   and press Save.
4. A **second** PIN appears, this one for Companion Link. Type it in and Save again.
5. The connection goes green. That is the whole setup.

The page tells you which step you are on, and the connection status says which PIN it is waiting
for. Both protocols are paired in one run, which is why there are two PINs: AirPlay first, then
Companion Link. If the second pairing cannot be started, the AirPlay pairing is still kept and
everything except app launching carries on working.

Once pairing is done the **Pairing PIN** box disappears, since there is nothing to type into it.
To start over — a replaced Apple TV, or a factory reset — tick **Pair again** and press Save;
the PIN box comes back as soon as you tick it.

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
ticking **Pair again** will run through both PINs.

Companion Link runs on a port the Apple TV picks fresh every time it restarts, so the module
always discovers it over Bonjour rather than remembering one. There is nothing to configure, but
it does mean Companion Link needs Bonjour to reach the Apple TV.

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

The module subscribes to now-playing updates when it connects, so the Apple TV pushes every
change as it happens — nothing is polled. It only asks outright once, just after connecting, to
find out what is already playing.

### Presets

Ready-made buttons for the full remote layout, transport controls, volume, power, keyboard
editing, now-playing text and a connection status button that reconnects when pressed.

### What each protocol can do

**Remote key** prefers AirPlay. When Companion Link is the only connection available it falls
back to Companion Link's HID commands, which cover up, down, left, right, select, menu, home
(including hold), volume up/down, play/pause, wake and sleep. The remaining keys — top menu,
play, pause, stop, next, previous and the skip keys — need AirPlay and will report an error.

The **on-screen keyboard** actions and all now-playing information come from AirPlay only.
**Launch app**, **Refresh app list** and **Companion Link request (advanced)** need Companion Link.

When Companion Link connects, the module asks the Apple TV which apps are installed and uses
that as the **Launch app** dropdown, so you pick apps by name rather than hunting for bundle
IDs. The field still accepts anything typed into it — a bundle ID such as `com.netflix.Netflix`,
or a URL such as `https://tv.apple.com/…` — which is useful for deep links.

### Things worth knowing

- **Not all apps report metadata.** Title, artist and artwork come from whatever the
  foreground app publishes. Some apps (YouTube is a common example) publish very little.
- **Turn off** puts the Apple TV to sleep; it does not power down the TV itself. Use your
  display's own module or HDMI-CEC for that.
- **Volume up/down** control whatever the Apple TV is set to control — often the connected
  AV receiver or TV over CEC, not the Apple TV.
- If the Apple TV sleeps, the connection drops and the module retries on the reconnect
  interval. Sending **Remote key → Turn on (wake)** only works once reconnected.
- **Refresh now playing** gets no answer when nothing is playing. That is normal, and it is
  logged at debug level rather than shown as an error.
- If the connection drops, the module retries every 10 seconds. AirPlay and Companion Link
  retry separately, so one coming back does not disturb the other.
- The protocol handshake trace from the underlying library is written to the connection log at
  **debug** level, so turn debug on if a pairing or connection problem needs diagnosing.
