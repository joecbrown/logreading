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
  Lambda). `POST /children/{childId}/sessions` logs a completed session,
  `GET /children/{childId}/balance` returns the current week's balance.
  Same DynamoDB-or-memory storage switch as the Alexa handler.
- `lambda/index.js` + `skill-package/` — the Alexa skill, kept as a
  reference/fallback, not the active target
- 34 tests across `lib/*.test.js`, `test/alexaHandler.test.js`, and
  `test/apiHandler.test.js`

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

## Next steps (not built yet)

1. **S3 + Amazon Transcribe pipeline** — iPad uploads session audio → S3 →
   Transcribe → word count/WPM → transcript handed to Claude for
   comprehension questions grounded in the actual text read. The iPad app
   already records reading-only audio locally and exposes its file URL
   from `AudioSessionManager.stop()` — it just isn't uploaded anywhere yet.
2. **Per-session notifications** — text (SMS) + email, triggered right
   after a session logs (hook into `api/handler.js`'s sessions route)
3. **Web dashboard** — read-only view of the ledger; the REST API's
   `GET /children/{childId}/balance` route already supports this
4. **Real iPad device testing** — only Simulator + real-kids-in-Simulator
   so far; a real device may reveal different mic behavior
5. **Tune the auto-pause volume threshold** (`silenceThresholdDB` in
   `ios/ReadingTime/AudioSessionManager.swift`) — the silence *duration*
   (10s, tuned down twice from an initial 45s) has been tuned against real
   kids; the volume/RMS *threshold* that decides speech-vs-silence hasn't
   been deliberately tuned yet, just left at its original guess
6. **Add API authentication** (see status note above)
7. Wire real credentials into `.env` for AWS/transcription/notification
   services (see `.env.example` — never commit the real `.env`)

Phase 2 (device-lock enforcement) remains parked — not a near-term
priority.

## iPad App — built, running, tested with real backend

Native SwiftUI app in `ios/ReadingTime/` — see **`ios/README.md`** for
Xcode project setup, since these are source files only (no `.xcodeproj`,
which isn't practical to hand-write). Key pieces:

- `AudioSessionManager.swift` — the core new capability: local mic
  monitoring via volume/RMS threshold, auto-pauses after a period of
  silence (`silenceThresholdSeconds`, currently 10s — tuned down twice
  from an initial 45s, via 20s, after testing with actual kids reading),
  resumes on speech, records only the active-reading segments
- `APIClient.swift` — calls the REST API in `api/handler.js`; base URL is
  set in-app (Settings screen) — now pointed at the real deployed API
- `ChildStore.swift` — local child profiles (name/grade); there's no
  backend concept of "which kids exist" yet, just childIds on sessions
- Views: child list → reading session (start/stop, live status, balance)

**Confirmed working, not just compiling:** run in Xcode Simulator,
auto-pause/resume verified against real silence/speech, and a full
session (start → stop → log → balance refresh) confirmed to reach the
real deployed AWS backend, with the resulting row visible in DynamoDB's
table explorer. Not yet tested on a real physical iPad — Simulator only
so far (using the Mac's own mic).
