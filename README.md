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
## Why this shape

Keeping `ledger.js` free of AWS/Alexa imports means:
- It can be unit-tested in plain Node (no mocking DynamoDB or the Alexa SDK)
- The same module drops directly into a Lambda handler later — the handler
  just becomes a thin wrapper that (a) reads/writes this shape to DynamoDB
  and (b) translates Alexa intents into calls like `logReadingSession(...)`

## What's built now (steps 1–2 of the build order, complete)

- `lib/ledger.js` — pure, tested business rules (baseline hours, bonus
  pool, week boundaries)
- `lib/store.js` — in-memory storage (local dev/tests)
- `lib/dynamoStore.js` — DynamoDB storage, same interface as `store.js`,
  contract-tested against a mocked AWS client (see `infra/table.json` for
  the table definition — create it with:
  `aws dynamodb create-table --cli-input-json file://infra/table.json`)
- `lib/ledgerStore.js` — wires the ledger rules to storage + active-session
  tracking (start/stop/balance/spend)
- `skill-package/interactionModels/custom/en-US.json` — Alexa interaction
  model: invocation name "reading time", intents for start/stop/check
  balance, using the built-in `AMAZON.FirstName` slot so it works for any
  kid's name without a custom list
- `lambda/index.js` — the Alexa skill handler (`ask-sdk-core`). Auto-selects
  DynamoDB when the `READING_APP_TABLE` env var is set (set this in the
  real Lambda's configuration), otherwise falls back to in-memory for local
  testing. Thin routing layer only — all logic stays in `ledger.js`/
  `ledgerStore.js`.
- 22 tests across `lib/*.test.js` and `test/alexaHandler.test.js`, covering
  the pure rules, the storage wiring, the DynamoDB wire format, and the
  full start → stop → balance flow through the real Alexa SDK

Kids: daughter (6th grade this fall) and son (4th grade this fall) — noted
for later grade-level calibration of comprehension questions.

**Notifications requirement (updated):** you want a text + email alert
after *each individual reading session* — not a daily/weekly digest. That
means the trigger point is inside `StopReadingIntentHandler` in
`lambda/index.js`, right after a session is logged, not a separate
scheduled job. Not built yet — see below.

## Next steps (not built yet)

Architecture decided this session: the iPad app **replaces** Alexa entirely
(Alexa can't do continuous listening, which auto-pause and transcription
both need). Cloud transcription via **Amazon Transcribe** (same AWS
account as the DynamoDB table, no new vendor). WPM no longer needs a
separate manual-entry decision — it comes for free from the transcript's
real word count once that pipeline exists.

1. **REST API layer** — API Gateway + Lambda, reusing `ledger.js`/
   `ledgerStore.js`/`dynamoStore.js` as-is, exposing start/stop/balance
   over plain HTTP instead of Alexa intents
2. **S3 + Amazon Transcribe pipeline** — iPad uploads session audio to S3,
   backend triggers transcription, computes word count/WPM, feeds the
   transcript to Claude for comprehension questions grounded in the
   actual text read
3. **iPad app** (SwiftUI) — mic access, local voice-activity detection for
   auto-pause during silence, calls the REST API. Can be scaffolded here
   but not compiled/tested outside Xcode.
4. **Per-session notifications** — text (SMS) + email, triggered right
   after a session is logged, not a scheduled digest
5. **Web dashboard** — read-only view of the ledger
6. Add real AWS/transcription/notification credentials via `.env`
   (see `.env.example` — never commit the real `.env`)

Kids: daughter (6th grade this fall), son (4th grade this fall) — for
comprehension-question grade-level calibration.

Phase 2 (device-lock enforcement) remains parked — not a near-term
priority.

The Alexa skill code (`lambda/index.js`, `skill-package/`) still works and
is still tested, but is no longer the active development target — kept as
a reference / fallback only.
