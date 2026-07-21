// lib/store.js
//
// Storage abstraction so the skill logic doesn't care whether it's
// talking to an in-memory Map (local dev/tests) or DynamoDB (deployed).
// Swap createMemoryStore() for a createDynamoStore() with the same
// interface once AWS is wired up — nothing above this layer changes.

function createMemoryStore() {
  const weeks = new Map(); // key: `${childId}#${weekId}` -> { entries, hoursUsed }
  const activeSessions = new Map(); // key: childId -> startTimeIso
  const pendingSessions = new Map(); // key: `${childId}#${sessionId}` -> { weekId, grade, createdAt }
  const questions = new Map(); // key: `${childId}#${sessionId}` -> { questions, generatedAt }

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
    // Pending sessions bridge the gap between "upload URL requested" and
    // "transcription completed" — the completion handler needs to know
    // which week and grade level a sessionId belongs to, without the
    // caller having to pass that context through Transcribe itself.
    async setPendingSession(childId, sessionId, data) {
      pendingSessions.set(`${childId}#${sessionId}`, data);
    },
    async getPendingSession(childId, sessionId) {
      return pendingSessions.get(`${childId}#${sessionId}`) || null;
    },
    async deletePendingSession(childId, sessionId) {
      pendingSessions.delete(`${childId}#${sessionId}`);
    },
    async saveQuestions(childId, sessionId, data) {
      questions.set(`${childId}#${sessionId}`, data);
    },
    async getQuestions(childId, sessionId) {
      return questions.get(`${childId}#${sessionId}`) || null;
    },
  };
}

module.exports = { createMemoryStore };
