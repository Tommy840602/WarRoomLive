# Browser suites

Playwright checks that drive the real app in a real browser. They exist for the
questions nothing else can answer: is audio actually *audible*, is an editor
really wired to its document, is a control offered to the right person, does
the room come back correctly after an outage. Chromium's fake camera and
microphone make the media deterministic — it emits a tone and a moving pattern.

```bash
docker compose up -d
npm --prefix tests/ui ci
npx --prefix tests/ui playwright install chromium   # once

tests/ui/run.sh              # media, collab, room-acl
tests/ui/run.sh --all        # plus reconnect, which restarts the backend
tests/ui/run.sh collab       # a named suite
```

Not run in CI — they need a running stack and a browser. The frontend's unit
tests (`npm test` in `frontend/`) are the part that does run there, and
`tests/e2e/` covers the same planes from outside the browser.

## Suites

| Suite | Covers |
|---|---|
| `media` | A remote tile appears, carries an unmuted audio track and **actually plays** the other participant's microphone; your own tile stays muted so you never hear yourself. Passes in both mesh and SFU mode — the backend picks the transport and the UI is the same either way. |
| `collab` | Typing in the shared notes reaches the other participant, and a stroke drawn on the whiteboard appears on their canvas (measured as rendered pixels, not just document state). |
| `room-acl` | Host-only affordances are offered only to the host, locking shows for everyone, and a kicked participant leaves *and stays gone* across the reconnect backoff. |
| `quality` | Real `getStats()` readings reach the connection indicator, a healthy link is graded good rather than flagged, and nothing is shown against your own entry. The thresholds and hysteresis themselves are unit-tested in `frontend/src/webrtc/quality.test.ts`. |
| `recordings` | A finished recording is listed in the room with a readable duration, and pressing play loads a presigned URL into the player that the page can actually fetch — with no object-store secret anywhere in the page. Deleting takes two presses (the first only arms it), and the list is refetched afterwards, so an empty panel means the server really lost it. |
| `reconnect` | **Destructive** — restarts the backend mid-session. The banner appears and clears, both sides list the right members afterwards (no ghosts, no duplicates), chat flows again both ways, and flags that live only in other clients' memory were replayed. |

## Notes

- `UI_ORIGIN` overrides the origin (default `http://localhost:8088`).
- `PLAYWRIGHT_CHROMIUM` points at a browser binary when you do not want
  Playwright's own download (useful in a sandbox that ships one).
- Audio is measured with `HTMLMediaElement.captureStream()`, which reflects
  what the element is really playing. `createMediaElementSource` cannot be used
  here: for an element whose `srcObject` is a MediaStream it returns silence in
  Chrome whether or not the element is playing, which reads as a bug that is
  not there.
- Each run uses a fresh room id, so suites can run back to back against a
  stack that keeps its data.
- Mouse coordinates are viewport-relative, so anything below the fold must be
  scrolled into view before dragging — the whiteboard sits under the video
  grid, whose height depends on how many people are in the room.
