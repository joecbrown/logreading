// lib/transcriptHelpers.test.js — run with: node lib/transcriptHelpers.test.js

const assert = require('assert');
const {
  buildTranscribeJobName,
  parseTranscribeJobName,
  transcriptOutputKey,
  audioObjectKey,
  extractTranscriptAndWordCount,
  buildQuestionGenerationPrompt,
  parseQuestionsResponse,
} = require('./transcriptHelpers');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

test('job name round-trips childId + sessionId', () => {
  const jobName = buildTranscribeJobName('emma', 'abc-123-def');
  assert.strictEqual(jobName, 'emma--abc-123-def');
  const parsed = parseTranscribeJobName(jobName);
  assert.deepStrictEqual(parsed, { childId: 'emma', sessionId: 'abc-123-def' });
});

test('parseTranscribeJobName returns null for job names not in our format', () => {
  assert.strictEqual(parseTranscribeJobName('some-other-job-entirely'), null);
  assert.strictEqual(parseTranscribeJobName(''), null);
});

test('output key locations are deterministic and match across start/complete', () => {
  assert.strictEqual(transcriptOutputKey('emma', 'session-1'), 'transcripts/emma/session-1.json');
  assert.strictEqual(audioObjectKey('emma', 'session-1'), 'audio/emma/session-1.wav');
});

test('extractTranscriptAndWordCount parses a realistic Transcribe output shape', () => {
  const fakeOutput = {
    results: {
      transcripts: [{ transcript: 'The quick brown fox jumps over the lazy dog' }],
    },
  };
  const { transcript, wordCount } = extractTranscriptAndWordCount(fakeOutput);
  assert.strictEqual(transcript, 'The quick brown fox jumps over the lazy dog');
  assert.strictEqual(wordCount, 9);
});

test('extractTranscriptAndWordCount handles empty/missing transcript gracefully', () => {
  assert.deepStrictEqual(extractTranscriptAndWordCount({}), { transcript: '', wordCount: 0 });
  assert.deepStrictEqual(
    extractTranscriptAndWordCount({ results: { transcripts: [{ transcript: '' }] } }),
    { transcript: '', wordCount: 0 }
  );
});

test('extractTranscriptAndWordCount collapses multiple whitespace correctly', () => {
  const fakeOutput = { results: { transcripts: [{ transcript: 'one   two\n\nthree' }] } };
  const { wordCount } = extractTranscriptAndWordCount(fakeOutput);
  assert.strictEqual(wordCount, 3);
});

test('question generation prompt includes grade context when provided', () => {
  const prompt = buildQuestionGenerationPrompt('Once upon a time...', '6th grade');
  assert.ok(prompt.includes('6th grade'));
  assert.ok(prompt.includes('Once upon a time...'));
});

test('question generation prompt omits grade context when not provided', () => {
  const prompt = buildQuestionGenerationPrompt('Once upon a time...', null);
  assert.ok(!prompt.includes('undefined'));
  assert.ok(!prompt.includes('null'));
});

test('parseQuestionsResponse parses clean JSON', () => {
  const raw = JSON.stringify([{ question: 'Who?', guidance: 'Name the character.' }]);
  const parsed = parseQuestionsResponse(raw);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].question, 'Who?');
});

test('parseQuestionsResponse strips markdown code fences if present', () => {
  const raw = '```json\n' + JSON.stringify([{ question: 'Who?', guidance: 'Name them.' }]) + '\n```';
  const parsed = parseQuestionsResponse(raw);
  assert.strictEqual(parsed[0].question, 'Who?');
});

test('parseQuestionsResponse rejects a non-array response', () => {
  assert.throws(() => parseQuestionsResponse(JSON.stringify({ not: 'an array' })));
});

test('parseQuestionsResponse rejects malformed question objects', () => {
  assert.throws(() => parseQuestionsResponse(JSON.stringify([{ question: 'Who?' }]))); // missing guidance
});

console.log('\nAll transcriptHelpers tests completed.');
