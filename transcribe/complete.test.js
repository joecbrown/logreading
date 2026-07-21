// transcribe/complete.test.js — run with: node transcribe/complete.test.js
//
// Mocks S3 (via aws-sdk-client-mock) and the Claude API call (via a
// monkey-patched global.fetch) to verify the surrounding orchestration
// logic — parsing the EventBridge event, fetching the transcript,
// updating the ledger, storing questions. The Claude API call itself is
// mocked here, not exercised for real — see the file header note in
// transcribe/complete.js about that limitation.

const assert = require('assert');
const { mockClient } = require('aws-sdk-client-mock');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
process.env.AUDIO_BUCKET = 'test-bucket';

const { handler, testHelpers } = require('./complete');
const { buildTranscribeJobName } = require('../lib/transcriptHelpers');

const s3Mock = mockClient(S3Client);

// Mirrors the ACTUAL EventBridge "Transcribe Job State Change" event shape —
// just job name + status, nothing else. An earlier version of this test
// (and of transcribe/complete.js) incorrectly assumed a Media field would
// be present; real testing showed it isn't.
function fakeEvent(childId, sessionId, status = 'COMPLETED') {
  return {
    detail: {
      TranscriptionJobName: buildTranscribeJobName(childId, sessionId),
      TranscriptionJobStatus: status,
    },
  };
}

function mockTranscribeOutput(transcript) {
  return {
    Body: { transformToString: async () => JSON.stringify({ results: { transcripts: [{ transcript }] } }) },
  };
}

function mockClaudeResponse(questions) {
  return {
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify(questions) }],
    }),
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
  await test('ignores events for non-completed job statuses', async () => {
    const result = await handler(fakeEvent('emma', 'session-1', 'IN_PROGRESS'));
    assert.strictEqual(result.skipped, true);
  });

  await test('ignores job names not matching our format', async () => {
    const result = await handler({
      detail: { TranscriptionJobName: 'some-unrelated-job', TranscriptionJobStatus: 'COMPLETED' },
    });
    assert.strictEqual(result.skipped, true);
  });

  await test('reports an error if no pending session record exists', async () => {
    const result = await handler(fakeEvent('emma', 'never-requested-session'));
    assert.strictEqual(result.error, 'no_pending_session');
  });

  await test('full happy path: attaches word count and generates questions', async () => {
    s3Mock.reset();
    const originalFetch = global.fetch;
    try {
      // Set up: a session was logged, and an upload-url request left a
      // pending record — mirroring what api/handler.js would have done.
      const logResult = await testHelpers.ledgerActions.logCompletedSession(
        'emma',
        '2026-07-20T16:00:00.000Z',
        20,
        null,
        'session-happy'
      );
      await testHelpers.store.setPendingSession('emma', 'session-happy', {
        weekId: logResult.weekId,
        grade: '6th grade',
        createdAt: '2026-07-20T16:00:00.000Z',
      });

      const transcript = 'The quick brown fox jumps over the lazy dog again and again';
      s3Mock.on(GetObjectCommand).resolves(mockTranscribeOutput(transcript));

      const expectedQuestions = [{ question: 'What animal jumped?', guidance: 'Should say fox.' }];
      global.fetch = async () => mockClaudeResponse(expectedQuestions);

      const result = await handler(fakeEvent('emma', 'session-happy'));

      assert.strictEqual(result.wordCount, 12);
      assert.ok(result.wpm > 0);

      const questionsRecord = await testHelpers.store.getQuestions('emma', 'session-happy');
      assert.deepStrictEqual(questionsRecord.questions, expectedQuestions);

      // Pending record should be cleaned up after processing
      const stillPending = await testHelpers.store.getPendingSession('emma', 'session-happy');
      assert.strictEqual(stillPending, null);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('word count / ledger update still succeeds even if Claude call fails', async () => {
    s3Mock.reset();
    const originalFetch = global.fetch;
    try {
      const logResult = await testHelpers.ledgerActions.logCompletedSession(
        'jack',
        '2026-07-20T16:00:00.000Z',
        10,
        null,
        'session-claude-fails'
      );
      await testHelpers.store.setPendingSession('jack', 'session-claude-fails', {
        weekId: logResult.weekId,
        grade: '4th grade',
        createdAt: '2026-07-20T16:00:00.000Z',
      });

      s3Mock.on(GetObjectCommand).resolves(mockTranscribeOutput('some words here'));
      global.fetch = async () => ({ ok: false, status: 500, text: async () => 'server error' });

      const result = await handler(fakeEvent('jack', 'session-claude-fails'));

      // Word count still made it through despite the Claude failure
      assert.strictEqual(result.wordCount, 3);
      assert.ok(result.wpm > 0);

      // No questions were saved, since generation failed
      const questionsRecord = await testHelpers.store.getQuestions('jack', 'session-claude-fails');
      assert.strictEqual(questionsRecord, null);
    } finally {
      global.fetch = originalFetch;
    }
  });

  console.log('\nAll transcribe/complete tests completed.');
}

run();
