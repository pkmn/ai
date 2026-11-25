import {DatabaseSync} from 'node:sqlite';

export type TeamPoolStatus = 'saved' | 'pending' | 'active';

export interface TeamPoolCounts {
  saved: number;
  pending: number;
  active: number;
}

export interface LadderRosterEntry {
  agentId: number;
  agentSlug: string;
  agentName: string;
  submittedAt: number;
  teams: Array<{
    index: number;
    packed: string;
  }>;
}

export function getActiveRosterForLadder(
  db: DatabaseSync,
  ladderId: string
): LadderRosterEntry[] {
  const rows = db.prepare(`
    SELECT
      alt.agent_id,
      a.slug AS agent_slug,
      a.name AS agent_name,
      alt.team_index,
      alt.packed_team,
      alt.submitted_at
    FROM agent_ladder_teams alt
    JOIN agents a ON a.id = alt.agent_id
    WHERE alt.ladder_id = ?
      AND alt.status = 'active'
    ORDER BY a.slug ASC, alt.team_index ASC
  `).all(ladderId) as Array<{
    agent_id: number;
    agent_slug: string;
    agent_name: string;
    team_index: number;
    packed_team: string;
    submitted_at: number;
  }>;

  const byAgent = new Map<number, LadderRosterEntry>();
  for (const r of rows) {
    let entry = byAgent.get(r.agent_id);
    if (!entry) {
      entry = {
        agentId: r.agent_id,
        agentSlug: r.agent_slug,
        agentName: r.agent_name,
        submittedAt: r.submitted_at,
        teams: [],
      };
      byAgent.set(r.agent_id, entry);
    }
    entry.teams.push({index: r.team_index, packed: r.packed_team});
  }
  return [...byAgent.values()];
}

export function hasActiveLadderTeams(
  db: DatabaseSync,
  ladderId: string,
  agentId: number
): boolean {
  const row = db.prepare(
    `SELECT 1 FROM agent_ladder_teams
     WHERE ladder_id = ? AND agent_id = ? AND status = 'active'
     LIMIT 1`
  ).get(ladderId, agentId);
  return row !== undefined;
}

export function getTeamsForAgentLadder(
  db: DatabaseSync,
  ladderId: string,
  agentId: number,
  status?: TeamPoolStatus
): string[] {
  const rows = status
    ? db.prepare(
      `SELECT packed_team FROM agent_ladder_teams
       WHERE ladder_id = ? AND agent_id = ? AND status = ?
       ORDER BY team_index ASC`
    ).all(ladderId, agentId, status)
    : db.prepare(
      `SELECT packed_team FROM agent_ladder_teams
       WHERE ladder_id = ? AND agent_id = ?
       ORDER BY team_index ASC`
    ).all(ladderId, agentId);
  return (rows as Array<{packed_team: string}>).map(r => r.packed_team);
}

export function replaceSavedTeams(
  db: DatabaseSync,
  ladderId: string,
  agentId: number,
  packedTeams: string[],
  now = Math.floor(Date.now() / 1000)
) {
  db.prepare(
    `DELETE FROM agent_ladder_teams
     WHERE ladder_id = ? AND agent_id = ? AND status = 'saved'`
  ).run(ladderId, agentId);
  const insertTeam = db.prepare(`
    INSERT INTO agent_ladder_teams (
      agent_id, ladder_id, team_index, packed_team, status, submitted_at
    )
    VALUES (?, ?, ?, ?, 'saved', ?)
  `);
  for (let i = 0; i < packedTeams.length; i++) {
    insertTeam.run(agentId, ladderId, i + 1, packedTeams[i], now);
  }
}

export function clearSavedTeams(db: DatabaseSync, ladderId: string, agentId: number) {
  db.prepare(
    `DELETE FROM agent_ladder_teams
     WHERE ladder_id = ? AND agent_id = ? AND status = 'saved'`
  ).run(ladderId, agentId);
}

// Stages uploaded team rosters under `status = 'pending'` while the accompanying version awaits
// offline smoke testing on the Mac mini, leaving any live `'active'` roster untouched until pass.
// Any staged `'saved'` partial/complete progress for the same ladder is cleared once promoted here.
export function replacePendingTeams(
  db: DatabaseSync,
  agentId: number,
  teamsByLadder: Record<string, string[]>,
  now: number
) {
  const clearStaged = db.prepare(
    `DELETE FROM agent_ladder_teams
     WHERE ladder_id = ? AND agent_id = ? AND status IN ('saved', 'pending')`
  );
  const insertTeam = db.prepare(`
    INSERT INTO agent_ladder_teams (
      agent_id, ladder_id, team_index, packed_team, status, submitted_at
    )
    VALUES (?, ?, ?, ?, 'pending', ?)
  `);
  for (const [ladderId, packedTeams] of Object.entries(teamsByLadder)) {
    clearStaged.run(ladderId, agentId);
    for (let i = 0; i < packedTeams.length; i++) {
      insertTeam.run(agentId, ladderId, i + 1, packedTeams[i], now);
    }
  }
}

// Atomically swaps any staged `'pending'` roster into `'active'` when a submission passes smoke
// testing. If no replacement paste was uploaded with the new version, the existing `'active'`
// roster remains live unchanged.
export function promotePendingTeams(db: DatabaseSync, ladderId: string, agentId: number) {
  const hasPending = db.prepare(
    `SELECT 1 FROM agent_ladder_teams
     WHERE ladder_id = ? AND agent_id = ? AND status = 'pending'
     LIMIT 1`
  ).get(ladderId, agentId);
  if (!hasPending) return;

  db.prepare(`
    DELETE FROM agent_ladder_teams
    WHERE ladder_id = ? AND agent_id = ? AND status = 'active'
  `).run(ladderId, agentId);
  db.prepare(`
    UPDATE agent_ladder_teams
    SET status = 'active'
    WHERE ladder_id = ? AND agent_id = ? AND status = 'pending'
  `).run(ladderId, agentId);
}

export function deletePendingTeams(db: DatabaseSync, ladderIds: string[], agentId: number) {
  const del = db.prepare(`
    DELETE FROM agent_ladder_teams
    WHERE ladder_id = ? AND agent_id = ? AND status = 'pending'
  `);
  for (const ladderId of ladderIds) {
    del.run(ladderId, agentId);
  }
}

export function getTeamPoolCountsByAgent(
  db: DatabaseSync
): Map<number, Map<string, TeamPoolCounts>> {
  const rows = db.prepare(`
    SELECT agent_id, ladder_id, status, COUNT(*) AS count
    FROM agent_ladder_teams
    GROUP BY agent_id, ladder_id, status
  `).all() as Array<{
    agent_id: number;
    ladder_id: string;
    status: TeamPoolStatus;
    count: number;
  }>;

  const out = new Map<number, Map<string, TeamPoolCounts>>();
  for (const r of rows) {
    let byLadder = out.get(r.agent_id);
    if (!byLadder) {
      byLadder = new Map();
      out.set(r.agent_id, byLadder);
    }
    let counts = byLadder.get(r.ladder_id);
    if (!counts) {
      counts = {saved: 0, pending: 0, active: 0};
      byLadder.set(r.ladder_id, counts);
    }
    counts[r.status] = r.count;
  }
  return out;
}

// Restores staged `'pending'` team pastes back to `'saved'` when a developer discards a staged
// version before activation so they do not have to re-paste their VGC roster on retry.
export function revertPendingTeamsToSaved(
  db: DatabaseSync,
  ladderIds: string[],
  agentId: number
) {
  const hasPending = db.prepare(`
    SELECT 1 FROM agent_ladder_teams
    WHERE ladder_id = ? AND agent_id = ? AND status = 'pending'
    LIMIT 1
  `);
  const clearSaved = db.prepare(`
    DELETE FROM agent_ladder_teams
    WHERE ladder_id = ? AND agent_id = ? AND status = 'saved'
  `);
  const revert = db.prepare(`
    UPDATE agent_ladder_teams
    SET status = 'saved'
    WHERE ladder_id = ? AND agent_id = ? AND status = 'pending'
  `);
  for (const ladderId of ladderIds) {
    if (!hasPending.get(ladderId, agentId)) continue;
    clearSaved.run(ladderId, agentId);
    revert.run(ladderId, agentId);
  }
}

// Restores an agent's `'active'` pool back to `'saved'` when an admin wipes the agent's last
// unplayed version on a `pools` ladder, preserving validated pastes without keeping them locked.
export function revertActiveTeamsToSaved(
  db: DatabaseSync,
  ladderId: string,
  agentId: number
) {
  const hasActive = db.prepare(`
    SELECT 1 FROM agent_ladder_teams
    WHERE ladder_id = ? AND agent_id = ? AND status = 'active'
    LIMIT 1
  `).get(ladderId, agentId);
  if (!hasActive) return;
  db.prepare(`
    DELETE FROM agent_ladder_teams
    WHERE ladder_id = ? AND agent_id = ? AND status = 'saved'
  `).run(ladderId, agentId);
  db.prepare(`
    UPDATE agent_ladder_teams
    SET status = 'saved'
    WHERE ladder_id = ? AND agent_id = ? AND status = 'active'
  `).run(ladderId, agentId);
}

// Demotes an agent's `'active'` pool to `'pending'` when an admin wipes the agent's last
// `ladder_entries` version on a `pools` ladder while another `'pending'` or `'staged'` version is
// still in flight for that ladder (preserving its roster for smoke testing and activation).
export function demoteActiveTeamsToPending(
  db: DatabaseSync,
  ladderId: string,
  agentId: number
) {
  const hasActive = db.prepare(`
    SELECT 1 FROM agent_ladder_teams
    WHERE ladder_id = ? AND agent_id = ? AND status = 'active'
    LIMIT 1
  `).get(ladderId, agentId);
  if (!hasActive) return;
  const hasPending = db.prepare(`
    SELECT 1 FROM agent_ladder_teams
    WHERE ladder_id = ? AND agent_id = ? AND status = 'pending'
    LIMIT 1
  `).get(ladderId, agentId);
  if (hasPending) {
    db.prepare(`
      DELETE FROM agent_ladder_teams
      WHERE ladder_id = ? AND agent_id = ? AND status = 'active'
    `).run(ladderId, agentId);
    return;
  }
  db.prepare(`
    UPDATE agent_ladder_teams
    SET status = 'pending'
    WHERE ladder_id = ? AND agent_id = ? AND status = 'active'
  `).run(ladderId, agentId);
}
