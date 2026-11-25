require('source-map-support').install();

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import polka from 'polka';
import * as yaml from 'yaml';

import {Database, combineInfoStatus, parseLaddersYaml} from '../db';
import type * as db from '../db';
import * as util from '../static/util';

import {WatchdogAlert} from './arena';

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_MAX_MESSAGE_LEN = 2000;
const MAX_INTERACTION_BYTES = 64 * 1024;
const SITES = ['vgc.bot', 'pkmn.bot'];
const CYCLE_MILLIS = 60_000;
// ASN.1 SubjectPublicKeyInfo header wrapping a raw 32-byte Ed25519 public key for node:crypto.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const inFlightVersionDms = new Set<number>();

export const COMMANDS = [
  {
    type: 1,
    name: 'define',
    description: 'Look up a competitive Pokémon AI glossary term',
    options: [
      {
        type: 3,
        name: 'term',
        description: 'Glossary term to define',
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    type: 1,
    name: 'watch',
    description: 'Get a one-shot DM when an agent or matchup goes live',
    options: [
      {
        type: 3,
        name: 'agent',
        description: 'Agent to watch (omit to list your active watches)',
        required: false,
        autocomplete: true,
      },
      {
        type: 3,
        name: 'opponent',
        description: 'Optional opponent for a specific matchup',
        required: false,
        autocomplete: true,
      },
      {
        type: 3,
        name: 'event',
        description: 'Optional ladder or tournament filter',
        required: false,
        autocomplete: true,
      },
    ],
  },
];

export interface Config {
  guild: string;
  channel?: string;
  competitor?: string;
  staff?: string[];
  pins?: string[];
  ladders: {[ladder: string]: string};
}

export interface Leader {
  ladder: string;
  agent?: {id: string; name: string};
  owner?: {name: string; discordId?: string};
}

// A Discord guild member snowflake ID, an agent role ID, or a username/display name to resolve.
export type Owner = {id: string} | {role: string} | {name: string};

// Discord REST API v10 wire payloads below retain Discord's native snake_case keys (and user.bot).
export interface User {
  id: string;
  username: string;
  global_name?: string;
  bot?: boolean;
}

export interface GuildMember {
  user: User;
  nick?: string;
  roles: string[];
}

export interface GuildChannel {
  id: string;
  name: string;
}

export interface GuildRole {
  id: string;
  name: string;
  managed?: boolean;
  tags?: {bot_id?: string};
}

export interface Embed {
  type?: string;
  title?: string;
  description?: string;
  url?: string;
  fields?: Array<{name: string; value: string}>;
}

export interface Poll {
  question: {text?: string};
  answers: Array<{
    answer_id: number;
    poll_media: {text?: string; emoji?: {name?: string}};
  }>;
  results?: {
    answer_counts: Array<{id: number; count: number}>;
  };
}

export interface MessageBody {
  content?: string;
  mentions?: User[];
  attachments?: Array<{url: string}>;
  embeds?: Embed[];
  sticker_items?: Array<{name: string}>;
  poll?: Poll;
}

export interface Message extends MessageBody {
  id: string;
  type?: number;
  timestamp: string;
  edited_timestamp?: string;
  content: string;
  author: User;
  referenced_message?: Message;
  message_snapshots?: Array<{message: MessageBody}>;
}

export interface Application {
  id: string;
  verify_key: string;
}

export interface CommandOption {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  autocomplete?: boolean;
}

export interface Command {
  id?: string;
  type: number;
  name: string;
  description: string;
  options?: CommandOption[];
}

export interface ButtonComponent {
  type: 2;
  style: 1 | 2 | 3 | 4 | 5;
  label: string;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
}

export interface ActionRowComponent {
  type: 1;
  components: ButtonComponent[];
}

export interface Interaction {
  type: number;
  member?: {user?: User};
  user?: User;
  data?: {
    name?: string;
    custom_id?: string;
    component_type?: number;
    options?: Array<{
      name: string;
      type?: number;
      value?: string;
      focused?: boolean;
    }>;
  };
}

export interface LiveMatchSnapshot {
  matchId: string;
  ladderId: string;
  format: string;
  p1: {slug: string; name: string; version: string};
  p2: {slug: string; name: string; version: string};
}

export interface LiveTournamentGameSnapshot {
  tournamentId: string;
  tournamentName?: string;
  table: number;
  label?: string;
  gameId?: string;
  stage?: db.TournamentGameStage;
  p1: {slug: string; name: string; version?: string};
  p2: {slug: string; name: string; version?: string};
}

export interface InteractionContext {
  db?: db.Database;
  getLiveMatch?: () => LiveMatchSnapshot | undefined;
  getLiveTournamentGames?: () => LiveTournamentGameSnapshot[];
  nowSeconds?: () => number;
}

interface RawPartnerLeader {
  ladder: string;
  agent?: {id: string; name: string} | null;
  bot?: {id: string; name: string} | null;
  owner?: {name: string; discordId?: string | null} | null;
}

const DISCORD_CONFIG_FILE = util.root('config', 'discord.yml');
const LADDERS_CONFIG_FILE = util.root('config', 'ladders.yml');
const GLOSSARY_FILE = util.root('static', 'glossary.yml');
let cachedConfig: {mtimeMs: number; config: Config} | undefined;

export function loadConfig(): Config {
  const mtimeMs = fs.statSync(DISCORD_CONFIG_FILE).mtimeMs;
  if (cachedConfig?.mtimeMs === mtimeMs) return cachedConfig.config;
  const config = yaml.parse(fs.readFileSync(DISCORD_CONFIG_FILE, 'utf8')) as Config;
  cachedConfig = {mtimeMs, config};
  return config;
}

export function loadGlossary(): Record<string, string> {
  return yaml.parse(fs.readFileSync(GLOSSARY_FILE, 'utf8')) as Record<string, string>;
}

const AGENT_ROLE_PREFIX = '🤖';

function agentRole(
  agent: NonNullable<Leader['agent']>,
  roles?: GuildRole[]
): string | undefined {
  if (!roles) return undefined;
  const id = util.toID(agent.name);
  if (!id) return undefined;
  const strippedId = util.toID(agent.name.replace(/[\s_-]+v?\d[\w.-]*$/i, ''));
  let match: {id: string; len: number} | undefined;
  for (const role of roles) {
    if (!role.name.startsWith(AGENT_ROLE_PREFIX)) continue;
    const roleAgentId = util.toID(role.name.slice(AGENT_ROLE_PREFIX.length));
    if (!roleAgentId) continue;
    const isMatch = roleAgentId === id || (Boolean(strippedId) && roleAgentId === strippedId);
    if (isMatch && (!match || roleAgentId.length > match.len)) {
      match = {id: role.id, len: roleAgentId.length};
    }
  }
  return match?.id;
}

export function ownerOf(leader: Leader, roles?: GuildRole[]): Owner | undefined {
  if (leader.owner?.discordId) return {id: leader.owner.discordId};
  const role = leader.agent && agentRole(leader.agent, roles);
  if (role) return {role};
  if (!leader.owner) return undefined;
  return {name: leader.owner.name};
}

export function findMember(members: GuildMember[], owner: Owner): GuildMember | undefined {
  if ('id' in owner) return members.find(m => m.user.id === owner.id);
  if ('role' in owner) return members.find(m => m.roles.includes(owner.role));
  const lower = owner.name.toLowerCase();
  return (
    members.find(m => m.user.id === owner.name) ??
    members.find(m => m.user.username.toLowerCase() === lower) ??
    members.find(m => m.user.global_name?.toLowerCase() === lower) ??
    members.find(m => m.nick?.toLowerCase() === lower)
  );
}

const MAX_DISCORD_RETRIES = 3;
const MAX_RETRY_AFTER_SECONDS = 30;
const MAX_INTERACTION_SKEW_SECONDS = 300;
const WATCH_DM_MAX_AGE_MILLIS = 120_000;

async function discordRequest(
  token: string,
  endpoint: string,
  init?: RequestInit,
  attempt = 0
): Promise<any> {
  const res = await fetch(`${DISCORD_API}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      ...init?.headers,
    },
    signal: init?.signal ?? AbortSignal.timeout(15_000),
  });
  if (res.status === 429) {
    const body = await res.json().catch(() => ({})) as {retry_after?: number};
    const retryAfterSeconds =
      typeof body.retry_after === 'number' && Number.isFinite(body.retry_after)
        ? body.retry_after
        : 1;
    // Never clamp long retry_after windows down to a shorter sleep — retrying before Discord's
    // bucket resets counts toward the 10k/10m invalid-request ban. Fail fast above 30s instead.
    if (attempt < MAX_DISCORD_RETRIES && retryAfterSeconds <= MAX_RETRY_AFTER_SECONDS) {
      const waitMillis = Math.max(100, Math.ceil(retryAfterSeconds * 1000));
      await new Promise(resolve => setTimeout(resolve, waitMillis));
      return discordRequest(token, endpoint, init, attempt + 1);
    }
    const method = init?.method ?? 'GET';
    throw Object.assign(
      new Error(
        `Discord API ${method} ${endpoint} rate-limited (429, retry_after=${retryAfterSeconds}s)`
      ),
      {status: 429, retryAfterSeconds}
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const method = init?.method ?? 'GET';
    throw Object.assign(
      new Error(`Discord API ${method} ${endpoint} failed (${res.status}): ${text}`),
      {status: res.status}
    );
  }
  if (res.status === 204) return undefined;
  return util.parseJsonResponse(res, 'Discord API');
}

export async function fetchGuildMembers(token: string, guild: string): Promise<GuildMember[]> {
  const all: GuildMember[] = [];
  let after = '0';
  while (true) {
    const page = await discordRequest(
      token,
      `/guilds/${guild}/members?limit=1000&after=${after}`
    ) as GuildMember[];
    all.push(...page.map(m => ({...m, roles: [...m.roles]})));
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }
  return all;
}

export async function fetchGuildChannels(token: string, guild: string): Promise<GuildChannel[]> {
  return await discordRequest(token, `/guilds/${guild}/channels`) as GuildChannel[];
}

export async function fetchGuildRoles(token: string, guild: string): Promise<GuildRole[]> {
  return await discordRequest(token, `/guilds/${guild}/roles`) as GuildRole[];
}

// Normalizes partner leader payloads from vgc.bot and pkmn.bot (which serialize external "bot"
// and nullable owner fields) into our internal undefined-based Leader shape at the HTTP boundary.
export async function fetchLeaders(site: string, vgcToken: string): Promise<Leader[]> {
  const res = await fetch(`https://${site}/api/partner/leaders`, {
    headers: {Authorization: `Bearer ${vgcToken}`},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`${site} API failed (${res.status})`);
  }
  const data = await util.parseJsonResponse<{leaders: RawPartnerLeader[]}>(res, `${site} API`);
  return data.leaders.map(raw => {
    const agent = raw.agent ?? raw.bot ?? undefined;
    const owner = raw.owner
      ? {name: raw.owner.name, discordId: raw.owner.discordId ?? undefined}
      : undefined;
    return {ladder: raw.ladder, agent, owner};
  });
}

export interface GuildCache {
  members?: GuildMember[];
  channels?: GuildChannel[];
  roles?: GuildRole[];
}

// Syncs external partner ladder #1 roles (vgc.bot / pkmn.bot). Guild members and roles are
// fetched lazily only when needed to resolve or update a ladder's leader.
export async function syncRoles(
  token: string,
  vgcToken: string,
  config: Config,
  state: Map<string, string | undefined>,
  cache: GuildCache = {}
) {
  let {members} = cache;
  const {roles} = cache;
  const leaders: Leader[] = [];
  for (const site of SITES) {
    try {
      leaders.push(...await fetchLeaders(site, vgcToken));
    } catch (err) {
      console.error(`Error fetching leaders from ${site}:`, err);
    }
  }
  const cachedRoles = state.get('roles');
  let resolvedRoles = roles ?? (cachedRoles ? JSON.parse(cachedRoles) as GuildRole[] : undefined);
  if (roles) state.set('roles', JSON.stringify(roles));

  for (const leader of leaders) {
    const roleId = config.ladders[leader.ladder];
    if (!roleId) continue;
    if (!resolvedRoles && leader.agent && !leader.owner?.discordId) {
      try {
        resolvedRoles = await fetchGuildRoles(token, config.guild);
        state.set('roles', JSON.stringify(resolvedRoles));
      } catch (err) {
        console.error(`[${leader.ladder}] Error fetching guild roles:`, err);
      }
    }
    const owner = ownerOf(leader, resolvedRoles);
    const key = owner && JSON.stringify(owner);
    if (state.has(leader.ladder) && state.get(leader.ladder) === key) continue;

    try {
      members ??= await fetchGuildMembers(token, config.guild);
      const fallbackOwner = owner && 'role' in owner ? ownerOf(leader) : undefined;
      const target = owner && (
        findMember(members, owner) ??
        (fallbackOwner && findMember(members, fallbackOwner))
      );

      for (const member of members) {
        if (member.roles.includes(roleId) && member.user.id !== target?.user.id) {
          await discordRequest(
            token,
            `/guilds/${config.guild}/members/${member.user.id}/roles/${roleId}`,
            {method: 'DELETE'}
          );
          member.roles = member.roles.filter(r => r !== roleId);
          console.log(`[${leader.ladder}] Removed role ${roleId} from ${member.user.username}`);
        }
      }

      if (target && !target.roles.includes(roleId)) {
        await discordRequest(
          token,
          `/guilds/${config.guild}/members/${target.user.id}/roles/${roleId}`,
          {method: 'PUT'}
        );
        target.roles.push(roleId);
        const who = `${target.user.username} (${leader.agent?.name})`;
        console.log(`[${leader.ladder}] Assigned role ${roleId} to ${who}`);
      } else if (owner && !target) {
        const who = 'id' in owner ? owner.id : 'role' in owner ? `role ${owner.role}` : owner.name;
        console.log(`[${leader.ladder}] ${who} is not in the server`);
      }

      if (!owner || target) {
        state.set(leader.ladder, key);
      } else {
        state.delete(leader.ladder);
        if (!roles) state.delete('roles');
      }
    } catch (err) {
      console.error(`[${leader.ladder}] Error syncing role:`, err);
    }
  }
}

// Syncs pkmn.ai Arena Competitor and #1 ladder leader roles directly from SQLite. Unlike external
// partner ladders, Arena projects can have multiple co-owners in `developers`, so every verified
// owner of a qualified project or #1 settled Champion receives the corresponding Discord role.
export async function syncArenaRoles(
  db: db.Database,
  token: string,
  config: Config,
  state: Map<string, string | undefined>,
  members?: GuildMember[]
): Promise<GuildMember[] | undefined> {
  const assignments: Array<{
    stateKey: string;
    label: string;
    roleId: string;
    targetIds: string[];
    agentName?: string;
  }> = [];

  if (config.competitor) {
    assignments.push({
      stateKey: 'arena:competitor',
      label: 'arena:competitor',
      roleId: config.competitor,
      targetIds: db.getCompetitorDiscordIds(),
    });
  }

  for (const target of db.getArenaLadderRoleTargets()) {
    assignments.push({
      stateKey: `arena:ladder:${target.discordRole}`,
      label: `arena:${target.slot}`,
      roleId: target.discordRole,
      targetIds: target.discordIds,
      agentName: target.agentName,
    });
  }

  for (const item of assignments) {
    const sortedIds = [...new Set(item.targetIds)].sort();
    const key = JSON.stringify(sortedIds);
    if (state.has(item.stateKey) && state.get(item.stateKey) === key) continue;

    try {
      members ??= await fetchGuildMembers(token, config.guild);
      const memberById = new Map(members.map(m => [m.user.id, m]));
      const presentIds = new Set(sortedIds.filter(id => memberById.has(id)));
      const missingIds = sortedIds.filter(id => !memberById.has(id));

      for (const member of members) {
        if (member.roles.includes(item.roleId) && !presentIds.has(member.user.id)) {
          await discordRequest(
            token,
            `/guilds/${config.guild}/members/${member.user.id}/roles/${item.roleId}`,
            {method: 'DELETE'}
          );
          member.roles = member.roles.filter(r => r !== item.roleId);
          console.log(`[${item.label}] Removed role ${item.roleId} from ${member.user.username}`);
        }
      }

      for (const userId of presentIds) {
        const target = memberById.get(userId)!;
        if (!target.roles.includes(item.roleId)) {
          await discordRequest(
            token,
            `/guilds/${config.guild}/members/${target.user.id}/roles/${item.roleId}`,
            {method: 'PUT'}
          );
          target.roles.push(item.roleId);
          const who = item.agentName
            ? `${target.user.username} (${item.agentName})`
            : target.user.username;
          console.log(`[${item.label}] Assigned role ${item.roleId} to ${who}`);
        }
      }

      if (missingIds.length === 0) {
        state.set(item.stateKey, key);
      } else {
        for (const missingId of missingIds) {
          console.log(`[${item.label}] ${missingId} is not in the server`);
        }
        state.delete(item.stateKey);
      }
    } catch (err) {
      console.error(`[${item.label}] Error syncing role:`, err);
    }
  }

  return members;
}

function appendCodeBlockWithinLimit(header: string, rawLog?: string): string {
  const trimmed = rawLog?.trim();
  if (!trimmed) return header.slice(0, DISCORD_MAX_MESSAGE_LEN);
  const safeLog = trimmed.replace(/```/g, "'''");
  const prefix = '\n```text\n';
  const suffix = '\n```';
  const truncNote = '\n… (truncated)';
  const budget = DISCORD_MAX_MESSAGE_LEN - header.length - prefix.length - suffix.length;
  if (budget <= 0) return header.slice(0, DISCORD_MAX_MESSAGE_LEN);
  if (safeLog.length <= budget) {
    return `${header}${prefix}${safeLog}${suffix}`;
  }
  const sliceBudget = Math.max(0, budget - truncNote.length);
  if (sliceBudget === 0) return header.slice(0, DISCORD_MAX_MESSAGE_LEN);
  return `${header}${prefix}${safeLog.slice(0, sliceBudget)}${truncNote}${suffix}`;
}

function formatSmokeStatsSummary(input: {
  smokeDurationMillis?: number;
  smokeInitMillis?: number;
  smokeTeamPreviewMillis?: number;
  smokeTurnMillis?: number;
  smokePeakRam?: number;
  smokeInfoStatus?: db.InfoStatus;
}): string | undefined {
  const parts: string[] = [];
  if (input.smokeDurationMillis !== undefined) {
    parts.push(`${(input.smokeDurationMillis / 1000).toFixed(1)}s`);
  }
  if (input.smokeInitMillis !== undefined) {
    parts.push(`${input.smokeInitMillis}ms init`);
  }
  if (input.smokeTeamPreviewMillis !== undefined) {
    parts.push(`${input.smokeTeamPreviewMillis}ms team`);
  }
  if (input.smokeTurnMillis !== undefined) {
    parts.push(`${input.smokeTurnMillis}ms/turn`);
  }
  if (input.smokePeakRam !== undefined) {
    parts.push(`${input.smokePeakRam.toLocaleString('en-US')} MiB`);
  }
  if (input.smokeInfoStatus !== undefined) {
    parts.push(
      input.smokeInfoStatus === 'full'
        ? '/info'
        : input.smokeInfoStatus === 'partial'
          ? '/info (partial)'
          : 'no /info'
    );
  }
  return parts.length ? parts.join(' · ') : undefined;
}

export function formatSubmissionDm(input: {
  agentName: string;
  version: string;
  smokeStatus: db.NotifiableSmokeStatus;
  ladderLabels: string[];
  smokeError?: string;
  smokeDurationMillis?: number;
  smokeInitMillis?: number;
  smokeTeamPreviewMillis?: number;
  smokeTurnMillis?: number;
  smokePeakRam?: number;
  smokeInfoStatus?: db.InfoStatus;
}): string {
  const laddersPart = input.ladderLabels.length
    ? ` on \`${input.ladderLabels.join(', ')}\``
    : '';
  if (input.smokeStatus === 'staged') {
    const stats = formatSmokeStatsSummary(input);
    const statsPart = stats ? ` (\`${stats}\`)` : '';
    return (
      `**${input.agentName}** (\`${input.version}\`) passed its diagnostic test` +
      `${laddersPart}${statsPart}. Review the replay and stderr log, then activate or discard ` +
      'it at <https://pkmn.ai/account/>.'
    );
  }
  if (input.smokeStatus === 'passed') {
    const stats = formatSmokeStatsSummary(input);
    const statsPart = stats ? ` (\`${stats}\`)` : '';
    return (
      `**${input.agentName}** (\`${input.version}\`) passed its smoke test` +
      `${laddersPart}${statsPart}. See <https://pkmn.ai/account/> for details.`
    );
  }
  const header = input.smokeStatus === 'quarantined'
    ? `**${input.agentName}** (\`${input.version}\`) has been ` +
      `**quarantined**${laddersPart} and paused from matchmaking. ` +
      'See <https://pkmn.ai/account/> for details.'
    : `**${input.agentName}** (\`${input.version}\`) failed its smoke test` +
      `${laddersPart}. Failed smoke tests do not trigger the 14-day cooldown — ` +
      'see <https://pkmn.ai/account/> for full logs.';
  return appendCodeBlockWithinLimit(header, input.smokeError);
}

export function formatStaffQuarantineDm(input: {
  agentName: string;
  agentSlug: string;
  version: string;
  ladderLabels: string[];
  ownersNotified: number;
  ownersTotal: number;
  smokeError?: string;
}): string {
  const laddersPart = input.ladderLabels.length
    ? ` on \`${input.ladderLabels.join(', ')}\``
    : '';
  const header =
    `**${input.agentName}** (\`${input.agentSlug}\` \`${input.version}\`) ` +
    `was **quarantined**${laddersPart} ` +
    `(owners DM'd: ${input.ownersNotified}/${input.ownersTotal}).`;
  return appendCodeBlockWithinLimit(header, input.smokeError);
}

export function formatWatchdogDm(alert: WatchdogAlert): string {
  const seenIso = new Date(alert.lastSeenAt * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  const matchNote = alert.lastMatchId ? `, last match \`${alert.lastMatchId}\`` : '';
  return (
    'Arena heartbeat timed out ' +
    `(last seen \`${seenIso} UTC\`${matchNote}). \`/api/live.json\` has been marked stale.`
  );
}

export const STAFF_ALERT_COOLDOWN_SECONDS = 6 * 60 * 60;

export interface StaffAlert {
  key: string;
  message: string;
  detail?: string;
  cooldownSeconds?: number;
}

export function formatStaffAlertDm(alert: Pick<StaffAlert, 'message' | 'detail'>): string {
  return appendCodeBlockWithinLimit(alert.message.trim(), alert.detail);
}

export async function sendDirectMessage(
  token: string,
  recipientId: string,
  content: string,
  state?: Map<string, string | undefined>,
  options?: {suppressEmbeds?: boolean; components?: ActionRowComponent[]}
): Promise<'sent' | 'blocked'> {
  const cacheKey = `dm-channel:${recipientId}`;
  let channelId = state?.get(cacheKey);
  if (!channelId) {
    try {
      const ch = await discordRequest(token, '/users/@me/channels', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({recipient_id: recipientId}),
      }) as {id: string};
      channelId = ch.id;
      state?.set(cacheKey, channelId);
    } catch (err) {
      const status = (err as {status?: number}).status;
      if (status === 400 || status === 403 || status === 404) {
        console.warn(`Cannot open Discord DM channel with ${recipientId}:`, err);
        return 'blocked';
      }
      throw err;
    }
  }

  try {
    const payload: {
      content: string;
      flags?: number;
      components?: ActionRowComponent[];
    } = options?.suppressEmbeds === false
      ? {content}
      : {content, flags: 4};
    if (options?.components?.length) {
      payload.components = options.components;
    }
    await discordRequest(token, `/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
    return 'sent';
  } catch (err) {
    const status = (err as {status?: number}).status;
    if (status === 403 || status === 404) {
      state?.delete(cacheKey);
      console.warn(`Cannot send Discord DM to ${recipientId}:`, err);
      return 'blocked';
    }
    throw err;
  }
}

function resolveTargetLabels(
  db: db.Database,
  ladderIds: readonly string[],
  tournamentIds: readonly string[] = []
): string[] {
  return [
    ...ladderIds.map(id => db.getLadder(id)?.name ?? id),
    ...tournamentIds.map(id => db.getTournament(id)?.name ?? `Tournament #${id}`),
  ];
}

interface DmContext {
  db: db.Database;
  token: string;
  config: Config;
  state: Map<string, string | undefined>;
}

async function dispatchVersionDm(
  ctx: DmContext,
  item: db.PendingVersionDmRow,
  notifyStaffIfNoOwners: boolean
): Promise<boolean> {
  const {db, token, config, state} = ctx;
  if (inFlightVersionDms.has(item.versionId)) return false;
  const latest = db.getVersionById(item.versionId);
  if (!latest || latest.notified) return false;

  inFlightVersionDms.add(item.versionId);
  try {
    const ladderLabels = resolveTargetLabels(db, item.ladders, item.tournaments);
    const notifiedOwners = new Set<string>();
    let blockedCount = 0;
    let errorCount = 0;

    const blockedKey = `dm-blocked:${item.versionId}:${item.ownerDiscordIds.join(',')}`;
    if (item.ownerDiscordIds.length > 0 && state.get(blockedKey) !== '1') {
      const ownerMessage = formatSubmissionDm({
        agentName: item.agentName,
        version: item.version,
        smokeStatus: item.smokeStatus,
        ladderLabels,
        smokeError: item.smokeError,
        smokeDurationMillis: item.smokeDurationMillis,
        smokeInitMillis: item.smokeInitMillis,
        smokeTeamPreviewMillis: item.smokeTeamPreviewMillis,
        smokeTurnMillis: item.smokeTurnMillis,
        smokePeakRam: item.smokePeakRam,
        smokeInfoStatus: item.smokeInfoStatus,
      });

      for (const ownerId of item.ownerDiscordIds) {
        try {
          const outcome = await sendDirectMessage(token, ownerId, ownerMessage, state);
          if (outcome === 'sent') {
            notifiedOwners.add(ownerId);
          } else {
            blockedCount++;
          }
        } catch (err) {
          errorCount++;
          console.error(
            `Error sending submission DM to ${ownerId} for version ${item.versionId}:`,
            err
          );
        }
      }

      if (notifiedOwners.size > 0) {
        db.markVersionNotified(item.versionId);
        state.delete(blockedKey);
      } else if (blockedCount === item.ownerDiscordIds.length && errorCount === 0) {
        // Avoid hammering Discord every 60s when all linked owners have DMs disabled; key includes
        // ownerDiscordIds so newly linked co-owners still trigger a fresh delivery attempt.
        state.set(blockedKey, '1');
      }
    }

    let staffNotified = false;
    const staffKey = `dm-staff:${item.versionId}`;
    if (
      item.smokeStatus === 'quarantined' &&
      config.staff?.length &&
      state.get(staffKey) !== '1' &&
      (notifiedOwners.size > 0 || notifyStaffIfNoOwners)
    ) {
      const staffMessage = formatStaffQuarantineDm({
        agentName: item.agentName,
        agentSlug: item.agentSlug,
        version: item.version,
        ladderLabels,
        ownersNotified: notifiedOwners.size,
        ownersTotal: item.ownerDiscordIds.length,
        smokeError: item.smokeError,
      });
      let staffError = false;
      for (const staffId of config.staff) {
        if (notifiedOwners.has(staffId)) continue;
        try {
          const outcome = await sendDirectMessage(token, staffId, staffMessage, state);
          if (outcome === 'sent') staffNotified = true;
        } catch (err) {
          staffError = true;
          console.error(`Error sending quarantine staff DM to ${staffId}:`, err);
        }
      }
      if (!staffError) {
        state.set(staffKey, '1');
      }
    }

    return notifiedOwners.size > 0 || staffNotified;
  } finally {
    inFlightVersionDms.delete(item.versionId);
  }
}

export async function notifySubmissionStatus(
  db: db.Database,
  token: string,
  config: Config,
  result: db.ApplySubmissionStatusResult,
  state = new Map<string, string | undefined>()
): Promise<boolean> {
  const status = result.version.smokeStatus;
  if (status === 'pending' || status === 'discarded') return false;
  if (result.version.notified) return false;

  const ownerDiscordIds = db.getVersionOwnerDiscordIds(
    result.agent.id,
    result.version.developerId
  );
  const diags = db.getSmokeDiagnosticsForVersion(result.version.id);
  const smokeInfoStatus = combineInfoStatus(diags.map(d => d.infoStatus));
  return dispatchVersionDm(
    {db, token, config, state},
    {
      versionId: result.version.id,
      agentId: result.agent.id,
      agentSlug: result.agent.slug,
      agentName: result.agent.name,
      version: result.version.version,
      smokeStatus: status,
      smokeError: result.version.smokeError,
      smokeDurationMillis: result.version.smokeDurationMillis,
      smokeInitMillis: result.version.smokeInitMillis,
      smokeTeamPreviewMillis: result.version.smokeTeamPreviewMillis,
      smokeTurnMillis: result.version.smokeTurnMillis,
      smokePeakRam: result.version.smokePeakRam,
      ...(smokeInfoStatus !== undefined ? {smokeInfoStatus} : {}),
      ladders: result.version.ladders,
      tournaments: result.version.tournaments,
      submittedAt: result.version.submittedAt,
      ownerDiscordIds,
    },
    true
  );
}

// Reconciles undelivered smoke-test (pass/failure) and quarantine DMs on the 60-second background
// cycle. Quarantined versions with zero linked Discord owners (e.g. CLI `pkmn quarantine` on a
// project whose developer hasn't linked Discord yet) still alert `config.staff` once per process
// while leaving `notified = 0` in SQLite so the owner receives their DM if they link Discord later.
export async function syncSubmissionDms(
  db: db.Database,
  token: string,
  config: Config,
  state = new Map<string, string | undefined>()
): Promise<number> {
  const ctx: DmContext = {db, token, config, state};
  let deliveredVersions = 0;
  for (const row of db.getPendingVersionDms()) {
    if (row.ownerDiscordIds.length === 0 && row.smokeStatus !== 'quarantined') continue;
    const sent = await dispatchVersionDm(
      ctx,
      row,
      row.smokeStatus === 'quarantined'
    );
    if (sent) deliveredVersions++;
  }
  return deliveredVersions;
}

async function sendStaffDm(
  token: string,
  config: Config,
  content: string,
  state: Map<string, string | undefined>,
  label: string
): Promise<number> {
  if (!config.staff?.length) return 0;
  let sent = 0;
  for (const staffId of new Set(config.staff)) {
    try {
      const outcome = await sendDirectMessage(token, staffId, content, state);
      if (outcome === 'sent') sent++;
    } catch (err) {
      console.error(`Error sending ${label} DM to ${staffId}:`, err);
    }
  }
  return sent;
}

export async function notifyStaffAlert(
  token: string,
  config: Config,
  alert: StaffAlert,
  state = new Map<string, string | undefined>(),
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<number> {
  if (!config.staff?.length) return 0;
  const cooldown = alert.cooldownSeconds ?? STAFF_ALERT_COOLDOWN_SECONDS;
  const stateKey = `staff-alert:${alert.key}`;
  const prev = Number(state.get(stateKey));
  if (cooldown > 0 && Number.isFinite(prev) && nowSeconds - prev < cooldown) {
    return 0;
  }
  const sent = await sendStaffDm(token, config, formatStaffAlertDm(alert), state, 'staff alert');
  if (sent > 0) {
    state.set(stateKey, String(nowSeconds));
  }
  return sent;
}

export async function resolveStaffAlert(
  token: string,
  config: Config,
  alert: {key: string; message?: string},
  state = new Map<string, string | undefined>()
): Promise<number> {
  const stateKey = `staff-alert:${alert.key}`;
  if (!state.has(stateKey)) return 0;
  state.delete(stateKey);
  if (!alert.message || !config.staff?.length) return 0;
  return sendStaffDm(
    token,
    config,
    formatStaffAlertDm({message: alert.message}),
    state,
    'recovery'
  );
}

export async function notifyWatchdogAlert(
  token: string,
  config: Config,
  alert: WatchdogAlert,
  state = new Map<string, string | undefined>()
): Promise<number> {
  return sendStaffDm(token, config, formatWatchdogDm(alert), state, 'heartbeat alert');
}

export interface ResolvedMention {
  input: string;
  output: string;
  kind: 'member' | 'role' | 'channel' | 'special';
  id?: string;
  label: string;
}

export interface ResolveMentionsResult {
  content: string;
  mentions: ResolvedMention[];
  errors: string[];
}

export interface AnnounceGuild {
  id: string;
  members: GuildMember[];
  roles: GuildRole[];
  channels?: GuildChannel[];
  roleAliases?: Record<string, string>;
}

const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const EMOJI_TOKEN =
  '(?:[0-9#*]\\uFE0F?\\u20E3|[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\p{So}]' +
  '|\\uFE0E|\\uFE0F|\\u200D)';
const LEADING_EMOJI_RE = new RegExp(`^(?:${EMOJI_TOKEN}+\\s*)+`, 'u');
const TRAILING_EMOJI_RE = new RegExp(`(?:\\s*${EMOJI_TOKEN}+)+$`, 'u');

function stripEdgeEmoji(name: string): string | undefined {
  const stripped = name.replace(LEADING_EMOJI_RE, '').replace(TRAILING_EMOJI_RE, '').trim();
  if (!stripped || stripped === name) return undefined;
  return stripped;
}

export function loadRoleAliases(config: Config): Record<string, string> {
  const aliases: Record<string, string> = {};
  if (fs.existsSync(LADDERS_CONFIG_FILE)) {
    const ladders = parseLaddersYaml(fs.readFileSync(LADDERS_CONFIG_FILE, 'utf8'));
    for (const ladder of ladders) {
      if (!ladder.discord) continue;
      if (ladder.status === 'archived' && aliases[ladder.name]) continue;
      aliases[ladder.name] = ladder.discord;
    }
  }
  if (config.competitor) {
    aliases.Competitor = config.competitor;
  }
  return aliases;
}

function isMentionBoundary(text: string, pos: number): boolean {
  const ch = text[pos];
  if (ch === undefined) return true;
  if (WORD_CHAR_RE.test(ch)) return false;
  if (ch === '_' || ch === '-' || ch === '.' || ch === '/') {
    const after = text[pos + 1];
    return after === undefined || !WORD_CHAR_RE.test(after);
  }
  return true;
}

function formatMemberLabel(member: GuildMember): string {
  const name = member.nick ?? member.user.global_name;
  if (name && name.toLowerCase() !== member.user.username.toLowerCase()) {
    return `${name} (@${member.user.username})`;
  }
  return member.user.username;
}

function findClosingInlineTicks(text: string, start: number, tickLen: number): number {
  let pos = start;
  while (pos < text.length) {
    const idx = text.indexOf('`', pos);
    if (idx === -1) return -1;
    let end = idx;
    while (end < text.length && text[end] === '`') end++;
    if (end - idx === tickLen) return end;
    pos = end;
  }
  return -1;
}

export function resolveMentions(raw: string, guild: AnnounceGuild): ResolveMentionsResult {
  const memberById = new Map(guild.members.map(m => [m.user.id, m]));
  const assignableRoles = guild.roles.filter(r => r.id !== guild.id && r.name !== '@everyone');
  const roleById = new Map(assignableRoles.map(r => [r.id, r]));
  const channelById = new Map((guild.channels ?? []).map(c => [c.id, c]));

  interface Candidate {
    name: string;
    lower: string;
    kind: 'member' | 'role';
    id: string;
    output: string;
    label: string;
    // 0 = exact member/role/config alias, 1 = emoji-stripped role, 2 = normalized role slug/toID.
    tier: 0 | 1 | 2;
  }
  const candidates: Candidate[] = [];
  for (const role of assignableRoles) {
    // Discord auto-creates a managed integration role (`tags.bot_id`) with the same name as each
    // bot in the guild; skip it for plaintext @name matching so @bot resolves to the bot member.
    if (!role.name.trim() || role.tags?.bot_id) continue;
    const seen = new Set<string>();
    const addRoleCandidate = (name: string, tier: 0 | 1 | 2) => {
      const lower = name.toLowerCase();
      if (!lower || seen.has(lower)) return;
      seen.add(lower);
      candidates.push({
        name,
        lower,
        kind: 'role',
        id: role.id,
        output: `<@&${role.id}>`,
        label: role.name,
        tier,
      });
    };
    addRoleCandidate(role.name, 0);
    const stripped = stripEdgeEmoji(role.name);
    if (stripped) addRoleCandidate(stripped, 1);
    const base = stripped ?? role.name;
    const slug = util.slugify(base);
    if (slug) {
      addRoleCandidate(slug, 2);
      const compactId = util.toID(slug);
      if (compactId) addRoleCandidate(compactId, 2);
    }
  }
  for (const [alias, roleId] of Object.entries(guild.roleAliases ?? {})) {
    const role = roleById.get(roleId);
    if (!alias.trim() || !role) continue;
    candidates.push({
      name: alias,
      lower: alias.toLowerCase(),
      kind: 'role',
      id: role.id,
      output: `<@&${role.id}>`,
      label: role.name,
      tier: 0,
    });
  }
  for (const member of guild.members) {
    const label = formatMemberLabel(member);
    const seen = new Set<string>();
    for (const alias of [member.user.username, member.user.global_name, member.nick]) {
      if (!alias?.trim()) continue;
      const lower = alias.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      candidates.push({
        name: alias,
        lower,
        kind: 'member',
        id: member.user.id,
        output: `<@${member.user.id}>`,
        label,
        tier: 0,
      });
    }
  }

  let out = '';
  const mentions: ResolvedMention[] = [];
  const errors: string[] = [];
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];

    // Skip fenced code blocks and inline code spans (Discord does not parse mentions inside them).
    if (ch === '`') {
      let end = i;
      while (end < raw.length && raw[end] === '`') end++;
      const tickLen = end - i;
      if (tickLen >= 3) {
        const fence = raw.slice(i, end);
        const close = raw.indexOf(fence, end);
        const next = close === -1 ? raw.length : close + tickLen;
        out += raw.slice(i, next);
        i = next;
        continue;
      }
      const closeEnd = findClosingInlineTicks(raw, end, tickLen);
      if (closeEnd !== -1) {
        out += raw.slice(i, closeEnd);
        i = closeEnd;
        continue;
      }
      out += raw.slice(i, end);
      i = end;
      continue;
    }

    // Respect Discord markdown escapes (\@foo, \<@123>).
    if (ch === '\\' && (raw[i + 1] === '@' || raw[i + 1] === '<')) {
      out += raw.slice(i, i + 2);
      i += 2;
      continue;
    }

    // Angle-bracketed URLs, explicit Discord mention tags, custom emojis, and timestamps.
    if (ch === '<') {
      const rest = raw.slice(i);
      const urlMatch = /^<https?:\/\/[^>\s]+>/i.exec(rest);
      if (urlMatch) {
        out += urlMatch[0];
        i += urlMatch[0].length;
        continue;
      }
      const userMatch = /^<@!?(\d+)>/.exec(rest);
      if (userMatch) {
        const [tag, id] = userMatch;
        const member = memberById.get(id);
        if (member) {
          mentions.push({
            input: tag,
            output: tag,
            kind: 'member',
            id,
            label: formatMemberLabel(member),
          });
        } else {
          errors.push(`Unknown user mention "${tag}" (not a member of guild ${guild.id})`);
        }
        out += tag;
        i += tag.length;
        continue;
      }
      const roleMatch = /^<@&(\d+)>/.exec(rest);
      if (roleMatch) {
        const [tag, id] = roleMatch;
        const role = roleById.get(id);
        if (role) {
          mentions.push({input: tag, output: tag, kind: 'role', id, label: role.name});
        } else {
          errors.push(`Unknown role mention "${tag}" (not a role in guild ${guild.id})`);
        }
        out += tag;
        i += tag.length;
        continue;
      }
      const chanMatch = /^<#(\d+)>/.exec(rest);
      if (chanMatch) {
        const [tag, id] = chanMatch;
        const channel = channelById.get(id);
        if (channel) {
          mentions.push({
            input: tag,
            output: tag,
            kind: 'channel',
            id,
            label: `#${channel.name}`,
          });
        } else {
          errors.push(`Unknown channel mention "${tag}" (not a channel in guild ${guild.id})`);
        }
        out += tag;
        i += tag.length;
        continue;
      }
      const otherMatch = /^<(?:a?:\w+:\d+|t:\d+(?::[tTdDfFR])?)>/.exec(rest);
      if (otherMatch) {
        out += otherMatch[0];
        i += otherMatch[0].length;
        continue;
      }
    }

    // Bare URLs (avoid flagging @ inside paths like https://medium.com/@author).
    if (ch === 'h' || ch === 'H') {
      const urlMatch = /^https?:\/\/[^\s<>]+/i.exec(raw.slice(i));
      if (urlMatch) {
        out += urlMatch[0];
        i += urlMatch[0].length;
        continue;
      }
    }

    // Plaintext @mentions: resolve against guild roles and members, validating every candidate.
    if (ch === '@') {
      const prev = i > 0 ? raw[i - 1] : '';
      const prev2 = i > 1 ? raw[i - 2] : '';
      if (/[A-Za-z0-9]/.test(prev) || (prev === '_' && /[A-Za-z0-9]/.test(prev2))) {
        out += '@';
        i++;
        continue;
      }

      const rest = raw.slice(i + 1);
      const specialMatch = /^(everyone|here)/.exec(rest);
      if (specialMatch && isMentionBoundary(raw, i + 1 + specialMatch[1].length)) {
        const tag = `@${specialMatch[1]}`;
        mentions.push({input: tag, output: tag, kind: 'special', label: specialMatch[1]});
        out += tag;
        i += tag.length;
        continue;
      }

      let maxLen = 0;
      const bestByEntity = new Map<string, Candidate & {exactCase: boolean}>();
      for (const candidate of candidates) {
        const len = candidate.name.length;
        if (len < maxLen || i + 1 + len > raw.length) continue;
        if (!isMentionBoundary(raw, i + 1 + len)) continue;
        const slice = raw.slice(i + 1, i + 1 + len);
        if (slice.toLowerCase() !== candidate.lower) continue;
        if (len > maxLen) {
          maxLen = len;
          bestByEntity.clear();
        }
        const key = `${candidate.kind}:${candidate.id}`;
        const exactCase = slice === candidate.name;
        const existing = bestByEntity.get(key);
        const better =
          !existing ||
          candidate.tier < existing.tier ||
          (candidate.tier === existing.tier && exactCase && !existing.exactCase);
        if (better) {
          bestByEntity.set(key, {...candidate, exactCase});
        }
      }

      if (maxLen > 0) {
        const rawTag = raw.slice(i, i + 1 + maxLen);
        let matches = [...bestByEntity.values()];
        if (matches.length > 1) {
          const minTier = Math.min(...matches.map(m => m.tier));
          const bestTier = matches.filter(m => m.tier === minTier);
          if (bestTier.length > 0 && bestTier.length < matches.length) {
            matches = bestTier;
          }
        }
        let winner = matches.length === 1 ? matches[0] : undefined;
        if (!winner) {
          const exact = matches.filter(m => m.exactCase);
          if (exact.length === 1) winner = exact[0];
        }
        if (winner) {
          mentions.push({
            input: rawTag,
            output: winner.output,
            kind: winner.kind,
            id: winner.id,
            label: winner.label,
          });
          out += winner.output;
        } else {
          const desc = matches.map(m => `${m.kind} "${m.label}" (${m.output})`).join(', ');
          errors.push(
            `Ambiguous mention "${rawTag}": matches ${desc} — use an explicit <@id> or <@&id> tag`
          );
          out += rawTag;
        }
        i += 1 + maxLen;
        continue;
      }

      const unknownMatch = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*(?:\/[\p{L}\p{N}_.-]+)*/u.exec(rest);
      if (unknownMatch) {
        const token = unknownMatch[0].replace(/[._-]+$/, '');
        if (token) {
          errors.push(`Unknown mention "@${token}" (no matching guild member or role)`);
          out += `@${token}`;
          i += 1 + token.length;
          continue;
        }
      }
    }

    out += ch;
    i++;
  }

  return {content: out, mentions, errors};
}

export interface AnnounceOptions {
  dryRun?: boolean;
  channel?: string;
  roleAliases?: Record<string, string>;
  state?: Map<string, string | undefined>;
}

export interface AnnounceResult {
  content: string;
  mentions: ResolvedMention[];
  dryRun: boolean;
  channel?: string;
  messageId?: string;
  staffSent?: number;
  staffTotal?: number;
}

export async function announce(
  token: string,
  config: Config,
  rawMessage: string,
  opts: AnnounceOptions = {}
): Promise<AnnounceResult> {
  const trimmed = rawMessage.replace(/\r\n/g, '\n').trim();
  if (!trimmed) {
    throw new Error('Announcement message is empty');
  }

  const dryRun = Boolean(opts.dryRun);
  const channel = opts.channel ?? config.channel;
  const staffIds = [...new Set(config.staff ?? [])];
  if (dryRun && staffIds.length === 0) {
    throw new Error('Cannot dry-run announcement: config/discord.yml has no staff recipients');
  }
  if (!dryRun && !channel) {
    throw new Error('Cannot send announcement: no target channel configured in config/discord.yml');
  }

  const needsChannels = /<#\d+>/.test(trimmed);
  const [members, roles, channels] = await Promise.all([
    fetchGuildMembers(token, config.guild),
    fetchGuildRoles(token, config.guild),
    needsChannels ? fetchGuildChannels(token, config.guild) : Promise.resolve(undefined),
  ]);

  const roleAliases = opts.roleAliases ?? loadRoleAliases(config);
  const resolved = resolveMentions(trimmed, {
    id: config.guild,
    members,
    roles,
    channels,
    roleAliases,
  });
  if (resolved.errors.length > 0) {
    const details = resolved.errors.map(e => `  - ${e}`).join('\n');
    throw new Error(`Invalid mention(s) in announcement:\n${details}`);
  }
  if (resolved.content.length > DISCORD_MAX_MESSAGE_LEN) {
    throw new Error(
      `Announcement exceeds Discord's ${DISCORD_MAX_MESSAGE_LEN}-character limit ` +
      `(${resolved.content.length} chars after resolving mentions)`
    );
  }

  if (dryRun) {
    const state = opts.state ?? new Map<string, string | undefined>();
    let staffSent = 0;
    for (const staffId of staffIds) {
      const outcome = await sendDirectMessage(
        token,
        staffId,
        resolved.content,
        state,
        {suppressEmbeds: false}
      );
      if (outcome === 'sent') staffSent++;
    }
    if (staffSent === 0) {
      throw new Error(`Failed to DM any staff member (0/${staffIds.length} delivered)`);
    }
    return {
      content: resolved.content,
      mentions: resolved.mentions,
      dryRun: true,
      staffSent,
      staffTotal: staffIds.length,
    };
  }

  const created = await discordRequest(
    token,
    `/channels/${channel}/messages`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({content: resolved.content}),
    }
  ) as Message;
  return {
    content: resolved.content,
    mentions: resolved.mentions,
    dryRun: false,
    channel,
    messageId: created.id,
  };
}

export interface DiskStat {
  freeBytes: number;
  totalBytes: number;
}

export interface HealthCheckOptions {
  state?: Map<string, string | undefined>;
  nowSeconds?: number;
  startedAtSeconds?: number;
  getArenaLastContactAt?: () => number | undefined;
  hasActiveLadder?: () => boolean;
  diskPaths?: readonly string[];
  statDisk?: (dir: string) => DiskStat | undefined;
  backupDir?: string;
  maxBackupAgeSeconds?: number;
  maxArenaSilenceSeconds?: number;
}

const GIB = 1024 * 1024 * 1024;
const DISK_LOW_PCT = 10;
const DISK_RECOVER_PCT = 15;
const DISK_LOW_BYTES = 2 * GIB;
const DISK_RECOVER_BYTES = 3 * GIB;
const BACKUP_MAX_AGE_SECONDS = 30 * 60 * 60;
const ARENA_SILENCE_SECONDS = 15 * 60;
const SYNC_ERROR_THRESHOLD = 5;

function statDiskDefault(dir: string): DiskStat | undefined {
  try {
    const st = fs.statfsSync(dir);
    return {freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize};
  } catch {
    return undefined;
  }
}

function formatUtcTimestamp(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function formatGiB(bytes: number): string {
  return (bytes / GIB).toFixed(1);
}

export async function checkSystemHealth(
  token: string,
  config: Config,
  opts: HealthCheckOptions = {}
): Promise<void> {
  if (!config.staff?.length) return;
  const state = opts.state ?? new Map<string, string | undefined>();
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const statDisk = opts.statDisk ?? statDiskDefault;

  const diskPaths = opts.diskPaths ?? (fs.existsSync('/var/lib/pkmn') ? ['/var/lib/pkmn'] : []);
  for (const dir of diskPaths) {
    const stat = statDisk(dir);
    if (!stat || stat.totalBytes <= 0) continue;
    const freePct = Math.round((stat.freeBytes / stat.totalBytes) * 100);
    const key = `disk:${dir}`;
    if (freePct < DISK_LOW_PCT || stat.freeBytes < DISK_LOW_BYTES) {
      await notifyStaffAlert(
        token,
        config,
        {
          key,
          message:
            `Low disk space on \`${dir}\`: ${freePct}% free ` +
            `(${formatGiB(stat.freeBytes)} / ${formatGiB(stat.totalBytes)} GiB).`,
        },
        state,
        now
      );
    } else if (freePct >= DISK_RECOVER_PCT && stat.freeBytes >= DISK_RECOVER_BYTES) {
      await resolveStaffAlert(
        token,
        config,
        {
          key,
          message:
            `Disk space recovered on \`${dir}\`: ${freePct}% free ` +
            `(${formatGiB(stat.freeBytes)} / ${formatGiB(stat.totalBytes)} GiB).`,
        },
        state
      );
    }
  }

  const backupDir = opts.backupDir ??
    (fs.existsSync('/var/lib/pkmn/backups') ? '/var/lib/pkmn/backups' : undefined);
  const maxBackupAge = opts.maxBackupAgeSeconds ?? BACKUP_MAX_AGE_SECONDS;
  if (backupDir && fs.existsSync(backupDir)) {
    let newestMtimeSec: number | undefined;
    try {
      for (const name of fs.readdirSync(backupDir)) {
        if (!/^arena-.*\.sqlite\.zst$/.test(name)) continue;
        const mtimeSec = Math.floor(fs.statSync(path.join(backupDir, name)).mtimeMs / 1000);
        if (newestMtimeSec === undefined || mtimeSec > newestMtimeSec) {
          newestMtimeSec = mtimeSec;
        }
      }
    } catch {}

    if (newestMtimeSec !== undefined) {
      const ageSec = Math.max(0, now - newestMtimeSec);
      if (ageSec > maxBackupAge) {
        const ageHours = Math.floor(ageSec / 3600);
        await notifyStaffAlert(
          token,
          config,
          {
            key: 'vps-backup-stale',
            message: `Nightly server backup is stale (last backup ${ageHours}h ago).`,
          },
          state,
          now
        );
      } else {
        await resolveStaffAlert(
          token,
          config,
          {key: 'vps-backup-stale', message: 'Nightly server backup resumed.'},
          state
        );
      }
    } else if (
      opts.startedAtSeconds !== undefined &&
      now - opts.startedAtSeconds > maxBackupAge
    ) {
      await notifyStaffAlert(
        token,
        config,
        {
          key: 'vps-backup-stale',
          message: `No nightly server backups found in \`${backupDir}\`.`,
        },
        state,
        now
      );
    }
  }

  if (opts.getArenaLastContactAt) {
    const maxSilence = opts.maxArenaSilenceSeconds ?? ARENA_SILENCE_SECONDS;
    const lastContact = opts.getArenaLastContactAt();
    if (lastContact !== undefined) {
      const silentSec = now - lastContact;
      if (silentSec >= maxSilence) {
        const mins = Math.floor(silentSec / 60);
        await notifyStaffAlert(
          token,
          config,
          {
            key: 'arena-offline',
            message:
              `Arena has not checked in since \`${formatUtcTimestamp(lastContact)} UTC\` ` +
              `(${mins}m ago).`,
          },
          state,
          now
        );
      } else {
        await resolveStaffAlert(
          token,
          config,
          {key: 'arena-offline', message: 'Arena is back online.'},
          state
        );
      }
    } else if (
      opts.hasActiveLadder?.() &&
      opts.startedAtSeconds !== undefined &&
      now - opts.startedAtSeconds >= maxSilence
    ) {
      const mins = Math.floor((now - opts.startedAtSeconds) / 60);
      await notifyStaffAlert(
        token,
        config,
        {
          key: 'arena-offline',
          message: `Arena has not checked in since server start (${mins}m ago).`,
        },
        state,
        now
      );
    }
  }
}

async function trackSyncTaskFailure(
  token: string,
  config: Config,
  state: Map<string, string | undefined>,
  task: string,
  err: unknown
): Promise<void> {
  if (util.isConnectivityError(err)) return;
  const errKey = `sync-err:${task}`;
  const count = (Number(state.get(errKey)) || 0) + 1;
  state.set(errKey, String(count));
  if (count >= SYNC_ERROR_THRESHOLD) {
    const detail = err instanceof Error ? err.message : String(err);
    await notifyStaffAlert(
      token,
      config,
      {key: `sync:${task}`, message: `${task} failed ${count} cycles in a row.`, detail},
      state
    );
  }
}

function clearSyncTaskFailure(state: Map<string, string | undefined>, task: string) {
  state.delete(`sync-err:${task}`);
}

function displayName(user: User, members?: GuildMember[]): string {
  const member = members?.find(m => m.user.id === user.id);
  const rawName = member?.nick ?? member?.user.global_name ?? user.global_name ?? user.username;
  return rawName.replace(/[\r\n]+/g, ' ').trim() || user.username;
}

function resolveText(
  raw: string,
  mentions?: User[],
  members?: GuildMember[],
  channels?: GuildChannel[],
  roles?: GuildRole[]
): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/<@!?(\d+)>/g, (match, id: string) => {
      const user =
        mentions?.find(u => u.id === id) ??
        members?.find(m => m.user.id === id)?.user;
      return user ? `@${displayName(user, members)}` : match;
    })
    .replace(/<#(\d+)>/g, (match, id: string) => {
      const name = channels?.find(c => c.id === id)?.name;
      return name ? `#${name}` : match;
    })
    .replace(/<@&(\d+)>/g, (match, id: string) => {
      const name = roles?.find(r => r.id === id)?.name;
      return name ? `@${name}` : match;
    })
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_, sec: string) => {
      const d = new Date(Number(sec) * 1000);
      return isNaN(d.getTime()) ? _ : `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
    })
    .trim();
}

function formatPoll(poll: Poll): string {
  const q = poll.question.text?.trim() ?? 'Poll';
  const counts = new Map(poll.results?.answer_counts.map(c => [c.id, c.count]));
  const answers = poll.answers.map((a, i) => {
    const emoji = a.poll_media.emoji?.name ? `${a.poll_media.emoji.name} ` : '';
    const label = `${emoji}${a.poll_media.text ?? ''}`.trim();
    const count = counts.get(a.answer_id);
    return `${i + 1}. ${label}${count !== undefined ? ` (${count})` : ''}`;
  });
  return `[Poll: ${q}]${answers.length ? ` ${answers.join(' | ')}` : ''}`;
}

function formatBody(
  body: MessageBody,
  members?: GuildMember[],
  channels?: GuildChannel[],
  roles?: GuildRole[]
): string {
  const text = resolveText(body.content ?? '', body.mentions, members, channels, roles);
  const poll = body.poll ? formatPoll(body.poll) : '';
  const attachments = body.attachments?.map(a => a.url.split('?')[0]) ?? [];
  const embeds: string[] = [];
  for (const embed of body.embeds ?? []) {
    if (text && embed.type !== 'rich') continue;
    const parts: string[] = [];
    if (embed.title) parts.push(resolveText(embed.title, body.mentions, members, channels, roles));
    if (embed.description) {
      parts.push(resolveText(embed.description, body.mentions, members, channels, roles));
    }
    for (const f of embed.fields ?? []) {
      const name = resolveText(f.name, body.mentions, members, channels, roles);
      const val = resolveText(f.value, body.mentions, members, channels, roles);
      parts.push(`${name}: ${val}`);
    }
    if (embed.url && !text.includes(embed.url)) parts.push(embed.url);
    if (parts.length) embeds.push(`[Embed: ${parts.join(' — ')}]`);
  }
  const stickers = body.sticker_items?.map(s => `[Sticker: ${s.name}]`) ?? [];
  return [text, poll, ...attachments, ...embeds, ...stickers].filter(Boolean).join(' ');
}

export function formatMessage(
  message: Message,
  members?: GuildMember[],
  channels?: GuildChannel[],
  roles?: GuildRole[]
): {date: string; line: string} | undefined {
  // 0 = DEFAULT, 19 = REPLY, 20 = CHAT_INPUT_COMMAND, 21 = THREAD_STARTER_MESSAGE
  if (
    message.type !== undefined &&
    message.type !== 0 &&
    message.type !== 19 &&
    message.type !== 20 &&
    message.type !== 21
  ) {
    return undefined;
  }

  const main = formatBody(message, members, channels, roles);
  const snapshots = (message.message_snapshots ?? [])
    .map(s => formatBody(s.message, members, channels, roles))
    .filter(Boolean)
    .map(s => `[Forwarded] ${s}`);
  const content = [main, ...snapshots].filter(Boolean).join(' ');
  if (!content) return undefined;

  const iso = new Date(message.timestamp).toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 19);

  let prefix = '';
  const ref = message.referenced_message;
  if (ref) {
    const refIso = new Date(ref.timestamp).toISOString();
    const refDate = refIso.slice(0, 10);
    const refTime = refIso.slice(11, 19);
    const stamp = refDate === date ? refTime : `${refDate} ${refTime}`;
    prefix = `@${displayName(ref.author, members)}[${stamp}] `;
  } else if (message.type === 19) {
    prefix = '@[deleted] ';
  }

  const safeContent = content.replace(/\n/g, '\n  ');
  return {date, line: `[${time}] ${displayName(message.author, members)}: ${prefix}${safeContent}`};
}

export async function syncMessages(
  token: string,
  channel: string,
  dir = util.root('chat', 'logs'),
  cache: GuildCache = {}
) {
  const {members, channels, roles} = cache;
  fs.mkdirSync(dir, {recursive: true});
  const cursorFile = path.join(dir, '.cursor');
  let after = '0';
  const tailOffsets = new Map<string, number>();
  if (fs.existsSync(cursorFile)) {
    const lines = fs.readFileSync(cursorFile, 'utf8').trim().split('\n');
    after = lines[0]?.trim() || '0';
    for (let i = 1; i < lines.length; i++) {
      const [file, sizeStr] = lines[i].trim().split(' ');
      const size = Number(sizeStr);
      if (file && !isNaN(size)) tailOffsets.set(file, size);
    }
  }

  function restoreTail() {
    for (const [file, size] of tailOffsets) {
      const full = path.join(dir, file);
      if (size === 0) {
        fs.rmSync(full, {force: true});
      } else if (fs.existsSync(full)) {
        fs.truncateSync(full, size);
      }
    }
    tailOffsets.clear();
  }

  function writeSlice(slice: Message[], recordOffsets: boolean) {
    const byDate = new Map<string, string[]>();
    for (let i = slice.length - 1; i >= 0; i--) {
      const formatted = formatMessage(slice[i], members, channels, roles);
      if (!formatted) continue;
      let lines = byDate.get(formatted.date);
      if (!lines) {
        lines = [];
        byDate.set(formatted.date, lines);
      }
      lines.push(formatted.line);
    }

    for (const [date, lines] of byDate) {
      const file = `${date}.txt`;
      const full = path.join(dir, file);
      if (recordOffsets && !tailOffsets.has(file)) {
        tailOffsets.set(file, fs.existsSync(full) ? fs.statSync(full).size : 0);
      }
      fs.appendFileSync(full, `${lines.join('\n')}\n`);
    }
  }

  function saveCursor() {
    const offsetLines = Array.from(tailOffsets.entries()).map(([f, s]) => `${f} ${s}`);
    util.writeFileAtomic(cursorFile, `${[after, ...offsetLines].join('\n')}\n`);
  }

  let page = await discordRequest(
    token,
    `/channels/${channel}/messages?limit=100&after=${after}`
  ) as Message[];
  restoreTail();

  while (page.length === 100) {
    const next = await discordRequest(
      token,
      `/channels/${channel}/messages?limit=100&after=${page[0].id}`
    ) as Message[];
    if (next.length > 0) {
      writeSlice(page, false);
      after = page[0].id;
      saveCursor();
      page = next;
    } else {
      writeSlice(page.slice(50), false);
      after = page[50].id;
      page = page.slice(0, 50);
      break;
    }
  }

  if (page.length > 0) {
    writeSlice(page, true);
  }
  saveCursor();
}

export async function syncPins(
  token: string,
  channel: string,
  pins: string[],
  state?: Map<string, string | undefined>
) {
  const key = JSON.stringify(pins);
  if (state?.has(channel) && state.get(channel) === key) return;

  const data = await discordRequest(
    token,
    `/channels/${channel}/messages/pins`
  ) as {items?: Array<{message: Message}>} | undefined;
  const items = Array.isArray(data?.items) ? data.items : [];
  const current = items.map(i => i.message);
  let ownBotId: string | undefined;
  const cachedApp = state?.get('app');
  if (cachedApp) {
    try {
      ownBotId = (JSON.parse(cachedApp) as {id?: string}).id;
    } catch {}
  }
  const isOwnBotMessage = (m: Message) =>
    Boolean(m.author?.bot && (!ownBotId || m.author.id === ownBotId));

  if (
    current.length === pins.length &&
    current.every((m, i) => isOwnBotMessage(m) && !m.edited_timestamp && m.content === pins[i])
  ) {
    state?.set(channel, key);
    return;
  }

  for (const m of current) {
    await discordRequest(
      token,
      `/channels/${channel}/messages/pins/${m.id}`,
      {method: 'DELETE'}
    );
  }

  const used = new Set<string>();
  const toPin: Message[] = [];
  for (let i = pins.length - 1; i >= 0; i--) {
    const content = pins[i];
    const existing = current.find(
      m => !used.has(m.id) && isOwnBotMessage(m) && !m.edited_timestamp && m.content === content
    );
    if (existing) {
      used.add(existing.id);
      toPin.push(existing);
    } else {
      const created = await discordRequest(
        token,
        `/channels/${channel}/messages`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({content}),
        }
      ) as Message;
      toPin.push(created);
    }
  }

  for (const m of current) {
    if (isOwnBotMessage(m) && !used.has(m.id)) {
      await discordRequest(
        token,
        `/channels/${channel}/messages/${m.id}`,
        {method: 'DELETE'}
      );
    }
  }

  for (const m of toPin) {
    await discordRequest(
      token,
      `/channels/${channel}/messages/pins/${m.id}`,
      {method: 'PUT'}
    );
  }

  if (toPin.length > 0) {
    const recent = await discordRequest(
      token,
      `/channels/${channel}/messages?limit=${Math.min(100, toPin.length * 2 + 10)}`
    ) as Message[];
    if (Array.isArray(recent)) {
      for (const m of recent) {
        if (m.type === 6 && isOwnBotMessage(m)) {
          await discordRequest(
            token,
            `/channels/${channel}/messages/${m.id}`,
            {method: 'DELETE'}
          );
        }
      }
    }
  }

  state?.set(channel, key);
}

export function formatGlossary(raw: string): string {
  const blocks = raw.trim().split(/\n\s*\n/).map(block => {
    if (/^\s*(?:-\s+|\d+\.\s+)/.test(block)) {
      return block
        .trim()
        .split(/\n(?=\s*(?:-\s+|\d+\.\s+))/)
        .map(item => item.trim().replace(/^(-|\d+\.)\s+/, '$1 ').replace(/\s*\n\s*/g, ' '))
        .join('\n');
    }
    return block.trim().replace(/\s*\n\s*/g, ' ');
  });
  let text = blocks.join('\n\n');
  text = text.replace(/\$`([^`]+)`/g, (_, m: string) => {
    const clean = m
      .replace(/\\widetilde\{([^}]+)\}/g, '~$1')
      .replace(/\\mid\b/g, '|')
      .replace(/\\land\b/g, '∧')
      .replace(/\\alpha\b/g, 'α')
      .replace(/\\beta\b/g, 'β')
      .replace(/\\%/g, '%')
      .replace(/\s+/g, ' ')
      .trim();
    return `\`${clean}\``;
  });
  text = text.replace(/\[([^\][]+)\]\{\.(?:dfn|seed)\}/g, '**$1**');
  text = text.replace(
    /\[([^\][]+)\]\(([^)]+)\)(?:\{\.subtle\})?/g,
    (_, label: string, url: string) => {
      const full = url.startsWith('#')
        ? `https://pkmn.ai/glossary/${url}`
        : url.startsWith('/')
          ? `https://pkmn.ai${url}`
          : url;
      return `[${label}](${full})`;
    }
  );
  text = text.replace(/\[((?:[^\][]|\[[^\][]*\]\([^)]+\))+)\]\{\.(?:dfn|seed)\}/g, '**$1**');
  return text.replace(/---/g, '—').replace(/--/g, '–');
}

export function formatGlossaryReply(term: string, raw: string): string {
  const url = `https://pkmn.ai/glossary/#${util.slugify(term)}`;
  const full = `**[${term}](${url})**: ${formatGlossary(raw)}`;
  if (full.length <= DISCORD_MAX_MESSAGE_LEN) return full;
  const suffix = `… ([more](${url}))`;
  const head = full.slice(0, Math.max(0, DISCORD_MAX_MESSAGE_LEN - suffix.length)).trimEnd();
  return `${head}${suffix}`;
}

interface GlossaryIndex {
  keyCount: number;
  sortedTerms: string[];
  aliases: Array<{alias: string; term: string}>;
}

const GLOSSARY_INDEX = Symbol('pkmn.glossaryIndex');

function extractGlossaryAliases(
  glossary: Record<string, string>
): Array<{alias: string; term: string}> {
  const terms = Object.keys(glossary);
  const topIds = new Set(terms.map(util.toID));
  const bySlug = new Map(terms.map(t => [util.slugify(t).toLowerCase(), t]));
  const aliases: Array<{alias: string; term: string}> = [];

  for (const [term, raw] of Object.entries(glossary)) {
    const flat = raw.replace(/\s+/g, ' ');
    for (const m of flat.matchAll(/\[\[([^\][]+)\]\(#([^)]+)\)\]\{\.dfn\}/g)) {
      const alias = m[1].trim();
      const target = bySlug.get(m[2].toLowerCase()) ?? term;
      if (!topIds.has(util.toID(alias))) {
        aliases.push({alias, term: target});
      }
    }
    const stripped = flat.replace(/\[([^\][]+)\]\([^)]+\)(?:\{\.subtle\})?/g, '$1');
    for (const m of stripped.matchAll(/\[([^\][]+)\]\{\.dfn\}/g)) {
      const alias = m[1].trim();
      const aliasId = util.toID(alias);
      if (!topIds.has(aliasId) && !aliases.some(a => util.toID(a.alias) === aliasId)) {
        aliases.push({alias, term});
      }
    }
  }
  return aliases;
}

function getGlossaryIndex(glossary: Record<string, string>): GlossaryIndex {
  const keys = Object.keys(glossary);
  const holder = glossary as Record<PropertyKey, unknown>;
  const cached = holder[GLOSSARY_INDEX] as GlossaryIndex | undefined;
  if (cached?.keyCount === keys.length) return cached;
  const built: GlossaryIndex = {
    keyCount: keys.length,
    sortedTerms: keys
      .slice()
      .sort((a, b) => a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase())),
    aliases: extractGlossaryAliases(glossary),
  };
  Object.defineProperty(glossary, GLOSSARY_INDEX, {
    value: built,
    configurable: true,
  });
  return built;
}

export function lookupGlossary(
  query: string,
  glossary: Record<string, string>
): {term: string; definition: string} | undefined {
  const q = query.trim();
  if (!q) return undefined;
  if (Object.prototype.hasOwnProperty.call(glossary, q)) {
    return {term: q, definition: glossary[q]};
  }
  const terms = Object.keys(glossary);
  const lower = q.toLowerCase();
  const slug = util.slugify(q).toLowerCase();
  const id = util.toID(q);

  const match =
    terms.find(t => t.toLowerCase() === lower) ??
    (slug ? terms.find(t => util.slugify(t).toLowerCase() === slug) : undefined) ??
    (id ? terms.find(t => util.toID(t) === id) : undefined);
  if (match) return {term: match, definition: glossary[match]};

  const {aliases} = getGlossaryIndex(glossary);
  const aliasMatch =
    aliases.find(a => a.alias.toLowerCase() === lower) ??
    (id ? aliases.find(a => util.toID(a.alias) === id) : undefined);
  if (aliasMatch) {
    return {term: aliasMatch.term, definition: glossary[aliasMatch.term]};
  }

  const prefixTerm = terms.find(
    t => t.toLowerCase().startsWith(lower) || Boolean(id && util.toID(t).startsWith(id))
  );
  if (prefixTerm) return {term: prefixTerm, definition: glossary[prefixTerm]};

  const prefixAlias = aliases.find(
    a => a.alias.toLowerCase().startsWith(lower) || Boolean(id && util.toID(a.alias).startsWith(id))
  );
  if (prefixAlias) {
    return {term: prefixAlias.term, definition: glossary[prefixAlias.term]};
  }
  return undefined;
}

export function autocompleteGlossary(
  query: string,
  glossary: Record<string, string>
): Array<{name: string; value: string}> {
  const {sortedTerms: terms, aliases} = getGlossaryIndex(glossary);
  const q = query.trim();
  if (!q) {
    return terms.slice(0, 25).map(t => ({name: t, value: t}));
  }

  const lower = q.toLowerCase();
  const id = util.toID(q);
  const choices: Array<{name: string; value: string}> = [];
  const seen = new Set<string>();

  const add = (name: string, value: string) => {
    if (seen.has(value) || choices.length >= 25) return;
    seen.add(value);
    choices.push({name: name.slice(0, 100), value});
  };

  for (const t of terms) {
    if (t.toLowerCase().startsWith(lower) || (id && util.toID(t).startsWith(id))) {
      add(t, t);
    }
  }
  for (const a of aliases) {
    if (a.alias.toLowerCase().startsWith(lower) || (id && util.toID(a.alias).startsWith(id))) {
      add(`${a.alias} (${a.term})`, a.term);
    }
  }
  for (const t of terms) {
    if (t.toLowerCase().includes(lower) || (id && util.toID(t).includes(id))) {
      add(t, t);
    }
  }
  for (const a of aliases) {
    if (a.alias.toLowerCase().includes(lower) || (id && util.toID(a.alias).includes(id))) {
      add(`${a.alias} (${a.term})`, a.term);
    }
  }
  for (const t of terms) {
    if (glossary[t].toLowerCase().includes(lower)) {
      add(t, t);
    }
  }

  return choices;
}

const WATCH_ARM_PREFIX = 'watch:arm:';
const WATCH_CANCEL_PREFIX = 'watch:cancel:';
const WATCH_CLEAR_ID = 'watch:clear';
const WATCH_ARM_RE = /^watch:arm:(\d+):(\d+):(any|l:[^:\s]+|t:[^:\s]+)$/;
const WATCH_CANCEL_RE = /^watch:cancel:(\d+)$/;

export function formatWatchArmCustomId(watch: {
  agentId: number;
  opponentId?: number;
  ladderId?: string;
  tournamentId?: string;
}): string {
  const scope = watch.ladderId
    ? `l:${watch.ladderId}`
    : watch.tournamentId
      ? `t:${watch.tournamentId}`
      : 'any';
  return `${WATCH_ARM_PREFIX}${watch.agentId}:${watch.opponentId ?? 0}:${scope}`;
}

function parseWatchArmCustomId(customId: string): {
  agentId: number;
  opponentId?: number;
  ladderId?: string;
  tournamentId?: string;
} | undefined {
  const match = WATCH_ARM_RE.exec(customId);
  if (!match) return undefined;
  const agentId = Number(match[1]);
  const rawOpp = Number(match[2]);
  if (!Number.isSafeInteger(agentId) || agentId <= 0) return undefined;
  if (!Number.isSafeInteger(rawOpp) || rawOpp < 0) return undefined;
  const opponentId = rawOpp > 0 ? rawOpp : undefined;
  if (opponentId === agentId) return undefined;
  const scope = match[3];
  if (scope === 'any') return {agentId, opponentId};
  if (scope.startsWith('l:')) return {agentId, opponentId, ladderId: scope.slice(2)};
  if (scope.startsWith('t:')) return {agentId, opponentId, tournamentId: scope.slice(2)};
  return undefined;
}

export function formatWatchLabel(watch: {
  agentName: string;
  opponentName?: string;
  ladderName?: string;
  tournamentName?: string;
}): string {
  const agents = watch.opponentName
    ? `**${watch.agentName}** vs **${watch.opponentName}**`
    : `**${watch.agentName}**`;
  if (watch.ladderName) return `${agents} on **${watch.ladderName}**`;
  if (watch.tournamentName) return `${agents} in **${watch.tournamentName}**`;
  return agents;
}

export function autocompleteWatchAgents(
  query: string,
  database: db.Database,
  exclude?: string
): Array<{name: string; value: string}> {
  const agents = database.listWatchableAgents();
  const exTrimmed = exclude?.trim();
  let excludedAgentId: number | undefined;
  if (exTrimmed) {
    const exLower = exTrimmed.toLowerCase();
    const exId = util.toID(exTrimmed);
    excludedAgentId = (
      agents.find(a => a.slug === exLower) ??
      agents.find(a => a.name.toLowerCase() === exLower) ??
      (exId ? agents.find(a => util.toID(a.name) === exId) : undefined)
    )?.id;
  }
  const q = query.trim();
  const lower = q.toLowerCase();
  const id = util.toID(q);

  const choices: Array<{name: string; value: string}> = [];
  const seen = new Set<string>();
  const add = (a: db.WatchableAgent) => {
    if (excludedAgentId === a.id) return;
    if (seen.has(a.slug) || choices.length >= 25) return;
    seen.add(a.slug);
    const label = a.active ? a.name : `${a.name} (inactive)`;
    choices.push({name: label.slice(0, 100), value: a.slug});
  };

  if (!q) {
    for (const a of agents) add(a);
    return choices;
  }

  for (const a of agents) {
    if (
      a.name.toLowerCase().startsWith(lower) ||
      a.slug.toLowerCase().startsWith(lower) ||
      Boolean(id && util.toID(a.name).startsWith(id))
    ) {
      add(a);
    }
  }
  for (const a of agents) {
    if (
      a.name.toLowerCase().includes(lower) ||
      a.slug.toLowerCase().includes(lower) ||
      Boolean(id && util.toID(a.name).includes(id))
    ) {
      add(a);
    }
  }
  return choices;
}

export function autocompleteWatchEvents(
  query: string,
  database: db.Database
): Array<{name: string; value: string}> {
  const ladders = database.getLadders().filter(l => l.status !== 'archived');
  const tournaments = database.getTournaments().filter(t => t.status !== 'completed');

  interface EventChoice {
    label: string;
    value: string;
    keys: string[];
    priority: number;
  }
  const items: EventChoice[] = [];
  for (const t of tournaments) {
    const badge = t.status === 'running' ? 'live' : 'scheduled';
    items.push({
      label: `${t.name} (${badge})`,
      value: `tournament:${t.id}`,
      keys: [t.name, t.id, t.format, `tournament ${t.id}`, `t#${t.id}`],
      priority: t.status === 'running' ? 0 : 2,
    });
  }
  for (const l of ladders) {
    const suffix = l.status === 'upcoming' ? `${l.format} · upcoming` : l.format;
    items.push({
      label: `${l.name} (${suffix})`,
      value: `ladder:${l.id}`,
      keys: [l.name, l.id, l.slot, l.format],
      priority: l.status === 'active' || l.status === 'settling' ? 1 : 3,
    });
  }
  items.sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label));

  const q = query.trim();
  const lower = q.toLowerCase();
  const id = util.toID(q);
  const choices: Array<{name: string; value: string}> = [];
  const seen = new Set<string>();
  const add = (item: EventChoice) => {
    if (seen.has(item.value) || choices.length >= 25) return;
    seen.add(item.value);
    choices.push({name: item.label.slice(0, 100), value: item.value});
  };

  if (!q) {
    for (const item of items) add(item);
    return choices;
  }
  for (const item of items) {
    if (
      item.keys.some(k => k.toLowerCase().startsWith(lower)) ||
      (Boolean(id) && item.keys.some(k => util.toID(k).startsWith(id)))
    ) {
      add(item);
    }
  }
  for (const item of items) {
    if (
      item.keys.some(k => k.toLowerCase().includes(lower)) ||
      (Boolean(id) && item.keys.some(k => util.toID(k).includes(id)))
    ) {
      add(item);
    }
  }
  return choices;
}

function resolveWatchAgent(database: db.Database, raw: string): db.AgentRow | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const bySlug = database.getAgentBySlug(trimmed.toLowerCase());
  if (bySlug && bySlug.status !== 'disabled') return bySlug;

  const lower = trimmed.toLowerCase();
  const targetId = util.toID(trimmed);
  const all = database.getAllAgents().filter(a => a.status !== 'disabled');
  return (
    all.find(a => a.name.toLowerCase() === lower) ??
    (targetId ? all.find(a => util.toID(a.name) === targetId) : undefined)
  );
}

function resolveWatchEvent(
  database: db.Database,
  raw: string
): {ladder?: db.LadderRow; tournament?: db.TournamentRow; error?: string} {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  if (trimmed.startsWith('ladder:')) {
    const id = trimmed.slice('ladder:'.length);
    const ladder = database.getLadder(id);
    if (!ladder) {
      const safe = id.replace(/[`\r\n]+/g, ' ').slice(0, 60);
      return {error: `Unknown ladder: \`${safe}\`.`};
    }
    if (ladder.status === 'archived') {
      return {error: `Ladder **${ladder.name}** is archived and no longer runs live matches.`};
    }
    return {ladder};
  }
  if (trimmed.startsWith('tournament:')) {
    const id = trimmed.slice('tournament:'.length);
    const tournament = database.getTournament(id);
    if (!tournament) {
      const safe = id.replace(/[`\r\n]+/g, ' ').slice(0, 60);
      return {error: `Unknown tournament: \`${safe}\`.`};
    }
    if (tournament.status === 'completed') {
      return {error: `Tournament **${tournament.name}** has already completed.`};
    }
    return {tournament};
  }

  const lower = trimmed.toLowerCase();
  const targetId = util.toID(trimmed);
  const ladders = database.getLadders().filter(l => l.status !== 'archived');
  const matchedLadder =
    ladders.find(l => l.id.toLowerCase() === lower) ??
    ladders.find(l => l.name.toLowerCase() === lower || l.slot.toLowerCase() === lower) ??
    ladders.find(l => l.format.toLowerCase() === lower) ??
    (targetId ? ladders.find(l => util.toID(l.name) === targetId) : undefined);
  if (matchedLadder) return {ladder: matchedLadder};

  const tournaments = database.getTournaments().filter(t => t.status !== 'completed');
  const matchedTournament =
    tournaments.find(t => t.id.toLowerCase() === lower) ??
    tournaments.find(t => t.name.toLowerCase() === lower) ??
    (targetId ? tournaments.find(t => util.toID(t.name) === targetId) : undefined);
  if (matchedTournament) return {tournament: matchedTournament};

  const safe = trimmed.replace(/[`\r\n]+/g, ' ').slice(0, 80);
  return {error: `Unknown or inactive event: \`${safe}\`.`};
}

export function formatLiveMatchWatchDm(
  database: db.Database,
  match: LiveMatchSnapshot
): {content: string; url: string} {
  const ladder = database.getLadder(match.ladderId);
  const ladderLabel = ladder?.name ?? match.ladderId;
  const modeNote = ladder && ladder.team !== 'random' ? ' (live telemetry)' : '';
  const url = 'https://pkmn.ai/arena/battles/';
  return {
    url,
    content:
      `**${match.p1.name}** (\`${match.p1.version}\`) vs ` +
      `**${match.p2.name}** (\`${match.p2.version}\`) ` +
      `is live on **${ladderLabel}**${modeNote} — <${url}>`,
  };
}

export function formatLiveTournamentWatchDm(
  database: db.Database,
  game: LiveTournamentGameSnapshot
): {content: string; url: string} {
  const tournament = database.getTournament(game.tournamentId);
  const tourneyName = game.tournamentName ?? tournament?.name ?? `Tournament #${game.tournamentId}`;
  const url =
    `https://pkmn.ai/arena/tournaments/${encodeURIComponent(game.tournamentId)}/` +
    `#table=${game.table}`;
  const p1Ver = game.p1.version ? ` (\`${game.p1.version}\`)` : '';
  const p2Ver = game.p2.version ? ` (\`${game.p2.version}\`)` : '';
  const stagePart = game.stage ? ` (${game.stage})` : '';
  return {
    url,
    content:
      `**${game.p1.name}**${p1Ver} vs **${game.p2.name}**${p2Ver} ` +
      `is live on **Table ${game.table}** of **${tourneyName}**${stagePart} — <${url}>`,
  };
}

function watchSpecificity(w: db.DiscordWatchView): number {
  return (w.opponentId !== undefined ? 2 : 0) + (w.ladderId || w.tournamentId ? 1 : 0);
}

async function dispatchWatchDms(
  token: string,
  consumed: db.DiscordWatchView[],
  message: {content: string; url: string},
  state: Map<string, string | undefined>,
  deadlineMillis = Date.now() + WATCH_DM_MAX_AGE_MILLIS
): Promise<number> {
  if (consumed.length === 0) return 0;
  // Dedupe per recipient so a user watching both sides (or both broad + matchup) receives one DM,
  // preserving their most specific watch on the "Watch next match" re-arm button.
  const bestByUser = new Map<string, db.DiscordWatchView>();
  for (const w of consumed) {
    const prev = bestByUser.get(w.discordId);
    if (!prev || watchSpecificity(w) > watchSpecificity(prev)) {
      bestByUser.set(w.discordId, w);
    }
  }

  let sent = 0;
  for (const [discordId, watch] of bestByUser) {
    if (Date.now() > deadlineMillis) break;
    const components: ActionRowComponent[] = [
      {
        type: 1,
        components: [
          {type: 2, style: 5, label: 'Watch Live', url: message.url},
          {
            type: 2,
            style: 2,
            label: 'Watch next match',
            custom_id: formatWatchArmCustomId(watch),
          },
        ],
      },
    ];
    try {
      const outcome = await sendDirectMessage(token, discordId, message.content, state, {
        components,
      });
      if (outcome === 'sent') sent++;
    } catch (err) {
      console.error(`Error sending live watch DM to ${discordId}:`, err);
      if ((err as {status?: number})?.status === 429) {
        // Stop hammering Discord for the remaining recipients after a persistent 429.
        break;
      }
    }
  }
  return sent;
}

export async function notifyLiveMatch(
  database: db.Database,
  token: string,
  match: LiveMatchSnapshot,
  state = new Map<string, string | undefined>(),
  deadlineMillis?: number
): Promise<number> {
  const p1Agent = database.getAgentBySlug(match.p1.slug);
  const p2Agent = database.getAgentBySlug(match.p2.slug);
  if (!p1Agent || !p2Agent) return 0;
  const consumed = database.consumeMatchingDiscordWatches({
    p1AgentId: p1Agent.id,
    p2AgentId: p2Agent.id,
    ladderId: match.ladderId,
  });
  if (consumed.length === 0) return 0;
  return dispatchWatchDms(
    token,
    consumed,
    formatLiveMatchWatchDm(database, match),
    state,
    deadlineMillis
  );
}

export async function notifyLiveTournamentGame(
  database: db.Database,
  token: string,
  game: LiveTournamentGameSnapshot,
  state = new Map<string, string | undefined>(),
  deadlineMillis?: number
): Promise<number> {
  const p1Agent = database.getAgentBySlug(game.p1.slug);
  const p2Agent = database.getAgentBySlug(game.p2.slug);
  if (!p1Agent || !p2Agent) return 0;
  const consumed = database.consumeMatchingDiscordWatches({
    p1AgentId: p1Agent.id,
    p2AgentId: p2Agent.id,
    tournamentId: game.tournamentId,
  });
  if (consumed.length === 0) return 0;
  return dispatchWatchDms(
    token,
    consumed,
    formatLiveTournamentWatchDm(database, game),
    state,
    deadlineMillis
  );
}

function getInteractionUserId(interaction: Interaction): string | undefined {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

function ephemeralReply(
  content: string,
  components?: ActionRowComponent[]
): {status: number; headers: Record<string, string>; body: string} {
  return {
    status: 200,
    headers: {'content-type': 'application/json; charset=utf-8'},
    body: JSON.stringify({
      type: 4,
      data: {
        content,
        flags: 68,
        ...(components?.length ? {components} : {}),
      },
    }),
  };
}

function slugsMatchWatch(
  p1Slug: string,
  p2Slug: string,
  agentSlug: string,
  opponentSlug?: string
): boolean {
  if (!opponentSlug) return p1Slug === agentSlug || p2Slug === agentSlug;
  return (
    (p1Slug === agentSlug && p2Slug === opponentSlug) ||
    (p1Slug === opponentSlug && p2Slug === agentSlug)
  );
}

function findCurrentLiveMatchForWatch(
  database: db.Database,
  ctx: InteractionContext,
  target: {
    agent: db.AgentRow;
    opponent?: db.AgentRow;
    ladder?: db.LadderRow;
    tournament?: db.TournamentRow;
  }
): {content: string; url: string} | undefined {
  if (!target.tournament) {
    const live = ctx.getLiveMatch?.();
    if (
      live &&
      (!target.ladder || live.ladderId === target.ladder.id) &&
      slugsMatchWatch(live.p1.slug, live.p2.slug, target.agent.slug, target.opponent?.slug)
    ) {
      return formatLiveMatchWatchDm(database, live);
    }
  }
  if (!target.ladder) {
    for (const game of ctx.getLiveTournamentGames?.() ?? []) {
      if (target.tournament && game.tournamentId !== target.tournament.id) continue;
      if (slugsMatchWatch(game.p1.slug, game.p2.slug, target.agent.slug, target.opponent?.slug)) {
        return formatLiveTournamentWatchDm(database, game);
      }
    }
  }
  return undefined;
}

function armWatchReply(
  database: db.Database,
  discordId: string,
  input: {
    agentId: number;
    opponentId?: number;
    ladderId?: string;
    tournamentId?: string;
    now?: number;
  }
): {status: number; headers: Record<string, string>; body: string} {
  const res = database.addDiscordWatch({discordId, ...input});
  if (res.status === 'limit') {
    return ephemeralReply(
      `You already have ${res.limit} active watches (maximum). ` +
      'Run `/watch` to view them or clear them below.',
      [
        {
          type: 1,
          components: [{type: 2, style: 4, label: 'Clear all watches', custom_id: WATCH_CLEAR_ID}],
        },
      ]
    );
  }
  const watch = res.watch!;
  const label = formatWatchLabel(watch);
  const cancelRow: ActionRowComponent[] = [
    {
      type: 1,
      components: [
        {type: 2, style: 2, label: 'Cancel watch', custom_id: `${WATCH_CANCEL_PREFIX}${watch.id}`},
      ],
    },
  ];
  if (res.status === 'exists') {
    return ephemeralReply(
      `Already watching ${label} — I'll DM you once when the next match goes live.`,
      cancelRow
    );
  }
  return ephemeralReply(
    `Watching ${label} — I'll DM you once when the next match goes live ` +
    '(make sure DMs from this server are enabled).',
    cancelRow
  );
}

function handleWatchCommand(
  interaction: Interaction,
  ctx: InteractionContext
): {status: number; headers: Record<string, string>; body?: string} {
  const database = ctx.db;
  const userId = getInteractionUserId(interaction);
  if (!database || !userId) {
    return ephemeralReply('Match watches are temporarily unavailable.');
  }

  const opts = interaction.data?.options ?? [];
  const agentRaw = opts.find(o => o.name === 'agent')?.value?.trim() ?? '';
  const opponentRaw = opts.find(o => o.name === 'opponent')?.value?.trim() ?? '';
  const eventRaw = opts.find(o => o.name === 'event')?.value?.trim() ?? '';

  if (!agentRaw) {
    if (opponentRaw || eventRaw) {
      return ephemeralReply(
        'Specify an `agent` to watch (or omit all options to list your active watches).'
      );
    }
    const watches = database.listDiscordWatchesForUser(userId);
    if (watches.length === 0) {
      return ephemeralReply(
        'You have no active match watches. Use `/watch agent:<name>` to get a one-shot DM ' +
        'when an agent or matchup goes live.'
      );
    }
    const lines = watches.map((w, idx) => `${idx + 1}. ${formatWatchLabel(w)}`);
    const cancelButtons: ButtonComponent[] = watches.slice(0, 5).map((w, idx) => ({
      type: 2,
      style: 2,
      label: watches.length === 1 ? 'Cancel watch' : `Cancel #${idx + 1}`,
      custom_id: `${WATCH_CANCEL_PREFIX}${w.id}`,
    }));
    const rows: ActionRowComponent[] = [{type: 1, components: cancelButtons}];
    if (watches.length > 1) {
      rows.push({
        type: 1,
        components: [{type: 2, style: 4, label: 'Clear all', custom_id: WATCH_CLEAR_ID}],
      });
    }
    return ephemeralReply(`**Your active match watches:**\n${lines.join('\n')}`, rows);
  }

  const agent = resolveWatchAgent(database, agentRaw);
  if (!agent) {
    const safe = agentRaw.replace(/[`\r\n]+/g, ' ').slice(0, 80);
    return ephemeralReply(`Unknown agent: \`${safe}\`.`);
  }

  let opponent: db.AgentRow | undefined;
  if (opponentRaw) {
    opponent = resolveWatchAgent(database, opponentRaw);
    if (!opponent) {
      const safe = opponentRaw.replace(/[`\r\n]+/g, ' ').slice(0, 80);
      return ephemeralReply(`Unknown opponent: \`${safe}\`.`);
    }
    if (opponent.id === agent.id) {
      return ephemeralReply(
        'Specify a different `opponent`, or omit `opponent` to watch all matches for ' +
        `**${agent.name}**.`
      );
    }
  }

  const eventRes = resolveWatchEvent(database, eventRaw);
  if (eventRes.error) {
    return ephemeralReply(eventRes.error);
  }

  const liveNow = findCurrentLiveMatchForWatch(database, ctx, {
    agent,
    opponent,
    ladder: eventRes.ladder,
    tournament: eventRes.tournament,
  });
  if (liveNow) {
    const canonical = opponent && opponent.id < agent.id
      ? {agentId: opponent.id, opponentId: agent.id}
      : {agentId: agent.id, opponentId: opponent?.id};
    const armId = formatWatchArmCustomId({
      ...canonical,
      ladderId: eventRes.ladder?.id,
      tournamentId: eventRes.tournament?.id,
    });
    return ephemeralReply(liveNow.content, [
      {
        type: 1,
        components: [
          {type: 2, style: 5, label: 'Watch Live', url: liveNow.url},
          {type: 2, style: 2, label: 'Watch next match', custom_id: armId},
        ],
      },
    ]);
  }

  return armWatchReply(database, userId, {
    agentId: agent.id,
    opponentId: opponent?.id,
    ladderId: eventRes.ladder?.id,
    tournamentId: eventRes.tournament?.id,
    now: ctx.nowSeconds?.(),
  });
}

function handleWatchComponent(
  interaction: Interaction,
  ctx: InteractionContext
): {status: number; headers: Record<string, string>; body?: string} {
  const database = ctx.db;
  const userId = getInteractionUserId(interaction);
  const customId = interaction.data?.custom_id ?? '';
  if (!database || !userId) {
    return ephemeralReply('Match watches are temporarily unavailable.');
  }

  if (customId === WATCH_CLEAR_ID) {
    const cleared = database.clearDiscordWatchesForUser(userId);
    if (cleared === 0) {
      return ephemeralReply('You have no active match watches.');
    }
    return ephemeralReply(`Cleared ${cleared} active ${cleared === 1 ? 'watch' : 'watches'}.`);
  }

  const cancelMatch = WATCH_CANCEL_RE.exec(customId);
  if (cancelMatch) {
    const watchId = Number(cancelMatch[1]);
    if (!Number.isSafeInteger(watchId) || watchId <= 0) {
      return ephemeralReply('Invalid watch reference.');
    }
    const deleted = database.deleteDiscordWatchForUser(userId, watchId);
    return ephemeralReply(
      deleted ? 'Watch cancelled.' : 'That watch was already triggered or cancelled.'
    );
  }

  const arm = parseWatchArmCustomId(customId);
  if (arm) {
    if (database.countDiscordMembers() > 0 && !database.isDiscordMember(userId)) {
      return ephemeralReply(
        'Match watch notifications are only available to members of the pkmn.ai Discord server.'
      );
    }
    const agent = database.getAgentById(arm.agentId);
    if (!agent || agent.status === 'disabled') {
      return ephemeralReply('That agent is no longer active.');
    }
    if (arm.opponentId !== undefined) {
      const opp = database.getAgentById(arm.opponentId);
      if (!opp || opp.status === 'disabled') {
        return ephemeralReply('That opponent is no longer active.');
      }
    }
    if (arm.ladderId) {
      const ladder = database.getLadder(arm.ladderId);
      if (!ladder || ladder.status === 'archived') {
        return ephemeralReply('That ladder has already been archived.');
      }
    }
    if (arm.tournamentId) {
      const tourney = database.getTournament(arm.tournamentId);
      if (!tourney || tourney.status === 'completed') {
        return ephemeralReply('That tournament has already completed.');
      }
    }
    return armWatchReply(database, userId, {
      ...arm,
      now: ctx.nowSeconds?.(),
    });
  }

  return {status: 400, headers: {}};
}

export function verifySignature(
  body: string | Buffer,
  signature: string | undefined,
  timestamp: string | undefined,
  verifyKey: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  if (!signature || !timestamp || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  if (!/^\d+$/.test(timestamp)) return false;
  const tsSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(tsSeconds) ||
    Math.abs(nowSeconds - tsSeconds) > MAX_INTERACTION_SKEW_SECONDS
  ) {
    return false;
  }
  if (!/^[0-9a-f]{64}$/i.test(verifyKey)) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(verifyKey, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    return crypto.verify(
      null,
      Buffer.concat([Buffer.from(timestamp, 'utf8'), bodyBuf]),
      key,
      Buffer.from(signature, 'hex')
    );
  } catch {
    return false;
  }
}

export function handleInteraction(
  body: string | Buffer,
  reqHeaders: http.IncomingHttpHeaders,
  verifyKey: string | undefined,
  glossary: Record<string, string>,
  ctx: InteractionContext = {}
): {status: number; headers: Record<string, string>; body?: string} {
  const sig = reqHeaders['x-signature-ed25519'];
  const ts = reqHeaders['x-signature-timestamp'];
  if (
    !verifyKey ||
    typeof sig !== 'string' ||
    typeof ts !== 'string' ||
    !verifySignature(body, sig, ts, verifyKey, ctx.nowSeconds?.())
  ) {
    return {status: 401, headers: {}};
  }

  let interaction: Interaction;
  try {
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : body;
    interaction = JSON.parse(text) as Interaction;
  } catch {
    return {status: 400, headers: {}};
  }

  const jsonHeaders = {'content-type': 'application/json; charset=utf-8'};
  if (interaction.type === 1) {
    return {status: 200, headers: jsonHeaders, body: JSON.stringify({type: 1})};
  }

  if (interaction.type === 3 && interaction.data?.custom_id?.startsWith('watch:')) {
    return handleWatchComponent(interaction, ctx);
  }

  const cmd = interaction.data?.name;
  const termOpt = interaction.data?.options?.find(o => o.name === 'term')?.value ?? '';

  if (interaction.type === 4 && cmd === 'define') {
    const choices = autocompleteGlossary(termOpt, glossary);
    return {
      status: 200,
      headers: jsonHeaders,
      body: JSON.stringify({type: 8, data: {choices}}),
    };
  }

  if (interaction.type === 4 && cmd === 'watch') {
    const focused = interaction.data?.options?.find(o => o.focused);
    const query = focused?.value ?? '';
    let choices: Array<{name: string; value: string}> = [];
    if (ctx.db) {
      if (focused?.name === 'agent') {
        const oppVal = interaction.data?.options?.find(o => o.name === 'opponent')?.value;
        choices = autocompleteWatchAgents(query, ctx.db, oppVal);
      } else if (focused?.name === 'opponent') {
        const agentVal = interaction.data?.options?.find(o => o.name === 'agent')?.value;
        choices = autocompleteWatchAgents(query, ctx.db, agentVal);
      } else if (focused?.name === 'event') {
        choices = autocompleteWatchEvents(query, ctx.db);
      }
    }
    return {
      status: 200,
      headers: jsonHeaders,
      body: JSON.stringify({type: 8, data: {choices}}),
    };
  }

  if (interaction.type === 2 && cmd === 'define') {
    const found = lookupGlossary(termOpt, glossary);
    if (found) {
      return {
        status: 200,
        headers: jsonHeaders,
        body: JSON.stringify({
          type: 4,
          data: {
            content: formatGlossaryReply(found.term, found.definition),
            flags: 4,
          },
        }),
      };
    }
    const safeTerm = termOpt.replace(/[`\r\n]+/g, ' ').trim().slice(0, 100);
    return {
      status: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        type: 4,
        data: {
          content: `Unknown glossary term: \`${safeTerm}\`. See <https://pkmn.ai/glossary/>.`,
          flags: 68,
        },
      }),
    };
  }

  if (interaction.type === 2 && cmd === 'watch') {
    return handleWatchCommand(interaction, ctx);
  }

  return {status: 400, headers: {}};
}

export async function syncCommands(
  token: string,
  guild: string,
  state?: Map<string, string | undefined>
): Promise<Application> {
  const key = JSON.stringify(COMMANDS);
  const cachedApp = state?.get('app');
  const app = cachedApp
    ? JSON.parse(cachedApp) as Application
    : await discordRequest(token, '/oauth2/applications/@me') as Application;
  state?.set('app', JSON.stringify({id: app.id, verify_key: app.verify_key}));

  if (state?.get('commands') === key) return app;

  const current = await discordRequest(
    token,
    `/applications/${app.id}/guilds/${guild}/commands`
  ) as Command[];

  const normalize = (cmds: Command[]) =>
    cmds
      .map(c => ({
        type: c.type ?? 1,
        name: c.name,
        description: c.description,
        options: (c.options ?? []).map(o => ({
          type: o.type,
          name: o.name,
          description: o.description,
          required: Boolean(o.required),
          autocomplete: Boolean(o.autocomplete),
        })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

  if (JSON.stringify(normalize(current)) !== JSON.stringify(normalize(COMMANDS))) {
    await discordRequest(
      token,
      `/applications/${app.id}/guilds/${guild}/commands`,
      {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(COMMANDS),
      }
    );
  }

  state?.set('commands', key);
  return app;
}

export function syncGuildMembers(
  db: db.Database,
  members: GuildMember[],
  now = Math.floor(Date.now() / 1000)
) {
  db.syncDiscordMembers(
    members.map(m => ({id: m.user.id, username: m.user.username})),
    now
  );
}

export interface Options {
  db: db.Database;
  token?: string;
  vgcToken?: string;
  verifyKey?: string;
  getArenaLastContactAt?: () => number | undefined;
  getLiveMatch?: () => LiveMatchSnapshot | undefined;
  getLiveTournamentGames?: () => LiveTournamentGameSnapshot[];
}

export interface Handle {
  stop: () => void;
  notifySubmissionStatus: (result: db.ApplySubmissionStatusResult) => Promise<boolean>;
  notifyWatchdogTimeout: (alert: WatchdogAlert) => Promise<number>;
  notifyStaffAlert: (alert: StaffAlert) => Promise<number>;
  resolveStaffAlert: (alert: {key: string; message?: string}) => Promise<number>;
  notifyLiveMatch: (match: LiveMatchSnapshot) => Promise<number>;
  notifyLiveTournamentGame: (game: LiveTournamentGameSnapshot) => Promise<number>;
}

export interface SyncOnceOptions {
  state?: Map<string, string | undefined>;
  onVerifyKey?: (key: string) => void;
  onCommandsSynced?: () => void;
  config?: Config;
}

export async function syncOnce(
  db: db.Database,
  token: string,
  vgcToken = '',
  opts: SyncOnceOptions = {}
) {
  const {state = new Map<string, string | undefined>(), onVerifyKey, onCommandsSynced} = opts;
  const config = opts.config ?? loadConfig();

  try {
    const app = await syncCommands(token, config.guild, state);
    onVerifyKey?.(app.verify_key);
  } catch (err) {
    if (util.isConnectivityError(err)) {
      console.warn('Discord API unreachable; skipping sync cycle.');
      return;
    }
    console.error('Error syncing commands:', err);
  } finally {
    onCommandsSynced?.();
  }

  let members: GuildMember[] | undefined;
  let membersFetchFailed = false;
  try {
    members = await fetchGuildMembers(token, config.guild);
    syncGuildMembers(db, members);
  } catch (err) {
    membersFetchFailed = true;
    if (util.isConnectivityError(err)) {
      console.warn('Discord API unreachable; skipping sync cycle.');
      return;
    }
    console.error('Error fetching guild members:', err);
  }

  let roles: GuildRole[] | undefined;
  if (vgcToken || config.channel) {
    try {
      roles = await fetchGuildRoles(token, config.guild);
    } catch (err) {
      if (util.isConnectivityError(err)) {
        console.warn('Discord API unreachable; skipping remainder of sync cycle.');
        return;
      }
      console.error('Error fetching guild roles:', err);
    }
  }

  if (vgcToken) {
    try {
      await syncRoles(token, vgcToken, config, state, {members, roles});
      clearSyncTaskFailure(state, 'Partner role sync');
    } catch (err) {
      console.error('Error syncing partner roles:', err);
      await trackSyncTaskFailure(token, config, state, 'Partner role sync', err);
    }
  }

  if (!membersFetchFailed) {
    try {
      members = await syncArenaRoles(db, token, config, state, members);
      clearSyncTaskFailure(state, 'Arena role sync');
    } catch (err) {
      console.error('Error syncing Arena roles:', err);
      await trackSyncTaskFailure(token, config, state, 'Arena role sync', err);
    }
  }

  try {
    await syncSubmissionDms(db, token, config, state);
    clearSyncTaskFailure(state, 'Submission DM sync');
  } catch (err) {
    console.error('Error syncing submission DMs:', err);
    await trackSyncTaskFailure(token, config, state, 'Submission DM sync', err);
  }

  try {
    db.pruneExpiredDiscordWatches();
  } catch (err) {
    console.error('Error pruning expired Discord watches:', err);
  }

  if (config.channel) {
    if (config.pins) {
      try {
        await syncPins(token, config.channel, config.pins, state);
      } catch (err) {
        console.error('Error syncing pins:', err);
      }
    }

    let channels: GuildChannel[] | undefined;
    try {
      channels = await fetchGuildChannels(token, config.guild);
    } catch (err) {
      console.error('Error fetching guild channels:', err);
    }

    try {
      await syncMessages(token, config.channel, undefined, {members, channels, roles});
      clearSyncTaskFailure(state, 'Discord chat archive sync');
    } catch (err) {
      console.error('Error syncing messages:', err);
      await trackSyncTaskFailure(token, config, state, 'Discord chat archive sync', err);
    }
  }
}

export function register(app: polka.Polka, options: Options): Handle {
  // Only synchronize live Discord roles, pins, chat logs, and DMs in production (or when tests pass
  // `options.token`) so local `npm start` never mutates the production guild.
  const syncEnabled = options.token !== undefined || process.env.NODE_ENV === 'production';
  const token = syncEnabled ? (options.token ?? process.env.DISCORD_BOT_TOKEN) : '';
  const vgcToken = options.vgcToken ?? process.env.VGC_BOT_TOKEN ?? '';
  const state = new Map<string, string | undefined>();
  let verifyKey = options.verifyKey;
  let glossary: Record<string, string> = {};
  try {
    glossary = loadGlossary();
  } catch (err) {
    console.error('Error loading glossary:', err);
  }
  const startedAtSeconds = Math.floor(Date.now() / 1000);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let verifyKeyReady = Promise.resolve();

  const scheduleNext = () => {
    if (stopped || !token) return;
    timer = setTimeout(() => {
      if (stopped) return;
      try {
        glossary = loadGlossary();
      } catch (err) {
        console.error('Error reloading glossary:', err);
      }
      syncOnce(options.db, token, vgcToken, {
        state,
        onVerifyKey: k => {
          verifyKey = k;
        },
      })
        .catch(err => {
          console.error('Error in Discord sync cycle:', err);
        })
        .then(async () => {
          if (stopped || process.env.NODE_ENV !== 'production') return;
          await checkSystemHealth(token, loadConfig(), {
            state,
            startedAtSeconds,
            getArenaLastContactAt: options.getArenaLastContactAt,
            hasActiveLadder: () => options.db.getPlayableLadders().length > 0,
          });
        })
        .catch(err => {
          console.error('Error in system health check:', err);
        })
        .finally(scheduleNext);
    }, CYCLE_MILLIS);
    timer.unref();
  };

  if (token) {
    let resolveVerifyKey!: () => void;
    verifyKeyReady = new Promise<void>(resolve => {
      resolveVerifyKey = resolve;
    });
    syncOnce(options.db, token, vgcToken, {
      state,
      onVerifyKey: k => {
        verifyKey = k;
        resolveVerifyKey();
      },
      onCommandsSynced: () => {
        resolveVerifyKey();
      },
    })
      .catch(err => {
        console.error('Error in initial Discord sync:', err);
      })
      .finally(() => {
        resolveVerifyKey();
        scheduleNext();
      });
  }

  let watchDmQueue: Promise<unknown> = Promise.resolve();
  const enqueueWatchDm = (fn: (deadlineMillis: number) => Promise<number>): Promise<number> => {
    const deadlineMillis = Date.now() + WATCH_DM_MAX_AGE_MILLIS;
    const next = watchDmQueue.then(() => fn(deadlineMillis), () => fn(deadlineMillis));
    watchDmQueue = next.catch(() => 0);
    return next;
  };

  app.post('/discord/interactions', async (req, res) => {
    let rawBody: Buffer;
    try {
      rawBody = await util.readBodyBuffer(req, MAX_INTERACTION_BYTES);
    } catch (err: unknown) {
      const status = (err as {status?: number})?.status === 413 ? 413 : 500;
      if (status === 500) console.error('Error reading interaction request:', err);
      res.writeHead(status);
      res.end();
      return;
    }
    try {
      if (!verifyKey) await verifyKeyReady;
      const result = handleInteraction(rawBody, req.headers, verifyKey, glossary, {
        db: options.db,
        getLiveMatch: options.getLiveMatch,
        getLiveTournamentGames: options.getLiveTournamentGames,
      });
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch (err) {
      console.error('Error handling interaction:', err);
      res.writeHead(500);
      res.end();
    }
  });

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    notifySubmissionStatus: async result => {
      if (stopped || !token) return false;
      return notifySubmissionStatus(options.db, token, loadConfig(), result, state);
    },
    notifyWatchdogTimeout: async alert => {
      if (stopped || !token) return 0;
      return notifyWatchdogAlert(token, loadConfig(), alert, state);
    },
    notifyStaffAlert: async alert => {
      if (stopped || !token) return 0;
      return notifyStaffAlert(token, loadConfig(), alert, state);
    },
    resolveStaffAlert: async alert => {
      if (stopped || !token) return 0;
      return resolveStaffAlert(token, loadConfig(), alert, state);
    },
    notifyLiveMatch: async match => {
      if (stopped || !token) return 0;
      return enqueueWatchDm(
        deadlineMillis => notifyLiveMatch(options.db, token, match, state, deadlineMillis)
      );
    },
    notifyLiveTournamentGame: async game => {
      if (stopped || !token) return 0;
      return enqueueWatchDm(
        deadlineMillis => notifyLiveTournamentGame(options.db, token, game, state, deadlineMillis)
      );
    },
  };
}

if (require.main === module) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const vgcToken = process.env.VGC_BOT_TOKEN ?? '';
  if (!token) {
    console.error('Missing DISCORD_BOT_TOKEN environment variable');
    process.exit(1);
  }
  const db = new Database();
  db.syncLadders();
  syncOnce(db, token, vgcToken)
    .catch(err => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => {
      db.close();
    });
}
