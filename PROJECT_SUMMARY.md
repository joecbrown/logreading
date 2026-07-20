# Reading Time / Electronics Bank App — Project Summary

*Compiled July 20, 2026 (evening) — backend deployed and confirmed working end-to-end; iPad app tuned and confirmed working with real kids after a real debugging session, for context on resuming work.*

Repo: https://github.com/joecbrown/logreading

## The Core Idea

An app that times how long each kid reads, converts that into bonus
electronics/video game time on a weekly bank, and generates comprehension
questions (with answer-quality guidance) so a parent can quiz the kid
afterward and gauge real understanding.

**Kids:** daughter (6th grade this fall), son (4th grade this fall) — used
later to calibrate comprehension-question difficulty.

## Electronics Time Rules

- **Baseline:** 1 hour/day by default, does not roll over
- **Bonus earning:** 30 minutes of reading = 1 additional hour of
  electronics time
- **Week boundary:** Sunday through Saturday
- **Bonus pool:** accumulates across the week, spendable on any day within it
- **Expiration:** unused bonus hours are lost at the week's end (reset Sunday)
- Bonus hours are based on **minutes read only** — reading speed (WPM) is a
  reporting metric, never a factor in how much bonus time is earned

## Architecture History — Two Major Pivots

**Original plan:** Alexa custom skill (voice-triggered start/stop timer) +
AWS Lambda + DynamoDB + Claude API for question generation.

**Pivot 1 — "45-second silence auto-pause" request.** Investigated and
confirmed: custom Alexa skills only receive audio for one triggered
utterance at a time — there's no API for continuous/passive listening, so
a skill can never detect 45 seconds of silence. Platform restriction, not
an engineering-effort problem.

**Pivot 2 — wanting transcription for grounded comprehension questions and
real WPM.** Same root cause: Alexa skills cannot transcribe open-ended,
continuous speech. Also a deliberate privacy boundary — Amazon doesn't
expose continuous audio capture to third parties, especially around
children's voice data.

**Resolution: replace Alexa entirely with a native iPad app.** Decisions
made:
- iPad **replaces** Alexa entirely
- Transcription: **cloud-based** via **Amazon Transcribe** (same AWS
  account as DynamoDB, no new vendor)
- WPM computed directly from the transcript's real word count — no manual
  entry needed
- Notifications: text (SMS) + email, sent after **each individual
  session**, not a digest
- Dev setup: Mac available, no paid Apple Developer account — sideloading
  to a personally-owned iPad works with a free "Personal Team" in Xcode

The Alexa skill code is fully built and tested but is now reference/
fallback only.

## What's Actually Built

**Backend (Node.js, all executed and tested in a sandbox — 35 tests
passing across 5 test files):**

- **`lib/ledger.js`** — pure business rules: Sunday-anchored week
  calculation, bonus-hour math, pool accumulation/expiration, and
  word-count/WPM tracking (WPM is a minutes-weighted average across
  sessions, not a naive mean — covered by a dedicated test). No AWS/Alexa
  dependencies.
- **`lib/store.js`** / **`lib/dynamoStore.js`** — swappable storage
  (in-memory for tests, DynamoDB for real use). Single-table design:
  partition key `childId`, sort key `recordType` (`WEEK#<weekId>` or
  `SESSION`). Contract-tested against a mocked AWS client.
- **`lib/ledgerStore.js`** — wires ledger rules to storage. Two logging
  paths:
  - `startReading`/`stopReading` (wall-clock timestamps — used by the
    Alexa reference implementation)
  - `logCompletedSession` (caller-supplied duration — used by the REST
    API/iPad app, since the backend can't see on-device pauses)
- **`infra/table.json`** — CLI-creatable DynamoDB table definition
- **`lambda/index.js`** + **`skill-package/`** — fully working Alexa skill
  (`ask-sdk-core`), kept as reference, not the active target
- **`api/handler.js`** — **REST API for the iPad app** (API Gateway HTTP
  API + Lambda). `POST /children/{childId}/sessions` logs a completed
  session; `GET /children/{childId}/balance` returns the week's balance.
  Same DynamoDB-or-memory storage switch as the Alexa handler. **Now
  deployed to real AWS and confirmed working end-to-end** (see AWS
  Deployment section below) — no longer just tested locally.
- **`.env.example`** — placeholder template for future AWS/SES/SNS/Twilio/
  Claude API credentials. Real `.env` is gitignored.

**iPad app (Swift/SwiftUI, source in
`ios/ReadingTimeXcode/ReadingTimeXcode/` — see note on this path below) —
built, compiles, runs in Xcode's Simulator, tested with real kids reading,
and confirmed talking to the real deployed AWS backend:**

- **`AudioSessionManager.swift`** — the core new capability. Monitors the
  mic continuously via a simple volume/RMS threshold (not real
  speech-recognition-based VAD), auto-pauses after a period of silence,
  resumes on speech, records only active-reading segments. **Confirmed
  working end-to-end, including two full rounds of real-world tuning:**
  - **Silence duration**, tuned twice: 45s (original plan value) → 20s
    (first real-kid test felt too slow) → **10s** (still felt too slow at
    20s)
  - **Volume threshold**, discovered broken then fixed: originally a
    guess of -35 dB, which turned out to be *louder* than actual reading
    volume — meaning it never triggered at all (the app was pausing at
    exactly the 10s mark regardless of whether anyone was reading, since
    it never once detected "speech"). Diagnosed by adding a live
    on-screen debug readout of the actual measured dB level
    (`currentDecibels`) rather than continuing to guess. Real numbers
    measured: quiet room ≈ -56 dB, actual reading aloud ≈ -38 to -41 dB.
    New threshold: **-48 dB**, sitting with real margin on both sides.
  - **Sustained-loudness requirement added**, after the above fix
    revealed a second issue: brief loud transients (keyboard clicks near
    the Mac's mic in Simulator) were being detected as "speech" too.
    Fixed by requiring loudness to persist for 0.3s
    (`minimumSustainedSpeechSeconds`) before counting as real speech —
    long enough to reliably catch genuine reading, short enough to still
    feel responsive, while filtering out sharp single-buffer spikes.
- **`APIClient.swift`** — calls the REST API; base URL configured in-app
  (Settings screen), now pointed at the real deployed API Gateway URL
- **`ChildStore.swift`** — local child profiles (name/grade), since the
  backend has no concept of "which kids exist," just childIds on sessions
- Views: child list → add-reader form → reading session (start/stop, live
  status badge, timer, live mic-level debug readout, balance display) →
  settings
- **Bugs found and fixed via actual manual testing, not just code
  review** (in the order discovered):
  1. App crashed (`SIGABRT` on `engine.inputNode`) the first time "Start
     Reading" was tapped — configuring an `AVAudioSession` category alone
     doesn't reliably trigger the mic permission prompt. Fixed by
     explicitly requesting permission
     (`AVAudioApplication.requestRecordPermission`) before touching the
     audio engine.
  2. A **project-structure bug, not a code bug**: dragging the Swift
     files into Xcode with "Copy items if needed" checked made Xcode
     create its own separate physical copy of every file, inside
     `ios/ReadingTimeXcode/ReadingTimeXcode/` — disconnected from the
     `ios/ReadingTime/` folder every code update was actually being
     extracted into. Several rounds of fixes (including bug #1 above)
     were silently not reaching the compiled app for a while as a result
     — the crash "appearing fixed" afterward was likely a coincidence
     (once macOS grants mic permission once, it stays granted regardless
     of which code version runs). Caught when a build error referenced
     an old, pre-fix version of a file that had definitely already been
     updated. **Resolved by retiring `ios/ReadingTime/` entirely** —
     `ios/ReadingTimeXcode/ReadingTimeXcode/` is now the one real source
     location, documented in `ios/README.md`.
  3. A **crash after the file-sync fix**: `TCC_CRASHING_DUE_TO_
     PRIVACY_VIOLATION` — the "Privacy - Microphone Usage Description"
     Info.plist entry (originally added correctly, early on) had gone
     missing, likely lost somewhere in the file/project confusion from
     bug #2. Re-added; resolved.
  4. A **Swift 6 concurrency compiler warning** (would become a hard
     error in stricter language modes): comparing the `ReadingState` enum
     from inside a plain `Timer` closure conflicted with the project's
     actor-isolation inference rules, even though the closure genuinely
     runs on the main thread in practice. Fixed by checking a plain
     `Bool` flag (`isCurrentlyReading`) instead of the enum in that one
     spot.
  5. The volume-threshold and transient-filtering issues described above.
  6. A SwiftUI bug caught via code review (not testing, since it doesn't
     manifest until a UI element is watched over time): nested
     `ObservableObject`s (the ViewModel holding `AudioSessionManager`)
     don't auto-propagate change notifications — without a fix, the live
     timer/status display would have silently stopped updating. Fixed by
     forwarding `audio`'s `objectWillChange` into the view model's own.
- **Full real-data round trip confirmed:** tapped Start/Stop Reading with
  actual kids reading aloud, app logged the session to the real API
  Gateway → Lambda → DynamoDB chain, and the resulting row (real child
  name, real minutes/hours) was visually confirmed in DynamoDB's table
  explorer — not a mocked or local-only test.
- `ios/README.md` documents current setup/rebuild notes, including the
  file-location lesson from bug #2 above.

**Known limitations of what's built, going in eyes-open:**
- Volume-threshold detection still isn't real speech recognition — the
  sustained-loudness fix reduces false positives from brief sounds, but
  can't distinguish sustained reading from other sustained sounds (a TV,
  someone else talking nearby).
- Not yet tested on a real device — only Simulator so far (using the
  Mac's mic, even for the real-kids testing). Real-device testing requires
  the device-signing step (plugging the iPad into the Mac, letting Xcode
  register it), not yet done. Volume levels/background noise will likely
  need retuning again once that happens — Simulator uses the Mac's own
  room and mic, not wherever the iPad actually sits.
- Recorded audio is captured locally but nothing uploads it anywhere yet.
- **The deployed API has no authentication** — see the AWS Deployment
  section below.

## AWS Deployment — ✅ Complete and confirmed end-to-end

**Region: `us-east-2` (Ohio).** Keep using this exact region for any
future AWS work on this project.

**Access:** created a dedicated IAM user for all console work, instead of
using the AWS root login — root has account-level powers (billing,
account closure) that can't be scoped down, so it's kept aside as a
break-glass fallback only. The IAM user has `AdministratorAccess`
attached (broad, not minimal — a deliberate practical tradeoff for a
solo personal project).

**What's live:**
1. ✅ DynamoDB table `ReadingAppTable` — partition key `childId` (String),
   sort key `recordType` (String), on-demand billing
2. ✅ Lambda function `ReadingAppApi` — Node.js runtime, handler set to
   `api/handler.handler`, environment variable
   `READING_APP_TABLE=ReadingAppTable`
3. ✅ Lambda's execution role granted `AmazonDynamoDBFullAccess` (hit and
   fixed an `AccessDeniedException` on the first test — the
   auto-created role had no DynamoDB permissions by default; this is
   broader than strictly necessary, scoped to any table in the account
   rather than just this one, same practical tradeoff as the IAM user's
   admin access)
4. ✅ API Gateway HTTP API `ReadingAppHttpApi`, `$default` stage,
   auto-deploy enabled, both routes wired to the Lambda:
   - `POST /children/{childId}/sessions`
   - `GET /children/{childId}/balance`
5. ✅ **Confirmed working at every layer**, in order: Lambda console test
   → invoke URL tested directly in a browser → iPad app's Settings screen
   pointed at the real URL → full Start/Stop Reading session in the app
   with real kids reading → resulting row visually confirmed in
   DynamoDB's table explorer (real child name, real minutes/hours, not a
   mock or local test)

**⚠️ Known gap: no authentication on the API.** Anyone with the invoke URL
could currently hit it and write arbitrary session data. Low practical
risk today (the URL isn't published anywhere public — deliberately kept
out of every file in this repo, including this one), but worth adding
(an API key, or IAM-based auth on the routes) before this is more than a
personal/family project. Tracked as a next step below.

## Not Yet Built

1. **Add API authentication** (see security note above)
2. **S3 + Amazon Transcribe pipeline** — iPad uploads session audio → S3 →
   Transcribe → word count/WPM → transcript handed to Claude for
   comprehension questions grounded in the actual text read
3. **Per-session notifications** — SMS + email, triggered right after a
   session logs (SES for email; SNS or Twilio for SMS, not yet decided)
4. **Web dashboard** — read-only view of the ledger; the REST API's
   balance route already supports this
5. **Real iPad device testing** — Simulator only so far, even for the
   real-kids test; a physical device may behave differently and likely
   need further threshold retuning (different room, different mic)
6. Wire real credentials into `.env` for AWS/notifications/Claude API

No preference has been stated on ordering among items 2–4 — open decision
for later.

**Phase 2 (parked, not a near-term priority):** actually locking the
iPad's electronics access via Screen Time API or similar, rather than the
current parent-enforced honor system for spending earned time.

## Git / Learning Notes

- Repo live at `https://github.com/joecbrown/logreading`, connected and
  working
- First-ever git session (an earlier day) covered: identity config,
  personal access token auth, fetching without altering local files,
  merging unrelated histories, resolving a real conflict, aborting/redoing
  a merge cleanly, and pushing
- Day-to-day flow since then has just been:
  ```
  git add -A
  git commit -m "message"
  git push
  ```
- This session's new-file delivery pattern: since the canonical repo now
  lives on your Mac (not in whatever sandbox built the code), updates are
  packaged as small `.tar.gz` archives containing just the new/changed
  files, extracted directly into the existing project folder
  (`tar -xzf update.tar.gz -C .`) rather than hand-pasted, to avoid the
  earlier text-editor (pico/nano) mishap
- This session's biggest lesson, project-management rather than pure
  code: when Xcode's "Copy items if needed" makes its own physical file
  copy, that copy — not whatever folder updates keep getting extracted
  into — is the one actually being compiled. Several rounds of fixes
  silently didn't reach the running app because of this. Resolved by
  eliminating the duplicate folder entirely (`ios/ReadingTime/` retired;
  `ios/ReadingTimeXcode/ReadingTimeXcode/` is now the one real source),
  and by adding a `.gitignore` for Xcode's per-machine build artifacts
  (`xcuserdata/`, `DerivedData/`, etc.) so those don't get committed
  going forward either.
- This session's debugging-methodology lesson: when a threshold-tuning
  bug ("it's not detecting my reading") couldn't be diagnosed by
  reasoning alone, adding a live on-screen debug readout of the actual
  measured value (mic volume in dB) turned guessing into measuring —
  found the real numbers in under a minute once visible, versus several
  rounds of blind guess-and-check before that.
- This session's API Gateway learning: HTTP API vs. REST API (chose HTTP
  API — simpler, cheaper, matches what the Lambda code expects), the
  route-configuration screen not pre-filling a route the way expected
  (had to add both manually), and the `$default` stage with auto-deploy
  meaning no manual "deploy" step is needed after route changes
- This session's AWS learning: the difference between the root user and
  an IAM user (and why root should be set aside as a fallback, not used
  day-to-day), creating an IAM user with console access, and navigating
  the Lambda console (code upload via .zip, and that Runtime
  settings/Handler lives under the Code tab, not Configuration → General
  — an easy wrong turn)
- An earlier session's Xcode learning: creating a new project (with a
  Personal Team for free device signing), adding files to a target, the
  Objective-C bridging header prompt (declined, correctly — no
  Objective-C in this project), building for Simulator vs. a physical
  device, provisioning-profile errors (expected without a connected
  device), and reading crash output via the Issue Navigator / console
