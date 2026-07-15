// lib/ledgerStore.test.js — run with: node lib/ledgerStore.test.js

const assert = require('assert');
const { createMemoryStore } = require('./store');
const { makeLedgerActions } = require('./ledgerStore');

function test(name, fn) {
  return fn()
    .then(() => console.log(`✓ ${name}`))
    .catch((err) => {
      console.error(`✗ ${name}`);
      console.error(err);
      process.exitCode = 1;
    });
}

async function run() {
  await test('start -> stop 30 min later earns exactly 1 bonus hour', async () => {
    const actions = makeLedgerActions(createMemoryStore());
    const start = '2026-07-15T16:00:00.000Z'; // Wed
    const stop = '2026-07-15T16:30:00.000Z';
    await actions.startReading('emma', start);
    const result = await actions.stopReading('emma', stop);
    assert.strictEqual(result.minutesRead, 30);
    assert.strictEqual(result.hoursEarned, 1);
  });

  await test('cannot start a second session while one is active', async () => {
    const actions = makeLedgerActions(createMemoryStore());
    await actions.startReading('jack', '2026-07-15T16:00:00.000Z');
    await assert.rejects(
      () => actions.startReading('jack', '2026-07-15T16:05:00.000Z'),
      { code: 'SESSION_ALREADY_ACTIVE' }
    );
  });

  await test('stopping with no active session throws', async () => {
    const actions = makeLedgerActions(createMemoryStore());
    await assert.rejects(
      () => actions.stopReading('jack', '2026-07-15T16:05:00.000Z'),
      { code: 'NO_ACTIVE_SESSION' }
    );
  });

  await test('balance reflects accumulated sessions within the week', async () => {
    const actions = makeLedgerActions(createMemoryStore());
    await actions.startReading('emma', '2026-07-13T16:00:00.000Z'); // Mon
    await actions.stopReading('emma', '2026-07-13T16:30:00.000Z'); // +30min -> 1h bonus
    await actions.startReading('emma', '2026-07-14T16:00:00.000Z'); // Tue
    await actions.stopReading('emma', '2026-07-14T17:00:00.000Z'); // +60min -> 2h bonus

    const balance = await actions.getBalance('emma', '2026-07-15T12:00:00.000Z');
    assert.strictEqual(balance.bonusHoursEarned, 3);
    assert.strictEqual(balance.bonusHoursRemaining, 3);
    assert.strictEqual(balance.availableToday, 4); // baseline 1 + 3 bonus
  });

  await test('spending bonus reduces remaining balance', async () => {
    const actions = makeLedgerActions(createMemoryStore());
    await actions.startReading('jack', '2026-07-13T16:00:00.000Z');
    await actions.stopReading('jack', '2026-07-13T17:00:00.000Z'); // 2h bonus
    await actions.spendBonus('jack', '2026-07-13T18:00:00.000Z', 1.5);
    const balance = await actions.getBalance('jack', '2026-07-13T18:00:00.000Z');
    assert.strictEqual(balance.bonusHoursRemaining, 0.5);
  });

  console.log('\nAll ledgerStore tests completed.');
}

run();
