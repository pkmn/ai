import {DatabaseSync} from 'node:sqlite';

import {TransactionRunner} from './index';

export type SmogonStanding = 'good' | 'bad' | 'missing' | 'unknown';

export interface DeveloperRow {
  id: number;
  agentId: number;
  githubId?: number;
  githubLogin: string;
  smogonId: number;
  smogonUsername: string;
  smogonStanding: SmogonStanding;
  discordId?: string;
  discordUsername?: string;
  verifiedAt?: number;
  createdAt: number;
}

export interface ResolvedProjectOwner {
  github: string;
  smogonId: number;
  smogonUsername: string;
  smogonStanding?: SmogonStanding;
}

interface RawDeveloperRow {
  id: number;
  agent_id: number;
  github_id: number | null;
  github_login: string;
  smogon_id: number;
  smogon_username: string;
  smogon_standing: SmogonStanding;
  discord_id: string | null;
  discord_username: string | null;
  verified_at: number | null;
  created_at: number;
}

function mapDeveloperRow(raw: RawDeveloperRow): DeveloperRow {
  return {
    id: raw.id,
    agentId: raw.agent_id,
    githubId: raw.github_id ?? undefined,
    githubLogin: raw.github_login,
    smogonId: raw.smogon_id,
    smogonUsername: raw.smogon_username,
    smogonStanding: raw.smogon_standing,
    discordId: raw.discord_id ?? undefined,
    discordUsername: raw.discord_username ?? undefined,
    verifiedAt: raw.verified_at ?? undefined,
    createdAt: raw.created_at,
  };
}

export function getDeveloperByGitHub(
  db: DatabaseSync,
  githubLogin: string
): DeveloperRow | undefined {
  const raw = db.prepare('SELECT * FROM developers WHERE github_login = ?')
    .get(githubLogin.trim().toLowerCase()) as unknown as RawDeveloperRow | undefined;
  return raw ? mapDeveloperRow(raw) : undefined;
}

export function getDeveloperByGitHubId(
  db: DatabaseSync,
  githubId: number
): DeveloperRow | undefined {
  const raw = db.prepare('SELECT * FROM developers WHERE github_id = ?')
    .get(githubId) as unknown as RawDeveloperRow | undefined;
  return raw ? mapDeveloperRow(raw) : undefined;
}

export function getDeveloperByDiscordId(
  db: DatabaseSync,
  discordId: string
): DeveloperRow | undefined {
  const raw = db.prepare('SELECT * FROM developers WHERE discord_id = ?')
    .get(discordId.trim()) as unknown as RawDeveloperRow | undefined;
  return raw ? mapDeveloperRow(raw) : undefined;
}

export function getDevelopersForAgent(db: DatabaseSync, agentId: number): DeveloperRow[] {
  const rows = db.prepare(
    'SELECT * FROM developers WHERE agent_id = ? ORDER BY github_login ASC'
  ).all(agentId) as unknown as RawDeveloperRow[];
  return rows.map(mapDeveloperRow);
}

// Returns Discord Snowflakes of all owners belonging to qualified Arena agents so
// `server/discord.ts` can synchronize the @Arena Competitor role.
export function getCompetitorDiscordIds(db: DatabaseSync): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT d.discord_id
    FROM developers d
    JOIN agents a ON a.id = d.agent_id
    WHERE a.status = 'qualified'
      AND d.discord_id IS NOT NULL
    ORDER BY d.discord_id ASC
  `).all() as Array<{discord_id: string}>;
  return rows.map(r => r.discord_id);
}

export function linkDeveloperGitHubId(
  db: DatabaseSync,
  githubLogin: string,
  githubId: number,
  now = Math.floor(Date.now() / 1000)
): boolean {
  const cleanLogin = githubLogin.trim().toLowerCase();
  const existing = getDeveloperByGitHub(db, cleanLogin);
  if (existing?.githubId !== undefined && existing.githubId !== githubId) {
    return false;
  }
  db.prepare(
    `UPDATE developers
     SET github_id = ?, verified_at = ?
     WHERE github_login = ? AND (github_id IS NULL OR github_id = ?)`
  ).run(githubId, now, cleanLogin, githubId);
  return true;
}

// Enforces global uniqueness of Discord accounts across developers so one person cannot link the
// same Discord identity to multiple Arena projects.
export function linkDeveloperDiscord(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  githubLogin: string,
  discordId: string,
  discordUsername: string,
  now = Math.floor(Date.now() / 1000)
) {
  const cleanLogin = githubLogin.trim().toLowerCase();
  const cleanDiscordId = discordId.trim();
  inTransaction(() => {
    const existing = getDeveloperByDiscordId(db, cleanDiscordId);
    if (existing && existing.githubLogin !== cleanLogin) {
      throw new Error(
        `Discord account @${discordUsername} is already linked to another developer`
      );
    }

    db.prepare(
      `UPDATE developers
       SET discord_id = ?, discord_username = ?, verified_at = ?
       WHERE github_login = ?`
    ).run(cleanDiscordId, discordUsername, now, cleanLogin);
  });
}

export function unlinkDeveloperDiscord(
  db: DatabaseSync,
  githubLogin: string,
  now = Math.floor(Date.now() / 1000)
) {
  db.prepare(
    `UPDATE developers
     SET discord_id = NULL, discord_username = NULL, verified_at = ?
     WHERE github_login = ?`
  ).run(now, githubLogin.trim().toLowerCase());
}

export function getDeveloperBySmogonId(
  db: DatabaseSync,
  smogonId: number
): DeveloperRow | undefined {
  const raw = db.prepare('SELECT * FROM developers WHERE smogon_id = ?')
    .get(smogonId) as unknown as RawDeveloperRow | undefined;
  return raw ? mapDeveloperRow(raw) : undefined;
}

export function pruneInactiveDevelopers(
  db: DatabaseSync,
  activeGitHubs: Set<string>,
  activeSmogonIds: Set<number> = new Set()
) {
  const allDevs = db.prepare('SELECT id, github_login, smogon_id FROM developers')
    .all() as Array<{id: number; github_login: string; smogon_id: number}>;
  const deleteDevById = db.prepare('DELETE FROM developers WHERE id = ?');
  for (const dev of allDevs) {
    if (!activeGitHubs.has(dev.github_login.toLowerCase()) && !activeSmogonIds.has(dev.smogon_id)) {
      deleteDevById.run(dev.id);
    }
  }
}

// Updates project ownership from `projects.yml` in-place (matching by `github_login` or immutable
// `smogon_id`) so reassigning a developer (`Project A -> Project B -> Project A`) or renaming a
// GitHub handle preserves `developers.id`, OAuth-bound `github_id` / `discord_id`, and historical
// `agent_versions.developer_id` audit pointers.
export function upsertProjectDevelopers(
  db: DatabaseSync,
  agentId: number,
  owners: ResolvedProjectOwner[],
  now: number
) {
  const selectByGitHub = db.prepare('SELECT id FROM developers WHERE github_login = ?');
  const selectBySmogon = db.prepare('SELECT id FROM developers WHERE smogon_id = ?');
  const updateDev = db.prepare(`
    UPDATE developers
    SET agent_id = ?,
        github_login = ?,
        smogon_id = ?,
        smogon_username = ?,
        smogon_standing = COALESCE(?, smogon_standing),
        verified_at = CASE WHEN ? IS NOT NULL THEN ? ELSE verified_at END
    WHERE id = ?
  `);
  const insertDev = db.prepare(`
    INSERT INTO developers (
      agent_id, github_login, smogon_id, smogon_username, smogon_standing, verified_at, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const owner of owners) {
    const cleanGithub = owner.github.trim().toLowerCase();
    const existing = (selectByGitHub.get(cleanGithub) as {id: number} | undefined) ??
      (selectBySmogon.get(owner.smogonId) as {id: number} | undefined);
    if (existing) {
      updateDev.run(
        agentId,
        cleanGithub,
        owner.smogonId,
        owner.smogonUsername,
        owner.smogonStanding ?? null,
        owner.smogonStanding ?? null,
        now,
        existing.id
      );
    } else {
      insertDev.run(
        agentId,
        cleanGithub,
        owner.smogonId,
        owner.smogonUsername,
        owner.smogonStanding ?? 'unknown',
        owner.smogonStanding ? now : null,
        now
      );
    }
  }
}

export function setDeveloperSmogonStanding(
  db: DatabaseSync,
  developerId: number,
  standing: SmogonStanding,
  now = Math.floor(Date.now() / 1000)
) {
  db.prepare(
    'UPDATE developers SET smogon_standing = ?, verified_at = ? WHERE id = ?'
  ).run(standing, now, developerId);
}

export function deleteDevelopersForAgent(db: DatabaseSync, agentId: number) {
  db.prepare('DELETE FROM developers WHERE agent_id = ?').run(agentId);
}
