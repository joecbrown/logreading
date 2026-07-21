// lib/dynamoStore.js
//
// DynamoDB implementation of the same interface as createMemoryStore() in
// store.js (getWeek, saveWeek, getActiveSession, setActiveSession,
// clearActiveSession). Nothing above this layer (ledgerStore.js,
// lambda/index.js) needs to change to use it.
//
// TABLE SCHEMA (single-table design):
//   Partition key: childId       (String)
//   Sort key:      recordType    (String)
//
//   Weekly ledger data -> recordType = "WEEK#<weekId>"
//     attributes: entries (List), hoursUsed (Number)
//   Active session data -> recordType = "SESSION"
//     attributes: startedAt (String, ISO timestamp)
//   Pending transcription data -> recordType = "PENDING#<sessionId>"
//     attributes: weekId (String), grade (String, optional), createdAt (String)
//   Generated comprehension questions -> recordType = "QUESTIONS#<sessionId>"
//     attributes: questions (List), generatedAt (String)
//
// See infra/table.json for a CLI-creatable table definition.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} = require('@aws-sdk/lib-dynamodb');

function createDynamoStore({ tableName, docClient } = {}) {
  const TableName = tableName || process.env.READING_APP_TABLE;
  if (!TableName) {
    throw new Error(
      'createDynamoStore requires a tableName option or READING_APP_TABLE env var'
    );
  }
  // docClient lets tests inject a mocked DynamoDBDocumentClient. In
  // production this always builds a real client from default
  // credentials/region (standard AWS SDK resolution).
  const doc = docClient || DynamoDBDocumentClient.from(new DynamoDBClient({}));

  return {
    async getWeek(childId, weekId) {
      const res = await doc.send(
        new GetCommand({
          TableName,
          Key: { childId, recordType: `WEEK#${weekId}` },
        })
      );
      if (!res.Item) return null;
      return {
        entries: res.Item.entries || [],
        hoursUsed: res.Item.hoursUsed || 0,
      };
    },

    async saveWeek(childId, weekId, weekData) {
      await doc.send(
        new PutCommand({
          TableName,
          Item: {
            childId,
            recordType: `WEEK#${weekId}`,
            entries: weekData.entries,
            hoursUsed: weekData.hoursUsed,
          },
        })
      );
    },

    async getActiveSession(childId) {
      const res = await doc.send(
        new GetCommand({
          TableName,
          Key: { childId, recordType: 'SESSION' },
        })
      );
      return res.Item ? res.Item.startedAt : null;
    },

    async setActiveSession(childId, startTimeIso) {
      await doc.send(
        new PutCommand({
          TableName,
          Item: { childId, recordType: 'SESSION', startedAt: startTimeIso },
        })
      );
    },

    async clearActiveSession(childId) {
      await doc.send(
        new DeleteCommand({
          TableName,
          Key: { childId, recordType: 'SESSION' },
        })
      );
    },

    async setPendingSession(childId, sessionId, data) {
      await doc.send(
        new PutCommand({
          TableName,
          Item: {
            childId,
            recordType: `PENDING#${sessionId}`,
            weekId: data.weekId,
            grade: data.grade ?? null,
            createdAt: data.createdAt,
          },
        })
      );
    },

    async getPendingSession(childId, sessionId) {
      const res = await doc.send(
        new GetCommand({
          TableName,
          Key: { childId, recordType: `PENDING#${sessionId}` },
        })
      );
      if (!res.Item) return null;
      return { weekId: res.Item.weekId, grade: res.Item.grade, createdAt: res.Item.createdAt };
    },

    async deletePendingSession(childId, sessionId) {
      await doc.send(
        new DeleteCommand({
          TableName,
          Key: { childId, recordType: `PENDING#${sessionId}` },
        })
      );
    },

    async saveQuestions(childId, sessionId, data) {
      await doc.send(
        new PutCommand({
          TableName,
          Item: {
            childId,
            recordType: `QUESTIONS#${sessionId}`,
            questions: data.questions,
            generatedAt: data.generatedAt,
          },
        })
      );
    },

    async getQuestions(childId, sessionId) {
      const res = await doc.send(
        new GetCommand({
          TableName,
          Key: { childId, recordType: `QUESTIONS#${sessionId}` },
        })
      );
      if (!res.Item) return null;
      return { questions: res.Item.questions, generatedAt: res.Item.generatedAt };
    },
  };
}

module.exports = { createDynamoStore };
