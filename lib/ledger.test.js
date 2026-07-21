// lib/ledger.test.js
// Plain-Node assertions (no test framework needed) — run with:
//   node lib/ledger.test.js

const assert = require('assert');
const {
  getWeekId,
  createLedger,
  logReadingSession,
  attachWordCount,
  getBonusHoursEarned,
  getBonusHoursRemaining,
  getAvailableHoursForDay,
  spendBonusHours,
  getAverageWpm,
} = require('./ledger');

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

test('week ID is Sunday-anchored', () => {
  // Wed July 15, 2026 -> Sunday July 12, 2026
  assert.strictEqual(getWeekId('2026-07-15'), '2026-07-12');
  // Sunday itself maps to itself
  assert.strictEqual(getWeekId('2026-07-12'), '2026-07-12');
  // Saturday July 18 is still in the same week
  assert.strictEqual(getWeekId('2026-07-18'), '2026-07-12');
  // Sunday July 19 rolls to the next week
  assert.strictEqual(getWeekId('2026-07-19'), '2026-07-19');
});

test('worked example: 30 min/day Mon-Fri, all spent Saturday = 6 total hours', () => {
  const ledger = createLedger();
  const child = 'son';
  // Mon 7/13 through Fri 7/17
  ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17'].forEach(
    (date) => logReadingSession(ledger, child, date, 30)
  );

  const weekId = getWeekId('2026-07-13'); // 2026-07-12
  assert.strictEqual(getBonusHoursEarned(ledger, child, weekId), 5);
  assert.strictEqual(getBonusHoursRemaining(ledger, child, weekId), 5);

  // Spend all 5 bonus hours on Saturday
  spendBonusHours(ledger, child, '2026-07-18', 5);

  // Saturday's total available BEFORE spending would've been baseline(1) + bonus(5) = 6
  // After logging the spend, remaining bonus is 0, but the combined total for
  // the day (baseline + what was used) is what the plan's example describes.
  assert.strictEqual(getBonusHoursRemaining(ledger, child, weekId), 0);
});

test('bonus pool accumulates across week and can be spent any day within it', () => {
  const ledger = createLedger();
  const child = 'daughter';
  logReadingSession(ledger, child, '2026-07-13', 60); // Mon: 2h bonus
  logReadingSession(ledger, child, '2026-07-15', 30); // Wed: 1h bonus
  const weekId = getWeekId('2026-07-13');
  assert.strictEqual(getBonusHoursEarned(ledger, child, weekId), 3);

  // Available on Thursday (before spending anything) = baseline 1 + bonus 3
  assert.strictEqual(getAvailableHoursForDay(ledger, child, '2026-07-16'), 4);
});

test('unused bonus hours expire at week boundary (reset Sunday)', () => {
  const ledger = createLedger();
  const child = 'son';
  logReadingSession(ledger, child, '2026-07-17', 90); // Fri: 3h bonus, week of 7/12
  const weekBefore = getWeekId('2026-07-17');
  assert.strictEqual(getBonusHoursRemaining(ledger, child, weekBefore), 3);

  // Next week (starting Sunday 7/19) has no memory of last week's unspent bonus
  const weekAfter = getWeekId('2026-07-20'); // Monday of new week
  assert.strictEqual(getBonusHoursRemaining(ledger, child, weekAfter), 0);
  assert.strictEqual(getAvailableHoursForDay(ledger, child, '2026-07-20'), 1); // baseline only
});

test('cannot overspend bonus pool', () => {
  const ledger = createLedger();
  const child = 'son';
  logReadingSession(ledger, child, '2026-07-13', 30); // 1h bonus
  assert.throws(() => spendBonusHours(ledger, child, '2026-07-13', 2));
});

test('baseline never rolls over — only bonus is pooled', () => {
  const ledger = createLedger();
  const child = 'son';
  // No reading logged at all — every day should just be baseline
  assert.strictEqual(getAvailableHoursForDay(ledger, child, '2026-07-13'), 1);
  assert.strictEqual(getAvailableHoursForDay(ledger, child, '2026-07-17'), 1);
});

test('sessions without a word count have no WPM data (plain honor-system)', () => {
  const ledger = createLedger();
  logReadingSession(ledger, 'son', '2026-07-13', 30); // no wordsRead arg
  const weekId = getWeekId('2026-07-13');
  assert.strictEqual(getAverageWpm(ledger, 'son', weekId), null);
});

test('sessions with a word count compute WPM correctly', () => {
  const ledger = createLedger();
  const { wordsPerMinute } = logReadingSession(ledger, 'daughter', '2026-07-13', 20, 2400);
  assert.strictEqual(wordsPerMinute, 120); // 2400 words / 20 min
});

test('average WPM blends multiple sessions by total words / total minutes, not a simple mean', () => {
  const ledger = createLedger();
  // Session A: 10 min, 1000 words -> 100 wpm
  logReadingSession(ledger, 'daughter', '2026-07-13', 10, 1000);
  // Session B: 30 min, 4500 words -> 150 wpm
  logReadingSession(ledger, 'daughter', '2026-07-14', 30, 4500);
  const weekId = getWeekId('2026-07-13');
  // Correct blended average: (1000+4500) / (10+30) = 137.5
  // (NOT the simple mean of 100 and 150, which would wrongly be 125 —
  // that would under-weight the longer, faster session.)
  assert.strictEqual(getAverageWpm(ledger, 'daughter', weekId), 137.5);
});

test('bonus hours are based on minutes alone, unaffected by reading speed', () => {
  const ledger = createLedger();
  // Same 30 minutes, wildly different word counts/speeds
  const fast = logReadingSession(ledger, 'a', '2026-07-13', 30, 6000); // 200 wpm
  const slow = logReadingSession(ledger, 'b', '2026-07-13', 30, 1500); // 50 wpm
  assert.strictEqual(fast.hoursEarned, 1);
  assert.strictEqual(slow.hoursEarned, 1);
});

test('logReadingSession returns the sessionId it was given, for later reference', () => {
  const ledger = createLedger();
  const result = logReadingSession(ledger, 'emma', '2026-07-13', 20, null, 'session-abc');
  assert.strictEqual(result.sessionId, 'session-abc');
});

test('attachWordCount fills in word count on an already-logged session, by sessionId', () => {
  const ledger = createLedger();
  logReadingSession(ledger, 'emma', '2026-07-13', 20, null, 'session-abc');
  const weekId = getWeekId('2026-07-13');

  // Before attaching: no WPM data yet (transcription hasn't finished)
  assert.strictEqual(getAverageWpm(ledger, 'emma', weekId), null);

  const wpm = attachWordCount(ledger, 'emma', weekId, 'session-abc', 2400);
  assert.strictEqual(wpm, 120); // 2400 words / 20 min

  // After attaching: now reflected in the week's average
  assert.strictEqual(getAverageWpm(ledger, 'emma', weekId), 120);
});

test('attachWordCount does not change hoursEarned — bonus was already locked in by minutes', () => {
  const ledger = createLedger();
  const { hoursEarned: earnedBefore } = logReadingSession(ledger, 'emma', '2026-07-13', 30, null, 'session-xyz');
  const weekId = getWeekId('2026-07-13');
  attachWordCount(ledger, 'emma', weekId, 'session-xyz', 9000); // even a huge word count
  assert.strictEqual(earnedBefore, 1);
  assert.strictEqual(getBonusHoursEarned(ledger, 'emma', weekId), 1); // unchanged
});

test('attachWordCount returns null for an unknown sessionId (e.g. expired week)', () => {
  const ledger = createLedger();
  logReadingSession(ledger, 'emma', '2026-07-13', 30, null, 'session-real');
  const weekId = getWeekId('2026-07-13');
  const result = attachWordCount(ledger, 'emma', weekId, 'session-does-not-exist', 500);
  assert.strictEqual(result, null);
});

console.log('\nAll tests completed.');
