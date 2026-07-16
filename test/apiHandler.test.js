// test/apiHandler.test.js — run with: node test/apiHandler.test.js

const assert = require('assert');
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

  console.log('\nAll API handler tests completed.');
}

run();
