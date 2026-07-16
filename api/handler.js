// api/handler.js
//
// Lambda handler for an API Gateway HTTP API (payload format 2.0). This is
// the iPad app's backend — plain REST instead of Alexa intents. All
// business logic still lives in lib/ledger.js and lib/ledgerStore.js;
// this file only does routing, request parsing, and response shaping.
//
// Routes:
//   POST /children/{childId}/sessions   { minutesRead, wordsRead? }
//     -> logs a completed session (duration already computed on-device,
//        net of any local auto-pauses) and returns hours earned / WPM
//   GET  /children/{childId}/balance
//     -> current week's bonus balance for that child
//
// NOTE ON STORAGE: same pattern as lambda/index.js — uses DynamoDB when
// READING_APP_TABLE is set, otherwise an in-memory store for local/test use.

const { createMemoryStore } = require('../lib/store');
const { createDynamoStore } = require('../lib/dynamoStore');
const { makeLedgerActions } = require('../lib/ledgerStore');

const store = process.env.READING_APP_TABLE ? createDynamoStore() : createMemoryStore();
const ledgerActions = makeLedgerActions(store);

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
    // POST /children/{childId}/sessions
    let match = path.match(/^\/children\/([^/]+)\/sessions\/?$/);
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
        typeof body.wordsRead === 'number' ? body.wordsRead : null
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

    return json(404, { error: `No route for ${method} ${path}` });
  } catch (err) {
    if (err.code === 'INVALID_MINUTES' || err.code === 'INVALID_JSON') {
      return json(400, { error: err.message });
    }
    console.error(err);
    return json(500, { error: 'Internal error' });
  }
};
