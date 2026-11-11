require('source-map-support').install();

import * as fs from 'fs';
import * as path from 'path';

import {
  ArenaDB,
  DB_PATH,
  type LadderStatus,
  type TeamMode,
} from '../db';
import {PUBLIC_DIR, renderArenaPages} from '../server/render';
import {type SmogonUser, lookupSmogonUser} from '../server/smogon';

export interface PkmnCliOptions {
  db?: ArenaDB;
  dbPath?: string;
  publicDir?: string;
  now?: number;
  smogonToken?: string;
  lookupSmogon?: (raw: string | number, token?: string) => Promise<SmogonUser>;
  log?: (line: string) => void;
}

const USAGE = [
  'Usage: pkmn <command> [args...]',
  '',
  'Commands:',
  '  quarantine <bot-slug> <version> [--reason "..."]',
  '  unquarantine <bot-slug> <version>',
  '  refund-cooldown <bot-slug>',
  '  set-anchor <ladder_id> <bot-slug> <version>',
  '  set-ladder-status <ladder_id> <upcoming|active|settling|archived>',
  '  rotate-ladder <old_ladder_id> --display-name "..." [--new <new_ladder_id>] ' +
    '[--new-display-name "..."] [--format <format_id>] [--team-mode <mode>] ' +
    '[--min-bots <n>] [--team-count <n>]',
  '  render',
  '  lookup-smogon <username|slug.id|id|url>',
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

export async function runPkmnCli(
  argv: string[],
  options: PkmnCliOptions = {}
): Promise<void> {
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
    const lookup = options.lookupSmogon ?? lookupSmogonUser;
    const token = options.smogonToken ?? process.env.SMOGON_TOKEN;
    const user = await lookup(target, token);
    log(
      `${user.username}.${user.id} ` +
      `(id=${user.id}, username="${user.username}", banned=${user.banned})`
    );
    return;
  }

  const ownsDb = !options.db;
  const db = options.db ?? new ArenaDB(options.dbPath ?? DB_PATH);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const maybeRender = () => {
    const pub = options.publicDir ?? (ownsDb && !options.dbPath ? PUBLIC_DIR : undefined);
    if (pub && fs.existsSync(path.join(pub, 'index.html'))) {
      renderArenaPages({db, publicDir: pub, now});
    }
  };

  try {
    switch (cmd) {
      case 'quarantine': {
        const [slug, version] = positional.slice(1);
        if (!slug || !version) {
          throw new Error('Usage: pkmn quarantine <bot-slug> <version> [--reason "..."]');
        }
        const reason = flags.get('reason');
        const res = db.quarantineVersion(slug, version, reason, now);
        maybeRender();
        log(
          `Quarantined ${res.bot.name} (${res.bot.slug}) version ${res.version.version_str}` +
          (reason ? `: ${reason}` : '')
        );
        return;
      }
      case 'unquarantine': {
        const [slug, version] = positional.slice(1);
        if (!slug || !version) {
          throw new Error('Usage: pkmn unquarantine <bot-slug> <version>');
        }
        const ver = db.unquarantineVersion(slug, version, now);
        maybeRender();
        log(`Unquarantined ${slug} version ${ver.version_str}`);
        return;
      }
      case 'refund-cooldown': {
        const [slug] = positional.slice(1);
        if (!slug) {
          throw new Error('Usage: pkmn refund-cooldown <bot-slug>');
        }
        const bot = db.refundCooldown(slug, now);
        log(`Refunded 14-day submission cooldown for ${bot.name} (${bot.slug})`);
        return;
      }
      case 'set-anchor': {
        const [ladderId, slug, version] = positional.slice(1);
        if (!ladderId || !slug || !version) {
          throw new Error('Usage: pkmn set-anchor <ladder_id> <bot-slug> <version>');
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
        log(`Ladder ${updated.id} (${updated.display_name}) -> status=${updated.status}`);
        return;
      }
      case 'rotate-ladder': {
        const [oldLadderId] = positional.slice(1);
        const displayName = flags.get('display-name');
        if (!oldLadderId || !displayName) {
          throw new Error(
            'Usage: pkmn rotate-ladder <old_ladder_id> --display-name "..." [--new <id>]'
          );
        }
        const minBotsStr = flags.get('min-bots');
        const teamCountStr = flags.get('team-count');
        const minBots = minBotsStr !== undefined ? Number(minBotsStr) : undefined;
        const teamCount = teamCountStr !== undefined ? Number(teamCountStr) : undefined;
        if (minBots !== undefined && (!Number.isInteger(minBots) || minBots < 2)) {
          throw new Error('--min-bots must be an integer >= 2');
        }
        if (teamCount !== undefined && (!Number.isInteger(teamCount) || teamCount < 1)) {
          throw new Error('--team-count must be a positive integer');
        }

        const rotated = db.rotateLadder({
          oldLadderId,
          archivedDisplayName: displayName,
          newLadderId: flags.get('new'),
          newDisplayName: flags.get('new-display-name'),
          newFormatId: flags.get('format'),
          newTeamMode: flags.get('team-mode') as TeamMode | undefined,
          newMinBots: minBots,
          newTeamCount: teamCount,
          now,
        });
        maybeRender();
        log(
          `Rotated ${rotated.oldLadder.id} ("${rotated.oldLadder.display_name}", ` +
        `status=${rotated.oldLadder.status})` +
        (rotated.newLadder
          ? ` -> activated ${rotated.newLadder.id} ("${rotated.newLadder.display_name}")`
          : '')
        );
        return;
      }
      case 'render': {
        const pub = options.publicDir ?? PUBLIC_DIR;
        renderArenaPages({db, publicDir: pub, now});
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
