// api/handler.js
//
// Lambda handler for an API Gateway HTTP API (payload format 2.0). This is
// the iPad app's backend — plain REST instead of Alexa intents. All
// business logic still lives in lib/ledger.js and lib/ledgerStore.js;
// this file only does routing, request parsing, and response shaping.
//
// Routes:
//   POST /children/{childId}/sessions/upload-url   { grade? }
//     -> generates a sessionId + a presigned S3 URL for the iPad to
//        upload session audio directly to (bypassing this Lambda/API
//        Gateway entirely for the actual file transfer — a 30-minute
//        recording is far too big for API Gateway's payload limits).
//        Stashes a "pending" record (weekId, grade) so the async
//        transcription-completion step (a separate Lambda, not this one)
//        knows which session/week to attach the result to later.
//   POST /children/{childId}/sessions   { minutesRead, wordsRead?, sessionId? }
//     -> logs a completed session (duration already computed on-device,
//        net of any local auto-pauses) and returns hours earned / WPM.
//        sessionId, if provided (from the upload-url call above), links
//        this entry to whatever transcription completes later.
//   GET  /children/{childId}/balance
//     -> current week's bonus balance for that child
//   GET  /children/{childId}/sessions/{sessionId}/questions
//     -> generated comprehension questions for that session, once the
//        async transcription + Claude pipeline has finished (404 until
//        then — the app should poll or just check back later)
//
// NOTE ON STORAGE: same pattern as lambda/index.js — uses DynamoDB when
// READING_APP_TABLE is set, otherwise an in-memory store for local/test use.

const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createMemoryStore } = require('../lib/store');
const { createDynamoStore } = require('../lib/dynamoStore');
const { makeLedgerActions } = require('../lib/ledgerStore');

const store = process.env.READING_APP_TABLE ? createDynamoStore() : createMemoryStore();
const ledgerActions = makeLedgerActions(store);
const s3Client = new S3Client({});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('Request body must be valid JSON');
    err.code = 'INVALID_JSON';
    throw err;
  }
}

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method;
  const path = event.rawPath || '';

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  try {
    // POST /children/{childId}/sessions/upload-url
    let match = path.match(/^\/children\/([^/]+)\/sessions\/upload-url\/?$/);
    if (match && method === 'POST') {
      const childId = decodeURIComponent(match[1]).toLowerCase();
      // childId flows into Transcribe job names, which strictly only allow
      // [0-9a-zA-Z._-] — a space (or other character) here would make the
      // transcription job fail outright with a BadRequestException. Caught
      // via real testing, not a hypothetical: reject clearly here instead
      // of letting it fail deep in an async Lambda where it's much harder
      // to notice.
      if (!/^[0-9a-z._-]+$/.test(childId)) {
        return json(400, {
          error: 'childId must contain only letters, numbers, ., _, or - (no spaces or other characters)',
        });
      }
      const body = parseBody(event);
      const bucket = process.env.AUDIO_BUCKET;
      if (!bucket) {
        return json(500, { error: 'Server is missing AUDIO_BUCKET configuration' });
      }

      const sessionId = crypto.randomUUID();
      const s3Key = `audio/${childId}/${sessionId}.wav`;
      const nowIso = new Date().toISOString();
      const weekId = require('../lib/ledger').getWeekId(nowIso);

      await store.setPendingSession(childId, sessionId, {
        weekId,
        grade: typeof body.grade === 'string' ? body.grade : null,
        createdAt: nowIso,
      });

      const uploadUrl = await getSignedUrl(
        s3Client,
        new PutObjectCommand({ Bucket: bucket, Key: s3Key, ContentType: 'audio/wav' }),
        { expiresIn: 900 } // 15 minutes — plenty of time to upload right after a session ends
      );

      return json(200, { sessionId, uploadUrl, s3Key, expiresIn: 900 });
    }

    // POST /children/{childId}/sessions
    match = path.match(/^\/children\/([^/]+)\/sessions\/?$/);
    if (match && method === 'POST') {
      const childId = decodeURIComponent(match[1]).toLowerCase();
      const body = parseBody(event);
      if (typeof body.minutesRead !== 'number') {
        return json(400, { error: 'minutesRead (number) is required' });
      }
      const result = await ledgerActions.logCompletedSession(
        childId,
        new Date().toISOString(),
        body.minutesRead,
        typeof body.wordsRead === 'number' ? body.wordsRead : null,
        typeof body.sessionId === 'string' ? body.sessionId : null
      );
      return json(200, result);
    }

    // GET /children/{childId}/balance
    match = path.match(/^\/children\/([^/]+)\/balance\/?$/);
    if (match && method === 'GET') {
      const childId = decodeURIComponent(match[1]).toLowerCase();
      const balance = await ledgerActions.getBalance(childId, new Date().toISOString());
      return json(200, balance);
    }

    // GET /children/{childId}/sessions/{sessionId}/questions
    match = path.match(/^\/children\/([^/]+)\/sessions\/([^/]+)\/questions\/?$/);
    if (match && method === 'GET') {
      const childId = decodeURIComponent(match[1]).toLowerCase();
      const sessionId = decodeURIComponent(match[2]);
      const result = await store.getQuestions(childId, sessionId);
      if (!result) {
        return json(404, { error: 'Questions not ready yet (or unknown session)' });
      }
      return json(200, result);
    }

    return json(404, { error: `No route for ${method} ${path}` });
  } catch (err) {
    if (err.code === 'INVALID_MINUTES' || err.code === 'INVALID_JSON') {
      return json(400, { error: err.message });
    }
    console.error(err);
    return json(500, { error: 'Internal error' });
  }
};
