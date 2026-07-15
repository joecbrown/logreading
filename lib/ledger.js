// lib/ledger.js
//
// Core business logic for the reading-time / electronics-bank system.
// Pure functions only — no AWS or Alexa dependencies — so this can be
// unit-tested standalone and dropped into a Lambda handler later
// without modification.

const BASELINE_DAILY_HOURS = 1;
const MINUTES_PER_BONUS_HOUR = 30; // 30 min reading = 1 bonus hour

/**
 * Returns a Sunday-anchored week ID for a given date — the ISO date
 * (YYYY-MM-DD) of the Sunday that starts that date's week.
 * All comparisons are done in UTC to avoid local-timezone drift.
 */
function getWeekId(date) {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0 = Sunday
  const sunday = new Date(d);
  sunday.setUTCDate(d.getUTCDate() - day);
  return sunday.toISOString().slice(0, 10);
}

function computeBonusHours(minutesRead) {
  return minutesRead / MINUTES_PER_BONUS_HOUR;
}

/**
 * Ledger shape:
 * {
 *   [childId]: {
 *     [weekId]: {
 *       entries: [{ date, minutesRead, hoursEarned, wordsRead?, wordsPerMinute? }],
 *       hoursUsed: number
 *     }
 *   }
 * }
 *
 * wordsRead/wordsPerMinute are only present when a transcript-derived word
 * count was available for that session (iPad app + cloud transcription).
 * Bonus-hour calculation is always based on minutesRead alone — WPM is a
 * reporting metric, never a factor in the electronics-time rules.
 */
function createLedger() {
  return {};
}

function ensureWeek(ledger, childId, weekId) {
  if (!ledger[childId]) ledger[childId] = {};
  if (!ledger[childId][weekId]) {
    ledger[childId][weekId] = { entries: [], hoursUsed: 0 };
  }
  return ledger[childId][weekId];
}

/**
 * Call this when a reading session ends. `wordsRead` is optional — pass it
 * when a transcript-derived word count is available (from the iPad app);
 * omit it for a plain honor-system timer session.
 */
function logReadingSession(ledger, childId, date, minutesRead, wordsRead = null) {
  const weekId = getWeekId(date);
  const week = ensureWeek(ledger, childId, weekId);
  const hoursEarned = computeBonusHours(minutesRead);
  const entry = { date, minutesRead, hoursEarned };
  if (wordsRead != null && minutesRead > 0) {
    entry.wordsRead = wordsRead;
    entry.wordsPerMinute = wordsRead / minutesRead;
  }
  week.entries.push(entry);
  return { weekId, hoursEarned, wordsPerMinute: entry.wordsPerMinute ?? null };
}

function getBonusHoursEarned(ledger, childId, weekId) {
  const week = ledger[childId]?.[weekId];
  if (!week) return 0;
  return week.entries.reduce((sum, e) => sum + e.hoursEarned, 0);
}

function getBonusHoursRemaining(ledger, childId, weekId) {
  const earned = getBonusHoursEarned(ledger, childId, weekId);
  const used = ledger[childId]?.[weekId]?.hoursUsed || 0;
  return Math.max(0, earned - used);
}

/**
 * Total electronics time available on a given calendar day: the daily
 * baseline (does not roll over) plus whatever bonus is still unspent
 * from the pool for that week (bonus is week-scoped, not per-day).
 */
function getAvailableHoursForDay(ledger, childId, date) {
  const weekId = getWeekId(date);
  return BASELINE_DAILY_HOURS + getBonusHoursRemaining(ledger, childId, weekId);
}

/** Spend bonus hours from the weekly pool (baseline hours aren't tracked — assumed always available). */
function spendBonusHours(ledger, childId, date, hours) {
  const weekId = getWeekId(date);
  const week = ensureWeek(ledger, childId, weekId);
  const remaining = getBonusHoursRemaining(ledger, childId, weekId);
  if (hours > remaining + 1e-9) {
    throw new Error(
      `Cannot spend ${hours}h bonus — only ${remaining}h remaining for week ${weekId}`
    );
  }
  week.hoursUsed += hours;
  return getBonusHoursRemaining(ledger, childId, weekId);
}

/**
 * Average words-per-minute across a week's sessions that have a
 * transcript-derived word count. Returns null if no sessions this week
 * have WPM data (e.g. plain honor-system sessions with no transcript).
 */
function getAverageWpm(ledger, childId, weekId) {
  const week = ledger[childId]?.[weekId];
  if (!week) return null;
  const withWpm = week.entries.filter((e) => e.wordsPerMinute != null);
  if (withWpm.length === 0) return null;
  const totalWords = withWpm.reduce((sum, e) => sum + e.wordsRead, 0);
  const totalMinutes = withWpm.reduce((sum, e) => sum + e.minutesRead, 0);
  return totalMinutes > 0 ? totalWords / totalMinutes : null;
}

module.exports = {
  BASELINE_DAILY_HOURS,
  MINUTES_PER_BONUS_HOUR,
  getWeekId,
  computeBonusHours,
  createLedger,
  logReadingSession,
  getBonusHoursEarned,
  getBonusHoursRemaining,
  getAvailableHoursForDay,
  spendBonusHours,
  getAverageWpm,
};
