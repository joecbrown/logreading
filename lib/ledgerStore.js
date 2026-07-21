// lib/ledgerStore.js
//
// Wires the pure, already-tested rules in ledger.js to a storage backend.
// This is the only layer that needs new tests when we swap in DynamoDB —
// ledger.js itself never has to change.

const ledger = require('./ledger');

function makeLedgerActions(store) {
  async function startReading(childId, nowIso) {
    const existing = await store.getActiveSession(childId);
    if (existing) {
      const err = new Error(`${childId} already has a reading session in progress`);
      err.code = 'SESSION_ALREADY_ACTIVE';
      throw err;
    }
    await store.setActiveSession(childId, nowIso);
    return { startedAt: nowIso };
  }

  async function stopReading(childId, nowIso) {
    const startedAt = await store.getActiveSession(childId);
    if (!startedAt) {
      const err = new Error(`${childId} has no reading session in progress`);
      err.code = 'NO_ACTIVE_SESSION';
      throw err;
    }
    const minutesRead = Math.max(0, (new Date(nowIso) - new Date(startedAt)) / 60000);
    await store.clearActiveSession(childId);

    const weekId = ledger.getWeekId(nowIso);
    const existingWeek = (await store.getWeek(childId, weekId)) || { entries: [], hoursUsed: 0 };
    // ledger.js operates on a full multi-child/multi-week object; we build a
    // one-child/one-week "scratch" view, run the pure function, then persist
    // back just that slice. This keeps ledger.js free of storage concerns.
    const scratch = { [childId]: { [weekId]: existingWeek } };
    const { hoursEarned } = ledger.logReadingSession(scratch, childId, nowIso, minutesRead);
    await store.saveWeek(childId, weekId, scratch[childId][weekId]);

    return { minutesRead: Math.round(minutesRead), hoursEarned, weekId };
  }

  async function getBalance(childId, nowIso) {
    const weekId = ledger.getWeekId(nowIso);
    const week = (await store.getWeek(childId, weekId)) || { entries: [], hoursUsed: 0 };
    const scratch = { [childId]: { [weekId]: week } };
    return {
      weekId,
      bonusHoursEarned: ledger.getBonusHoursEarned(scratch, childId, weekId),
      bonusHoursRemaining: ledger.getBonusHoursRemaining(scratch, childId, weekId),
      availableToday: ledger.getAvailableHoursForDay(scratch, childId, nowIso),
    };
  }

  async function spendBonus(childId, nowIso, hours) {
    const weekId = ledger.getWeekId(nowIso);
    const week = (await store.getWeek(childId, weekId)) || { entries: [], hoursUsed: 0 };
    const scratch = { [childId]: { [weekId]: week } };
    const remaining = ledger.spendBonusHours(scratch, childId, nowIso, hours);
    await store.saveWeek(childId, weekId, scratch[childId][weekId]);
    return remaining;
  }

  /**
   * Logs a session whose duration (and optionally word count) was already
   * computed by the caller — used by the iPad app, which tracks active
   * reading time itself (net of any auto-pauses from local silence
   * detection). Unlike startReading/stopReading, this doesn't rely on
   * wall-clock start/stop timestamps, since the backend has no visibility
   * into pauses that happened on-device.
   *
   * `sessionId`, if provided, lets attachWordCount (below) fill in a real
   * word count later, once transcription finishes asynchronously.
   */
  async function logCompletedSession(childId, nowIso, minutesRead, wordsRead = null, sessionId = null) {
    if (typeof minutesRead !== 'number' || minutesRead < 0) {
      const err = new Error('minutesRead must be a non-negative number');
      err.code = 'INVALID_MINUTES';
      throw err;
    }
    const weekId = ledger.getWeekId(nowIso);
    const existingWeek = (await store.getWeek(childId, weekId)) || { entries: [], hoursUsed: 0 };
    const scratch = { [childId]: { [weekId]: existingWeek } };
    const { hoursEarned, wordsPerMinute } = ledger.logReadingSession(
      scratch,
      childId,
      nowIso,
      minutesRead,
      wordsRead,
      sessionId
    );
    await store.saveWeek(childId, weekId, scratch[childId][weekId]);
    return { minutesRead, hoursEarned, wordsPerMinute, weekId, sessionId };
  }

  /**
   * Fills in a transcript-derived word count on an already-logged session,
   * once transcription completes (asynchronously, sometime after the
   * session itself was logged). Returns the computed wordsPerMinute, or
   * null if no matching session was found (e.g. the week's data expired,
   * or the sessionId is unrecognized).
   */
  async function attachWordCount(childId, weekId, sessionId, wordsRead) {
    const week = await store.getWeek(childId, weekId);
    if (!week) return null;
    const scratch = { [childId]: { [weekId]: week } };
    const wordsPerMinute = ledger.attachWordCount(scratch, childId, weekId, sessionId, wordsRead);
    if (wordsPerMinute == null) return null;
    await store.saveWeek(childId, weekId, scratch[childId][weekId]);
    return wordsPerMinute;
  }

  return {
    startReading,
    stopReading,
    getBalance,
    spendBonus,
    logCompletedSession,
    attachWordCount,
  };
}

module.exports = { makeLedgerActions };
