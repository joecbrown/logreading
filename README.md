# Reading Time / Electronics Bank — Ledger Core

> **Status:** Backend is **deployed and confirmed working end-to-end** —
> DynamoDB table, Lambda function, and API Gateway HTTP API are all live
> in AWS (`us-east-2`). The iPad app has been built, run (Simulator), and
> tested with real kids reading, successfully logging real sessions
> through the real deployed backend (confirmed via DynamoDB's table
> explorer). The Alexa skill (`lambda/index.js`, `skill-package/`) was the
> original front-end, fully built + tested, but is no longer the active
> target — replaced by the iPad app, since Alexa can't do continuous
> listening for auto-pause-on-silence or transcription. Kept as reference.
>
> **New: the S3 + Amazon Transcribe + Claude question-generation
> pipeline is built and tested (70 tests passing across the backend) but
> NOT YET DEPLOYED** — it needs an S3 bucket, two new Lambda functions,
> an EventBridge rule, and a Claude API key, none of which exist in AWS
> yet. See "Deploying the Transcription Pipeline" below for the walkthrough.
>
> **Known gap worth flagging:** the deployed API has no authentication —
> anyone with the invoke URL could hit it. Low practical risk for a home
> setup where the URL isn't published anywhere public, but worth adding
> (e.g. an API key or IAM auth on the routes) before treating this as
> more than a personal project.

*Captured: July 20, 2026*

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

## Deploying the Transcription Pipeline (NOT done yet — this session's next step)

None of this exists in AWS yet. Rough order to build it in:

1. **Create an S3 bucket** (e.g. `reading-app-audio-<something-unique>`) in
   `us-east-2`. This holds both the uploaded audio (`audio/{childId}/{sessionId}.caf`)
   and Transcribe's output (`transcripts/{childId}/{sessionId}.json`).
2. **Deploy `transcribe/start.js`** as a new Lambda function (e.g.
   `ReadingAppTranscribeStart`), same packaging approach as `ReadingAppApi`
   (zip of the file + `lib/` + production `node_modules`, including the
   new `@aws-sdk/client-transcribe` dependency). Handler:
   `transcribe/start.handler`.
3. **Add an S3 event trigger** on the bucket from step 1: "All object
   create events", prefix `audio/`, pointing at the Lambda from step 2.
4. **Grant that Lambda's execution role** permission to call
   `transcribe:StartTranscriptionJob` and to read/write the S3 bucket
   (`AmazonTranscribeFullAccess` and `AmazonS3FullAccess` managed policies
   are the broad-but-simple option, same tradeoff as elsewhere in this
   project).
5. **Deploy `transcribe/complete.js`** as another new Lambda (e.g.
   `ReadingAppTranscribeComplete`). Handler: `transcribe/complete.handler`.
   Needs environment variables `READING_APP_TABLE=ReadingAppTable` and
   `ANTHROPIC_API_KEY=<your key>` (get one from
   [console.anthropic.com](https://console.anthropic.com) if you don't
   have one).
6. **Grant that Lambda's role** DynamoDB access (`AmazonDynamoDBFullAccess`,
   already used elsewhere) and S3 read access (`AmazonS3ReadOnlyAccess`)
   for fetching the transcript.
7. **Create an EventBridge rule**: Amazon EventBridge → Rules → Create
   rule. Event source: "AWS services" → Service: "Transcribe" → Event
   type: "Transcribe Job State Change". Target: the Lambda from step 5.
   (This is what actually connects "transcription finished" to the
   completion handler — Transcribe itself has no direct Lambda trigger.)
8. **Test end-to-end**: use the iPad app to do a real reading session,
   confirm audio lands in S3, confirm a Transcribe job starts and
   completes (Amazon Transcribe console shows job status), confirm the
   DynamoDB entry gets its `wordsPerMinute` filled in, and confirm
   questions appear via the app's "Check for Comprehension Questions"
   button.

## Next steps (not built yet)

1. **Deploy the transcription pipeline** (see walkthrough above)
2. **Per-session notifications** — text (SMS) + email, triggered right
   after a session logs (hook into `api/handler.js`'s sessions route)
3. **Web dashboard** — read-only view of the ledger; the REST API's
   `GET /children/{childId}/balance` route already supports this
4. **Real iPad device testing** — only Simulator so far, even for the
   real-kids test; a physical device may behave differently and need
   further threshold retuning
5. **Add API authentication** (see status note above)
6. Wire real credentials into `.env` for AWS/transcription/notification
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
table explorer. Not yet tested on a real physical iPad — Simulator only
so far (using the Mac's own mic).

**Not yet tested: the new upload/questions flow.** The upload-URL
request, S3 upload, and questions-checking code was written this session
alongside the backend pipeline, but hasn't been run in Xcode yet — same
"written carefully, needs real verification" caveat as any iOS change
here. Since the backend pipeline it talks to isn't deployed yet either
(see above), there's nothing to test it against until that's done.
