// test/alexaHandler.test.js — run with: node test/alexaHandler.test.js
//
// Builds mock Alexa request envelopes (same shape the real Alexa service
// sends) and invokes the skill directly, without going through Lambda.

const assert = require('assert');
const { skill } = require('../lambda/index');

function intentEnvelope(intentName, slots = {}) {
  const slotObj = {};
  for (const [name, value] of Object.entries(slots)) {
    slotObj[name] = { name, value, confirmationStatus: 'NONE' };
  }
  return {
    version: '1.0',
    session: {
      new: false,
      sessionId: 'test-session',
      application: { applicationId: 'test-app' },
      user: { userId: 'test-user' },
    },
    context: {
      System: {
        application: { applicationId: 'test-app' },
        user: { userId: 'test-user' },
        apiEndpoint: 'https://api.amazonalexa.com',
      },
    },
    request: {
      type: 'IntentRequest',
      requestId: `req-${Math.random()}`,
      timestamp: new Date().toISOString(),
      locale: 'en-US',
      intent: { name: intentName, confirmationStatus: 'NONE', slots: slotObj },
    },
  };
}

function getSpeechText(response) {
  const ssml = response.response.outputSpeech.ssml;
  return ssml.replace(/<\/?speak>/g, '');
}

function test(name, fn) {
  return fn()
    .then(() => console.log(`✓ ${name}`))
    .catch((err) => {
      console.error(`✗ ${name}`);
      console.error(err);
      process.exitCode = 1;
    });
}

async function run() {
  await test('StartReadingIntent with a name starts a session', async () => {
    const envelope = intentEnvelope('StartReadingIntent', { ChildName: 'Sofia' });
    const response = await skill.invoke(envelope);
    const text = getSpeechText(response);
    assert.match(text, /starting the reading timer for sofia/i);
  });

  await test('StartReadingIntent without a name asks who', async () => {
    const envelope = intentEnvelope('StartReadingIntent', {});
    const response = await skill.invoke(envelope);
    const text = getSpeechText(response);
    assert.match(text, /who's starting to read/i);
  });

  await test('StopReadingIntent with no active session says so gracefully', async () => {
    const envelope = intentEnvelope('StopReadingIntent', { ChildName: 'Noah' });
    const response = await skill.invoke(envelope);
    const text = getSpeechText(response);
    assert.match(text, /don't have a reading session in progress for noah/i);
  });

  await test('full start -> stop -> balance flow via voice intents', async () => {
    const start = intentEnvelope('StartReadingIntent', { ChildName: 'Amir' });
    await skill.invoke(start);

    const stop = intentEnvelope('StopReadingIntent', { ChildName: 'Amir' });
    const stopResponse = await skill.invoke(stop);
    const stopText = getSpeechText(stopResponse);
    // Real elapsed time in-test is near-zero (rounds to 0 minutes), so we
    // confirm it reports gracefully with a clean number, not scientific
    // notation or a floating-point remainder.
    assert.match(stopText, /amir read for 0 minutes/i);

    const balance = intentEnvelope('CheckBalanceIntent', { ChildName: 'Amir' });
    const balanceResponse = await skill.invoke(balance);
    const balanceText = getSpeechText(balanceResponse);
    assert.match(balanceText, /amir has 0 bonus hours left this week, for a total of 1 hour[s]? available today/i);
  });

  await test('CheckBalanceIntent without a name asks whose', async () => {
    const envelope = intentEnvelope('CheckBalanceIntent', {});
    const response = await skill.invoke(envelope);
    const text = getSpeechText(response);
    assert.match(text, /whose balance/i);
  });

  console.log('\nAll Alexa handler smoke tests completed.');
}

run();
