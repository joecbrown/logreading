// test/apiHandler.test.js — run with: node test/apiHandler.test.js

const assert = require('assert');

// Presigned URL generation only needs *validly-shaped* credentials — it's
// pure local HMAC signing, no network call, so fake values are enough to
// test the actual logic (bucket, key, expiry) rather than mocking it away.
process.env.AWS_ACCESS_KEY_ID ||= 'test-access-key-id';
process.env.AWS_SECRET_ACCESS_KEY ||= 'test-secret-access-key';
process.env.AWS_REGION ||= 'us-east-2';
process.env.AUDIO_BUCKET = 'test-reading-app-audio';

const { handler } = require('../api/handler');

function makeEvent({ method, path, body }) {
  return {
    rawPath: path,
    requestContext: { http: { method } },
    body: body ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
  };
}

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`✓ ${name}`))
    .catch((err) => {
      console.error(`✗ ${name}`);
      console.error(err);
      process.exitCode = 1;
    });
}

async function run() {
  await test('POST /children/:id/sessions logs a session and returns hours earned', async () => {
    const event = makeEvent({
      method: 'POST',
      path: '/children/Amir/sessions',
      body: { minutesRead: 30, wordsRead: 3600 },
    });
    const res = await handler(event);
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.hoursEarned, 1);
    assert.strictEqual(data.wordsPerMinute, 120);
  });

  await test('POST without minutesRead returns 400', async () => {
    const event = makeEvent({ method: 'POST', path: '/children/amir/sessions', body: { wordsRead: 100 } });
    const res = await handler(event);
    assert.strictEqual(res.statusCode, 400);
  });

  await test('POST with malformed JSON body returns 400', async () => {
    const event = {
      rawPath: '/children/amir/sessions',
      requestContext: { http: { method: 'POST' } },
      body: '{not valid json',
      isBase64Encoded: false,
    };
    const res = await handler(event);
    assert.strictEqual(res.statusCode, 400);
  });

  await test('GET /children/:id/balance reflects logged sessions (case-insensitive child id)', async () => {
    await handler(makeEvent({ method: 'POST', path: '/children/sofia/sessions', body: { minutesRead: 60 } }));
    const res = await handler(makeEvent({ method: 'GET', path: '/children/SOFIA/balance' }));
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.bonusHoursRemaining, 2);
    assert.strictEqual(data.availableToday, 3); // baseline 1 + bonus 2
  });

  await test('unknown route returns 404', async () => {
    const res = await handler(makeEvent({ method: 'GET', path: '/nope' }));
    assert.strictEqual(res.statusCode, 404);
  });

  await test('OPTIONS preflight returns 204 with CORS headers', async () => {
    const res = await handler(makeEvent({ method: 'OPTIONS', path: '/children/amir/sessions' }));
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers['Access-Control-Allow-Origin'], '*');
  });

  await test('POST /children/:id/sessions/upload-url returns a real presigned URL', async () => {
    const res = await handler(
      makeEvent({
        method: 'POST',
        path: '/children/emma/sessions/upload-url',
        body: { grade: '6th grade' },
      })
    );
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.sessionId, 'should return a sessionId');
    assert.ok(data.uploadUrl.startsWith('https://'), 'should return a real-looking URL');
    assert.ok(data.uploadUrl.includes('test-reading-app-audio'), 'URL should reference the configured bucket');
    assert.strictEqual(data.s3Key, `audio/emma/${data.sessionId}.wav`);
  });

  await test('upload-url endpoint 500s clearly if AUDIO_BUCKET is not configured', async () => {
    const original = process.env.AUDIO_BUCKET;
    delete process.env.AUDIO_BUCKET;
    // Re-require isn't needed — the handler reads process.env.AUDIO_BUCKET
    // at request time, not at module load time.
    const res = await handler(
      makeEvent({ method: 'POST', path: '/children/emma/sessions/upload-url', body: {} })
    );
    assert.strictEqual(res.statusCode, 500);
    process.env.AUDIO_BUCKET = original;
  });

  await test('upload-url rejects a childId with a space (would break the Transcribe job name)', async () => {
    const res = await handler(
      makeEvent({ method: 'POST', path: '/children/oj test4/sessions/upload-url', body: {} })
    );
    assert.strictEqual(res.statusCode, 400);
    const data = JSON.parse(res.body);
    assert.ok(data.error.includes('letters, numbers'));
  });

  await test('sessionId round-trips: log with sessionId, then questions route 404s until ready', async () => {
    const logRes = await handler(
      makeEvent({
        method: 'POST',
        path: '/children/amir/sessions',
        body: { minutesRead: 15, sessionId: 'linked-session-1' },
      })
    );
    assert.strictEqual(logRes.statusCode, 200);
    const logData = JSON.parse(logRes.body);
    assert.strictEqual(logData.sessionId, 'linked-session-1');

    // Questions haven't been generated yet (that's a separate, async Lambda)
    const qRes = await handler(
      makeEvent({ method: 'GET', path: '/children/amir/sessions/linked-session-1/questions' })
    );
    assert.strictEqual(qRes.statusCode, 404);
  });

  console.log('\nAll API handler tests completed.');
}

run();
