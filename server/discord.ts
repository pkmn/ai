require('source-map-support').install();

import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'yaml';

const root = path.join(__dirname, '..', '..');

const DISCORD_API = 'https://discord.com/api/v10';
const VGC_API = 'https://vgc.bot/api/partner/leaders';
const CYCLE_MS = 60_000;

interface Config {
  guild: string;
  ladders: {[ladder: string]: string};
  bots?: {[bot: string]: string};
  authors?: {[author: string]: string};
}

export interface Leader {
  ladder: string;
  bot: {id: string; name: string} | null;
  owner: {name: string; discordId: string | null} | null;
}

// A member id, or a name to look a member up by.
export type Owner = {id: string} | {name: string};

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

export function ownerOf(leader: Leader, config: Config): Owner | undefined {
  const override = leader.bot && (config.bots?.[leader.bot.id] ?? config.bots?.[leader.bot.name]);
  if (override) return {name: override};
  if (!leader.owner) return undefined;
  if (leader.owner.discordId) return {id: leader.owner.discordId};
  return {name: config.authors?.[leader.owner.name] ?? leader.owner.name};
}

export function findMember(members: GuildMember[], owner: Owner): GuildMember | undefined {
  if ('id' in owner) return members.find(m => m.user.id === owner.id);
  const lower = owner.name.toLowerCase();
  return (
    members.find(m => m.user.id === owner.name) ??
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

export async function fetchLeaders(vgcToken: string): Promise<Leader[]> {
  const res = await fetch(VGC_API, {headers: {Authorization: `Bearer ${vgcToken}`}});
  if (!res.ok) {
    throw new Error(`vgc.bot API failed (${res.status})`);
  }
  const data = await res.json() as {leaders: Leader[]};
  return data.leaders;
}

// Fetches the members only when some ladder's owner changed since the last cycle.
export async function syncRoles(
  token: string,
  vgcToken: string,
  config: Config,
  state: Map<string, string | undefined>
) {
  const leaders = await fetchLeaders(vgcToken);
  let members: GuildMember[] | undefined;
  for (const leader of leaders) {
    const roleId = config.ladders[leader.ladder];
    if (!roleId) continue;
    const owner = ownerOf(leader, config);
    const key = owner && JSON.stringify(owner);
    if (state.has(leader.ladder) && state.get(leader.ladder) === key) continue;

    try {
      members ??= await fetchGuildMembers(token, config.guild);
      const target = owner && findMember(members, owner);

      for (const member of members) {
        if (member.roles.includes(roleId) && member.user.id !== target?.user.id) {
          await discordRequest(
            token,
            `/guilds/${config.guild}/members/${member.user.id}/roles/${roleId}`,
            {method: 'DELETE'}
          );
          console.log(`[${leader.ladder}] Removed role ${roleId} from ${member.user.username}`);
        }
      }

      if (target && !target.roles.includes(roleId)) {
        await discordRequest(
          token,
          `/guilds/${config.guild}/members/${target.user.id}/roles/${roleId}`,
          {method: 'PUT'}
        );
        const who = `${target.user.username} (${leader.bot?.name})`;
        console.log(`[${leader.ladder}] Assigned role ${roleId} to ${who}`);
      } else if (owner && !target) {
        const who = 'id' in owner ? owner.id : owner.name;
        console.log(`[${leader.ladder}] ${who} is not in the server`);
      }

      if (!owner || target) {
        state.set(leader.ladder, key);
      } else {
        state.delete(leader.ladder);
      }
    } catch (err) {
      console.error(`[${leader.ladder}] Error syncing role:`, err);
    }
  }
}

export async function run(token: string, vgcToken: string, once = false) {
  const state = new Map<string, string | undefined>();
  while (true) {
    try {
      await syncRoles(token, vgcToken, loadConfig(), state);
    } catch (err) {
      console.error('Error syncing roles:', err);
    }
    if (once) break;
    await new Promise(resolve => setTimeout(resolve, CYCLE_MS));
  }
}

if (require.main === module) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const vgcToken = process.env.VGC_BOT_TOKEN;
  if (!token || !vgcToken) {
    console.error(`Missing ${token ? 'VGC_BOT_TOKEN' : 'DISCORD_BOT_TOKEN'} environment variable`);
    process.exit(1);
  }
  run(token, vgcToken, process.argv.includes('--once')).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
