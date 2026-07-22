# Reading Time / Electronics Bank — Ledger Core

> **Status:** The **entire pipeline is deployed and confirmed working
> end-to-end** — DynamoDB, the REST API (Lambda + API Gateway), and now
> the full S3 + Amazon Transcribe + Claude question-generation pipeline
> are all live in AWS (`us-east-2`) and have processed a real reading
> session start to finish: iPad app → S3 upload → Transcribe → DynamoDB
> (real word count/WPM attached) → Claude → real comprehension questions
> displayed back in the app. The Alexa skill (`lambda/index.js`,
> `skill-package/`) was the original front-end, fully built + tested, but
> is no longer the active target — replaced by the iPad app, since Alexa
> can't do continuous listening for auto-pause-on-silence or
> transcription. Kept as reference.
>
> **Known gap worth flagging:** the deployed API has no authentication —
> anyone with the invoke URL could hit it. Low practical risk for a home
> setup where the URL isn't published anywhere public, but worth adding
> (e.g. an API key or IAM auth on the routes) before treating this as
> more than a personal project.

*Captured: July 21, 2026*

## Files

- `lib/ledger.js` — pure functions implementing the rules from the plan:
  - 1 hour/day baseline (doesn't roll over)
  - 30 min reading = 1 bonus hour
  - Sunday–Saturday week, bonus pooled across the week
  - Unused bonus expires at the week boundary
- `lib/ledger.test.js` — assertions covering the worked example plus edge
  cases (overspending, expiration, pooling). Run with:
  ```
  node lib/ledger.test.js
  ```

## Why this shape

Keeping `ledger.js` free of AWS/Alexa imports means:
- It can be unit-tested in plain Node (no mocking DynamoDB or the Alexa SDK)
- The same module drops directly into a Lambda handler later — the handler
  just becomes a thin wrapper that (a) reads/writes this shape to DynamoDB
  and (b) translates Alexa intents into calls like `logReadingSession(...)`

## What's built now

- `lib/ledger.js` — pure, tested business rules (baseline hours, bonus
  pool, week boundaries, WPM)
- `lib/store.js` / `lib/dynamoStore.js` — swappable storage (in-memory /
  DynamoDB)
- `lib/ledgerStore.js` — wires the ledger rules to storage. Two ways to
  log a session:
  - `startReading`/`stopReading` — wall-clock timestamps (used by the
    Alexa reference implementation, which has no concept of pausing)
  - `logCompletedSession` — accepts a duration the caller already computed
    (used by the REST API / iPad app, since the backend has no visibility
    into on-device auto-pauses)
- `api/handler.js` — **REST API for the iPad app** (API Gateway HTTP API +
  Lambda). Routes: `POST /children/{childId}/sessions` (logs a session,
  optionally linked to a `sessionId`), `GET /children/{childId}/balance`,
  `POST /children/{childId}/sessions/upload-url` (presigned S3 upload URL
  for session audio), `GET /children/{childId}/sessions/{sessionId}/questions`.
  Same DynamoDB-or-memory storage switch as the Alexa handler.
- `lib/transcriptHelpers.js` — pure logic for the transcription pipeline:
  job naming/parsing, word counting from Transcribe's output shape,
  building the Claude prompt, parsing Claude's response
- `transcribe/start.js` — Lambda triggered by S3 upload; starts an Amazon
  Transcribe job for the new audio
- `transcribe/complete.js` — Lambda triggered by Transcribe job
  completion (via EventBridge); fetches the transcript, updates the
  ledger with real word count/WPM, calls Claude to generate comprehension
  questions, stores them. Word count/WPM succeeds independently even if
  the Claude call fails (tested).
- `lambda/index.js` + `skill-package/` — the Alexa skill, kept as a
  reference/fallback, not the active target
- 70 tests across `lib/*.test.js`, `test/*.test.js`, and
  `transcribe/*.test.js` — including a real (not mocked) presigned S3 URL
  generation test

Kids: daughter (6th grade this fall) and son (4th grade this fall) — noted
for later grade-level calibration of comprehension questions.

## Deploying the REST API — ✅ done

1. ✅ DynamoDB table `ReadingAppTable` created (partition key `childId`,
   sort key `recordType`, on-demand billing) in `us-east-2`
2. ✅ Lambda function `ReadingAppApi` created, code uploaded (zip of
   `api/handler.js` + `lib/` + production-only `node_modules`), handler
   set to `api/handler.handler`
3. ✅ Environment variable `READING_APP_TABLE=ReadingAppTable` set; Lambda
   execution role granted `AmazonDynamoDBFullAccess` (broad, not scoped to
   just this table — a deliberate practical tradeoff, same reasoning as
   the IAM user's `AdministratorAccess`)
4. ✅ HTTP API created in API Gateway (`ReadingAppHttpApi`) with both
   routes wired to the Lambda, `$default` stage with auto-deploy
5. ✅ Invoke URL confirmed working via direct browser request and via the
   iPad app (its Settings screen holds the URL locally on-device, not
   committed to git). The URL itself is intentionally not written into
   any file in this repo — since the API has no authentication yet (see
   status note above), publishing the endpoint anywhere public would let
   anyone who finds it write arbitrary session data. If you want it saved
   somewhere for your own reference, put it in your local `.env` (already
   gitignored), not in a tracked file.

## Deploying the Transcription Pipeline — ✅ done, confirmed end-to-end

Full walkthrough (as actually executed, corrected from the original plan
below where reality differed):

1. ✅ **S3 bucket** created in `us-east-2` for uploaded audio
   (`audio/{childId}/{sessionId}.wav` — see format note below) and
   Transcribe's output (`transcripts/{childId}/{sessionId}.json`)
2. ✅ **`transcribe/start.js`** deployed as Lambda `ReadingAppTranscribeStart`
   (zip of the file + `lib/` + production `node_modules` including
   `@aws-sdk/client-transcribe`), handler `transcribe/start.handler`
3. ✅ **S3 event trigger** on the bucket: "All object create events",
   prefix `audio/`, targeting that Lambda
4. ✅ That Lambda's execution role granted `AmazonTranscribeFullAccess` +
   `AmazonS3FullAccess`
5. ✅ **`transcribe/complete.js`** deployed as Lambda
   `ReadingAppTranscribeComplete`, handler `transcribe/complete.handler`,
   env vars `READING_APP_TABLE`, `AUDIO_BUCKET`, and `ANTHROPIC_API_KEY`
   (a Claude API key is a **separate account/product from a claude.ai
   subscription** — get one at
   [console.anthropic.com](https://console.anthropic.com) if you don't
   have one; a claude.ai Pro/Max plan does not include API access)
6. ✅ That Lambda's role granted `AmazonDynamoDBFullAccess` +
   `AmazonS3ReadOnlyAccess`
7. ✅ **EventBridge rule** (`TranscribeJobCompleteRule`): source
   "aws.transcribe", event type "Transcribe Job State Change", target =
   `ReadingAppTranscribeComplete` — this is the only way to know when a
   transcription job finishes; Transcribe has no direct Lambda trigger
8. ✅ **API Gateway routes added** for the two new endpoints
   (`POST /children/{childId}/sessions/upload-url` and
   `GET /children/{childId}/sessions/{sessionId}/questions`) — **easy to
   miss**: redeploying a Lambda's code does NOT automatically create
   routes for new paths in API Gateway; those have to be added
   explicitly as their own step, same as the original two routes were.
9. ✅ **Confirmed working end-to-end** via a real reading session in the
   app: audio in S3 → Transcribe job completes → DynamoDB entry gets a
   real `wordsPerMinute`/`wordsRead` → real comprehension questions
   appear via the app's "Check for Comprehension Questions" button

### Real bugs hit and fixed while deploying this (all confirmed via actual testing, not caught in review)

1. **childId with a space broke Transcribe job names** — Transcribe job
   names only allow `[0-9a-zA-Z._-]`. A test child named with a space
   (e.g. "oj test4") produced an invalid job name and the job failed
   outright. Fixed at the root: the iPad app's `Child.makeId` now
   produces a real slug (spaces become hyphens, unsafe characters
   stripped), and the backend's upload-url route now validates and
   rejects bad childIds defensively too.
2. **Recorded audio format (`.caf`) isn't supported by Amazon Transcribe
   at all** — confirmed via AWS's own docs: supported formats are WAV,
   MP3, MP4, M4A, FLAC, Ogg, AMR, WebM; CAF isn't among them. Every job
   failed with `Unsupported audio format: caf` until the recording format
   was switched to WAV (a one-line change in `AudioSessionManager.swift`,
   since WAV is natively compatible with the same linear PCM data being
   captured — no format conversion needed, just a different container).
3. **The EventBridge "Transcribe Job State Change" event is much leaner
   than assumed** — the original code tried to read the audio's S3
   bucket from `detail.Media.MediaFileUri` in the event, assuming the
   full job configuration would be included. It isn't — the real event
   only carries the job name and status. Fixed by passing the bucket
   name in as an environment variable instead, which is simpler and more
   reliable than trying to extract it from event fields that were never
   actually there.
4. **A stale Claude model name** (`claude-sonnet-4-6`, not a real model)
   in the question-generation call — fixed to `claude-sonnet-5`.
5. **Lambda's default 3-second timeout** was killing
   `ReadingAppTranscribeComplete` before it could finish — fetching from
   S3 plus a network call to the Claude API plus a DynamoDB write
   routinely takes longer than 3 seconds. The function was timing out
   silently (no error logged, just killed) on every single invocation.
   Fixed by raising the timeout to 30 seconds in the function's General
   configuration.

## Next steps (not built yet)

1. **Per-session notifications** — text (SMS) + email, triggered right
   after a session logs (hook into `api/handler.js`'s sessions route)
2. **Web dashboard** — read-only view of the ledger; the REST API's
   `GET /children/{childId}/balance` route already supports this
3. **Real iPad device testing** — only Simulator so far, even for the
   real-kids test; a physical device may behave differently and need
   further threshold retuning
4. **Add API authentication** (see status note above)
5. Wire real credentials into `.env` for AWS/transcription/notification
   services (see `.env.example` — never commit the real `.env`)

Phase 2 (device-lock enforcement) remains parked — not a near-term
priority.

## iPad App — built, running, tested with real backend

Native SwiftUI app — source lives in
**`ios/ReadingTimeXcode/ReadingTimeXcode/`** (the actual Xcode project
folder; see **`ios/README.md`** for why, and for setup/rebuild notes).
Key pieces:

- `AudioSessionManager.swift` — the core new capability: local mic
  monitoring via volume/RMS threshold, auto-pauses after a period of
  silence (`silenceThresholdSeconds`, currently 10s — tuned down twice
  from an initial 45s, via 20s, after testing with actual kids reading),
  resumes on speech, records only the active-reading segments. Requires
  sustained loudness (`minimumSustainedSpeechSeconds`, 0.3s) before
  counting something as speech, to filter out brief transients like
  keyboard clicks. Volume threshold (`silenceThresholdDB`, currently -48)
  was measured via a live on-screen debug readout against a real room
  (quiet baseline ~-56 dB, actual reading ~-38 to -41 dB) — the original
  -35 guess turned out to be louder than real reading volume, meaning it
  never triggered at all.
- `APIClient.swift` — calls the REST API in `api/handler.js`; base URL is
  set in-app (Settings screen) — now pointed at the real deployed API.
  Now also handles requesting a presigned S3 upload URL, uploading the
  recorded audio directly to S3 (bypassing the API/Lambda entirely for
  the actual file transfer), and fetching generated questions.
- `ChildStore.swift` — local child profiles (name/grade); grade is now
  sent along with the upload-url request, for question-difficulty
  calibration
- Views: child list → reading session (start/stop, live status, timer,
  live mic-level debug readout, balance, "Check for Comprehension
  Questions" button once a session has uploaded successfully)

**Confirmed working, not just compiling:** run in Xcode Simulator,
auto-pause/resume verified against real silence/speech (including
correctly ignoring false triggers like keyboard clicks), and a full
session (start → stop → log → balance refresh) confirmed to reach the
real deployed AWS backend, with the resulting row visible in DynamoDB's
table explorer. **The upload/transcription/questions flow is now also
confirmed working end-to-end**, including through several real bugs
found and fixed along the way (see "Deploying the Transcription
Pipeline" above for the full list). Not yet tested on a real physical
iPad — Simulator only so far (using the Mac's own mic).
