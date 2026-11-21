// Operator CLI (`npm run pkmn -- <command>`) for administering the pkmn.ai Arena SQLite DB,
// managing version quarantines and submission cooldowns, rotating seasonal ladders, resolving
// Smogon forum member IDs, and minting local session cookies for `curl` / browser testing.

require('source-map-support').install();

import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import * as db from '../db';
import * as arena from '../server/arena';
import * as auth from '../server/auth';
import * as discordApi from '../server/discord';
import * as render from '../server/render';
import * as sim from '../server/sim';
import * as smogon from '../server/smogon';
import {validateHarvestedTeamsForVersion} from '../server/teams';
import {syncStaticLiveBanner} from '../static/build';
import {copyFileAtomic, root, writeFileAtomic} from '../static/util';

export interface Options {
  db?: db.Database;
  publicDir?: string;
  now?: number;
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
  '  set-ladders <agent-slug> <slot...|all|none>',
  '  set-anchor <ladder_id> <agent-slug> <version>',
  '  set-ladder-status <ladder_id> <upcoming|active|settling|archived>',
  '  upload-ladder-teams <ladder_id> <teams-file>',
  '  rotate-ladder <old_ladder_id> --name "..." [--new <new_ladder_id>] ' +
    '[--new-name "..."] [--format <format>] [--version <sim_version>] [--team <mode>] ' +
    '[--teams <n>] [--discord <role_id>]',
  '  install-sim <version> [--sim <spec>] [--dex <spec>] [--mods <spec>] [--randoms <spec>]',
  '  reassign-developer <github-login> <target-agent-slug|--none> ' +
    '[--smogon <username.id|id|username>] [--projects <path>] [--offline]',
  '  sync-projects [--projects <path>] [--offline]',
  '  create-tournament <id> --name "..." --format <format> --version <sim_version> ' +
    '--starts <iso|unix> [--team <harvested|random|pools|custom>] [--games <n>] ' +
    '[--batch <n>] [--tables <n>] [--hardware "..."] [--rules \'<json>\'] ' +
    '[--status <scheduled|running|completed>]',
  '  set-tournament-status <id> <scheduled|running|completed>',
  '  seed-tournament <id>',
  '  publish-tournament-archive <id> <archive.7z>',
  '  publish-ladder-archive <ladder_id> <archive.tar>',
  '  lookup-smogon <username|slug.id|id|url>',
  '  notify-staff <message> [--key <key>] [--cooldown <seconds>] [--detail <text>] ' +
    '[--detail-file <path>] [--state <path>]',
  '  session [--github <login>] [--github-id <id>] [--discord <id>:<username>] [--ttl <seconds>]',
].join('\n');

const BOOLEAN_FLAGS = new Set(['help', 'offline', 'none']);
const ALLOWED_FLAGS_BY_CMD: Record<string, ReadonlySet<string>> = {
  quarantine: new Set(['reason']),
  unquarantine: new Set(),
  'refund-cooldown': new Set(),
  'set-ladders': new Set(),
  'set-anchor': new Set(),
  'set-ladder-status': new Set(),
  'upload-ladder-teams': new Set(),
  'rotate-ladder': new Set([
    'name',
    'new',
    'new-name',
    'format',
    'version',
    'team',
    'teams',
    'discord',
  ]),
  'install-sim': new Set(['sim', 'dex', 'mods', 'randoms']),
  'reassign-developer': new Set(['none', 'smogon', 'projects', 'offline']),
  'sync-projects': new Set(['projects', 'offline']),
  'create-tournament': new Set([
    'name',
    'format',
    'version',
    'starts',
    'team',
    'games',
    'batch',
    'tables',
    'hardware',
    'rules',
    'status',
  ]),
  'set-tournament-status': new Set(),
  'seed-tournament': new Set(),
  'publish-tournament-archive': new Set(),
  'publish-ladder-archive': new Set(),
  'lookup-smogon': new Set(),
  'notify-staff': new Set(['key', 'cooldown', 'detail', 'detail-file', 'state']),
  session: new Set(['github', 'github-id', 'discord', 'ttl']),
};

function assertAllowedFlags(cmd: string, flags: ReadonlyMap<string, string>) {
  const allowed = ALLOWED_FLAGS_BY_CMD[cmd];
  if (!allowed) return;
  for (const key of flags.keys()) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown flag "--${key}" for command "${cmd}"`);
    }
  }
}
const TOURNAMENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function parseArgs(argv: string[]): {positional: string[]; flags: Map<string, string>} {
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
        if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith('--')) {
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
  assertAllowedFlags(cmd, flags);

  if (cmd === 'lookup-smogon') {
    const target = positional[1];
    if (!target) {
      throw new Error('Usage: pkmn lookup-smogon <username|slug.id|id|url>');
    }
    const lookup = options.lookupSmogon ?? smogon.lookupUser;
    const user = await lookup(target, process.env.SMOGON_TOKEN);
    log(
      `${user.username}.${user.id} ` +
      `(id=${user.id}, username="${user.username}", banned=${user.banned})`
    );
    return;
  }

  if (cmd === 'session') {
    const secret = process.env.SESSION_SECRET ?? '';
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
    let githubClaim: {id: number; login: string} | undefined;
    if (githubLogin) {
      let resolvedId = 0;
      if (flags.has('github-id')) {
        resolvedId = Number(flags.get('github-id'));
        if (!Number.isSafeInteger(resolvedId) || resolvedId < 0) {
          throw new Error('--github-id must be a non-negative integer');
        }
      } else if (options.db) {
        resolvedId = options.db.getDeveloperByGitHub(githubLogin)?.githubId ?? 0;
      } else if (fs.existsSync(db.DB_PATH)) {
        const tempDb = new db.Database(db.DB_PATH);
        try {
          resolvedId = tempDb.getDeveloperByGitHub(githubLogin)?.githubId ?? 0;
        } finally {
          tempDb.close();
        }
      }
      githubClaim = {id: resolvedId, login: githubLogin};
    }

    const payload: auth.Session = {
      ...(githubClaim ? {github: githubClaim} : {}),
      ...(discord ? {discord} : {}),
      exp: now + ttl,
    };
    const token = auth.signToken(payload, secret);
    log(`${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`);
    return;
  }

  if (cmd === 'notify-staff') {
    const message = positional.slice(1).join(' ').trim();
    if (!message) {
      throw new Error(
        'Usage: pkmn notify-staff <message> [--key <key>] [--cooldown <seconds>] ' +
        '[--detail <text>] [--detail-file <path>] [--state <path>]'
      );
    }
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      log('Skipping staff alert: DISCORD_BOT_TOKEN is not set.');
      return;
    }
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const key = flags.get('key')?.trim() || `cli-${now}`;
    const rawCooldown = flags.get('cooldown');
    const cooldownSeconds = rawCooldown !== undefined
      ? Number(rawCooldown)
      : (flags.has('key') ? discordApi.STAFF_ALERT_COOLDOWN_SECONDS : 0);
    if (!Number.isFinite(cooldownSeconds) || cooldownSeconds < 0) {
      throw new Error(`Invalid --cooldown "${rawCooldown}"`);
    }
    let detail = flags.get('detail');
    const detailFile = flags.get('detail-file');
    if (detailFile && fs.existsSync(detailFile)) {
      const raw = fs.readFileSync(detailFile, 'utf8').trim();
      if (raw) {
        detail = raw.length > 4096 ? raw.slice(-4096) : raw;
      }
    }

    const stateFile = flags.get('state') ?? (
      flags.has('key') && fs.existsSync('/var/lib/pkmn')
        ? '/var/lib/pkmn/alert-state.json'
        : undefined
    );
    const state = new Map<string, string | undefined>();
    if (stateFile && fs.existsSync(stateFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, string>;
        for (const [k, v] of Object.entries(parsed)) {
          if (k.startsWith('staff-alert:') && typeof v === 'string') {
            state.set(k, v);
          }
        }
      } catch {}
    }

    const sent = await discordApi.notifyStaffAlert(
      token,
      discordApi.loadConfig(),
      {key, message, ...(detail ? {detail} : {}), cooldownSeconds},
      state,
      now
    );
    if (stateFile && sent > 0) {
      const persisted: Record<string, string> = {};
      for (const [k, v] of state.entries()) {
        if (k.startsWith('staff-alert:') && v !== undefined) {
          persisted[k] = v;
        }
      }
      try {
        writeFileAtomic(stateFile, `${JSON.stringify(persisted, null, 2)}\n`);
      } catch (err) {
        console.warn(`Failed persisting alert state to ${stateFile}:`, err);
      }
    }
    log(
      sent > 0
        ? `Sent staff alert (${sent} DM(s))`
        : 'Staff alert suppressed (cooldown/no staff)'
    );
    return;
  }

  if (cmd === 'install-sim') {
    const [version] = positional.slice(1);
    if (!version) {
      throw new Error(
        'Usage: pkmn install-sim <version> [--sim <spec>] [--dex <spec>] ' +
        '[--mods <spec>] [--randoms <spec>]'
      );
    }
    const simDir = root('sim', version);
    fs.mkdirSync(simDir, {recursive: true});
    const pkgPath = path.join(simDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      writeFileAtomic(
        pkgPath,
        `${JSON.stringify({name: `pkmn-sim-${version}`, private: true}, null, 2)}\n`
      );
    }
    const simSpec = flags.get('sim') ?? `@pkmn/sim@${version}`;
    const pkgs = [simSpec];
    const dexSpec = flags.get('dex');
    const modsSpec = flags.get('mods');
    const randomsSpec = flags.get('randoms');
    if (dexSpec) pkgs.push(dexSpec);
    if (modsSpec) pkgs.push(modsSpec);
    if (randomsSpec) pkgs.push(randomsSpec);
    execFileSync('npm', ['install', '--prefix', simDir, '--no-save', ...pkgs], {
      stdio: 'inherit',
      env: {...process.env, npm_config_allow_git: 'all'},
    });
    const resolvedVersion = await sim.getWorkerSimVersion(version);
    await sim.closeAllWorkers();
    log(`Installed @pkmn/sim ${resolvedVersion} in ${simDir} (key="${version}")`);
    return;
  }

  const ownsDb = !options.db;
  const database = options.db ?? new db.Database(db.DB_PATH);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const maybeSyncStaticBanner = () => {
    const pub = options.publicDir ?? (ownsDb ? render.PUBLIC_DIR : undefined);
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
      case 'set-ladders': {
        const slug = positional[1];
        const rawTokens = positional
          .slice(2)
          .flatMap(t => t.split(','))
          .map(t => t.trim().toLowerCase())
          .filter(Boolean);
        if (!slug || rawTokens.length === 0) {
          throw new Error('Usage: pkmn set-ladders <agent-slug> <slot...|all|none>');
        }
        let slots: db.LadderSlot[];
        if (rawTokens.includes('none')) {
          if (rawTokens.length > 1) {
            throw new Error('Cannot combine "none" with other ladder slots');
          }
          slots = [];
        } else if (rawTokens.includes('all')) {
          slots = [...db.ALL_SLOTS];
        } else {
          slots = rawTokens.map(t => db.normalizeLadderSlot(t));
        }
        const res = database.setAgentLadders(slug, slots, now);
        const list = res.slots.length > 0 ? res.slots.join(', ') : 'none';
        log(
          `Set qualified ladders for ${res.agent.name} (${res.agent.slug}): ` +
          `${list} (status=${res.agent.status})`
        );
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
        if (updated.team === 'pools' && updated.status === 'archived') {
          arena.promoteArchivedPoolsLogs(options.publicDir ?? render.PUBLIC_DIR, updated.id);
        }
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
        const packed = await validateHarvestedTeamsForVersion(
          fs.readFileSync(teamsFile, 'utf8'),
          ladder.format,
          ladder.version
        );
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
        const teamsStr = flags.get('teams');
        const teams = teamsStr !== undefined ? Number(teamsStr) : undefined;
        if (teams !== undefined && (!Number.isInteger(teams) || teams < 1)) {
          throw new Error('--teams must be a positive integer');
        }

        const newId = flags.get('new');
        const rotated = database.rotateLadder({
          oldLadderId,
          archivedName,
          ...(newId
            ? {
              next: {
                id: newId,
                name: flags.get('new-name'),
                format: flags.get('format'),
                version: flags.get('version'),
                team: flags.get('team') as db.TeamMode | undefined,
                teams,
                discord: flags.get('discord'),
              },
            }
            : {}),
          now,
        });
        if (rotated.oldLadder.team === 'pools' && rotated.oldLadder.status === 'archived') {
          arena.promoteArchivedPoolsLogs(
            options.publicDir ?? render.PUBLIC_DIR,
            rotated.oldLadder.id
          );
        }
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
        const projectsPath = flags.get('projects') ?? db.PROJECTS_FILE;
        const rawYaml = fs.readFileSync(projectsPath, 'utf8');
        const smogonSpec = flags.get('smogon');
        const updated = db.reassignDeveloperInProjectsYaml(
          rawYaml,
          githubLogin,
          rawTarget,
          smogonSpec
        );
        writeFileAtomic(projectsPath, updated.yaml);

        if (flags.has('offline')) {
          database.syncProjects(projectsPath, db.AVATARS_DIR, now);
        } else {
          await database.syncProjectsWithSmogon(projectsPath, {
            avatarsDir: db.AVATARS_DIR,
            smogonToken: process.env.SMOGON_TOKEN,
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
        const projectsPath = flags.get('projects') ?? db.PROJECTS_FILE;
        if (flags.has('offline')) {
          database.syncProjects(projectsPath, db.AVATARS_DIR, now);
        } else {
          await database.syncProjectsWithSmogon(projectsPath, {
            avatarsDir: db.AVATARS_DIR,
            smogonToken: process.env.SMOGON_TOKEN,
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
        const simVersion = flags.get('version');
        const startsRaw = flags.get('starts');
        if (!tourneyId || !name || !format || !simVersion || !startsRaw) {
          throw new Error(
            'Usage: pkmn create-tournament <id> --name "..." --format <format> ' +
            '--version <sim_version> --starts <iso|unix> ' +
            '[--team <harvested|random|pools>] [--games <n>] [--batch <n>] ' +
            '[--tables <n>] [--hardware "..."] [--rules \'<json>\'] ' +
            '[--status <scheduled|running|completed>]'
          );
        }
        if (!TOURNAMENT_ID_RE.test(tourneyId)) {
          throw new Error(
            `Invalid tournament ID "${tourneyId}" (must match ^[a-z0-9][a-z0-9-]{0,31}$)`
          );
        }
        const rawTeam = flags.get('team');
        let team: db.TeamMode | undefined;
        if (rawTeam !== undefined && rawTeam !== 'custom') {
          if (!db.TEAM_MODES.has(rawTeam as db.TeamMode)) {
            throw new Error('--team must be harvested, random, pools, or custom');
          }
          team = rawTeam as db.TeamMode;
        }
        try {
          if (!(await sim.hasFormat(format, simVersion))) {
            throw new Error(
              `Unknown Pokémon Showdown format "${format}" for @pkmn/sim "${simVersion}"`
            );
          }
        } finally {
          await sim.closeAllWorkers();
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
          version: simVersion,
          team,
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
        copyFileAtomic(srcFile, dest);
        log(`Published tournament archive -> /arena/tournaments/${tournament.id}/${fileName}`);
        return;
      }
      case 'publish-ladder-archive': {
        const [ladderId, srcFile] = positional.slice(1);
        if (!ladderId || !srcFile) {
          throw new Error('Usage: pkmn publish-ladder-archive <ladder_id> <archive.tar>');
        }
        if (!fs.existsSync(srcFile) || !fs.statSync(srcFile).isFile()) {
          throw new Error(`Archive file not found: ${srcFile}`);
        }
        const ladder = database.getLadder(ladderId);
        if (!ladder) {
          throw new Error(`Unknown ladder "${ladderId}"`);
        }
        if (ladder.team !== 'pools' && ladder.team !== 'random') {
          throw new Error(
            'Full battle log archives are only published for random or team-pool (pools) ladders ' +
            `("${ladder.id}" has team="${ladder.team}")`
          );
        }
        if (ladder.team === 'pools' && ladder.status !== 'archived') {
          throw new Error(
            `Ladder "${ladder.id}" must be retired ("archived") before publishing full battle ` +
            `logs (current status="${ladder.status}")`
          );
        }
        const pub = options.publicDir ?? render.PUBLIC_DIR;
        const fileName = `${ladder.id}-logs.tar`;
        const dest = path.join(pub, 'arena', 'ladders', ladder.id, fileName);
        if (ladder.team === 'pools') {
          arena.promoteArchivedPoolsLogs(pub, ladder.id);
        }
        copyFileAtomic(srcFile, dest);
        log(`Published ladder archive -> /arena/ladders/${ladder.id}/${fileName}`);
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
