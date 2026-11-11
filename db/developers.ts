import type {DatabaseSync} from 'node:sqlite';

import type {TransactionRunner} from './index';

export interface DeveloperRow {
  id: number;
  bot_id: number;
  github_login: string;
  github_id: number | null;
  smogon_id: number;
  smogon_username: string;
  discord_id: string | null;
  discord_username: string | null;
  updated_at: number;
}

export interface ResolvedProjectOwner {
  github: string;
  smogonId: number;
  smogonUsername: string;
}

export function getDeveloperByGitHub(
  db: DatabaseSync,
  githubLogin: string
): DeveloperRow | undefined {
  return db.prepare('SELECT * FROM developers WHERE github_login = ?')
    .get(githubLogin.trim().toLowerCase()) as unknown as DeveloperRow | undefined;
}

export function getDeveloperByDiscordId(
  db: DatabaseSync,
  discordId: string
): DeveloperRow | undefined {
  return db.prepare('SELECT * FROM developers WHERE discord_id = ?')
    .get(discordId.trim()) as unknown as DeveloperRow | undefined;
}

export function getDevelopersForBot(db: DatabaseSync, botId: number): DeveloperRow[] {
  return db.prepare(
    'SELECT * FROM developers WHERE bot_id = ? ORDER BY github_login ASC'
  ).all(botId) as unknown as DeveloperRow[];
}

export function linkDeveloperGitHubId(
  db: DatabaseSync,
  githubLogin: string,
  githubId: number,
  now = Math.floor(Date.now() / 1000)
) {
  db.prepare(
    'UPDATE developers SET github_id = ?, updated_at = ? WHERE github_login = ?'
  ).run(githubId, now, githubLogin.trim().toLowerCase());
}

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
    if (existing && existing.github_login !== cleanLogin) {
      throw new Error(
        `Discord account @${discordUsername} is already linked to another developer`
      );
    }

    db.prepare(
      `UPDATE developers
       SET discord_id = ?, discord_username = ?, updated_at = ?
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
     SET discord_id = NULL, discord_username = NULL, updated_at = ?
     WHERE github_login = ?`
  ).run(now, githubLogin.trim().toLowerCase());
}

export function pruneInactiveDevelopers(db: DatabaseSync, activeGitHubs: Set<string>) {
  const allDevs = db.prepare('SELECT id, github_login FROM developers')
    .all() as Array<{id: number; github_login: string}>;
  const deleteDevById = db.prepare('DELETE FROM developers WHERE id = ?');
  for (const dev of allDevs) {
    if (!activeGitHubs.has(dev.github_login)) {
      deleteDevById.run(dev.id);
    }
  }
}

export function upsertProjectDevelopers(
  db: DatabaseSync,
  botId: number,
  owners: ResolvedProjectOwner[],
  now: number
) {
  const selectExistingDev = db.prepare('SELECT id FROM developers WHERE github_login = ?');
  const updateDev = db.prepare(`
    UPDATE developers
    SET bot_id = ?, smogon_id = ?, smogon_username = ?, updated_at = ?
    WHERE id = ?
  `);
  const insertDev = db.prepare(`
    INSERT INTO developers (bot_id, github_login, smogon_id, smogon_username, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const owner of owners) {
    const existing = selectExistingDev.get(owner.github) as {id: number} | undefined;
    if (existing) {
      updateDev.run(botId, owner.smogonId, owner.smogonUsername, now, existing.id);
    } else {
      insertDev.run(botId, owner.github, owner.smogonId, owner.smogonUsername, now);
    }
  }
}

export function deleteDevelopersForBot(db: DatabaseSync, botId: number) {
  db.prepare('DELETE FROM developers WHERE bot_id = ?').run(botId);
}
