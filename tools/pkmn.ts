// Operator CLI (`npm run pkmn -- <command>`) for administering the pkmn.ai Arena SQLite DB,
// managing version quarantines and submission cooldowns, rotating seasonal ladders, resolving
// Smogon forum member IDs, and minting local session cookies for `curl` / browser testing.

require('source-map-support').install();

import * as fs from 'fs';
import * as path from 'path';

import * as db from '../db';
import * as auth from '../server/auth';
import * as render from '../server/render';
import * as smogon from '../server/smogon';
import {validateHarvestedTeams} from '../server/teams';
import {syncStaticLiveBanner} from '../static/build';

export interface Options {
  db?: db.Database;
  dbPath?: string;
  projectsFile?: string;
  avatarsDir?: string;
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
  '  upload-ladder-teams <ladder_id> <teams-file>',
  '  rotate-ladder <old_ladder_id> --name "..." [--new <new_ladder_id>] ' +
    '[--new-name "..."] [--format <format>] [--team <mode>] [--min <n>] [--teams <n>]',
  '  reassign-developer <github-login> <target-agent-slug|--none> ' +
    '[--smogon <username.id|id|username>] [--projects <path>] [--offline]',
  '  sync-projects [--projects <path>] [--offline]',
  '  create-tournament <id> --name "..." --format <format> --starts <iso|unix> ' +
    '[--games <n>] [--batch <n>] [--tables <n>] [--hardware "..."] [--rules \'<json>\'] ' +
    '[--status <scheduled|running|completed>]',
  '  set-tournament-status <id> <scheduled|running|completed>',
  '  seed-tournament <id>',
  '  publish-tournament-archive <id> <archive.7z>',
  '  publish-ladder-archive <ladder_id> <archive.7z>',
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
  const database = options.db ?? new db.Database(options.dbPath ?? db.DB_PATH);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const maybeSyncStaticBanner = () => {
    const pub = options.publicDir ?? (ownsDb && !options.dbPath ? render.PUBLIC_DIR : undefined);
    if (pub && fs.existsSync(pub)) {
      syncStaticLiveBanner(pub, database.getRunningTournament());
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
        const res = database.quarantineVersion(slug, version, reason, now);
        const suffix = reason ? `: ${reason}` : '';
        log(
          `Quarantined ${res.agent.name} (${res.agent.slug}) version ` +
          `${res.version.version}${suffix}`
        );
        return;
      }
      case 'unquarantine': {
        const [slug, version] = positional.slice(1);
        if (!slug || !version) {
          throw new Error('Usage: pkmn unquarantine <agent-slug> <version>');
        }
        const ver = database.unquarantineVersion(slug, version, now);
        log(`Unquarantined ${slug} version ${ver.version}`);
        return;
      }
      case 'refund-cooldown': {
        const [slug] = positional.slice(1);
        if (!slug) {
          throw new Error('Usage: pkmn refund-cooldown <agent-slug>');
        }
        const agent = database.refundCooldown(slug, now);
        log(`Refunded 14-day submission cooldown for ${agent.name} (${agent.slug})`);
        return;
      }
      case 'set-anchor': {
        const [ladderId, slug, version] = positional.slice(1);
        if (!ladderId || !slug || !version) {
          throw new Error('Usage: pkmn set-anchor <ladder_id> <agent-slug> <version>');
        }
        database.setLadderAnchor(ladderId, slug, version, now);
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
        const updated = database.setLadderStatus(ladderId, status as db.LadderStatus, now);
        log(`Ladder ${updated.id} (${updated.name}) -> status=${updated.status}`);
        return;
      }
      case 'upload-ladder-teams': {
        const [ladderId, teamsFile] = positional.slice(1);
        if (!ladderId || !teamsFile) {
          throw new Error('Usage: pkmn upload-ladder-teams <ladder_id> <teams-file>');
        }
        if (!fs.existsSync(teamsFile) || !fs.statSync(teamsFile).isFile()) {
          throw new Error(`Teams file not found: ${teamsFile}`);
        }
        const ladder = database.getLadder(ladderId);
        if (!ladder) {
          throw new Error(`Unknown ladder "${ladderId}"`);
        }
        if (ladder.team !== 'harvested') {
          throw new Error(
            'Harvested teams can only be uploaded to harvested ladders ' +
            `("${ladder.id}" has team="${ladder.team}")`
          );
        }
        const packed = validateHarvestedTeams(fs.readFileSync(teamsFile, 'utf8'), ladder.format);
        const count = database.replaceLadderTeams(ladder.id, packed, now);
        log(`Uploaded ${count} validated teams for ${ladder.id} (${ladder.format})`);
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

        const rotated = database.rotateLadder({
          oldLadderId,
          archivedName,
          newLadderId: flags.get('new'),
          newName: flags.get('new-name'),
          newFormat: flags.get('format'),
          newTeam: flags.get('team') as db.TeamMode | undefined,
          newMin: min,
          newTeams: teams,
          now,
        });
        const nextMsg = rotated.newLadder
          ? ` -> staged ${rotated.newLadder.id} ("${rotated.newLadder.name}", ` +
            `status=${rotated.newLadder.status})`
          : '';
        log(
          `Rotated ${rotated.oldLadder.id} ("${rotated.oldLadder.name}", ` +
          `status=${rotated.oldLadder.status})${nextMsg}`
        );
        return;
      }
      case 'reassign-developer': {
        const [githubLogin] = positional.slice(1);
        const rawTarget = flags.has('none') ? undefined : positional[2];
        if (!githubLogin || (!flags.has('none') && !rawTarget)) {
          throw new Error(
            'Usage: pkmn reassign-developer <github-login> <target-agent-slug|--none> ' +
            '[--smogon <username.id|id|username>] [--projects <path>] [--offline]'
          );
        }
        const projectsPath = flags.get('projects') ?? options.projectsFile ?? db.PROJECTS_FILE;
        const avatarsDir = options.avatarsDir ?? db.AVATARS_DIR;
        const rawYaml = fs.readFileSync(projectsPath, 'utf8');
        const smogonSpec = flags.get('smogon');
        const updated = db.reassignDeveloperInProjectsYaml(
          rawYaml,
          githubLogin,
          rawTarget,
          smogonSpec
        );
        const tmpPath = `${projectsPath}.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(tmpPath, updated.yaml, 'utf8');
        fs.renameSync(tmpPath, projectsPath);

        if (flags.has('offline')) {
          database.syncProjects(projectsPath, avatarsDir, now);
        } else {
          await database.syncProjectsWithSmogon(projectsPath, {
            avatarsDir,
            smogonToken: options.smogonToken ?? process.env.SMOGON_TOKEN,
            lookupSmogon: options.lookupSmogon,
            now,
          });
        }
        const fromLabel = updated.previousProject ? `"${updated.previousProject}"` : 'unassigned';
        const toLabel = updated.targetProject ? `"${updated.targetProject}"` : 'unassigned';
        log(`Reassigned @${githubLogin}: ${fromLabel} -> ${toLabel}`);
        return;
      }
      case 'sync-projects': {
        const projectsPath = flags.get('projects') ?? options.projectsFile ?? db.PROJECTS_FILE;
        const avatarsDir = options.avatarsDir ?? db.AVATARS_DIR;
        if (flags.has('offline')) {
          database.syncProjects(projectsPath, avatarsDir, now);
        } else {
          await database.syncProjectsWithSmogon(projectsPath, {
            avatarsDir,
            smogonToken: options.smogonToken ?? process.env.SMOGON_TOKEN,
            lookupSmogon: options.lookupSmogon,
            now,
          });
        }
        log(`Synced Arena projects from ${projectsPath}`);
        return;
      }
      case 'create-tournament': {
        const [tourneyId] = positional.slice(1);
        const name = flags.get('name');
        const format = flags.get('format');
        const startsRaw = flags.get('starts');
        if (!tourneyId || !name || !format || !startsRaw) {
          throw new Error(
            'Usage: pkmn create-tournament <id> --name "..." --format <format> ' +
            '--starts <iso|unix> [--games <n>] [--batch <n>] [--tables <n>] ' +
            '[--hardware "..."] [--rules \'<json>\'] [--status <scheduled|running|completed>]'
          );
        }
        const startsAt = /^\d+$/.test(startsRaw)
          ? Number(startsRaw)
          : Math.floor(Date.parse(startsRaw) / 1000);
        if (!Number.isFinite(startsAt) || startsAt <= 0) {
          throw new Error('--starts must be a valid ISO-8601 timestamp or positive Unix seconds');
        }
        const gamesPerMatchup = flags.has('games') ? Number(flags.get('games')) : 50;
        const batchSize = flags.has('batch') ? Number(flags.get('batch')) : 10;
        const parallelTables = flags.has('tables') ? Number(flags.get('tables')) : 4;
        if (!Number.isInteger(gamesPerMatchup) || gamesPerMatchup < 1) {
          throw new Error('--games must be a positive integer');
        }
        if (!Number.isInteger(batchSize) || batchSize < 1) {
          throw new Error('--batch must be a positive integer');
        }
        if (!Number.isInteger(parallelTables) || parallelTables < 1) {
          throw new Error('--tables must be a positive integer');
        }
        const rulesJson = flags.get('rules') ?? '[]';
        const parsedRules = JSON.parse(rulesJson) as unknown;
        if (!Array.isArray(parsedRules)) {
          throw new Error('--rules must be a JSON array');
        }
        const status = (flags.get('status') ?? 'scheduled') as db.TournamentStatus;
        if (status !== 'scheduled' && status !== 'running' && status !== 'completed') {
          throw new Error('--status must be scheduled, running, or completed');
        }
        const hardware = flags.get('hardware') ??
          'GCP g2-custom-24-49152 (NVIDIA L4 24 GB VRAM · 24 vCPUs + 48 GB RAM / agent)';
        database.upsertTournament({
          id: tourneyId,
          name,
          format,
          rulesJson: JSON.stringify(parsedRules),
          gamesPerMatchup,
          batchSize,
          parallelTables,
          hardware,
          status,
          startsAt,
          completedAt: status === 'completed' ? now : undefined,
        });
        maybeSyncStaticBanner();
        log(`Upserted tournament ${tourneyId} ("${name}", status=${status})`);
        return;
      }
      case 'set-tournament-status': {
        const [tourneyId, status] = positional.slice(1);
        if (!tourneyId || !status) {
          throw new Error(
            'Usage: pkmn set-tournament-status <id> <scheduled|running|completed>'
          );
        }
        const updated = database.setTournamentStatus(tourneyId, status as db.TournamentStatus, now);
        maybeSyncStaticBanner();
        log(`Tournament ${updated.id} ("${updated.name}") -> status=${updated.status}`);
        return;
      }
      case 'seed-tournament': {
        const [tourneyId] = positional.slice(1);
        if (!tourneyId) {
          throw new Error('Usage: pkmn seed-tournament <id>');
        }
        const count = database.seedTournamentEntrants(tourneyId);
        log(`Seeded ${count} entrants for tournament ${tourneyId}`);
        return;
      }
      case 'publish-tournament-archive': {
        const [tourneyId, srcFile] = positional.slice(1);
        if (!tourneyId || !srcFile) {
          throw new Error('Usage: pkmn publish-tournament-archive <id> <archive.7z>');
        }
        if (!fs.existsSync(srcFile) || !fs.statSync(srcFile).isFile()) {
          throw new Error(`Archive file not found: ${srcFile}`);
        }
        const tournament = database.getTournament(tourneyId);
        if (!tournament) {
          throw new Error(`Unknown tournament "${tourneyId}"`);
        }
        if (tournament.status !== 'completed') {
          throw new Error(
            `Tournament ${tournament.id} must be "completed" before publishing replay archive ` +
            `(current status="${tournament.status}")`
          );
        }
        const pub = options.publicDir ?? render.PUBLIC_DIR;
        const fileName = `${tournament.id}-replays.7z`;
        const dest = path.join(pub, 'arena', 'tournaments', tournament.id, fileName);
        render.copyFileAtomic(srcFile, dest);
        log(`Published tournament archive -> /arena/tournaments/${tournament.id}/${fileName}`);
        return;
      }
      case 'publish-ladder-archive': {
        const [ladderId, srcFile] = positional.slice(1);
        if (!ladderId || !srcFile) {
          throw new Error('Usage: pkmn publish-ladder-archive <ladder_id> <archive.7z>');
        }
        if (!fs.existsSync(srcFile) || !fs.statSync(srcFile).isFile()) {
          throw new Error(`Archive file not found: ${srcFile}`);
        }
        const ladder = database.getLadder(ladderId);
        if (!ladder) {
          throw new Error(`Unknown ladder "${ladderId}"`);
        }
        if (ladder.team !== 'pools') {
          throw new Error(
            'Full battle log archives are only published for team-pool (pools) ladders ' +
            `("${ladder.id}" has team="${ladder.team}")`
          );
        }
        if (ladder.status !== 'archived') {
          throw new Error(
            `Ladder "${ladder.id}" must be retired ("archived") before publishing full battle ` +
            `logs (current status="${ladder.status}")`
          );
        }
        const pub = options.publicDir ?? render.PUBLIC_DIR;
        const fileName = `${ladder.id}-logs.7z`;
        const dest = path.join(pub, 'arena', 'ladders', ladder.id, fileName);
        render.copyFileAtomic(srcFile, dest);
        log(`Published retired ladder archive -> /arena/ladders/${ladder.id}/${fileName}`);
        return;
      }
      default:
        throw new Error(`Unknown command "${cmd}"\n\n${USAGE}`);
    }
  } finally {
    if (ownsDb) database.close();
  }
}

if (require.main === module) {
  runPkmnCli(process.argv.slice(2)).catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
