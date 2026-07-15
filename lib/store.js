// lib/store.js
//
// Storage abstraction so the skill logic doesn't care whether it's
// talking to an in-memory Map (local dev/tests) or DynamoDB (deployed).
// Swap createMemoryStore() for a createDynamoStore() with the same
// interface once AWS is wired up — nothing above this layer changes.

function createMemoryStore() {
  const weeks = new Map(); // key: `${childId}#${weekId}` -> { entries, hoursUsed }
  const activeSessions = new Map(); // key: childId -> startTimeIso

  return {
    async getWeek(childId, weekId) {
      return weeks.get(`${childId}#${weekId}`) || null;
    },
    async saveWeek(childId, weekId, weekData) {
      weeks.set(`${childId}#${weekId}`, weekData);
    },
    async getActiveSession(childId) {
      return activeSessions.get(childId) || null;
    },
    async setActiveSession(childId, startTimeIso) {
      activeSessions.set(childId, startTimeIso);
    },
    async clearActiveSession(childId) {
      activeSessions.delete(childId);
    },
  };
}

module.exports = { createMemoryStore };
