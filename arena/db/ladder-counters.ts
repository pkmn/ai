import {DatabaseSync} from 'node:sqlite';

import {TransactionRunner} from '../../db';

export function nextMatchSequence(
  db: DatabaseSync,
  txRunner: TransactionRunner,
  format: string
): number {
  return txRunner(() => {
    const globalRow = db.prepare(
      'SELECT COALESCE(SUM(next_seq), 0) AS total FROM ladder_counters'
    ).get() as {total: number};
    const nextGlobal = globalRow.total + 1;

    db.prepare(`
      INSERT INTO ladder_counters (format, next_seq, last_global_match_seq)
      VALUES (?, 1, ?)
      ON CONFLICT(format) DO UPDATE SET
        next_seq = next_seq + 1,
        last_global_match_seq = excluded.last_global_match_seq
    `).run(format, nextGlobal);

    const row = db.prepare(
      'SELECT next_seq FROM ladder_counters WHERE format = ?'
    ).get(format) as {next_seq: number};
    return row.next_seq;
  });
}

export function getMatchSequence(db: DatabaseSync, format: string): number {
  const row = db.prepare(
    'SELECT next_seq FROM ladder_counters WHERE format = ?'
  ).get(format) as {next_seq: number} | undefined;
  return row?.next_seq ?? 0;
}

export function getLastGlobalMatchSequence(db: DatabaseSync, format: string): number {
  const row = db.prepare(
    'SELECT last_global_match_seq FROM ladder_counters WHERE format = ?'
  ).get(format) as {last_global_match_seq: number} | undefined;
  return row?.last_global_match_seq ?? 0;
}

export function getGlobalMatchCount(db: DatabaseSync): number {
  const row = db.prepare(
    'SELECT COALESCE(SUM(next_seq), 0) AS total FROM ladder_counters'
  ).get() as {total: number};
  return row.total;
}
