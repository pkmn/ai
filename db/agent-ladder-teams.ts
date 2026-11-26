import {DatabaseSync} from 'node:sqlite';

import {getAgentBySlug} from './agents';
import {getLadder} from './ladders';

import {TransactionRunner} from './index';

export type TeamPoolStatus = 'saved' | 'pending' | 'active';

export interface TeamPoolCounts {
  saved: number;
  pending: number;
  active: number;
}

export interface WipeSavedTeamsResult {
  agentId: number;
  agentSlug: string;
  ladderId: string;
  ladderName: string;
  wipedCount: number;
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

// Returns `(agentId -> Set<ladderId>)` for saved `pools` rosters that are safe to wipe:
// strictly on an `'upcoming'` ladder with zero played matches, no `'active'` or `'pending'`
// teams, no enrolled `ladder_entries`, and no in-flight `'pending'`/`'staged'` versions
// targeting that ladder.
export function getWipeableSavedPools(db: DatabaseSync): Map<number, Set<string>> {
  const rows = db.prepare(`
    SELECT DISTINCT alt.agent_id, alt.ladder_id
    FROM agent_ladder_teams alt
    JOIN ladders l ON l.id = alt.ladder_id
    WHERE alt.status = 'saved'
      AND l.team = 'pools'
      AND l.status = 'upcoming'
      AND NOT EXISTS (
        SELECT 1 FROM matches m WHERE m.ladder_id = l.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM agent_ladder_teams other
        WHERE other.agent_id = alt.agent_id
          AND other.ladder_id = alt.ladder_id
          AND other.status IN ('pending', 'active')
      )
      AND NOT EXISTS (
        SELECT 1 FROM ladder_entries le
        JOIN agent_versions av ON av.id = le.version_id
        WHERE le.ladder_id = alt.ladder_id
          AND av.agent_id = alt.agent_id
      )
  `).all() as Array<{agent_id: number; ladder_id: string}>;

  const inFlightByAgent = new Map<number, Set<string>>();
  const inFlightRows = db.prepare(`
    SELECT agent_id, ladders_json
    FROM agent_versions
    WHERE smoke_status IN ('pending', 'staged')
      AND ladders_json != '[]'
  `).all() as Array<{agent_id: number; ladders_json: string}>;
  for (const r of inFlightRows) {
    let set = inFlightByAgent.get(r.agent_id);
    if (!set) {
      set = new Set();
      inFlightByAgent.set(r.agent_id, set);
    }
    for (const lid of JSON.parse(r.ladders_json) as string[]) {
      set.add(lid);
    }
  }

  const out = new Map<number, Set<string>>();
  for (const r of rows) {
    if (inFlightByAgent.get(r.agent_id)?.has(r.ladder_id)) continue;
    let set = out.get(r.agent_id);
    if (!set) {
      set = new Set();
      out.set(r.agent_id, set);
    }
    set.add(r.ladder_id);
  }
  return out;
}

// Permanently deletes an agent's `'saved'` team pool on an `'upcoming'` `pools` ladder when
// doing so cannot affect any other competitor, active/in-flight submission, or played match.
export function wipeSavedTeams(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  agentSlug: string,
  ladderId: string
): WipeSavedTeamsResult {
  return inTransaction(() => {
    const agent = getAgentBySlug(db, agentSlug);
    if (!agent) {
      throw Object.assign(new Error(`Agent "${agentSlug}" not found.`), {status: 404});
    }
    const ladder = getLadder(db, ladderId);
    if (!ladder) {
      throw Object.assign(new Error(`Unknown ladder "${ladderId}".`), {status: 404});
    }
    if (ladder.team !== 'pools') {
      throw Object.assign(
        new Error(`Ladder "${ladder.name}" does not use competitor team pools.`),
        {status: 400}
      );
    }
    if (ladder.status !== 'upcoming') {
      throw Object.assign(
        new Error(
          `Ladder "${ladder.name}" is ${ladder.status}; ` +
          'saved teams can only be wiped on an upcoming ladder.'
        ),
        {status: 409}
      );
    }
    const hasMatch = db.prepare(
      'SELECT 1 FROM matches WHERE ladder_id = ? LIMIT 1'
    ).get(ladder.id);
    if (hasMatch) {
      throw Object.assign(
        new Error(`Ladder "${ladder.name}" has played matches and teams cannot be wiped.`),
        {status: 409}
      );
    }

    const countRows = db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM agent_ladder_teams
      WHERE agent_id = ? AND ladder_id = ?
      GROUP BY status
    `).all(agent.id, ladder.id) as Array<{status: TeamPoolStatus; count: number}>;
    const counts: TeamPoolCounts = {saved: 0, pending: 0, active: 0};
    for (const r of countRows) counts[r.status] = r.count;

    if (counts.active > 0) {
      throw Object.assign(
        new Error(
          `${agent.name} has an active team pool on ${ladder.name}; ` +
          'wipe its unplayed version first.'
        ),
        {status: 409}
      );
    }
    if (counts.pending > 0) {
      throw Object.assign(
        new Error(
          `${agent.name} has a pending team pool on ${ladder.name}; ` +
          'discard or wipe the in-flight version first.'
        ),
        {status: 409}
      );
    }
    const hasEntry = db.prepare(`
      SELECT 1 FROM ladder_entries le
      JOIN agent_versions av ON av.id = le.version_id
      WHERE le.ladder_id = ? AND av.agent_id = ?
      LIMIT 1
    `).get(ladder.id, agent.id);
    if (hasEntry) {
      throw Object.assign(
        new Error(
          `${agent.name} is enrolled on ${ladder.name}; wipe its unplayed version first.`
        ),
        {status: 409}
      );
    }
    const inFlightRows = db.prepare(`
      SELECT ladders_json FROM agent_versions
      WHERE agent_id = ? AND smoke_status IN ('pending', 'staged') AND ladders_json != '[]'
    `).all(agent.id) as Array<{ladders_json: string}>;
    for (const r of inFlightRows) {
      if ((JSON.parse(r.ladders_json) as string[]).includes(ladder.id)) {
        throw Object.assign(
          new Error(
            `${agent.name} has a pending or staged submission for ${ladder.name}; ` +
            'discard or wipe it first.'
          ),
          {status: 409}
        );
      }
    }
    if (counts.saved === 0) {
      throw Object.assign(
        new Error(`No saved teams for "${agent.slug}" on ${ladder.name}.`),
        {status: 404}
      );
    }

    db.prepare(`
      DELETE FROM agent_ladder_teams
      WHERE ladder_id = ? AND agent_id = ? AND status = 'saved'
    `).run(ladder.id, agent.id);

    return {
      agentId: agent.id,
      agentSlug: agent.slug,
      ladderId: ladder.id,
      ladderName: ladder.name,
      wipedCount: counts.saved,
    };
  });
}
