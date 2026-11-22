import {DatabaseSync} from 'node:sqlite';

export const SMOKE_TESTS_PER_CYCLE = 1;
export const SMOKE_TEST_CYCLE_INTERVAL = 1;

export interface SmokeCadence {
  maxPerCycle: number;
  everyCycles: number;
}

interface RawConfigRow {
  smoke_tests_per_cycle: number;
  smoke_test_cycle_interval: number;
}

export function getSmokeCadence(db: DatabaseSync): SmokeCadence {
  const row = db.prepare(
    'SELECT smoke_tests_per_cycle, smoke_test_cycle_interval FROM config WHERE id = 1'
  ).get() as RawConfigRow | undefined;
  if (!row) {
    return {
      maxPerCycle: SMOKE_TESTS_PER_CYCLE,
      everyCycles: SMOKE_TEST_CYCLE_INTERVAL,
    };
  }
  return {
    maxPerCycle: row.smoke_tests_per_cycle,
    everyCycles: row.smoke_test_cycle_interval,
  };
}

export function setSmokeCadence(
  db: DatabaseSync,
  cadence: SmokeCadence,
  now = Math.floor(Date.now() / 1000)
): SmokeCadence {
  if (!Number.isInteger(cadence.maxPerCycle) || cadence.maxPerCycle < 0) {
    throw new Error('maxPerCycle must be a non-negative integer.');
  }
  if (!Number.isInteger(cadence.everyCycles) || cadence.everyCycles < 1) {
    throw new Error('everyCycles must be a positive integer.');
  }
  db.prepare(`
    INSERT INTO config (id, smoke_tests_per_cycle, smoke_test_cycle_interval, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      smoke_tests_per_cycle = excluded.smoke_tests_per_cycle,
      smoke_test_cycle_interval = excluded.smoke_test_cycle_interval,
      updated_at = excluded.updated_at
  `).run(cadence.maxPerCycle, cadence.everyCycles, now);
  return {
    maxPerCycle: cadence.maxPerCycle,
    everyCycles: cadence.everyCycles,
  };
}
