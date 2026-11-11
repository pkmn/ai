// Operator CLI (`npm run pkmn -- <command>`) for administering the pkmn.ai Arena SQLite DB,
// managing version quarantines and submission cooldowns, rotating seasonal ladders, resolving
// Smogon forum member IDs, and minting local session cookies for `curl` / browser testing.

require('source-map-support').install();

import * as fs from 'fs';
import * as path from 'path';

import {DB_PATH, Database, LadderStatus, TeamMode} from '../db';
import * as auth from '../server/auth';
import * as render from '../server/render';
import * as smogon from '../server/smogon';

export interface Options {
  db?: Database;
  dbPath?: string;
  publicDir?: string;
  now?: number;
  smogonToken?: string;
  sessionSecret?: string;
  lookupSmogon?: (raw: string | number, token?: string) => Promise<smogon.User>;
  log?: (line: string) => void;
}

const USAGE = [
  'Usage: pkmn <command> [args...]',
  '',
  'Commands:',
  '  quarantine <agent-slug> <version> [--reason "..."]',
  '  unquarantine <agent-slug> <version>',
  '  refund-cooldown <agent-slug>',
  '  set-anchor <ladder_id> <agent-slug> <version>',
  '  set-ladder-status <ladder_id> <upcoming|active|settling|archived>',
  '  rotate-ladder <old_ladder_id> --name "..." [--new <new_ladder_id>] ' +
    '[--new-name "..."] [--format <format>] [--team <mode>] [--min <n>] [--teams <n>]',
  '  render',
  '  lookup-smogon <username|slug.id|id|url>',
  '  session [--github <login>] [--discord <id>:<username>] [--ttl <seconds>]',
].join('\n');

function parseArgs(argv: string[]): {positional: string[]; flags: Map<string, string>} {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 2) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          flags.set(key, 'true');
        } else {
          flags.set(key, next);
          i++;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return {positional, flags};
}

export async function runPkmnCli(argv: string[], options: Options = {}): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  const {positional, flags} = parseArgs(argv);
  const cmd = positional[0];

  if (!cmd || cmd === 'help' || flags.has('help')) {
    log(USAGE);
    return;
  }

  if (cmd === 'lookup-smogon') {
    const target = positional[1];
    if (!target) {
      throw new Error('Usage: pkmn lookup-smogon <username|slug.id|id|url>');
    }
    const lookup = options.lookupSmogon ?? smogon.lookupUser;
    const token = options.smogonToken ?? process.env.SMOGON_TOKEN;
    const user = await lookup(target, token);
    log(
      `${user.username}.${user.id} ` +
      `(id=${user.id}, username="${user.username}", banned=${user.banned})`
    );
    return;
  }

  if (cmd === 'session') {
    const secret = flags.get('secret') ?? options.sessionSecret ?? process.env.SESSION_SECRET ?? '';
    if (!secret) {
      throw new Error('SESSION_SECRET is required to mint a session cookie');
    }
    const githubLogin = flags.get('github');
    const discordFlag = flags.get('discord');
    if (!githubLogin && !discordFlag) {
      throw new Error(
        'Usage: pkmn session [--github <login>] [--discord <id>:<username>] [--ttl <seconds>]'
      );
    }
    const ttl = flags.has('ttl') ? Number(flags.get('ttl')) : auth.SESSION_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl <= 0) {
      throw new Error('--ttl must be a positive integer (seconds)');
    }
    const now = options.now ?? Math.floor(Date.now() / 1000);
    let discord: {id: string; username: string} | undefined;
    if (discordFlag) {
      const colon = discordFlag.indexOf(':');
      if (colon <= 0 || colon === discordFlag.length - 1) {
        throw new Error('--discord must be formatted as <id>:<username>');
      }
      discord = {id: discordFlag.slice(0, colon), username: discordFlag.slice(colon + 1)};
    }
    const payload: auth.Session = {
      ...(githubLogin ? {github: {id: 1, login: githubLogin}} : {}),
      ...(discord ? {discord} : {}),
      exp: now + ttl,
    };
    const token = auth.signToken(payload, secret);
    log(`${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`);
    return;
  }

  const ownsDb = !options.db;
  const db = options.db ?? new Database(options.dbPath ?? DB_PATH);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const maybeRender = () => {
    const pub = options.publicDir ?? (ownsDb && !options.dbPath ? render.PUBLIC_DIR : undefined);
    if (pub && fs.existsSync(path.join(pub, 'index.html'))) {
      render.renderArenaPages({db, publicDir: pub, now});
    }
  };

  try {
    switch (cmd) {
      case 'quarantine': {
        const [slug, version] = positional.slice(1);
        if (!slug || !version) {
          throw new Error('Usage: pkmn quarantine <agent-slug> <version> [--reason "..."]');
        }
        const reason = flags.get('reason');
        const res = db.quarantineVersion(slug, version, reason, now);
        maybeRender();
        log(
          `Quarantined ${res.agent.name} (${res.agent.slug}) version ${res.version.version}` +
          (reason ? `: ${reason}` : '')
        );
        return;
      }
      case 'unquarantine': {
        const [slug, version] = positional.slice(1);
        if (!slug || !version) {
          throw new Error('Usage: pkmn unquarantine <agent-slug> <version>');
        }
        const ver = db.unquarantineVersion(slug, version, now);
        maybeRender();
        log(`Unquarantined ${slug} version ${ver.version}`);
        return;
      }
      case 'refund-cooldown': {
        const [slug] = positional.slice(1);
        if (!slug) {
          throw new Error('Usage: pkmn refund-cooldown <agent-slug>');
        }
        const agent = db.refundCooldown(slug, now);
        log(`Refunded 14-day submission cooldown for ${agent.name} (${agent.slug})`);
        return;
      }
      case 'set-anchor': {
        const [ladderId, slug, version] = positional.slice(1);
        if (!ladderId || !slug || !version) {
          throw new Error('Usage: pkmn set-anchor <ladder_id> <agent-slug> <version>');
        }
        db.setLadderAnchor(ladderId, slug, version, now);
        maybeRender();
        log(`Set 1500 Elo anchor on ${ladderId} to ${slug} ${version}`);
        return;
      }
      case 'set-ladder-status': {
        const [ladderId, status] = positional.slice(1);
        if (!ladderId || !status) {
          throw new Error(
            'Usage: pkmn set-ladder-status <ladder_id> <upcoming|active|settling|archived>'
          );
        }
        const updated = db.setLadderStatus(ladderId, status as LadderStatus, now);
        maybeRender();
        log(`Ladder ${updated.id} (${updated.name}) -> status=${updated.status}`);
        return;
      }
      case 'rotate-ladder': {
        const [oldLadderId] = positional.slice(1);
        const archivedName = flags.get('name');
        if (!oldLadderId || !archivedName) {
          throw new Error(
            'Usage: pkmn rotate-ladder <old_ladder_id> --name "..." [--new <id>]'
          );
        }
        const minStr = flags.get('min');
        const teamsStr = flags.get('teams');
        const min = minStr !== undefined ? Number(minStr) : undefined;
        const teams = teamsStr !== undefined ? Number(teamsStr) : undefined;
        if (min !== undefined && (!Number.isInteger(min) || min < 2)) {
          throw new Error('--min must be an integer >= 2');
        }
        if (teams !== undefined && (!Number.isInteger(teams) || teams < 1)) {
          throw new Error('--teams must be a positive integer');
        }

        const rotated = db.rotateLadder({
          oldLadderId,
          archivedName,
          newLadderId: flags.get('new'),
          newName: flags.get('new-name'),
          newFormat: flags.get('format'),
          newTeam: flags.get('team') as TeamMode | undefined,
          newMin: min,
          newTeams: teams,
          now,
        });
        maybeRender();
        log(
          `Rotated ${rotated.oldLadder.id} ("${rotated.oldLadder.name}", ` +
          `status=${rotated.oldLadder.status})` +
          (rotated.newLadder
            ? ` -> activated ${rotated.newLadder.id} ("${rotated.newLadder.name}")`
            : '')
        );
        return;
      }
      case 'render': {
        const pub = options.publicDir ?? render.PUBLIC_DIR;
        render.renderArenaPages({db, publicDir: pub, now});
        log(`Rendered static Arena pages into ${pub}`);
        return;
      }
      default:
        throw new Error(`Unknown command "${cmd}"\n\n${USAGE}`);
    }
  } finally {
    if (ownsDb) db.close();
  }
}

if (require.main === module) {
  runPkmnCli(process.argv.slice(2)).catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
