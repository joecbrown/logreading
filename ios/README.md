# iPad App — Status & Setup

**Status: built, running, and confirmed working** — compiled in Xcode,
run in Simulator, tested with real kids reading, and confirmed logging
real sessions through the real deployed AWS backend (see the main
README and PROJECT_SUMMARY.md for the full story).

## Where the actual source code lives

**`ReadingTimeXcode/ReadingTimeXcode/`** — this flat folder (no
subfolders) is the one real source of truth. It's what the Xcode project
(`ReadingTimeXcode.xcodeproj`, alongside it) actually compiles.

This wasn't true earlier in development — an initial `ios/ReadingTime/`
folder (with a `Views/` subfolder) was the original source, meant to be
dragged into a new Xcode project. That drag-in used "Copy items if
needed," which made Xcode's *own* physical copy diverge from the
original folder. Several rounds of edits went to the wrong (unused) copy
before this was caught (a compiler error referencing an old, un-updated
version of a file was the tell). The old `ios/ReadingTime/` folder has
since been removed entirely, so there's only one copy now — no more
confusion about which one Xcode is actually building.

**If you ever get a code update for this app again:** it should come as
files meant to be extracted directly into
`ios/ReadingTimeXcode/ReadingTimeXcode/`, overwriting in place. No
dragging into Xcode should be needed for a plain code change — just
extract, then `Cmd + R` in Xcode to rebuild and run.

## Rebuilding after a code update

```
cd ~/Downloads/reading-app/ios/ReadingTimeXcode/ReadingTimeXcode
tar -xzf ~/Downloads/whatever-update.tar.gz -C .
```

Then in Xcode: `Cmd + R` (Run — this rebuilds automatically first).

If something seems stale even after that (a value not changing, an old
error persisting), try **Product → Clean Build Folder** (`Cmd+Shift+K`)
first, then `Cmd + R` again — this clears Xcode's build cache, which can
occasionally hold onto old compiled output.

## Required project configuration (already done, documented for reference)

- **Microphone permission:** Project → target `ReadingTimeXcode` → **Info**
  tab → a row for **"Privacy - Microphone Usage Description"** must exist,
  or iOS force-kills the app the instant it touches the microphone (a
  `TCC_CRASHING_DUE_TO_PRIVACY_VIOLATION` crash — this happened once
  already, from the row silently not being present after a mixed-up
  drag-in; worth a quick check if this ever crashes on a fresh install).
- **Deployment target:** iOS 17 minimum (General tab)
- **Signing:** Team set to your Apple ID's **Personal Team** (free,
  no paid Developer Program needed for installing on your own device —
  just requires re-signing every ~7 days via Xcode)

## Testing notes

- **Simulator microphone = your Mac's real microphone**, passed through.
  Useful for confirming logic works at all, but the volume levels,
  background noise, and acoustic environment are your Mac's room, not
  wherever the iPad will actually sit — expect some retuning once this
  moves to a real device.
- **Not yet tested on a physical iPad** — only Simulator so far, including
  the real-kids testing session. Real-device testing requires plugging
  the iPad into the Mac via USB once and letting Xcode register it as a
  run destination (this hasn't been done yet).
- A live microphone-level debug readout (`currentDecibels`, shown on the
  reading session screen) was added specifically to diagnose a tuning
  bug — it's genuinely useful to keep for now in case a real device needs
  retuning too, safe to remove later once the thresholds feel solid
  long-term across real use.
