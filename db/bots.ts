import * as fs from 'fs';
import type {DatabaseSync} from 'node:sqlite';
import * as path from 'path';

import * as yaml from 'yaml';

import {
  type SmogonUser,
  lookupSmogonUser,
  parseSmogonIdentifier,
} from '../server/smogon';
import type {Project} from '../static/projects';
import {root, slugify} from '../static/util';

import {
  type ResolvedProjectOwner,
  deleteDevelopersForBot,
  getDeveloperByGitHub,
  pruneInactiveDevelopers,
  upsertProjectDevelopers,
} from './developers';

import type {TransactionRunner} from './index';

export type BotStatus = 'pending' | 'qualified' | 'disabled';

export const PROJECTS_FILE = root('static', 'projects.yml');
export const AVATARS_DIR = root('static', 'avatars');

export interface BotRow {
  id: number;
  slug: string;
  name: string;
  logo_file: string | null;
  status: BotStatus;
  cooldown_refunded_at: number | null;
  updated_at: number;
}

export interface RawProjectOwner {
  github: string;
  rawSmogon: string | number;
  smogonId?: number;
  smogonUsername?: string;
}

export interface ParsedArenaProject<Owner = RawProjectOwner> {
  slug: string;
  name: string;
  logoFile: string | null;
  qualified: boolean;
  owners: Owner[];
}

export interface SyncProjectsOptions {
  avatarsDir?: string;
  smogonToken?: string;
  lookupSmogon?: (raw: string | number, token?: string) => Promise<SmogonUser>;
  refreshSmogonNames?: boolean;
  now?: number;
}

export function extractProjectOwners(
  arena: NonNullable<Project['arena']>
): RawProjectOwner[] {
  const out: RawProjectOwner[] = [];
  const seen = new Set<string>();

  if (!arena.owners || typeof arena.owners !== 'object' || Array.isArray(arena.owners)) {
    return out;
  }
  for (const [ghRaw, smogonRaw] of Object.entries(arena.owners)) {
    const github = ghRaw.trim().toLowerCase();
    if (!github || smogonRaw === undefined || smogonRaw === null || smogonRaw === '') {
      throw new Error(`Invalid owner mapping "${ghRaw}: ${String(smogonRaw)}"`);
    }
    if (seen.has(github)) continue;
    seen.add(github);
    const parsed = parseSmogonIdentifier(smogonRaw);
    out.push({
      github,
      rawSmogon: smogonRaw,
      smogonId: parsed.id,
      smogonUsername: parsed.username,
    });
  }
  return out;
}

export function parseArenaProjects(
  projectsYaml: string,
  avatarsDir = AVATARS_DIR
): ParsedArenaProject[] {
  const entries = (yaml.parse(projectsYaml) ?? []) as Project[];
  if (!Array.isArray(entries)) {
    throw new Error('projects.yml must parse to a YAML array');
  }

  const seenSlugs = new Set<string>();
  const githubOwner = new Map<string, string>();
  const smogonIdOwner = new Map<number, string>();
  const smogonNameOwner = new Map<string, string>();
  const parsed: ParsedArenaProject[] = [];

  for (const entry of entries) {
    if (!entry?.arena) continue;
    const name = entry.name?.trim();
    if (!name) {
      throw new Error('Arena project entry is missing required "name"');
    }
    const slug = slugify(name).toLowerCase();
    if (!slug) {
      throw new Error(`Invalid arena project slug derived from "${name}"`);
    }
    if (seenSlugs.has(slug)) {
      throw new Error(`Duplicate arena project slug "${slug}" ("${name}")`);
    }
    seenSlugs.add(slug);

    const owners = extractProjectOwners(entry.arena);
    if (!owners.length) {
      throw new Error(`Arena project "${name}" must list at least one owner`);
    }

    for (const owner of owners) {
      const prevGh = githubOwner.get(owner.github);
      if (prevGh) {
        throw new Error(
          `GitHub owner "${owner.github}" is assigned to both "${prevGh}" and "${name}"`
        );
      }
      githubOwner.set(owner.github, name);

      if (owner.smogonId !== undefined) {
        const prevId = smogonIdOwner.get(owner.smogonId);
        if (prevId) {
          throw new Error(
            `Smogon ID ${owner.smogonId} is assigned to both "${prevId}" and "${name}"`
          );
        }
        smogonIdOwner.set(owner.smogonId, name);
      } else if (owner.smogonUsername) {
        const key = owner.smogonUsername.toLowerCase();
        const prevName = smogonNameOwner.get(key);
        if (prevName) {
          throw new Error(
            `Smogon account "${owner.smogonUsername}" is assigned ` +
            `to both "${prevName}" and "${name}"`
          );
        }
        smogonNameOwner.set(key, name);
      }
    }

    let logoFile: string | null = null;
    if (entry.arena.logo?.trim()) {
      logoFile = entry.arena.logo.trim();
    } else if (avatarsDir && fs.existsSync(path.join(avatarsDir, `${slug}.png`))) {
      logoFile = `${slug}.png`;
    }

    parsed.push({
      slug,
      name,
      logoFile,
      qualified: Boolean(entry.arena.qualified),
      owners,
    });
  }

  return parsed;
}

function validateUniqueSmogonIds(projects: Array<ParsedArenaProject<ResolvedProjectOwner>>) {
  const smogonIdOwner = new Map<number, string>();
  for (const proj of projects) {
    for (const owner of proj.owners) {
      const prev = smogonIdOwner.get(owner.smogonId);
      if (prev) {
        throw new Error(
          `Smogon ID ${owner.smogonId} ("${owner.smogonUsername}") ` +
          `is assigned to both "${prev}" and "${proj.name}"`
        );
      }
      smogonIdOwner.set(owner.smogonId, proj.name);
    }
  }
}

function applyResolvedProjects(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  projects: Array<ParsedArenaProject<ResolvedProjectOwner>>,
  now: number
) {
  validateUniqueSmogonIds(projects);

  const upsertBot = db.prepare(`
    INSERT INTO bots (slug, name, logo_file, status, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      logo_file = excluded.logo_file,
      status = excluded.status,
      updated_at = excluded.updated_at
  `);
  const selectBotId = db.prepare('SELECT id FROM bots WHERE slug = ?');
  const selectAllBots = db.prepare('SELECT id, slug FROM bots');
  const disableBot = db.prepare("UPDATE bots SET status = 'disabled', updated_at = ? WHERE id = ?");

  inTransaction(() => {
    const activeSlugs = new Set<string>();
    const activeGitHubs = new Set<string>();

    for (const proj of projects) {
      activeSlugs.add(proj.slug);
      for (const owner of proj.owners) activeGitHubs.add(owner.github);
    }

    pruneInactiveDevelopers(db, activeGitHubs);

    for (const proj of projects) {
      const botStatus: BotStatus = proj.qualified ? 'qualified' : 'pending';
      upsertBot.run(proj.slug, proj.name, proj.logoFile, botStatus, now);
      const bot = selectBotId.get(proj.slug) as {id: number};
      upsertProjectDevelopers(db, bot.id, proj.owners, now);
    }

    const allBots = selectAllBots.all() as Array<{id: number; slug: string}>;
    for (const bot of allBots) {
      if (!activeSlugs.has(bot.slug)) {
        disableBot.run(now, bot.id);
        deleteDevelopersForBot(db, bot.id);
      }
    }
  });
}

export function syncProjectsFromYaml(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  projectsYaml: string,
  avatarsDir = AVATARS_DIR,
  now = Math.floor(Date.now() / 1000)
) {
  const rawProjects = parseArenaProjects(projectsYaml, avatarsDir);
  const resolved: Array<ParsedArenaProject<ResolvedProjectOwner>> = rawProjects.map(proj => ({
    slug: proj.slug,
    name: proj.name,
    logoFile: proj.logoFile,
    qualified: proj.qualified,
    owners: proj.owners.map(owner => {
      if (owner.smogonId !== undefined) {
        const existing = getDeveloperByGitHub(db, owner.github);
        const smogonUsername = owner.smogonUsername ??
          (existing?.smogon_id === owner.smogonId ? existing.smogon_username : undefined) ??
          String(owner.smogonId);
        return {github: owner.github, smogonId: owner.smogonId, smogonUsername};
      }

      const existing = getDeveloperByGitHub(db, owner.github);
      if (existing) {
        return {
          github: owner.github,
          smogonId: existing.smogon_id,
          smogonUsername: existing.smogon_username,
        };
      }

      throw new Error(
        `Smogon account "${String(owner.rawSmogon)}" for GitHub owner "${owner.github}" ` +
        'has no numerical ID; pass <name>.<id> / <id> or use syncProjectsWithSmogon()'
      );
    }),
  }));

  applyResolvedProjects(db, inTransaction, resolved, now);
}

export function syncProjects(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  file = PROJECTS_FILE,
  avatarsDir = AVATARS_DIR,
  now = Math.floor(Date.now() / 1000)
) {
  if (!fs.existsSync(file)) return;
  syncProjectsFromYaml(db, inTransaction, fs.readFileSync(file, 'utf8'), avatarsDir, now);
}

export async function syncProjectsFromYamlWithSmogon(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  projectsYaml: string,
  options: SyncProjectsOptions = {}
) {
  const avatarsDir = options.avatarsDir ?? AVATARS_DIR;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const smogonToken = options.smogonToken ?? process.env.SMOGON_TOKEN;
  const lookup = options.lookupSmogon ?? lookupSmogonUser;
  const refreshNames = options.refreshSmogonNames ?? Boolean(smogonToken || options.lookupSmogon);

  const rawProjects = parseArenaProjects(projectsYaml, avatarsDir);
  const resolved: Array<ParsedArenaProject<ResolvedProjectOwner>> = [];

  for (const proj of rawProjects) {
    const owners: ResolvedProjectOwner[] = [];
    for (const owner of proj.owners) {
      const existing = getDeveloperByGitHub(db, owner.github);

      if (owner.smogonId !== undefined) {
        if (refreshNames && (smogonToken || options.lookupSmogon)) {
          const profile = await lookup(owner.smogonId, smogonToken);
          if (profile.banned) {
            throw new Error(`Smogon account "${profile.username}" (${profile.id}) is banned`);
          }
          owners.push({
            github: owner.github,
            smogonId: profile.id,
            smogonUsername: profile.username,
          });
        } else {
          const smogonUsername = owner.smogonUsername ??
            (existing?.smogon_id === owner.smogonId ? existing.smogon_username : undefined) ??
            String(owner.smogonId);
          owners.push({github: owner.github, smogonId: owner.smogonId, smogonUsername});
        }
        continue;
      }

      if (existing && refreshNames && (smogonToken || options.lookupSmogon)) {
        const profile = await lookup(existing.smogon_id, smogonToken);
        if (profile.banned) {
          throw new Error(`Smogon account "${profile.username}" (${profile.id}) is banned`);
        }
        owners.push({
          github: owner.github,
          smogonId: profile.id,
          smogonUsername: profile.username,
        });
        continue;
      }

      if (existing && !smogonToken && !options.lookupSmogon) {
        owners.push({
          github: owner.github,
          smogonId: existing.smogon_id,
          smogonUsername: existing.smogon_username,
        });
        continue;
      }

      const profile = await lookup(owner.rawSmogon, smogonToken);
      if (profile.banned) {
        throw new Error(`Smogon account "${profile.username}" (${profile.id}) is banned`);
      }
      owners.push({
        github: owner.github,
        smogonId: profile.id,
        smogonUsername: profile.username,
      });
    }

    resolved.push({
      slug: proj.slug,
      name: proj.name,
      logoFile: proj.logoFile,
      qualified: proj.qualified,
      owners,
    });
  }

  applyResolvedProjects(db, inTransaction, resolved, now);
}

export async function syncProjectsWithSmogon(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  file = PROJECTS_FILE,
  options: SyncProjectsOptions = {}
) {
  if (!fs.existsSync(file)) return;
  await syncProjectsFromYamlWithSmogon(
    db,
    inTransaction,
    fs.readFileSync(file, 'utf8'),
    options
  );
}

export function getBotBySlug(db: DatabaseSync, slug: string): BotRow | undefined {
  return db.prepare('SELECT * FROM bots WHERE slug = ?')
    .get(slug.toLowerCase()) as unknown as BotRow | undefined;
}

export function getBotById(db: DatabaseSync, id: number): BotRow | undefined {
  return db.prepare('SELECT * FROM bots WHERE id = ?')
    .get(id) as unknown as BotRow | undefined;
}

export function refundCooldown(
  db: DatabaseSync,
  botSlug: string,
  now = Math.floor(Date.now() / 1000)
): BotRow {
  const bot = getBotBySlug(db, botSlug);
  if (!bot) throw new Error(`Bot "${botSlug}" not found`);
  db.prepare('UPDATE bots SET cooldown_refunded_at = ?, updated_at = ? WHERE id = ?')
    .run(now, now, bot.id);
  return getBotById(db, bot.id)!;
}
