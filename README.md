# Reading Time / Electronics Bank — Ledger Core

> **Status (as of this commit):** The core ledger logic (`lib/ledger.js`,
> `lib/ledgerStore.js`) and DynamoDB storage (`lib/dynamoStore.js`,
> `infra/table.json`) are stable and reused going forward. The Alexa skill
> (`lambda/index.js`, `skill-package/`) was the original front-end and is
> fully built + tested, but **the plan is to replace it with a native iPad
> app** — Alexa can't do continuous listening for auto-pause-on-silence or
> transcription, which the iPad can. The Alexa code is kept here as a
> working reference / fallback, not the active development target. Next
> up: a REST API layer, an S3 + Amazon Transcribe pipeline, and the iOS
> app itself — none of those are built yet.

*Captured: July 15, 2026*

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

## Deploying the REST API (not yet done)

1. Create the DynamoDB table from `infra/table.json` (if not already done)
2. Zip `api/handler.js` + `lib/` + `node_modules` (production deps only:
   `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`), upload as a Lambda
   function, handler = `api/handler.handler`
3. Set the Lambda's environment variable `READING_APP_TABLE` to the table
   name
4. Create an HTTP API in API Gateway, add a Lambda integration, with
   routes `POST /children/{childId}/sessions` and
   `GET /children/{childId}/balance` both pointing at the Lambda
5. Note the API's invoke URL — the iPad app will call this directly

## Next steps (not built yet)

1. **S3 + Amazon Transcribe pipeline** — iPad uploads session audio → S3 →
   Transcribe → word count/WPM → transcript handed to Claude for
   comprehension questions grounded in the actual text read
2. **iPad app** (SwiftUI) — mic access, local voice-activity detection for
   auto-pause, computes active-reading minutes itself, calls the REST API
   above. Can be scaffolded here but not compiled/tested outside Xcode.
3. **Per-session notifications** — text (SMS) + email, triggered right
   after a session logs (hook into `api/handler.js`'s sessions route)
4. **Web dashboard** — read-only view of the ledger; the REST API's
   `GET /children/{childId}/balance` route already supports this
5. Add real AWS/transcription/notification credentials via `.env`
   (see `.env.example` — never commit the real `.env`)

Phase 2 (device-lock enforcement) remains parked — not a near-term
priority.
