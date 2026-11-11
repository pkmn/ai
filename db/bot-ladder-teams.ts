import type {DatabaseSync} from 'node:sqlite';

export type TeamPoolStatus = 'pending' | 'active';

export interface BotLadderTeamRow {
  ladder_id: string;
  bot_id: number;
  slot_index: number;
  canonical_packed: string;
  status: TeamPoolStatus;
  created_at: number;
}

export function hasActiveLadderTeams(
  db: DatabaseSync,
  ladderId: string,
  botId: number
): boolean {
  const row = db.prepare(
    `SELECT 1 FROM bot_ladder_teams
     WHERE ladder_id = ? AND bot_id = ? AND status = 'active'
     LIMIT 1`
  ).get(ladderId, botId);
  return row !== undefined;
}

export function getTeamsForBotLadder(
  db: DatabaseSync,
  ladderId: string,
  botId: number,
  status?: TeamPoolStatus
): string[] {
  const rows = status
    ? db.prepare(
      `SELECT canonical_packed FROM bot_ladder_teams
       WHERE ladder_id = ? AND bot_id = ? AND status = ?
       ORDER BY slot_index ASC`
    ).all(ladderId, botId, status)
    : db.prepare(
      `SELECT canonical_packed FROM bot_ladder_teams
       WHERE ladder_id = ? AND bot_id = ?
       ORDER BY slot_index ASC`
    ).all(ladderId, botId);
  return (rows as Array<{canonical_packed: string}>).map(r => r.canonical_packed);
}

export function replacePendingTeams(
  db: DatabaseSync,
  botId: number,
  teamsByLadder: Record<string, string[]>,
  now: number
) {
  const clearPending = db.prepare(
    `DELETE FROM bot_ladder_teams
     WHERE ladder_id = ? AND bot_id = ? AND status = 'pending'`
  );
  const insertTeam = db.prepare(`
    INSERT INTO bot_ladder_teams (
      ladder_id, bot_id, slot_index, canonical_packed, status, created_at
    )
    VALUES (?, ?, ?, ?, 'pending', ?)
  `);
  for (const [ladderId, packedTeams] of Object.entries(teamsByLadder)) {
    clearPending.run(ladderId, botId);
    for (let i = 0; i < packedTeams.length; i++) {
      insertTeam.run(ladderId, botId, i + 1, packedTeams[i], now);
    }
  }
}

export function promotePendingTeams(db: DatabaseSync, ladderId: string, botId: number) {
  db.prepare(`
    UPDATE bot_ladder_teams
    SET status = 'active'
    WHERE ladder_id = ? AND bot_id = ? AND status = 'pending'
  `).run(ladderId, botId);
}

export function deletePendingTeams(db: DatabaseSync, ladderIds: string[], botId: number) {
  const del = db.prepare(`
    DELETE FROM bot_ladder_teams
    WHERE ladder_id = ? AND bot_id = ? AND status = 'pending'
  `);
  for (const ladderId of ladderIds) {
    del.run(ladderId, botId);
  }
}
