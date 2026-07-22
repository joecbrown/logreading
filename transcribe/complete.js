// transcribe/complete.js
//
// Lambda triggered by an EventBridge rule matching Amazon Transcribe job
// state changes (source: aws.transcribe, detail-type: "Transcribe Job
// State Change", detail.TranscriptionJobStatus: COMPLETED). See the main
// README for the exact EventBridge rule pattern to create.
//
// For each completed job: fetches the transcript from S3, computes word
// count, attaches it to the already-logged session in DynamoDB (updating
// its WPM), calls the Claude API to generate comprehension questions
// grounded in the actual transcript and stores those for the app to fetch,
// then emails those questions to a fixed list of recipients (SES) —
// SES_FROM_EMAIL and NOTIFICATION_EMAILS (comma-separated) env vars.
// Both the question-generation and email steps are independently
// non-blocking: word count/WPM succeeds regardless, and email failures
// don't undo already-saved questions (the app can still show them).
//
// NOT LIVE-TESTED: the Claude API call and the actual SES send can't be
// exercised without real credentials/network access, unlike everything
// else in this project. The surrounding logic (parsing, word counting,
// ledger update, email content) is unit-tested in
// lib/transcriptHelpers.test.js and lib/ledgerStore.test.js.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const { createMemoryStore } = require('../lib/store');
const { createDynamoStore } = require('../lib/dynamoStore');
const { makeLedgerActions } = require('../lib/ledgerStore');
const {
  parseTranscribeJobName,
  transcriptOutputKey,
  extractTranscriptAndWordCount,
  buildQuestionGenerationPrompt,
  parseQuestionsResponse,
  buildQuestionsEmail,
} = require('../lib/transcriptHelpers');

const store = process.env.READING_APP_TABLE ? createDynamoStore() : createMemoryStore();
const ledgerActions = makeLedgerActions(store);
const s3Client = new S3Client({});
const sesClient = new SESClient({});

async function fetchJsonFromS3(bucket, key) {
  const res = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const raw = await res.Body.transformToString('utf-8');
  return JSON.parse(raw);
}

async function generateQuestions(transcript, grade) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  const prompt = buildQuestionGenerationPrompt(transcript, grade);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API request failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((block) => block.type === 'text');
  if (!textBlock) {
    throw new Error('Claude response contained no text content');
  }
  return parseQuestionsResponse(textBlock.text);
}

async function sendQuestionsEmail(displayName, questions, wpm) {
  const fromEmail = process.env.SES_FROM_EMAIL;
  const recipients = (process.env.NOTIFICATION_EMAILS || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

  if (!fromEmail || recipients.length === 0) {
    throw new Error('SES_FROM_EMAIL and/or NOTIFICATION_EMAILS is not configured');
  }

  const { subject, body } = buildQuestionsEmail(displayName, questions, wpm);

  await sesClient.send(
    new SendEmailCommand({
      Source: fromEmail,
      Destination: { ToAddresses: recipients },
      Message: {
        Subject: { Data: subject },
        Body: { Text: { Data: body } },
      },
    })
  );
}

exports.handler = async (event) => {
  const detail = event.detail || {};
  if (detail.TranscriptionJobStatus !== 'COMPLETED') {
    console.log(`Ignoring job in status ${detail.TranscriptionJobStatus}`);
    return { skipped: true };
  }

  const jobName = detail.TranscriptionJobName;
  const parsed = parseTranscribeJobName(jobName);
  if (!parsed) {
    console.log(`Job name doesn't match our expected format, ignoring: ${jobName}`);
    return { skipped: true };
  }
  const { childId, sessionId } = parsed;

  const pending = await store.getPendingSession(childId, sessionId);
  if (!pending) {
    console.error(`No pending session found for ${childId}/${sessionId} — cannot attach word count`);
    return { error: 'no_pending_session' };
  }

  // Originally this tried to read the bucket back from detail.Media.MediaFileUri
  // in the EventBridge event — that was wrong. The actual "Transcribe Job
  // State Change" event is minimal (just job name + status), it does NOT
  // include the job's Media/output configuration. Found via real testing:
  // the field was simply absent. Since this pipeline always uses one
  // fixed bucket anyway, an env var is both simpler and correct.
  const bucket = process.env.AUDIO_BUCKET;
  if (!bucket) {
    console.error('AUDIO_BUCKET environment variable is not configured');
    return { error: 'missing_audio_bucket_config' };
  }

  const outputJson = await fetchJsonFromS3(bucket, transcriptOutputKey(childId, sessionId));
  const { transcript, wordCount } = extractTranscriptAndWordCount(outputJson);

  const wpm = await ledgerActions.attachWordCount(childId, pending.weekId, sessionId, wordCount);
  if (wpm == null) {
    console.error(`attachWordCount found no matching entry for ${childId}/${sessionId} in week ${pending.weekId}`);
  }

  try {
    const questions = await generateQuestions(transcript, pending.grade);
    await store.saveQuestions(childId, sessionId, {
      questions,
      generatedAt: new Date().toISOString(),
    });
    try {
      await sendQuestionsEmail(pending.displayName, questions, wpm);
    } catch (emailErr) {
      // Questions are already saved and visible in the app regardless of
      // whether the email succeeds — email is a convenience layer on top,
      // not a dependency for the core feature.
      console.error(`Sending questions email failed for ${childId}/${sessionId}:`, emailErr);
    }
  } catch (err) {
    // Word count/WPM already succeeded above even if question generation
    // fails here — don't let a Claude API hiccup undo the part that did
    // work. Log it clearly so it's visible in CloudWatch.
    console.error(`Question generation failed for ${childId}/${sessionId}:`, err);
  }

  await store.deletePendingSession(childId, sessionId);

  return { childId, sessionId, wordCount, wpm };
};

// Exported so tests can pre-populate the store (a pending session, an
// already-logged session entry) before invoking the handler.
exports.testHelpers = { store, ledgerActions };
