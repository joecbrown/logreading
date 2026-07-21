// transcribe/start.js
//
// Lambda triggered by an S3 "Object Created" event on the audio bucket
// (configured in the S3 console, or via infra — see README). Starts an
// Amazon Transcribe job for the newly-uploaded audio file.
//
// This Lambda does NOT touch DynamoDB or generate anything — it only
// kicks off transcription. The actual result-processing (word count,
// ledger update, Claude question generation) happens in transcribe/
// complete.js, once Transcribe finishes (which can take anywhere from
// several seconds to a minute or more, well past what's reasonable to
// hold this Lambda open waiting for).

const { TranscribeClient, StartTranscriptionJobCommand } = require('@aws-sdk/client-transcribe');
const { buildTranscribeJobName, transcriptOutputKey } = require('../lib/transcriptHelpers');

const transcribeClient = new TranscribeClient({});

exports.handler = async (event) => {
  const results = [];
  for (const record of event.Records || []) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    // Expected shape: audio/{childId}/{sessionId}.wav
    const match = key.match(/^audio\/([^/]+)\/([^/]+)\.wav$/);
    if (!match) {
      console.log(`Skipping S3 object not matching expected audio path shape: ${key}`);
      continue;
    }
    const [, childId, sessionId] = match;
    const jobName = buildTranscribeJobName(childId, sessionId);

    try {
      await transcribeClient.send(
        new StartTranscriptionJobCommand({
          TranscriptionJobName: jobName,
          LanguageCode: 'en-US',
          Media: { MediaFileUri: `s3://${bucket}/${key}` },
          OutputBucketName: bucket,
          OutputKey: transcriptOutputKey(childId, sessionId),
        })
      );
      results.push({ jobName, status: 'started' });
    } catch (err) {
      // If a job with this name already exists (e.g. a retried S3 event),
      // Transcribe throws ConflictException — treat that as fine, not an
      // error, since the job is already in flight either way.
      if (err.name === 'ConflictException') {
        results.push({ jobName, status: 'already_started' });
      } else {
        console.error(`Failed to start transcription job ${jobName}:`, err);
        results.push({ jobName, status: 'error', error: err.message });
      }
    }
  }
  return { results };
};
