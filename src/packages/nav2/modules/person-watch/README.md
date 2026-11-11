# Person watch

Optional advisory monitoring module. Registers its own sidebar/workspace and
an always-visible footer status; never changes the shell or navigation commands.
The shared service polls `person_watch_url` every two seconds with one request
in flight and a three-second timeout. Multiple mounted views share the poller;
unmounting the last subscriber cancels timers and requests.

Only the configured real host connection enables access. Simulation does not
query the robot detector. Server timestamps determine sample age, avoiding a
false outage solely from laptop/robot clock offset. Failed requests and old
samples are shown as unavailable; no fresh negative is invented.

New confirmed detections appear in the footer for 15 seconds and in a bounded
camera/time-labelled history. Confirmation and 30-second per-camera cooldown
belong to the detector, not the browser. Reloading Cockpit does not cause a new
backend alert. The server's in-memory history resets on detector restart.
Each new alert can open its annotated JPEG on demand. Image URLs are derived
from the configured detector endpoint and a valid alert UUID; server-supplied
URLs are ignored. Missing/evicted images show an explicit unavailable message.
The last 50 snapshots live in detector memory and disappear on its restart.
No external notifications, identity recognition or extra video readers
are created by this module. The detector itself consumes all three local saving
streams even when a live view is paused or in Normal quality.

Host implementation/configuration and contract: `salus_robot/deploy/person_watch`.
`person_watch_url` defaults to the private robot status endpoint. For an HTTPS
publication use a same-origin HTTPS reverse proxy and update this setting;
HTTP to a Tailscale address can be blocked as mixed content. Browser security
must remain enabled. Tailnet access controls govern the read-only metadata API.

Verification: `npm run build`, `npm run test`. No Tauri build required.
