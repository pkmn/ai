import {DatabaseSync} from 'node:sqlite';

import {getLadder} from './ladders';

import {TransactionRunner} from './index';

export interface LadderTeamRow {
  ladderId: string;
  teamIndex: number;
  packedTeam: string;
  uploadedAt: number;
}

export function countLadderTeams(db: DatabaseSync, ladderId: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) AS cnt FROM ladder_teams WHERE ladder_id = ?'
  ).get(ladderId) as {cnt: number};
  return row.cnt;
}

export function hasLadderTeams(db: DatabaseSync, ladderId: string): boolean {
  return countLadderTeams(db, ladderId) >= 2;
}

export function getLadderTeams(db: DatabaseSync, ladderId: string): string[] {
  const rows = db.prepare(
    'SELECT packed_team FROM ladder_teams WHERE ladder_id = ? ORDER BY team_index ASC'
  ).all(ladderId) as Array<{packed_team: string}>;
  return rows.map(r => r.packed_team);
}

export function replaceLadderTeams(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  ladderId: string,
  packedTeams: string[],
  now = Math.floor(Date.now() / 1000)
): number {
  if (packedTeams.length < 2) {
    throw Object.assign(
      new Error(`Harvested ladder "${ladderId}" requires at least 2 validated teams.`),
      {status: 400}
    );
  }
  return inTransaction(() => {
    const ladder = getLadder(db, ladderId);
    if (!ladder) {
      throw Object.assign(new Error(`Unknown ladder "${ladderId}".`), {status: 404});
    }
    if (ladder.team !== 'harvested') {
      throw Object.assign(
        new Error(
          'Harvested teams can only be uploaded to harvested ladders ' +
          `("${ladder.id}" has team="${ladder.team}").`
        ),
        {status: 400}
      );
    }

    db.prepare('DELETE FROM ladder_teams WHERE ladder_id = ?').run(ladder.id);
    const insert = db.prepare(`
      INSERT INTO ladder_teams (ladder_id, team_index, packed_team, uploaded_at)
      VALUES (?, ?, ?, ?)
    `);
    for (let i = 0; i < packedTeams.length; i++) {
      insert.run(ladder.id, i + 1, packedTeams[i], now);
    }
    return packedTeams.length;
  });
}
