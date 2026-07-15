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

1. **Deploy** — ASK CLI (`ask deploy`) or AWS Console: create the skill
   from `skill-package/`, create the DynamoDB table from
   `infra/table.json`, deploy `lambda/index.js` (+ `node_modules`) as the
   Lambda function with `READING_APP_TABLE` set in its environment
   variables, link skill and Lambda in the Alexa Developer Console
2. **Per-session notifications** — after `stopReading()` succeeds in
   `StopReadingIntentHandler`, send a text (SNS or Twilio) and email (SES)
   with the session summary (child, minutes read, bonus hours earned,
   running weekly balance)
3. **Web dashboard** — read-only view of the ledger — small static page
   hitting an API Gateway endpoint that reads from DynamoDB
4. **Claude API integration** for comprehension questions, calibrated to
   6th grade / 4th grade reading levels

Phase 2 (device-lock enforcement) is parked per your call — not a near-term
priority.
