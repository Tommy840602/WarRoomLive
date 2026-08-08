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
| `agenda` | The agenda board between two participants: one input produces both a task and an appointment (the span is what stamps it), the clock files them into 現在/稍後 on its own, and — the point of the design — **a triage decision made by one person reaches the other**, stops being marked automatic, and survives as the room's decision rather than one browser's. Also: finishing records who, the calendar is a **time grid** over the same items (an hour-long appointment is drawn an hour tall, today carries a now-line, paging leaves it behind and 今天 brings it back), undated items are counted rather than dropped, and deleting takes two presses. |
| `layout` | The workspace layout, the split, and the skin: exactly one sidebar panel is open at any width, the tabs match the panels that exist, nothing spills off the side on a phone — the divider really drags (an early version re-registered its listeners mid-drag and let go after one step), the video gives up the width, the split survives a reload and moves by keyboard, and the zoom control resizes the tiles. Plus: the two skins are different surfaces, the tile stays black in both, and a skin choice survives a reload. |
| `files` | Sharing a file the way a person does: pick it, watch it upload straight from the page to the object store, see it appear live for the other participant, download the exact bytes back, and delete it in two presses. |
| `captions` | Live subtitles and the transcript panel. One participant is a browser and the other is a bare socket, saying things: a caption is drawn under the video with its speaker, the translation lands on the line it belongs to, a sentence being revised stays **one** line instead of stacking, and the overlay does not intercept clicks meant for the video. Then the panel: the transcript lists both languages, the filter matches the translation too, and the summary's action items go to the room's to-do list through the capture line. Speech recognition itself is deliberately not exercised — Chromium's fake device emits a tone, not speech, so a suite that tried would be asserting on Google's service rather than on this app. |
| `reconnect` | **Destructive** — restarts the backend mid-session. The banner appears and clears, both sides list the right members afterwards (no ghosts, no duplicates), chat flows again both ways, and flags that live only in other clients' memory were replayed. |

## Notes

- **Open the panel first.** One sidebar panel is shown at a time, at every
  width, and the default is chat. A hidden element still answers `.count()` and
  `.innerText()`, so a suite that forgets passes its text assertions and then
  hangs on the first click — pointing at the control rather than at the panel
  that was never opened. `openPanel(page, label, selector)` in `lib.mjs` does
  it and waits for visibility.
- **Do not write an assertion that only holds at some times of day.** One suite
  captured `明天14:00-15:00` and asserted it landed in 現在, which is true only
  after 14:00. It passed all afternoon and failed at ten to one in the morning,
  with nothing about the product changed. Relative times (`2小時後`) say what
  they mean at any hour.
- **Address items by name, not by position.** The agenda's bands reorder as
  items move between them, so "the first triage button" is a different item
  after every press.

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
