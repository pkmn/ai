import {DatabaseSync} from 'node:sqlite';

import {AgentRow, getAgentById, getAgentBySlug} from './agents';
import {LadderSlot, SLOTS, SLOT_ORDER_SQL} from './ladders';

import {TransactionRunner} from './index';

export const ALL_SLOTS: readonly LadderSlot[] = ['rby', 'adv', 'sv', 'rand', 'vgc'];

export interface AgentLadderRow {
  agentId: number;
  slot: LadderSlot;
  updatedAt: number;
}

export interface SetAgentLaddersResult {
  agent: AgentRow;
  slots: LadderSlot[];
}

export function normalizeLadderSlot(raw: string): LadderSlot {
  const slot = raw.trim().toLowerCase() as LadderSlot;
  if (!SLOTS.has(slot)) {
    throw new Error(
      `Unknown ladder slot "${raw}" (expected one of: ${ALL_SLOTS.join(', ')})`
    );
  }
  return slot;
}

export function parseLadderSlotTokens(rawTokens: Iterable<string>): LadderSlot[] {
  const tokens: string[] = [];
  for (const raw of rawTokens) {
    for (const part of raw.split(',')) {
      const clean = part.trim().toLowerCase();
      if (clean) tokens.push(clean);
    }
  }
  if (tokens.includes('none')) {
    if (tokens.length > 1) {
      throw new Error('Cannot combine "none" with other ladder slots');
    }
    return [];
  }
  if (tokens.includes('all')) {
    if (tokens.length > 1) {
      throw new Error('Cannot combine "all" with other ladder slots');
    }
    return [...ALL_SLOTS];
  }
  return tokens.map(t => normalizeLadderSlot(t));
}

export function getAgentLadders(db: DatabaseSync, agentId: number): LadderSlot[] {
  const rows = db.prepare(`
    SELECT al.slot
    FROM agent_ladders al
    JOIN agents a ON a.id = al.agent_id
    WHERE al.agent_id = ? AND a.status != 'disabled'
    ORDER BY ${SLOT_ORDER_SQL} ASC
  `).all(agentId) as Array<{slot: LadderSlot}>;
  return rows.map(r => r.slot);
}

export function getAgentLaddersByAgent(db: DatabaseSync): Map<number, LadderSlot[]> {
  const rows = db.prepare(`
    SELECT al.agent_id, al.slot
    FROM agent_ladders al
    JOIN agents a ON a.id = al.agent_id
    WHERE a.status != 'disabled'
    ORDER BY al.agent_id ASC, ${SLOT_ORDER_SQL} ASC
  `).all() as Array<{agent_id: number; slot: LadderSlot}>;
  const out = new Map<number, LadderSlot[]>();
  for (const row of rows) {
    let list = out.get(row.agent_id);
    if (!list) {
      list = [];
      out.set(row.agent_id, list);
    }
    list.push(row.slot);
  }
  return out;
}

export function isAgentQualifiedForSlot(
  db: DatabaseSync,
  agentId: number,
  slot: LadderSlot
): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM agent_ladders al
    JOIN agents a ON a.id = al.agent_id
    WHERE al.agent_id = ? AND al.slot = ? AND a.status != 'disabled'
    LIMIT 1
  `).get(agentId, slot);
  return Boolean(row);
}

export function deleteAgentLadders(db: DatabaseSync, agentId: number): void {
  db.prepare('DELETE FROM agent_ladders WHERE agent_id = ?').run(agentId);
}

function resolveAgent(db: DatabaseSync, agentSlugOrId: string | number): AgentRow {
  const agent = typeof agentSlugOrId === 'number'
    ? getAgentById(db, agentSlugOrId)
    : getAgentBySlug(db, agentSlugOrId);
  if (!agent) {
    throw new Error(`Agent "${String(agentSlugOrId)}" not found`);
  }
  if (agent.status === 'disabled') {
    throw new Error(`Agent "${agent.slug}" is disabled`);
  }
  return agent;
}

// Replaces an agent's qualified ladder slots without retiring existing active entries (revoking a
// slot only blocks future submissions to that ladder). Syncs `agents.status` so downstream readers
// (Discord @Arena Competitor role, profile pages, submission gating) stay consistent.
export function setAgentLadders(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  agentSlugOrId: string | number,
  slots: Iterable<LadderSlot>,
  now = Math.floor(Date.now() / 1000)
): SetAgentLaddersResult {
  const unique = new Set<LadderSlot>();
  for (const raw of slots) {
    unique.add(normalizeLadderSlot(raw));
  }

  return inTransaction(() => {
    const agent = resolveAgent(db, agentSlugOrId);
    const existing = new Set(getAgentLadders(db, agent.id));

    const delStmt = db.prepare(
      'DELETE FROM agent_ladders WHERE agent_id = ? AND slot = ?'
    );
    const insStmt = db.prepare(
      'INSERT OR IGNORE INTO agent_ladders (agent_id, slot, updated_at) VALUES (?, ?, ?)'
    );

    for (const prev of existing) {
      if (!unique.has(prev)) delStmt.run(agent.id, prev);
    }
    for (const next of unique) {
      if (!existing.has(next)) insStmt.run(agent.id, next, now);
    }

    const nextStatus = unique.size > 0 ? 'qualified' : 'pending';
    db.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?')
      .run(nextStatus, now, agent.id);

    return {
      agent: getAgentById(db, agent.id)!,
      slots: getAgentLadders(db, agent.id),
    };
  });
}

export function setAgentLadder(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  agentSlugOrId: string | number,
  slot: LadderSlot,
  qualified: boolean,
  now = Math.floor(Date.now() / 1000)
): SetAgentLaddersResult {
  const cleanSlot = normalizeLadderSlot(slot);
  return inTransaction(() => {
    const agent = resolveAgent(db, agentSlugOrId);
    const current = new Set(getAgentLadders(db, agent.id));
    if (qualified) {
      current.add(cleanSlot);
    } else {
      current.delete(cleanSlot);
    }
    return setAgentLadders(db, inTransaction, agent.id, current, now);
  });
}
