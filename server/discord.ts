require('source-map-support').install();

import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'yaml';

const root = path.join(__dirname, '..', '..');

const DISCORD_API = 'https://discord.com/api/v10';
const VGC_API = 'https://vgc.bot/api/leaderboard';
const MAX_DEVIATION = 80;
const CYCLE_MS = 60_000;

interface Config {
  guild: string;
  ladders: {[ladder: string]: string};
  bots?: {[bot: string]: string};
  authors?: {[author: string]: string};
}

interface VGCBot {
  id: string;
  name: string;
  ladders: string[];
  author?: string;
  rating: number;
  deviation: number;
  wins: number;
  losses: number;
  ties: number;
  retired: boolean;
}

interface GuildMember {
  user: {
    id: string;
    username: string;
    global_name?: string;
  };
  nick?: string;
  roles: string[];
}

function loadConfig(file = path.join(root, 'config', 'discord.yml')): Config {
  return yaml.parse(fs.readFileSync(file, 'utf8')) as Config;
}

function getLeader(bots: VGCBot[]): VGCBot | undefined {
  for (const bot of bots) {
    if (bot.wins + bot.losses + bot.ties > 0 && bot.deviation <= MAX_DEVIATION) {
      return bot;
    }
  }
  return undefined;
}

export function resolveOwner(bot: VGCBot | undefined, config: Config): string | undefined {
  if (!bot) return undefined;
  if (config.bots?.[bot.name]) return config.bots[bot.name];
  if (!bot.author) return undefined;
  return config.authors?.[bot.author] ?? bot.author;
}

export function findMember(members: GuildMember[], owner?: string): GuildMember | undefined {
  if (!owner) return undefined;
  const lower = owner.toLowerCase();
  return (
    members.find(m => m.user.id === owner) ??
    members.find(m => m.user.username.toLowerCase() === lower) ??
    members.find(m => m.user.global_name?.toLowerCase() === lower) ??
    members.find(m => m.nick?.toLowerCase() === lower)
  );
}

async function discordRequest(token: string, endpoint: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${DISCORD_API}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      ...init?.headers,
    },
  });
  if (res.status === 429) {
    const body = await res.json().catch(() => ({})) as {retry_after?: number};
    const waitMs = Math.ceil((body.retry_after ?? 1) * 1000);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    return discordRequest(token, endpoint, init);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const method = init?.method ?? 'GET';
    throw new Error(`Discord API ${method} ${endpoint} failed (${res.status}): ${text}`);
  }
  if (res.status === 204) return undefined;
  return res.json();
}

export async function fetchGuildMembers(token: string, guild: string): Promise<GuildMember[]> {
  const all: GuildMember[] = [];
  let after = '0';
  while (true) {
    const page = await discordRequest(
      token,
      `/guilds/${guild}/members?limit=1000&after=${after}`
    ) as GuildMember[];
    all.push(...page);
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }
  return all;
}

export async function fetchLadderBots(ladder: string): Promise<VGCBot[]> {
  const res = await fetch(`${VGC_API}?ladder=${encodeURIComponent(ladder)}`);
  if (!res.ok) {
    throw new Error(`vgc.bot API failed for ${ladder} (${res.status})`);
  }
  const data = await res.json() as {bots: VGCBot[]};
  return data.bots;
}

export async function syncLadderRole(
  token: string,
  config: Config,
  ladder: string,
  roleId: string,
  state: Map<string, string | undefined>
) {
  const bots = await fetchLadderBots(ladder);
  const leader = getLeader(bots);
  const owner = resolveOwner(leader, config);

  if (state.has(ladder) && state.get(ladder) === owner) return;

  const members = await fetchGuildMembers(token, config.guild);
  const target = findMember(members, owner);

  for (const member of members) {
    if (member.roles.includes(roleId) && member.user.id !== target?.user.id) {
      await discordRequest(
        token,
        `/guilds/${config.guild}/members/${member.user.id}/roles/${roleId}`,
        {method: 'DELETE'}
      );
      console.log(`[${ladder}] Removed role ${roleId} from ${member.user.username}`);
    }
  }

  if (target && !target.roles.includes(roleId)) {
    await discordRequest(
      token,
      `/guilds/${config.guild}/members/${target.user.id}/roles/${roleId}`,
      {method: 'PUT'}
    );
    console.log(
      `[${ladder}] Assigned role ${roleId} to ${target.user.username} (${leader?.name})`
    );
  }

  if (!owner || target) {
    state.set(ladder, owner);
  } else {
    state.delete(ladder);
  }
}

export async function run(token: string, once = false) {
  const state = new Map<string, string | undefined>();
  while (true) {
    const config = loadConfig();
    const entries = Object.entries(config.ladders);
    const delayMs = entries.length > 0 ? Math.floor(CYCLE_MS / entries.length) : CYCLE_MS;

    for (let i = 0; i < entries.length; i++) {
      const [ladder, roleId] = entries[i];
      try {
        await syncLadderRole(token, config, ladder, roleId, state);
      } catch (err) {
        console.error(`[${ladder}] Error syncing role:`, err);
      }
      if (!once && i < entries.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    if (once) break;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

if (require.main === module) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('Missing DISCORD_BOT_TOKEN environment variable');
    process.exit(1);
  }
  run(token, process.argv.includes('--once')).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
