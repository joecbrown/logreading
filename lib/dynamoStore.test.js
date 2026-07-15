// lib/dynamoStore.test.js — run with: node lib/dynamoStore.test.js
//
// Uses aws-sdk-client-mock to verify the store sends correctly-shaped
// commands and parses responses correctly, without needing a real AWS
// account or network access. This is a wire-format/contract test, not a
// live-integration test — run against a real (or local) DynamoDB table
// before trusting this in production.

const assert = require('assert');
const { mockClient } = require('aws-sdk-client-mock');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { createDynamoStore } = require('./dynamoStore');

const ddbMock = mockClient(DynamoDBDocumentClient);

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
  await test('getWeek returns null when no item exists', async () => {
    ddbMock.reset();
    ddbMock.on(GetCommand).resolves({});
    const store = createDynamoStore({ tableName: 'TestTable', docClient: ddbMock });
    const result = await store.getWeek('emma', '2026-07-12');
    assert.strictEqual(result, null);
    const call = ddbMock.commandCalls(GetCommand)[0];
    assert.deepStrictEqual(call.args[0].input.Key, {
      childId: 'emma',
      recordType: 'WEEK#2026-07-12',
    });
  });

  await test('getWeek parses an existing item', async () => {
    ddbMock.reset();
    ddbMock.on(GetCommand).resolves({
      Item: {
        childId: 'emma',
        recordType: 'WEEK#2026-07-12',
        entries: [{ date: '2026-07-13', minutesRead: 30, hoursEarned: 1 }],
        hoursUsed: 0.5,
      },
    });
    const store = createDynamoStore({ tableName: 'TestTable', docClient: ddbMock });
    const result = await store.getWeek('emma', '2026-07-12');
    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(result.hoursUsed, 0.5);
  });

  await test('saveWeek sends a correctly-shaped PutCommand', async () => {
    ddbMock.reset();
    ddbMock.on(PutCommand).resolves({});
    const store = createDynamoStore({ tableName: 'TestTable', docClient: ddbMock });
    await store.saveWeek('jack', '2026-07-12', {
      entries: [{ date: '2026-07-13', minutesRead: 30, hoursEarned: 1 }],
      hoursUsed: 0,
    });
    const call = ddbMock.commandCalls(PutCommand)[0];
    assert.deepStrictEqual(call.args[0].input.Item, {
      childId: 'jack',
      recordType: 'WEEK#2026-07-12',
      entries: [{ date: '2026-07-13', minutesRead: 30, hoursEarned: 1 }],
      hoursUsed: 0,
    });
  });

  await test('getActiveSession returns null when none exists, else the timestamp', async () => {
    ddbMock.reset();
    ddbMock.on(GetCommand).resolves({});
    let store = createDynamoStore({ tableName: 'TestTable', docClient: ddbMock });
    assert.strictEqual(await store.getActiveSession('jack'), null);

    ddbMock.reset();
    ddbMock.on(GetCommand).resolves({
      Item: { childId: 'jack', recordType: 'SESSION', startedAt: '2026-07-13T16:00:00.000Z' },
    });
    store = createDynamoStore({ tableName: 'TestTable', docClient: ddbMock });
    assert.strictEqual(
      await store.getActiveSession('jack'),
      '2026-07-13T16:00:00.000Z'
    );
  });

  await test('setActiveSession and clearActiveSession send correct commands', async () => {
    ddbMock.reset();
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});
    const store = createDynamoStore({ tableName: 'TestTable', docClient: ddbMock });

    await store.setActiveSession('jack', '2026-07-13T16:00:00.000Z');
    const putCall = ddbMock.commandCalls(PutCommand)[0];
    assert.deepStrictEqual(putCall.args[0].input.Item, {
      childId: 'jack',
      recordType: 'SESSION',
      startedAt: '2026-07-13T16:00:00.000Z',
    });

    await store.clearActiveSession('jack');
    const delCall = ddbMock.commandCalls(DeleteCommand)[0];
    assert.deepStrictEqual(delCall.args[0].input.Key, {
      childId: 'jack',
      recordType: 'SESSION',
    });
  });

  await test('throws clearly if no table name is configured', async () => {
    delete process.env.READING_APP_TABLE;
    assert.throws(() => createDynamoStore({}), /requires a tableName/);
  });

  console.log('\nAll dynamoStore contract tests completed.');
}

run();
