# Reading Time / Electronics Bank App — Project Summary

*Compiled July 22, 2026 (night) — the entire system is real and in daily use: full pipeline confirmed end-to-end, email notifications working, running on a real physical iPad (not just Simulator), and auto-pause tuned against two different kids' voices with real measured data. For context on resuming work.*

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

**Backend (Node.js, all executed and tested in a sandbox — 70 tests
passing across 8 test files):**

- **`lib/ledger.js`** — pure business rules: Sunday-anchored week
  calculation, bonus-hour math, pool accumulation/expiration, and
  word-count/WPM tracking (WPM is a minutes-weighted average across
  sessions, not a naive mean — covered by a dedicated test). Extended
  this session with `sessionId` tracking and `attachWordCount` — a
  session can be logged immediately (bonus hours locked in right away
  from minutes alone) and have its real word count/WPM filled in later,
  once transcription finishes asynchronously, without changing the
  already-earned bonus hours. No AWS/Alexa dependencies.
- **`lib/store.js`** / **`lib/dynamoStore.js`** — swappable storage
  (in-memory for tests, DynamoDB for real use). Single-table design:
  partition key `childId`, sort key `recordType` (`WEEK#<weekId>`,
  `SESSION`, `PENDING#<sessionId>`, or `QUESTIONS#<sessionId>`).
  Contract-tested against a mocked AWS client.
- **`lib/ledgerStore.js`** — wires ledger rules to storage. Logging
  paths:
  - `startReading`/`stopReading` (wall-clock timestamps — used by the
    Alexa reference implementation)
  - `logCompletedSession` (caller-supplied duration — used by the REST
    API/iPad app, since the backend can't see on-device pauses)
  - `attachWordCount` — fills in WPM on an already-logged session once
    transcription completes
- **`infra/table.json`** — CLI-creatable DynamoDB table definition
- **`lambda/index.js`** + **`skill-package/`** — fully working Alexa skill
  (`ask-sdk-core`), kept as reference, not the active target
- **`api/handler.js`** — **REST API for the iPad app** (API Gateway HTTP
  API + Lambda). Routes: session logging, balance, and (new this
  session) `POST /children/{childId}/sessions/upload-url` (generates a
  sessionId + a real presigned S3 URL — tested for real, not mocked,
  since presigned URL generation is local HMAC signing and only needs
  validly-shaped credentials) and
  `GET /children/{childId}/sessions/{sessionId}/questions`. Same
  DynamoDB-or-memory storage switch as the Alexa handler. **Deployed to
  real AWS and confirmed working end-to-end** (see AWS Deployment
  section below) — though the new upload-url/questions routes specifically
  are tested locally only, not yet deployed (see Transcription Pipeline
  Deployment section).
- **`lib/transcriptHelpers.js`** (new this session) — pure logic for the
  transcription pipeline: builds/parses the Transcribe job name encoding
  (childId, sessionId) together (since Transcribe's completion event
  only gives back the job name, no way to attach other metadata to a
  job), extracts transcript text + word count from Transcribe's output
  JSON shape, builds the Claude prompt, parses Claude's response. Fully
  unit tested (12 tests), no AWS/network dependencies.
- **`transcribe/start.js`** (new this session) — Lambda meant to be
  triggered by an S3 upload event; starts an Amazon Transcribe job for
  the new audio. Tested against a mocked Transcribe client, including a
  case for duplicate/retried S3 events (treated as fine, not an error).
- **`transcribe/complete.js`** (new this session) — Lambda meant to be
  triggered by Transcribe job completion (via EventBridge — Transcribe
  has no direct Lambda trigger, hence needing this indirection); fetches
  the transcript from S3, updates the ledger with real word count/WPM via
  `attachWordCount`, calls the Claude API to generate comprehension
  questions grounded in the actual transcript, stores them. **Tested
  graceful degradation**: word count/WPM still succeeds even if the
  Claude API call fails — a transcription-quality/API issue shouldn't
  also break the numbers that matter for bonus-hour tracking. The Claude
  API call itself is mocked in tests (via a monkey-patched
  `global.fetch`), not exercised for real — that's the one piece of this
  pipeline that genuinely can't be verified without a real API key and
  deployed infrastructure.
- **`.env.example`** — placeholder template for future AWS/SES/SNS/Twilio/
  Claude API credentials, now including `AUDIO_BUCKET`. Real `.env` is
  gitignored.

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
    20s) — settled here, unchanged since
  - **Volume threshold**, tuned across four values as real data came in
    from two different kids' voices:
    - -35 (initial guess) → too loud, never triggered at all — the app
      was pausing at exactly the 10s mark regardless of whether anyone
      was reading, since it never once detected "speech." Diagnosed by
      adding a live on-screen debug readout (`currentDecibels`) instead
      of continuing to guess.
    - -48 (tuned to one reader's voice: quiet room ≈ -56 dB, reading
      ≈ -38 to -41 dB) — worked well for that reader.
    - -60 (a second, quieter-voiced reader measured -55 to -61 dB —
      below the -48 threshold entirely, causing false pauses even while
      actively reading).
    - **-65** (that same reader's actual room measured ambient noise at
      -70 dB — real data, not a guess — giving confirmed margin on both
      sides: his voice stays well above -65, the room's silence stays
      well below it). **This is the current, final value.**
    - **Known limitation, stated plainly:** this is one global value now
      serving two meaningfully different voices. It works for both as of
      real measurements taken, but if a third voice (or a different
      room) doesn't fit comfortably in the gap between ambient noise and
      reading volume, the real fix is making this a **per-child setting**
      rather than one shared constant — not built, but the clear next
      step if -65 ever stops working well for someone.
  - **Sustained-loudness requirement added**, after the above fix
    revealed a second issue: brief loud transients (keyboard clicks near
    the Mac's mic in Simulator) were being detected as "speech" too.
    Fixed by requiring loudness to persist for 0.3s
    (`minimumSustainedSpeechSeconds`) before counting as real speech —
    long enough to reliably catch genuine reading, short enough to still
    feel responsive, while filtering out sharp single-buffer spikes.
- **`APIClient.swift`** — calls the REST API; base URL configured in-app
  (Settings screen), pointed at the real deployed API Gateway URL.
  Requests a presigned upload URL, uploads recorded audio directly to S3
  (bypassing the API/Lambda for the actual transfer, since a multi-minute
  recording is too large for API Gateway's payload limits), and fetches
  generated questions. **All of this is now confirmed working end-to-end
  via a real reading session** — not just written and hoped-for.
- **`ChildStore.swift`** — local child profiles (name/grade), since the
  backend has no concept of "which kids exist," just childIds on sessions
- Views: child list → add-reader form → reading session (start/stop, live
  status badge, timer, live mic-level debug readout, balance display,
  "Check for Comprehension Questions" button) → settings
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
- **Email notifications**: after Claude generates questions, the child's
  display name (now threaded through the upload-url request, alongside
  grade) and the questions are emailed via Amazon SES to a fixed list of
  recipients (`NOTIFICATION_EMAILS` env var). Independently non-blocking,
  same philosophy as question generation itself — an email failure
  (e.g. SES sandbox rejecting an unverified recipient) never undoes the
  already-saved questions, which remain visible in the app regardless.
  **Confirmed working** — first email landed in spam (expected for a
  brand-new sender with no reputation yet; "Report not spam" in Gmail
  helps train this over the first several sends).
- **Deployed to a real physical iPad**, not just Simulator, for the first
  time. Required working through: USB trust prompt, Xcode's device
  destination selector (easy to accidentally leave on Simulator even with
  a real device plugged in), a keychain permission prompt for the code
  signing tool (wants your **Mac login password**, not any project
  credential), and — the one that actually blocked the app from
  launching — trusting the developer certificate on the device itself
  (Settings → General → VPN & Device Management → the entry under
  "Developer App" → Trust). None of these are code issues; all are
  standard one-time steps for a first on-device deployment with a free
  Personal Team.

**Known limitations of what's built, going in eyes-open:**
- Volume-threshold detection still isn't real speech recognition — the
  sustained-loudness fix reduces false positives from brief sounds, but
  can't distinguish sustained reading from other sustained sounds (a TV,
  someone else talking nearby).
- **One global volume threshold serves multiple kids' voices** — currently
  tuned (-65 dB) with real confirmed margin for both kids based on actual
  measurements, but this is inherently a compromise, not a per-child
  solution. Worth revisiting if a future reader's voice doesn't fit the
  gap between their room's ambient noise and their reading volume.
- **The deployed API has no authentication** — anyone with the invoke URL
  could hit it. Low practical risk (URL isn't published anywhere), but
  worth adding before this is more than a personal project.

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

## Transcription Pipeline Deployment — ✅ COMPLETE, confirmed end-to-end

**Region: `us-east-2`, same as everything else.**

**Everything live:**
1. ✅ S3 bucket (session audio + Transcribe output)
2. ✅ Lambda `ReadingAppTranscribeStart`, handler `transcribe/start.handler`,
   role granted `AmazonTranscribeFullAccess` + `AmazonS3FullAccess`
3. ✅ S3 event notification (prefix `audio/`) → triggers that Lambda
4. ✅ Lambda `ReadingAppTranscribeComplete`, handler
   `transcribe/complete.handler`, env vars `READING_APP_TABLE`,
   `AUDIO_BUCKET`, `ANTHROPIC_API_KEY` (billing issue on Anthropic's side
   from earlier eventually cleared — see Git/Learning Notes)
5. ✅ That Lambda's role granted `AmazonDynamoDBFullAccess` +
   `AmazonS3ReadOnlyAccess`
6. ✅ EventBridge rule `TranscribeJobCompleteRule` (source
   "aws.transcribe", "Transcribe Job State Change") → targets that Lambda
7. ✅ API Gateway routes added for `POST .../sessions/upload-url` and
   `GET .../sessions/{sessionId}/questions`, attached to `ReadingAppApi`
8. ✅ **Confirmed working via a real reading session end-to-end** — real
   audio uploaded, transcribed, real word count/WPM attached to the
   DynamoDB entry, real Claude-generated comprehension questions
   retrieved via the app

### Real bugs hit during deployment (five, all found via actual testing — this is the value of testing against real infrastructure instead of stopping at "the code looks right")

1. **A test child's name had a space in it** ("oj test4"), which flowed
   into the Transcribe job name and violated Transcribe's strict
   character rules (`[0-9a-zA-Z._-]` only) — job failed with
   `BadRequestException`. Root-caused and fixed on the iPad side:
   `Child.makeId` now actually produces a slug (spaces → hyphens, unsafe
   characters stripped) instead of just lowercasing. Also added
   server-side validation in `api/handler.js` as defense in depth.
2. **Recorded audio was `.caf` (Apple's Core Audio Format), which Amazon
   Transcribe doesn't support at all** — confirmed against AWS's own
   docs (supported: WAV, MP3, MP4, M4A, FLAC, Ogg, AMR, WebM). Every job
   failed with `Unsupported audio format: caf`. Fixed by switching the
   recording to `.wav` — a one-line extension change in
   `AudioSessionManager.swift`, since the underlying linear PCM data
   didn't need to change, just its container.
3. **Wrong assumption about the EventBridge event shape** — the
   completion Lambda tried to read the audio's S3 bucket from
   `detail.Media.MediaFileUri`, assuming the full Transcribe job config
   would be in the event. It isn't — the real "Transcribe Job State
   Change" event is minimal (job name + status only). Fixed by passing
   the bucket in as an env var instead of trying to derive it from a
   field that was never actually present.
4. **A stale/incorrect Claude model name** (`claude-sonnet-4-6`) in the
   question-generation call — fixed to `claude-sonnet-5`.
5. **Lambda's default 3-second timeout was silently killing the
   completion function on every single run** — no error was ever logged,
   because AWS force-kills the process at the timeout before the code
   gets a chance to log anything. The actual work (S3 fetch + Claude API
   call + DynamoDB write) routinely takes longer than 3 seconds. This one
   was the trickiest to diagnose, since the symptom (silence, no error)
   looked identical to "nothing happened" rather than "something failed"
   — the giveaway was noticing `Status: timeout` in the CloudWatch log's
   REPORT line. Fixed by raising the timeout to 30 seconds.

Also worth noting as a process lesson, not a code bug: **redeploying a
Lambda's code does not create new API Gateway routes** — those new
`upload-url`/`questions` endpoints needed their own explicit route +
integration-attachment steps in API Gateway, separate from just
uploading the updated `api/handler.js`. Easy to forget since it worked
differently from how updating the Lambda's *existing* routes' behavior
does.

## Not Yet Built

1. **Add API authentication** (see security note above)
2. **SMS notifications** — email is done (SES); text messages were also
   originally discussed but never built (SNS or Twilio, not yet decided)
3. **Web dashboard** — read-only view of the ledger; the REST API's
   balance route already supports this
4. **Per-child adjustable volume threshold** — currently one global
   value tuned to work for both kids; would be more robust as a setting
   stored per child (alongside grade), tuned once per kid using the
   existing live debug readout
5. Wire remaining real credentials into `.env` for local dev parity (AWS
   access keys, Claude API key) — the deployed Lambdas already have their
   own env vars set directly in AWS Console, this is just about local
   `.env` completeness

No preference has been stated on ordering among items 1–4 — open decision
for later.

**Phase 2 (parked, not a near-term priority):** actually locking the
iPad's electronics access via Screen Time API or similar, rather than the
current parent-enforced honor system for spending earned time.

## Git / Learning Notes

- **Tonight's specific mixup, worth remembering:** a small threshold
  tweak was packaged as a zip whose internal path already matched the
  deep `ios/ReadingTimeXcode/ReadingTimeXcode/` folder, but the
  extraction instructions said to `cd` into that same folder first —
  which recreated the whole path a second time, nested inside itself.
  The edit landed in a disconnected, unused copy; Xcode kept compiling
  the real (unchanged) file the whole time, with no error to signal
  anything was wrong other than the value just not changing. Resolved by
  editing the real file directly in Xcode (Cmd+F to find the line, edit,
  Cmd+S), then deleting the stray nested folder. **Going forward, small
  one-line value changes get described as "find this line in Xcode and
  change it," not shipped as a zip** — more reliable given this exact
  failure mode already happened once.
- Repo live at `https://github.com/joecbrown/logreading`, connected and
  working
- **Anthropic Console billing issue from earlier resolved** — the
  "Payment failed" error eventually cleared (through Anthropic's own
  support, or possibly just resolved itself/a different card worked;
  worth noting for future reference that this can happen and isn't
  necessarily something wrong with your own card) and a working API key
  was obtained
- This session's biggest debugging lesson: **CloudWatch logs showing no
  error at all can itself be the diagnostic clue**, not just "nothing to
  see here." A Lambda silently hitting its timeout produces no error
  message — the function just stops — and the only visible sign is
  `Status: timeout` in the automatically-generated REPORT line. Worth
  reading that line specifically, not just scanning for words like
  "ERROR."
- This session's other lesson: **test against the real, deployed
  infrastructure, not just local logic tests.** All 70+ local tests
  passed the whole time — they were testing the code's logic correctly.
  None of them could have caught: Transcribe's job-naming character
  rules, Transcribe's supported audio format list, the actual shape of
  an EventBridge event, a stale model name, or a Lambda timeout default
  — all of these are facts about the real external world that only
  surface by actually running the thing against real services.
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
