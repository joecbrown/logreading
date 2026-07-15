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

  return { startReading, stopReading, getBalance, spendBonus };
}

module.exports = { makeLedgerActions };
