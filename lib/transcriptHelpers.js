// lib/transcriptHelpers.js
//
// Pure functions supporting the transcription pipeline — no AWS or Claude
// API calls here, so these can be unit-tested directly, the same way
// lib/ledger.js is.

/**
 * Builds the Transcribe job name (and the inverse parser below) encoding
 * childId + sessionId together, since Transcribe job state change events
 * only give us the job name — no way to attach arbitrary metadata to a
 * job that comes back on completion. Uses "--" as a separator since
 * childId (a lowercased name slug) won't naturally contain it, and both
 * childId and sessionId (a UUID) are safe within Transcribe's allowed
 * job-name character set (letters, numbers, ., _, -).
 */
function buildTranscribeJobName(childId, sessionId) {
  return `${childId}--${sessionId}`;
}

/**
 * Inverse of buildTranscribeJobName. Returns null if the job name doesn't
 * match the expected shape (e.g. a stray job created some other way) —
 * callers should treat that as "not one of ours" rather than throwing.
 */
function parseTranscribeJobName(jobName) {
  const idx = jobName.indexOf('--');
  if (idx === -1) return null;
  const childId = jobName.slice(0, idx);
  const sessionId = jobName.slice(idx + 2);
  if (!childId || !sessionId) return null;
  return { childId, sessionId };
}

/** Where a completed job's transcript JSON lands, given how transcribeStart configures OutputKey. */
function transcriptOutputKey(childId, sessionId) {
  return `transcripts/${childId}/${sessionId}.json`;
}

/** Where uploaded session audio lands, given how the upload-url route configures its S3 key. */
function audioObjectKey(childId, sessionId) {
  return `audio/${childId}/${sessionId}.wav`;
}

/**
 * Extracts the transcript text from Amazon Transcribe's output JSON shape
 * (the standard `results.transcripts[0].transcript` field) and counts
 * words via a simple whitespace split. Good enough for WPM purposes;
 * not attempting anything smarter (e.g. filtering filler words).
 */
function extractTranscriptAndWordCount(transcribeOutputJson) {
  const transcript = transcribeOutputJson?.results?.transcripts?.[0]?.transcript ?? '';
  const words = transcript.trim().length > 0 ? transcript.trim().split(/\s+/) : [];
  return { transcript, wordCount: words.length };
}

/**
 * Builds the prompt for Claude to generate comprehension questions from a
 * transcript. Keeps the instruction to return ONLY JSON, since the caller
 * parses the response directly (see api/handler.js's structured-output
 * guidance elsewhere in this project for why that matters).
 */
function buildQuestionGenerationPrompt(transcript, grade) {
  const gradeContext = grade ? ` The reader is in ${grade}.` : '';
  return (
    `A child just read the following passage aloud.${gradeContext} ` +
    `Generate 3-5 comprehension questions calibrated to that grade level, ` +
    `each with brief guidance on what a strong answer should include. ` +
    `Respond with ONLY a JSON array, no other text, no markdown code fences, ` +
    `in this exact shape: ` +
    `[{"question": "...", "guidance": "..."}]\n\n` +
    `Passage:\n${transcript}`
  );
}

/**
 * Parses Claude's response into the expected question-list shape,
 * tolerating markdown code fences in case the model adds them despite
 * being asked not to.
 */
function parseQuestionsResponse(rawText) {
  const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected a JSON array of questions');
  }
  for (const item of parsed) {
    if (typeof item.question !== 'string' || typeof item.guidance !== 'string') {
      throw new Error('Each question must have "question" and "guidance" strings');
    }
  }
  return parsed;
}

/**
 * Builds the subject/body for the "comprehension questions ready" email.
 * Pure/testable — no SES or network calls here, those live in
 * transcribe/complete.js.
 */
function buildQuestionsEmail(displayName, questions, wpm) {
  const name = displayName || 'Your reader';
  const subject = `Comprehension questions for ${name}'s reading session`;

  const wpmLine = wpm != null ? `Reading speed: ${Math.round(wpm)} words/minute\n\n` : '';

  const questionsList = questions
    .map((q, i) => `${i + 1}. ${q.question}\n   What to listen for: ${q.guidance}`)
    .join('\n\n');

  const body =
    `${name} just finished a reading session.\n\n` +
    wpmLine +
    `Comprehension questions to ask:\n\n${questionsList}\n`;

  return { subject, body };
}

module.exports = {
  buildTranscribeJobName,
  parseTranscribeJobName,
  transcriptOutputKey,
  audioObjectKey,
  extractTranscriptAndWordCount,
  buildQuestionGenerationPrompt,
  parseQuestionsResponse,
  buildQuestionsEmail,
};
