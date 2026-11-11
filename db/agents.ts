import * as fs from 'fs';
import {DatabaseSync} from 'node:sqlite';
import * as path from 'path';

import * as yaml from 'yaml';

import * as smogon from '../server/smogon';
import {Project} from '../static/projects';
import {root, slugify} from '../static/util';

import * as developers from './developers';

import {TransactionRunner} from './index';

export type AgentStatus = 'pending' | 'qualified' | 'disabled';

export const PROJECTS_FILE = root('static', 'projects.yml');
export const AVATARS_DIR = root('static', 'avatars');

export interface AgentRow {
  id: number;
  slug: string;
  name: string;
  logo?: string;
  status: AgentStatus;
  cooldownRefundedAt?: number;
  updatedAt: number;
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
  logo?: string;
  qualified: boolean;
  owners: Owner[];
}

export interface SyncProjectsOptions {
  avatarsDir?: string;
  smogonToken?: string;
  lookupSmogon?: (raw: string | number, token?: string) => Promise<smogon.User>;
  refreshSmogonNames?: boolean;
  now?: number;
}

interface RawAgentRow {
  id: number;
  slug: string;
  name: string;
  logo: string | null;
  status: AgentStatus;
  cooldown_refunded_at: number | null;
  updated_at: number;
}

function mapAgentRow(raw: RawAgentRow): AgentRow {
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    logo: raw.logo ?? undefined,
    status: raw.status,
    cooldownRefundedAt: raw.cooldown_refunded_at ?? undefined,
    updatedAt: raw.updated_at,
  };
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
    const parsed = smogon.parseIdentifier(smogonRaw);
    out.push({
      github,
      rawSmogon: smogonRaw,
      smogonId: parsed.id,
      smogonUsername: parsed.username,
    });
  }
  return out;
}

// Validates the one-project-per-human anti-circumvention rule across both GitHub handles and
// Smogon identities when parsing `arena:` blocks from `static/projects.yml`.
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

    let logo: string | undefined;
    if (entry.arena.logo?.trim()) {
      logo = entry.arena.logo.trim();
    } else if (avatarsDir && fs.existsSync(path.join(avatarsDir, `${slug}.png`))) {
      logo = `${slug}.png`;
    }

    parsed.push({
      slug,
      name,
      logo,
      qualified: Boolean(entry.arena.qualified),
      owners,
    });
  }

  return parsed;
}

function validateUniqueSmogonIds(
  projects: Array<ParsedArenaProject<developers.ResolvedProjectOwner>>
) {
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
  projects: Array<ParsedArenaProject<developers.ResolvedProjectOwner>>,
  now: number
) {
  validateUniqueSmogonIds(projects);

  const upsertAgent = db.prepare(`
    INSERT INTO agents (slug, name, logo, status, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      logo = excluded.logo,
      status = excluded.status,
      updated_at = excluded.updated_at
  `);
  const selectAgentId = db.prepare('SELECT id FROM agents WHERE slug = ?');
  const selectAllAgents = db.prepare('SELECT id, slug FROM agents');
  const disableAgent = db.prepare(
    "UPDATE agents SET status = 'disabled', updated_at = ? WHERE id = ?"
  );

  inTransaction(() => {
    const activeSlugs = new Set<string>();
    const activeGitHubs = new Set<string>();

    for (const proj of projects) {
      activeSlugs.add(proj.slug);
      for (const owner of proj.owners) activeGitHubs.add(owner.github);
    }

    developers.pruneInactiveDevelopers(db, activeGitHubs);

    for (const proj of projects) {
      const status: AgentStatus = proj.qualified ? 'qualified' : 'pending';
      upsertAgent.run(proj.slug, proj.name, proj.logo ?? null, status, now);
      const agent = selectAgentId.get(proj.slug) as {id: number};
      developers.upsertProjectDevelopers(db, agent.id, proj.owners, now);
    }

    // Projects removed from `arena:` in projects.yml are marked 'disabled' rather than deleted so
    // their historical versions and matches remain intact in the rating graph.
    const allAgents = selectAllAgents.all() as Array<{id: number; slug: string}>;
    for (const agent of allAgents) {
      if (!activeSlugs.has(agent.slug)) {
        disableAgent.run(now, agent.id);
        developers.deleteDevelopersForAgent(db, agent.id);
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
  const resolved: Array<ParsedArenaProject<developers.ResolvedProjectOwner>> = rawProjects.map(
    proj => ({
      slug: proj.slug,
      name: proj.name,
      logo: proj.logo,
      qualified: proj.qualified,
      owners: proj.owners.map(owner => {
        const existing = developers.getDeveloperByGitHub(db, owner.github);
        if (owner.smogonId !== undefined) {
          const smogonUsername = owner.smogonUsername ??
            (existing?.smogonId === owner.smogonId ? existing.smogonUsername : undefined) ??
            String(owner.smogonId);
          return {github: owner.github, smogonId: owner.smogonId, smogonUsername};
        }

        if (existing) {
          return {
            github: owner.github,
            smogonId: existing.smogonId,
            smogonUsername: existing.smogonUsername,
          };
        }

        throw new Error(
          `Smogon account "${String(owner.rawSmogon)}" for GitHub owner "${owner.github}" ` +
          'has no numerical ID; pass <name>.<id> / <id> or use syncProjectsWithSmogon()'
        );
      }),
    })
  );

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

// Syncs `projects.yml` with live Smogon XenForo profile verification. Once a developer's numerical
// `smogon_id` is stored in SQLite, subsequent syncs query by that immutable ID rather than the
// string in `projects.yml` so Smogon username changes never break ownership verification.
export async function syncProjectsFromYamlWithSmogon(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  projectsYaml: string,
  options: SyncProjectsOptions = {}
) {
  const avatarsDir = options.avatarsDir ?? AVATARS_DIR;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const smogonToken = options.smogonToken ?? process.env.SMOGON_TOKEN;
  const lookup = options.lookupSmogon ?? smogon.lookupUser;
  const refreshNames = options.refreshSmogonNames ?? Boolean(smogonToken || options.lookupSmogon);

  const rawProjects = parseArenaProjects(projectsYaml, avatarsDir);
  const resolved: Array<ParsedArenaProject<developers.ResolvedProjectOwner>> = [];

  for (const proj of rawProjects) {
    const owners: developers.ResolvedProjectOwner[] = [];
    for (const owner of proj.owners) {
      const existing = developers.getDeveloperByGitHub(db, owner.github);

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
            smogonStanding: 'good',
          });
        } else {
          const smogonUsername = owner.smogonUsername ??
            (existing?.smogonId === owner.smogonId ? existing.smogonUsername : undefined) ??
            String(owner.smogonId);
          owners.push({github: owner.github, smogonId: owner.smogonId, smogonUsername});
        }
        continue;
      }

      if (existing && refreshNames && (smogonToken || options.lookupSmogon)) {
        const profile = await lookup(existing.smogonId, smogonToken);
        if (profile.banned) {
          throw new Error(`Smogon account "${profile.username}" (${profile.id}) is banned`);
        }
        owners.push({
          github: owner.github,
          smogonId: profile.id,
          smogonUsername: profile.username,
          smogonStanding: 'good',
        });
        continue;
      }

      if (existing && !smogonToken && !options.lookupSmogon) {
        owners.push({
          github: owner.github,
          smogonId: existing.smogonId,
          smogonUsername: existing.smogonUsername,
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
        smogonStanding: 'good',
      });
    }

    resolved.push({
      slug: proj.slug,
      name: proj.name,
      logo: proj.logo,
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

export function getAgentBySlug(db: DatabaseSync, slug: string): AgentRow | undefined {
  const raw = db.prepare('SELECT * FROM agents WHERE slug = ?')
    .get(slug.toLowerCase()) as unknown as RawAgentRow | undefined;
  return raw ? mapAgentRow(raw) : undefined;
}

export function getAgentById(db: DatabaseSync, id: number): AgentRow | undefined {
  const raw = db.prepare('SELECT * FROM agents WHERE id = ?')
    .get(id) as unknown as RawAgentRow | undefined;
  return raw ? mapAgentRow(raw) : undefined;
}

export function getAllActiveAgents(db: DatabaseSync): AgentRow[] {
  const rows = db.prepare(`
    SELECT *
    FROM agents
    WHERE status != 'disabled'
    ORDER BY slug ASC
  `).all() as unknown as RawAgentRow[];
  return rows.map(mapAgentRow);
}

export function refundCooldown(
  db: DatabaseSync,
  agentSlug: string,
  now = Math.floor(Date.now() / 1000)
): AgentRow {
  const agent = getAgentBySlug(db, agentSlug);
  if (!agent) throw new Error(`Agent "${agentSlug}" not found`);
  db.prepare('UPDATE agents SET cooldown_refunded_at = ?, updated_at = ? WHERE id = ?')
    .run(now, now, agent.id);
  return getAgentById(db, agent.id)!;
}
