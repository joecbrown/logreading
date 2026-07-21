// transcribe/start.test.js — run with: node transcribe/start.test.js

const assert = require('assert');
const { mockClient } = require('aws-sdk-client-mock');
const { TranscribeClient, StartTranscriptionJobCommand } = require('@aws-sdk/client-transcribe');
const { handler } = require('./start');

const transcribeMock = mockClient(TranscribeClient);

function s3Event(bucket, key) {
  return { Records: [{ s3: { bucket: { name: bucket }, object: { key } } }] };
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
  await test('starts a transcription job with the correctly-shaped job name and output location', async () => {
    transcribeMock.reset();
    transcribeMock.on(StartTranscriptionJobCommand).resolves({});
    const result = await handler(s3Event('my-bucket', 'audio/emma/session-1.caf'));
    assert.strictEqual(result.results[0].status, 'started');

    const call = transcribeMock.commandCalls(StartTranscriptionJobCommand)[0];
    assert.strictEqual(call.args[0].input.TranscriptionJobName, 'emma--session-1');
    assert.strictEqual(call.args[0].input.Media.MediaFileUri, 's3://my-bucket/audio/emma/session-1.caf');
    assert.strictEqual(call.args[0].input.OutputKey, 'transcripts/emma/session-1.json');
    assert.strictEqual(call.args[0].input.OutputBucketName, 'my-bucket');
  });

  await test('skips S3 objects that do not match the expected audio path shape', async () => {
    transcribeMock.reset();
    transcribeMock.on(StartTranscriptionJobCommand).resolves({});
    const result = await handler(s3Event('my-bucket', 'something-else/random-file.txt'));
    assert.strictEqual(result.results.length, 0);
    assert.strictEqual(transcribeMock.commandCalls(StartTranscriptionJobCommand).length, 0);
  });

  await test('treats a duplicate job (ConflictException) as already_started, not an error', async () => {
    transcribeMock.reset();
    const err = new Error('Job already exists');
    err.name = 'ConflictException';
    transcribeMock.on(StartTranscriptionJobCommand).rejects(err);
    const result = await handler(s3Event('my-bucket', 'audio/jack/session-2.caf'));
    assert.strictEqual(result.results[0].status, 'already_started');
  });

  await test('reports genuine errors clearly rather than throwing and losing the whole batch', async () => {
    transcribeMock.reset();
    transcribeMock.on(StartTranscriptionJobCommand).rejects(new Error('Some other AWS error'));
    const result = await handler(s3Event('my-bucket', 'audio/jack/session-3.caf'));
    assert.strictEqual(result.results[0].status, 'error');
  });

  console.log('\nAll transcribe/start tests completed.');
}

run();
