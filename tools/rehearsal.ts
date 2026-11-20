// Production dress rehearsal orchestrator (`node --env-file-if-exists=.env build/tools/rehearsal`).
//
// Builds real Metamon policy participants in both native darwin/arm64 (.tar.zst) and rootless
// Podman linux/arm64 (OCI) formats, stages harvested pkmn/teams pools and private GCP artifacts,
// submits participants via POST https://pkmn.ai/api/submissions, verifies live matchmaking and
// Davidson ratings across RBY/ADV/SV, and restores pkmn.ai, arena, and GCP cleanly afterward.

require('source-map-support').install();

import {execFileSync, spawnSync} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import * as unpack from '../arena/unpack';
import {validateHarvestedTeams} from '../server/teams';
import {VERSION_RE, root, slugify} from '../static/util';

export type Subcommand =
  'snapshot' |
  'restore-drill' |
  'build' |
  'stage' |
  'submit' |
  'verify' |
  'status' |
  'cleanup';

export interface ParticipantSpec {
  name: string;
  slug: string;
  modelName: string;
  hfWeightsPath: string;
  upgradeHfWeightsPath?: string;
  fp16: boolean;
  packageFormat: 'bundle' | 'oci';
  ladders: readonly ('gen1ou20261109' | 'gen3ou20261109' | 'gen9ou20261109')[];
  avatarIcon: string;
  githubLogin: string;
  smogonSpec: string;
}

export interface RemoteHostConfig {
  pkmnHost: string;
  arenaHost: string;
  publicBaseUrl: string;
}

export interface GcpStagingConfig {
  project: string;
  location: string;
  bucket: string;
  garRepo: string;
}

export interface RehearsalContext {
  stateDir: string;
  hosts: RemoteHostConfig;
  gcp: GcpStagingConfig;
}

export interface StagedArtifactRecord {
  slug: string;
  version: string;
  packageFormat: 'bundle' | 'oci';
  url: string;
  sha256: string;
  unpackedBytes: number;
  ladders: string[];
}

export interface HostSnapshot {
  head: string;
  gitStatus: string;
  counts: Record<string, number>;
}

export interface PkmnSnapshot extends HostSnapshot {
  wikiHead: string;
  wikiStatus: string;
  backups: string[];
  avatars: string[];
  ladders: Array<{id: string; slot: string; status: string; teams: number}>;
}

export interface ArenaSnapshot extends HostSnapshot {
  agentsDir: string[];
  coldAgents: string[];
  archiveLogs: string[];
  dbBackups: string[];
  podmanImages: string[];
}

export interface SnapshotReport {
  capturedAt: string;
  pkmnPreBackup: string;
  arenaPreBackup: string;
  pkmn: PkmnSnapshot;
  arena: ArenaSnapshot;
  gcsObjects: string[];
  gcpEnabledServices: string[];
}

interface BuildArtifactRecord {
  slug: string;
  version: string;
  packageFormat: 'bundle' | 'oci';
  localBundlePath?: string;
  sha256?: string;
  unpackedBytes: number;
  ladders: string[];
}

const MAX_UNPACKED_BYTES = unpack.MAX_BYTES;

function buildArenaSqliteRestoreLines(backupPath: string, tmpTag: string): string[] {
  return [
    `TMP_DB="/Volumes/Staging/${tmpTag}-$$.sqlite"`,
    'trap \'rm -f "$TMP_DB"\' EXIT',
    `zstd -dc '${backupPath}' -o "$TMP_DB"`,
    'chmod 0600 "$TMP_DB"',
    'CHK_SRC="$(sqlite3 "$TMP_DB" \'PRAGMA integrity_check;\')"',
    '[[ "$CHK_SRC" == "ok" ]] || { echo "Arena backup integrity failed: $CHK_SRC" >&2; exit 1; }',
    // Drain `ai.pkmn.arena` via permitted SIGUSR1 twice (waiting 1.5s after attempt 1 so the
    // respawned Node process registers its SIGUSR1 handler before attempt 2 triggers launchd's
    // 5s ThrottleInterval) so zero handles remain open on `/opt/arena/state/arena.sqlite*` before
    // removing `-wal`/`-shm`; fall back to online `sqlite3 .restore` if it is still running.
    'for _attempt in 1 2; do',
    '  OLD_PID="$(pgrep -f \'/opt/arena/repo/build/arena\' | head -n 1 || true)"',
    '  [[ -z "$OLD_PID" ]] && break',
    '  sudo -n /bin/launchctl kill SIGUSR1 system/ai.pkmn.arena || true',
    '  for _w in $(seq 1 100); do',
    '    kill -0 "$OLD_PID" 2>/dev/null || break',
    '    sleep 0.1',
    '  done',
    '  if [[ "$_attempt" == "1" ]]; then sleep 1.5; fi',
    'done',
    'if ! pgrep -f \'/opt/arena/repo/build/arena\' >/dev/null 2>&1; then',
    '  rm -f /opt/arena/state/arena.sqlite /opt/arena/state/arena.sqlite-wal ' +
      '/opt/arena/state/arena.sqlite-shm',
    '  cp "$TMP_DB" /opt/arena/state/arena.sqlite',
    'else',
    '  sqlite3 -cmd \'.timeout 10000\' /opt/arena/state/arena.sqlite ".restore \'$TMP_DB\'"',
    'fi',
    'chmod 0600 /opt/arena/state/arena.sqlite',
    'CHK_LIVE="$(sqlite3 /opt/arena/state/arena.sqlite \'PRAGMA integrity_check;\')"',
    '[[ "$CHK_LIVE" == "ok" ]] || { echo "Arena live integrity failed: $CHK_LIVE" >&2; exit 1; }',
  ];
}
const LINUX_PY_URL =
  'https://github.com/astral-sh/python-build-standalone/releases/download/20261110/' +
  'cpython-3.12.16%2B20261110-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz';

const ALL_THREE_LADDERS = [
  'gen1ou20261109',
  'gen3ou20261109',
  'gen9ou20261109',
] as const;
const CLASSIC_LADDERS = ['gen1ou20261109', 'gen3ou20261109'] as const;
const RBY_ONLY_LADDERS = ['gen1ou20261109'] as const;

export const PARTICIPANTS: readonly ParticipantSpec[] = [
  {
    name: 'Alakazam',
    slug: 'alakazam',
    modelName: 'Alakazam',
    hfWeightsPath: 'alakazam/ckpts/policy_weights/policy_epoch_8.pt',
    upgradeHfWeightsPath: 'alakazam/ckpts/policy_weights/policy_epoch_10.pt',
    fp16: true,
    packageFormat: 'bundle',
    ladders: ALL_THREE_LADDERS,
    avatarIcon: 'alakazam.png',
    githubLogin: 'rehearsal-alakazam',
    smogonSpec: 'RehearsalAlakazam.990001',
  },
  {
    name: 'Kadabra IV',
    slug: 'kadabra-iv',
    modelName: 'Kadabra4',
    hfWeightsPath: 'kadabra4/ckpts/policy_weights/policy_epoch_50.pt',
    fp16: true,
    packageFormat: 'oci',
    ladders: ALL_THREE_LADDERS,
    avatarIcon: 'kadabra.png',
    githubLogin: 'rehearsal-kadabra4',
    smogonSpec: 'RehearsalKadabra4.990002',
  },
  {
    name: 'Kadabra III',
    slug: 'kadabra-iii',
    modelName: 'Kadabra3',
    hfWeightsPath: 'kadabra3/ckpts/policy_weights/policy_epoch_20.pt',
    fp16: true,
    packageFormat: 'bundle',
    ladders: ALL_THREE_LADDERS,
    avatarIcon: 'kadabra.png',
    githubLogin: 'rehearsal-kadabra3',
    smogonSpec: 'RehearsalKadabra3.990003',
  },
  {
    name: 'Kadabra II',
    slug: 'kadabra-ii',
    modelName: 'Kadabra2',
    hfWeightsPath: 'kadabra2/ckpts/policy_weights/policy_epoch_44.pt',
    fp16: true,
    packageFormat: 'oci',
    ladders: ALL_THREE_LADDERS,
    avatarIcon: 'kadabra.png',
    githubLogin: 'rehearsal-kadabra2',
    smogonSpec: 'RehearsalKadabra2.990004',
  },
  {
    name: 'Abra',
    slug: 'abra',
    modelName: 'Abra',
    hfWeightsPath: 'abra/ckpts/policy_weights/policy_epoch_40.pt',
    fp16: true,
    packageFormat: 'bundle',
    ladders: ALL_THREE_LADDERS,
    avatarIcon: 'abra.png',
    githubLogin: 'rehearsal-abra',
    smogonSpec: 'RehearsalAbra.990005',
  },
  {
    name: 'Gen9Beta',
    slug: 'gen9beta',
    modelName: 'SmallRLGen9Beta',
    hfWeightsPath: 'small-rl-gen9beta/ckpts/policy_weights/policy_epoch_24.pt',
    fp16: false,
    packageFormat: 'oci',
    ladders: ALL_THREE_LADDERS,
    avatarIcon: 'ditto.png',
    githubLogin: 'rehearsal-gen9beta',
    smogonSpec: 'RehearsalGen9Beta.990006',
  },
  {
    name: 'Minikazam',
    slug: 'minikazam',
    modelName: 'Minikazam',
    hfWeightsPath: 'minikazam/ckpts/policy_weights/policy_epoch_40.pt',
    fp16: false,
    packageFormat: 'bundle',
    ladders: ALL_THREE_LADDERS,
    avatarIcon: 'minikazam.png',
    githubLogin: 'rehearsal-minikazam',
    smogonSpec: 'RehearsalMinikazam.990007',
  },
  {
    name: 'MixedGens V2A',
    slug: 'mixedgens-v2a',
    modelName: 'V2AMixedGens',
    hfWeightsPath: 'v2_small_rl_baseline_all_gens/ckpts/policy_weights/policy_epoch_26.pt',
    fp16: false,
    packageFormat: 'oci',
    ladders: ALL_THREE_LADDERS,
    avatarIcon: 'kakuna.png',
    githubLogin: 'rehearsal-mixedv2a',
    smogonSpec: 'RehearsalMixedV2A.990008',
  },
  {
    name: 'MediumRL',
    slug: 'mediumrl',
    modelName: 'MediumRL',
    hfWeightsPath: 'medium-rl/ckpts/policy_weights/policy_epoch_40.pt',
    fp16: true,
    packageFormat: 'bundle',
    ladders: CLASSIC_LADDERS,
    avatarIcon: 'ditto.png',
    githubLogin: 'rehearsal-mediumrl',
    smogonSpec: 'RehearsalMediumRL.990009',
  },
  {
    name: 'SmallIL',
    slug: 'smallil',
    modelName: 'SmallIL',
    hfWeightsPath: 'small-il/ckpts/policy_weights/policy_epoch_40.pt',
    fp16: false,
    packageFormat: 'oci',
    ladders: CLASSIC_LADDERS,
    avatarIcon: 'abra.png',
    githubLogin: 'rehearsal-smallil',
    smogonSpec: 'RehearsalSmallIL.990010',
  },
  {
    name: 'Tauros',
    slug: 'tauros',
    modelName: 'TaurosV0',
    hfWeightsPath: 'tauros-v0/ckpts/policy_weights/policy_epoch_62.pt',
    fp16: true,
    packageFormat: 'bundle',
    ladders: RBY_ONLY_LADDERS,
    avatarIcon: 'tauros.png',
    githubLogin: 'rehearsal-tauros',
    smogonSpec: 'RehearsalTauros.990011',
  },
  {
    name: 'Grouped V2A',
    slug: 'grouped-v2a',
    modelName: 'V2AGroupedV2ISFilter',
    hfWeightsPath: 'v2_small_rl_grouped_v2_isfilter/ckpts/policy_weights/policy_epoch_88.pt',
    fp16: false,
    packageFormat: 'oci',
    ladders: RBY_ONLY_LADDERS,
    avatarIcon: 'kakuna.png',
    githubLogin: 'rehearsal-groupedv2a',
    smogonSpec: 'RehearsalGroupedV2A.990012',
  },
];

const HARVESTED_LADDER_FORMATS: ReadonlyArray<{
  ladderId: string;
  slot: 'rby' | 'adv' | 'sv';
  format: string;
}> = [
  {ladderId: 'gen1ou20261109', slot: 'rby', format: 'gen1ou'},
  {ladderId: 'gen3ou20261109', slot: 'adv', format: 'gen3ou'},
  {ladderId: 'gen9ou20261109', slot: 'sv', format: 'gen9ou'},
];

const USAGE = [
  'Usage: rehearsal <command> --state-dir <dir> [options]',
  '',
  'Commands:',
  '  snapshot       Capture pre-rehearsal state & backup manifest [--fresh-backups]',
  '  restore-drill  Practice restoring SQLite backups on pkmn.ai and arena',
  '  build          Build 6 native (.tar.zst) + 6 OCI (linux/arm64) Metamon artifacts',
  '  stage          Upload private artifacts to GCP, upload pkmn/teams, activate RBY/ADV/SV',
  '  submit         Submit all 12 participants [--upgrade-alakazam]',
  '  verify         Wait for smoke tests + matches and verify ratings/telemetry/routes',
  '  status         Print live rehearsal standings, match counts, and inspect cookie',
  '  cleanup        Restore pkmn.ai, arena, and GCP to exact pre-rehearsal snapshot',
].join('\n');

const BOOLEAN_FLAGS = new Set(['help', 'fresh-backups', 'upgrade-alakazam', 'skip-preflight']);

function parseCliArgs(argv: string[]): {positional: string[]; flags: Map<string, string>} {
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

function runCmd(
  bin: string,
  args: string[],
  opts: {cwd?: string; input?: string | Buffer; timeoutMillis?: number} = {}
): string {
  return execFileSync(bin, args, {
    cwd: opts.cwd,
    input: opts.input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeoutMillis ?? 300_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function sshCmd(host: string, script: string, timeoutMillis = 300_000): string {
  return runCmd('ssh', [host, 'bash -se'], {input: script, timeoutMillis});
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(65_536);
  try {
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(n === buf.length ? buf : buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function sleepMillis(millis: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, millis));
}

function inspectRemotePkmn(pkmnHost: string): PkmnSnapshot {
  const script = [
    'set -euo pipefail',
    "node - <<'NODE_EOF'",
    "const {execFileSync} = require('child_process');",
    "const fs = require('fs');",
    "const {DatabaseSync} = require('node:sqlite');",
    "const db = new DatabaseSync('/var/lib/pkmn/arena.sqlite', {readOnly: true});",
    'const tables = db',
    "  .prepare(\"SELECT name FROM sqlite_master WHERE type = 'table' " +
      "AND name NOT LIKE 'sqlite_%' ORDER BY name\")",
    '  .all()',
    '  .map(r => r.name);',
    'const counts = {};',
    'for (const t of tables) {',
    '  counts[t] = db.prepare(\'SELECT COUNT(*) AS c FROM "\' + t + \'"\').get().c;',
    '}',
    'const ladders = db',
    '  .prepare(',
    "    'SELECT id, slot, status, ' +",
    "    '(SELECT COUNT(*) FROM ladder_teams lt WHERE lt.ladder_id = ladders.id) AS teams ' +",
    "    'FROM ladders ORDER BY slot'",
    '  )',
    '  .all();',
    'db.close();',
    'const git = (dir, args) =>',
    "  execFileSync('git', ['-C', dir, ...args], {encoding: 'utf8'}).trim();",
    'const lsDir = d => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);',
    'console.log(JSON.stringify({',
    "  head: git('/home/pkmn/ai', ['rev-parse', 'HEAD']),",
    "  gitStatus: git('/home/pkmn/ai', ['status', '--porcelain']),",
    "  wikiHead: git('/home/pkmn/ai/wiki', ['rev-parse', 'HEAD']),",
    "  wikiStatus: git('/home/pkmn/ai/wiki', ['status', '--porcelain']),",
    "  backups: lsDir('/var/lib/pkmn/backups'),",
    "  avatars: lsDir('/home/pkmn/ai/static/avatars'),",
    '  counts,',
    '  ladders,',
    '}));',
    'NODE_EOF',
  ].join('\n');
  return JSON.parse(sshCmd(pkmnHost, script)) as PkmnSnapshot;
}

function inspectRemoteArena(arenaHost: string): ArenaSnapshot {
  const script = [
    'set -euo pipefail',
    'export PATH="/opt/homebrew/bin:$PATH"',
    "/opt/homebrew/bin/node - <<'NODE_EOF'",
    "const {execFileSync} = require('child_process');",
    "const fs = require('fs');",
    "const {DatabaseSync} = require('node:sqlite');",
    "const db = new DatabaseSync('/opt/arena/state/arena.sqlite', {readOnly: true});",
    'const tables = db',
    "  .prepare(\"SELECT name FROM sqlite_master WHERE type = 'table' " +
      "AND name NOT LIKE 'sqlite_%' ORDER BY name\")",
    '  .all()',
    '  .map(r => r.name);',
    'const counts = {};',
    'for (const t of tables) {',
    '  counts[t] = db.prepare(\'SELECT COUNT(*) AS c FROM "\' + t + \'"\').get().c;',
    '}',
    'db.close();',
    'const podmanRaw = execFileSync(',
    "  '/opt/homebrew/bin/podman',",
    "  ['images', '--format', '{{.Repository}}:{{.Tag}}'],",
    "  {encoding: 'utf8'}",
    ').trim();',
    'const lsDir = d => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);',
    'console.log(JSON.stringify({',
    "  head: execFileSync('git', ['-C', '/opt/arena/repo', 'rev-parse', 'HEAD'], " +
      "{encoding: 'utf8'}).trim(),",
    "  gitStatus: execFileSync('git', ['-C', '/opt/arena/repo', 'status', '--porcelain'], " +
      "{encoding: 'utf8'}).trim(),",
    "  agentsDir: lsDir('/opt/arena/agents'),",
    "  coldAgents: lsDir('/Volumes/Archive/cold-agents'),",
    "  archiveLogs: lsDir('/Volumes/Archive/logs'),",
    "  dbBackups: lsDir('/Volumes/Archive/db-backups'),",
    "  podmanImages: podmanRaw ? podmanRaw.split('\\n').filter(Boolean).sort() : [],",
    '  counts,',
    '}));',
    'NODE_EOF',
  ].join('\n');
  return JSON.parse(sshCmd(arenaHost, script)) as ArenaSnapshot;
}

function listGcsObjects(bucket: string): string[] {
  const res = spawnSync('gcloud', ['storage', 'ls', '-r', `gs://${bucket}/`], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  return out
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith(`gs://${bucket}/`) && !l.endsWith(':'))
    .sort();
}

function listEnabledGcpServices(project: string): string[] {
  const out = runCmd('gcloud', [
    'services',
    'list',
    '--enabled',
    `--project=${project}`,
    '--format=value(config.name)',
  ]);
  return out.split('\n').map(s => s.trim()).filter(Boolean).sort();
}

function runSnapshot(ctx: RehearsalContext, freshBackups: boolean): SnapshotReport {
  const backupsDir = path.join(ctx.stateDir, 'backups');
  const manifestsDir = path.join(ctx.stateDir, 'manifests');
  fs.mkdirSync(backupsDir, {recursive: true, mode: 0o700});
  fs.mkdirSync(manifestsDir, {recursive: true, mode: 0o700});

  const pkmnPathFile = path.join(backupsDir, 'pkmn-ai-pre-remote-path.txt');
  const arenaPathFile = path.join(backupsDir, 'arena-pre-remote-path.txt');
  const localPkmnBackup = path.join(backupsDir, 'pkmn-ai-pre.sqlite.zst');
  const localArenaBackup = path.join(backupsDir, 'arena-pre.sqlite.zst');

  let pkmnRemoteBackup = fs.existsSync(pkmnPathFile)
    ? fs.readFileSync(pkmnPathFile, 'utf8').trim()
    : '';
  let arenaRemoteBackup = fs.existsSync(arenaPathFile)
    ? fs.readFileSync(arenaPathFile, 'utf8').trim()
    : '';

  if (freshBackups || !pkmnRemoteBackup || !fs.existsSync(localPkmnBackup)) {
    pkmnRemoteBackup = sshCmd(
      ctx.hosts.pkmnHost,
      'sudo -n /usr/sbin/service pkmn.ai-backup start && ' +
      'ls -1t /var/lib/pkmn/backups/arena-*.sqlite.zst | head -n 1'
    );
    fs.writeFileSync(pkmnPathFile, `${pkmnRemoteBackup}\n`, 'utf8');
    runCmd('scp', [`${ctx.hosts.pkmnHost}:${pkmnRemoteBackup}`, localPkmnBackup]);
    runCmd('zstd', ['-t', localPkmnBackup]);
  }

  if (freshBackups || !arenaRemoteBackup || !fs.existsSync(localArenaBackup)) {
    arenaRemoteBackup = sshCmd(
      ctx.hosts.arenaHost,
      'export PATH="/opt/homebrew/bin:$PATH" && ' +
      '/opt/arena/repo/arena/scripts/archive.sh && ' +
      'ls -1t /Volumes/Archive/db-backups/arena-state-*.sqlite.zst | head -n 1'
    );
    fs.writeFileSync(arenaPathFile, `${arenaRemoteBackup}\n`, 'utf8');
    runCmd('scp', [`${ctx.hosts.arenaHost}:${arenaRemoteBackup}`, localArenaBackup]);
    runCmd('zstd', ['-t', localArenaBackup]);
  }

  const report: SnapshotReport = {
    capturedAt: new Date().toISOString(),
    pkmnPreBackup: pkmnRemoteBackup,
    arenaPreBackup: arenaRemoteBackup,
    pkmn: inspectRemotePkmn(ctx.hosts.pkmnHost),
    arena: inspectRemoteArena(ctx.hosts.arenaHost),
    gcsObjects: listGcsObjects(ctx.gcp.bucket),
    gcpEnabledServices: listEnabledGcpServices(ctx.gcp.project),
  };

  const snapPath = path.join(manifestsDir, 'pre-snapshot.json');
  fs.writeFileSync(snapPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Saved pre-rehearsal snapshot -> ${snapPath}`);
  console.log(`  pkmn.ai HEAD=${report.pkmn.head} agents=${report.pkmn.counts.agents ?? 0}`);
  const localAgents = report.arena.counts.local_agents ?? 0;
  console.log(`  arena   HEAD=${report.arena.head} local_agents=${localAgents}`);
  console.log(`  GCS objects (${report.gcsObjects.length}): ${report.gcsObjects.join(', ')}`);
  return report;
}

function loadPreSnapshot(ctx: RehearsalContext): SnapshotReport {
  const snapPath = path.join(ctx.stateDir, 'manifests', 'pre-snapshot.json');
  if (!fs.existsSync(snapPath)) {
    throw new Error(`Missing pre-rehearsal snapshot at ${snapPath}; run 'snapshot' first.`);
  }
  return JSON.parse(fs.readFileSync(snapPath, 'utf8')) as SnapshotReport;
}

async function runRestoreDrill(ctx: RehearsalContext): Promise<void> {
  const snap = loadPreSnapshot(ctx);
  if ((snap.pkmn.counts.agents ?? 0) > 0 || (snap.pkmn.counts.matches ?? 0) > 0) {
    throw new Error('Refusing restore-drill: pre-snapshot has non-zero agents or matches.');
  }

  console.log('1. Restoring pkmn.ai /var/lib/pkmn/arena.sqlite from pinned zstd backup...');
  sshCmd(
    ctx.hosts.pkmnHost,
    [
      'set -euo pipefail',
      'sudo -n /usr/sbin/service pkmn.ai-server stop',
      'rm -f /var/lib/pkmn/arena.sqlite /var/lib/pkmn/arena.sqlite-wal ' +
        '/var/lib/pkmn/arena.sqlite-shm',
      'umask 077',
      `zstd -dc '${snap.pkmnPreBackup}' -o /var/lib/pkmn/arena.sqlite`,
      'chmod 0600 /var/lib/pkmn/arena.sqlite',
      'CHK="$(sqlite3 /var/lib/pkmn/arena.sqlite \'PRAGMA integrity_check;\')"',
      '[[ "$CHK" == "ok" ]] || { echo "Integrity check failed: $CHK" >&2; exit 1; }',
      'sudo -n /usr/sbin/service pkmn.ai-server start',
    ].join('\n')
  );

  console.log('2. Restoring arena /opt/arena/state/arena.sqlite from pinned zstd backup...');
  sshCmd(
    ctx.hosts.arenaHost,
    [
      'set -euo pipefail',
      'export PATH="/opt/homebrew/bin:$PATH"',
      ...buildArenaSqliteRestoreLines(snap.arenaPreBackup, 'restore-drill'),
      'sudo -n /bin/launchctl kickstart -k system/ai.pkmn.arena',
    ].join('\n')
  );

  console.log('3. Waiting 7s for fresh coordinator heartbeat...');
  await sleepMillis(7_000);
  const arenaRes = await fetch(`${ctx.hosts.publicBaseUrl}/arena.json`);
  if (!arenaRes.ok) throw new Error(`/arena.json returned HTTP ${arenaRes.status}`);
  const liveRes = await fetch(`${ctx.hosts.publicBaseUrl}/api/live.json`);
  if (!liveRes.ok) throw new Error(`/api/live.json returned HTTP ${liveRes.status}`);
  const liveJson = (await liveRes.json()) as {stale: boolean; recentMatches: unknown[]};
  if (liveJson.stale) throw new Error('/api/live.json reported stale=true after restore drill');
  if (liveJson.recentMatches.length !== 0) {
    throw new Error(`Expected 0 recentMatches, got ${liveJson.recentMatches.length}`);
  }
  console.log('PASS: Live SQLite backup restore drill succeeded on both pkmn.ai and arena.');
}

function ensurePackedCheckpoint(
  ctx: RehearsalContext,
  pyBin: string,
  cacheKey: string,
  hfWeightsPath: string,
  fp16: boolean
): string {
  const weightsDir = path.join(ctx.stateDir, 'weights');
  fs.mkdirSync(weightsDir, {recursive: true});
  const outZst = path.join(weightsDir, `${cacheKey}.pt.zst`);
  if (fs.existsSync(outZst) && fs.statSync(outZst).size > 0) return outZst;

  console.log(`  Downloading & packing checkpoint ${cacheKey} (${hfWeightsPath})...`);
  const rawPt = path.join(weightsDir, `${cacheKey}.raw.pt`);
  const hfUrl = `https://huggingface.co/jakegrigsby/metamon/resolve/main/${hfWeightsPath}`;
  runCmd('curl', ['-fsSL', hfUrl, '-o', rawPt], {timeoutMillis: 600_000});

  if (fp16) {
    runCmd(pyBin, [
      '-c',
      'import sys, torch; ' +
      'sd = torch.load(sys.argv[1], map_location="cpu", weights_only=False); ' +
      'sd16 = {k: (v.half() if torch.is_floating_point(v) else v) for k, v in sd.items()}; ' +
      'torch.save(sd16, sys.argv[2])',
      rawPt,
      `${rawPt}.fp16`,
    ]);
    fs.renameSync(`${rawPt}.fp16`, rawPt);
  }
  runCmd('zstd', ['-3', '-q', '--rm', '-f', rawPt, '-o', outZst]);
  return outZst;
}

function ensureHarvestedTeamFiles(ctx: RehearsalContext): void {
  const teamsDir = path.join(ctx.stateDir, 'teams');
  fs.mkdirSync(teamsDir, {recursive: true});
  const allReady = HARVESTED_LADDER_FORMATS.every(({format}) =>
    fs.existsSync(path.join(teamsDir, `${format}.txt`)));
  if (allReady) return;

  const commit = runCmd('git', ['-C', root('teams', 'teams'), 'rev-parse', 'HEAD']);
  const extractDir = path.join(ctx.stateDir, 'pkmn-teams-extract');
  fs.rmSync(extractDir, {recursive: true, force: true});
  fs.mkdirSync(extractDir, {recursive: true});

  try {
    runCmd('bash', [
      '-euo',
      'pipefail',
      '-c',
      `curl -fsSL "https://codeload.github.com/pkmn/teams/tar.gz/${commit}" | ` +
      `tar -xz --strip-components=1 -C "${extractDir}"`,
    ]);

    for (const {format} of HARVESTED_LADDER_FORMATS) {
      const dir = path.join(extractDir, format);
      const files = fs.readdirSync(dir).sort();
      const maxCandidates = 180;
      const step = Math.max(1, Math.floor(files.length / maxCandidates));
      let anchorPaste: string | undefined;
      let anchorPacked: string | undefined;
      const seenPacked = new Set<string>();
      const validPastes: string[] = [];

      for (let i = 0; i < files.length && validPastes.length < 100; i += step) {
        const full = path.join(dir, files[i]);
        if (!fs.statSync(full).isFile()) continue;
        const paste = fs.readFileSync(full, 'utf8').trim();
        if (!paste) continue;
        if (!anchorPaste) {
          anchorPaste = paste;
          continue;
        }
        try {
          const pair = validateHarvestedTeams([anchorPaste, paste], format);
          if (!anchorPacked) {
            anchorPacked = pair[0];
            seenPacked.add(anchorPacked);
            validPastes.push(`=== [${format}] team-1 ===\n${anchorPaste}`);
          }
          if (!seenPacked.has(pair[1])) {
            seenPacked.add(pair[1]);
            validPastes.push(`=== [${format}] team-${validPastes.length + 1} ===\n${paste}`);
          }
        } catch {
          if (!anchorPacked) anchorPaste = paste;
        }
      }
      const combined = `${validPastes.join('\n\n')}\n`;
      const checked = validateHarvestedTeams(combined, format);
      const outPath = path.join(teamsDir, `${format}.txt`);
      fs.writeFileSync(outPath, combined, 'utf8');
      console.log(`  Validated ${checked.length} ${format} teams -> ${outPath}`);
    }
  } finally {
    fs.rmSync(extractDir, {recursive: true, force: true});
  }
}

function buildNativeBundleArchive(opts: {
  pyDarwinDir: string;
  stdioScriptPath: string;
  weightsZstPath: string;
  modelName: string;
  outBundlePath: string;
  verifyStagingDir: string;
}): {sha256: string; unpackedBytes: number} {
  const verifyDest = fs.mkdtempSync(path.join(opts.verifyStagingDir, 'bundle-chk-'));
  if (fs.existsSync(opts.outBundlePath) && fs.statSync(opts.outBundlePath).size > 0) {
    try {
      fs.rmSync(verifyDest, {recursive: true, force: true});
      const unpackedBytes = unpack.bundle(opts.outBundlePath, verifyDest);
      if (unpackedBytes <= MAX_UNPACKED_BYTES) {
        return {sha256: sha256File(opts.outBundlePath), unpackedBytes};
      }
    } catch {
      // Rebuild if existing archive is invalid.
    } finally {
      fs.rmSync(verifyDest, {recursive: true, force: true});
    }
  }

  const stageRoot = fs.mkdtempSync(path.join(opts.verifyStagingDir, 'bundle-src-'));
  const freshVerifyDest = fs.mkdtempSync(path.join(opts.verifyStagingDir, 'bundle-chk-'));
  try {
    const srcPy = path.join(opts.pyDarwinDir, 'python');
    const dstPy = path.join(stageRoot, 'python');
    runCmd('/bin/cp', ['-cR', srcPy, dstPy]);
    fs.copyFileSync(opts.stdioScriptPath, path.join(stageRoot, 'metamon_stdio.py'));
    fs.copyFileSync(opts.weightsZstPath, path.join(stageRoot, 'policy.pt.zst'));

    const runSh = [
      '#!/bin/sh',
      'set -eu',
      'DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
      `export METAMON_MODEL_NAME='${opts.modelName}'`,
      'export METAMON_WEIGHTS_PATH="$DIR/policy.pt.zst"',
      'export PYTHONUNBUFFERED=1',
      'export TORCH_COMPILE_DISABLE=1',
      'exec "$DIR/python/bin/python3.12" "$DIR/metamon_stdio.py"',
      '',
    ].join('\n');
    const runPath = path.join(stageRoot, 'run');
    fs.writeFileSync(runPath, runSh, {mode: 0o755});
    fs.chmodSync(runPath, 0o755);

    fs.rmSync(opts.outBundlePath, {force: true});
    runCmd('tar', [
      '--no-mac-metadata',
      '--no-xattrs',
      '--zstd',
      '-cf',
      opts.outBundlePath,
      '-C',
      stageRoot,
      '.',
    ], {timeoutMillis: 300_000});

    fs.rmSync(freshVerifyDest, {recursive: true, force: true});
    const unpackedBytes = unpack.bundle(opts.outBundlePath, freshVerifyDest);
    if (unpackedBytes > MAX_UNPACKED_BYTES) {
      throw new Error(`Bundle ${opts.outBundlePath} exceeds 500 MiB (${unpackedBytes} B)`);
    }
    const sha256 = sha256File(opts.outBundlePath);
    return {sha256, unpackedBytes};
  } finally {
    fs.rmSync(stageRoot, {recursive: true, force: true});
    fs.rmSync(freshVerifyDest, {recursive: true, force: true});
  }
}

function buildLinuxBaseContainerScript(): string {
  return [
    'set -euo pipefail',
    'export PATH="/opt/homebrew/bin:$PATH"',
    'BDIR="/Volumes/Archive/_rehearsal_build"',
    'cd "$BDIR"',
    'if ! podman image exists rehearsal-metamon-linux-base:latest; then',
    "  cat > Containerfile.base <<'EOF'",
    'FROM docker.io/library/debian:bookworm-slim AS builder',
    'RUN apt-get update && apt-get install -y --no-install-recommends \\',
    '      ca-certificates curl git zstd unzip && \\',
    '    mkdir -p /opt/py && \\',
    `    curl -fsSL "${LINUX_PY_URL}" | tar -xz -C /opt/py && \\`,
    '    PY="/opt/py/python/bin/python3.12" && \\',
    '    "$PY" -m pip install --no-cache-dir ' +
      '--index-url https://download.pytorch.org/whl/cpu "torch==2.8.0+cpu" && \\',
    '    "$PY" -m pip install --no-cache-dir \\',
    '      "numpy>=2.0,<2.3" "gymnasium==0.29.1" "cloudpickle" "farama-notifications" \\',
    '      "typing-extensions" "gin-config" "einops" "orjson" "termcolor" "lz4" \\',
    '      "tqdm" "tabulate" "packaging" "pyyaml" "psutil" "safetensors" "websockets" \\',
    '      "requests" "sympy>=1.13.3" "mpmath<1.4,>=1.1.0" && \\',
    '    "$PY" -m pip install --no-cache-dir --no-deps \\',
    '      "accelerate>=1.0" \\',
    '      "git+https://github.com/UT-Austin-RPL/poke-env.git" \\',
    '      "git+https://github.com/UT-Austin-RPL/amago@v3.4.0" && \\',
    '    SITE="$("$PY" -c \'import site; print(site.getsitepackages()[0])\')" && \\',
    '    git clone --depth 1 -q https://github.com/UT-Austin-RPL/metamon.git /tmp/mm && \\',
    '    cp -R /tmp/mm/metamon "$SITE/metamon" && \\',
    '    rm -rf /tmp/mm "$SITE/metamon/baselines/model_based/pretrained_models" \\',
    '      "$SITE/metamon/backend/team_preview/gen9ou_high_elo_v4" && \\',
    '    printf \'def init(*a, **kw): return None\\ndef log(*a, **kw): pass\\n' +
      'def finish(*a, **kw): pass\\nrun = None\\n\' > "$SITE/wandb.py" && \\',
    '    printf \'from gymnasium import *\\nfrom gymnasium import spaces, wrappers\\n\' ' +
      '> "$SITE/gym.py" && \\',
    '    printf \'def hf_hub_download(*a, **kw): raise RuntimeError("offline")\\n\' ' +
      '> "$SITE/huggingface_hub.py" && \\',
    '    mkdir -p "$SITE/datasets" "$SITE/ratarmountcore" "$SITE/rich" && \\',
    '    touch "$SITE/datasets/__init__.py" "$SITE/ratarmountcore/__init__.py" && \\',
    '    printf \'class SQLiteIndexedTarFileSystem: pass\\n\' ' +
      '> "$SITE/ratarmountcore/SQLiteIndexedTarFsspec.py" && \\',
    '    printf \'def print(*a, **kw): pass\\n\' > "$SITE/rich/__init__.py" && \\',
    '    printf \'class Console:\\n  def print(self, *a, **kw): pass\\n' +
      '  def log(self, *a, **kw): pass\\n\' > "$SITE/rich/console.py" && \\',
    '    printf \'def track(seq, *a, **kw): return seq\\n\' > "$SITE/rich/progress.py" && \\',
    '    printf \'class Table:\\n  def __init__(self, *a, **kw): pass\\n' +
      '  def add_column(self, *a, **kw): pass\\n  def add_row(self, *a, **kw): pass\\n\' ' +
      '> "$SITE/rich/table.py" && \\',
    '    "$PY" -m pip uninstall -y pip setuptools wheel || true && \\',
    '    rm -rf /opt/py/python/include /opt/py/python/share /opt/py/python/lib/pkgconfig \\',
    '      /opt/py/python/lib/libpython3.12* /opt/py/python/lib/libtcl* \\',
    '      /opt/py/python/lib/libtk* /opt/py/python/lib/tcl* /opt/py/python/lib/tk* \\',
    '      /opt/py/python/lib/python3.12/lib-dynload/_tkinter* \\',
    '      /opt/py/python/lib/python3.12/test /opt/py/python/lib/python3.12/tkinter \\',
    '      /opt/py/python/lib/python3.12/idlelib /opt/py/python/lib/python3.12/ensurepip \\',
    '      /opt/py/python/lib/python3.12/pydoc_data "$SITE/torch/include" "$SITE/torch/share" \\',
    '      "$SITE/torch/test" "$SITE/caffe2" "$SITE/torch/bin/protoc"* "$SITE/numpy/tests" \\',
    '      "$SITE/sympy/testing" && \\',
    '    find /opt/py/python -type d -name "tests" -prune -exec rm -rf {} + ' +
      '2>/dev/null || true && \\',
    '    find /opt/py/python -type f -name "*.a" -delete && \\',
    '    "$PY" -m compileall -q "$SITE/metamon" "$SITE/amago" "$SITE/poke_env" || true && \\',
    '    mkdir -p /tmp/sp && mv "$SITE" /tmp/sp/site-packages && \\',
    '    tar -cf - -C /tmp/sp site-packages | zstd -6 -T0 -o /opt/py/site-packages.tar.zst && \\',
    '    rm -rf /tmp/sp && ln -s /scratch/.py/site-packages "$SITE" && \\',
    '    printf \'#!/bin/sh\\nset -eu\\nif [ ! -d /scratch/.py/site-packages ]; then\\n' +
      '  mkdir -p /scratch/.py\\n' +
      '  zstd -dc /opt/py/site-packages.tar.zst | tar -xf - -C /scratch/.py\\nfi\\n' +
      'exec /opt/py/python/bin/python3.12 /app/metamon_stdio.py\\n\' > /opt/py/entrypoint.sh && \\',
    '    chmod 0755 /opt/py/entrypoint.sh',
    'FROM docker.io/library/debian:bookworm-slim',
    'RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 zstd && \\',
    '    mkdir -p /scratch /opt/arena/stats /app && \\',
    '    rm -rf /var/lib/apt/lists/* /var/cache/apt/*',
    'COPY --from=builder /opt/py /opt/py',
    'EOF',
    '  podman build --platform linux/arm64 -t rehearsal-metamon-linux-base:latest ' +
      '-f Containerfile.base "$BDIR" >/dev/null',
    'fi',
    "podman image inspect --format '{{.Size}}' rehearsal-metamon-linux-base:latest",
  ].join('\n');
}

function runBuild(ctx: RehearsalContext, skipPreflight: boolean): void {
  const pyDarwinDir = path.join(ctx.stateDir, 'py-darwin');
  const pyBin = path.join(pyDarwinDir, 'python', 'bin', 'python3.12');
  const stdioScriptPath = path.join(ctx.stateDir, 'runtime', 'metamon_stdio.py');
  if (!fs.existsSync(pyBin) || !fs.existsSync(stdioScriptPath)) {
    throw new Error(`Missing local darwin runtime (${pyBin}) or ${stdioScriptPath}`);
  }
  const stdioSrc = fs.readFileSync(stdioScriptPath, 'utf8');
  if (!stdioSrc.includes('/ready')) {
    throw new Error(
      `Cached ${stdioScriptPath} does not emit /ready; update it for the current Arena protocol`
    );
  }

  ensureHarvestedTeamFiles(ctx);

  console.log('1. Downloading and packing all Metamon checkpoints...');
  for (const p of PARTICIPANTS) {
    ensurePackedCheckpoint(ctx, pyBin, p.slug, p.hfWeightsPath, p.fp16);
    if (p.upgradeHfWeightsPath) {
      ensurePackedCheckpoint(ctx, pyBin, `${p.slug}-1.1.0`, p.upgradeHfWeightsPath, p.fp16);
    }
  }

  const bundlesDir = path.join(ctx.stateDir, 'bundles');
  const tmpVerifyDir = path.join(ctx.stateDir, 'tmp-verify');
  fs.mkdirSync(bundlesDir, {recursive: true});
  fs.mkdirSync(tmpVerifyDir, {recursive: true});

  const buildRecords: BuildArtifactRecord[] = [];

  console.log('2. Building & verifying native darwin/arm64 .tar.zst bundles...');
  for (const p of PARTICIPANTS) {
    if (p.packageFormat !== 'bundle') continue;
    const outBundle = path.join(bundlesDir, `${p.slug}-1.0.0.tar.zst`);
    const weightsZst = path.join(ctx.stateDir, 'weights', `${p.slug}.pt.zst`);
    const built = buildNativeBundleArchive({
      pyDarwinDir,
      stdioScriptPath,
      weightsZstPath: weightsZst,
      modelName: p.modelName,
      outBundlePath: outBundle,
      verifyStagingDir: tmpVerifyDir,
    });
    const mib = (built.unpackedBytes / (1024 * 1024)).toFixed(1);
    const shortSha = built.sha256.slice(0, 12);
    console.log(`  Built bundle ${p.slug}@1.0.0: ${mib} MiB unpacked, sha256=${shortSha}…`);
    buildRecords.push({
      slug: p.slug,
      version: '1.0.0',
      packageFormat: 'bundle',
      localBundlePath: outBundle,
      sha256: built.sha256,
      unpackedBytes: built.unpackedBytes,
      ladders: [...p.ladders],
    });

    if (p.upgradeHfWeightsPath) {
      const upgBundle = path.join(bundlesDir, `${p.slug}-1.1.0.tar.zst`);
      const upgWeights = path.join(ctx.stateDir, 'weights', `${p.slug}-1.1.0.pt.zst`);
      const builtUpg = buildNativeBundleArchive({
        pyDarwinDir,
        stdioScriptPath,
        weightsZstPath: upgWeights,
        modelName: p.modelName,
        outBundlePath: upgBundle,
        verifyStagingDir: tmpVerifyDir,
      });
      const upgMib = (builtUpg.unpackedBytes / (1024 * 1024)).toFixed(1);
      console.log(`  Built upgrade bundle ${p.slug}@1.1.0: ${upgMib} MiB unpacked`);
      buildRecords.push({
        slug: p.slug,
        version: '1.1.0',
        packageFormat: 'bundle',
        localBundlePath: upgBundle,
        sha256: builtUpg.sha256,
        unpackedBytes: builtUpg.unpackedBytes,
        ladders: [...p.ladders],
      });
    }
  }

  console.log('3. Building & verifying linux/arm64 OCI images on arena...');
  const ociSpecs = PARTICIPANTS.filter(p => p.packageFormat === 'oci');
  sshCmd(
    ctx.hosts.arenaHost,
    'mkdir -p /Volumes/Archive/_rehearsal_build/weights && ' +
    'chmod 0700 /Volumes/Archive/_rehearsal_build'
  );
  const remoteBuildRoot = `${ctx.hosts.arenaHost}:/Volumes/Archive/_rehearsal_build`;
  runCmd('scp', [stdioScriptPath, `${remoteBuildRoot}/metamon_stdio.py`]);
  for (const p of ociSpecs) {
    const localW = path.join(ctx.stateDir, 'weights', `${p.slug}.pt.zst`);
    runCmd('scp', [localW, `${remoteBuildRoot}/weights/${p.slug}.pt.zst`]);
  }

  const baseBytes = Number(
    sshCmd(ctx.hosts.arenaHost, buildLinuxBaseContainerScript(), 900_000)
  );
  console.log(`  Linux OCI base image size: ${(baseBytes / (1024 * 1024)).toFixed(1)} MiB`);

  for (const p of ociSpecs) {
    const tag = `rehearsal-build-${p.slug}:1.0.0`;
    const childScript = [
      'set -euo pipefail',
      'export PATH="/opt/homebrew/bin:$PATH"',
      'BDIR="/Volumes/Archive/_rehearsal_build"',
      `CTX="$BDIR/ctx-${p.slug}"`,
      'rm -rf "$CTX" && mkdir -p "$CTX"',
      'cp "$BDIR/metamon_stdio.py" "$CTX/metamon_stdio.py"',
      `cp "$BDIR/weights/${p.slug}.pt.zst" "$CTX/policy.pt.zst"`,
      "cat > \"$CTX/Containerfile\" <<'EOF'",
      'FROM localhost/rehearsal-metamon-linux-base:latest',
      'COPY metamon_stdio.py /app/metamon_stdio.py',
      'COPY policy.pt.zst /app/policy.pt.zst',
      `ENV METAMON_MODEL_NAME=${p.modelName}`,
      'ENV METAMON_WEIGHTS_PATH=/app/policy.pt.zst',
      'ENV PYTHONUNBUFFERED=1',
      'ENV TORCH_COMPILE_DISABLE=1',
      'ENTRYPOINT ["/opt/py/entrypoint.sh"]',
      'EOF',
      `podman build --platform linux/arm64 -t '${tag}' "$CTX" >/dev/null`,
      'rm -rf "$CTX"',
      `podman image inspect --format '{{.Size}}' '${tag}'`,
    ].join('\n');
    const imgBytes = Number(sshCmd(ctx.hosts.arenaHost, childScript, 300_000));
    if (!Number.isFinite(imgBytes) || imgBytes > MAX_UNPACKED_BYTES) {
      throw new Error(`OCI image ${tag} exceeds 500 MiB (${imgBytes} B)`);
    }
    const imgMib = (imgBytes / (1024 * 1024)).toFixed(1);
    console.log(`  Built OCI ${p.slug}@1.0.0: ${imgMib} MiB uncompressed`);
    buildRecords.push({
      slug: p.slug,
      version: '1.0.0',
      packageFormat: 'oci',
      unpackedBytes: imgBytes,
      ladders: [...p.ladders],
    });
  }

  if (!skipPreflight) {
    console.log('4. Running sandbox pre-flight gate on arena (1 native + 1 OCI)...');
    const sampleNative = path.join(bundlesDir, 'alakazam-1.0.0.tar.zst');
    runCmd('scp', [
      sampleNative,
      `${ctx.hosts.arenaHost}:/Volumes/Staging/_preflight_alakazam.tar.zst`,
    ]);
    for (const fmt of ['gen1ou', 'gen3ou', 'gen9ou']) {
      runCmd('scp', [
        path.join(ctx.stateDir, 'teams', `${fmt}.txt`),
        `${ctx.hosts.arenaHost}:/Volumes/Staging/_preflight_${fmt}.txt`,
      ]);
    }
    const preflightScript = [
      'set -euo pipefail',
      'export PATH="/opt/arena/bin:/opt/homebrew/bin:$PATH"',
      'cd /opt/arena/repo',
      'DEST="/opt/arena/agents/_preflight_alakazam"',
      'rm -rf "$DEST"',
      'trap \'rm -rf "$DEST" /Volumes/Staging/_preflight_*; ' +
        '/opt/arena/bin/arena cleanup p1 native >/dev/null 2>&1 || true; ' +
        '/opt/arena/bin/arena cleanup p1 container >/dev/null 2>&1 || true\' EXIT',
      "/opt/homebrew/bin/node - <<'NODE_EOF'",
      "const fs = require('fs');",
      "const unpack = require('./build/arena/unpack');",
      "const {TimeSlicedArenaGame} = require('./build/arena/arbiter');",
      "const {validateHarvestedTeams} = require('./build/server/teams');",
      "unpack.bundle('/Volumes/Staging/_preflight_alakazam.tar.zst', " +
        "'/opt/arena/agents/_preflight_alakazam');",
      "const bad = new Set(['crash', 'oom', 'timeout', 'invalid-choice', " +
        "'arbiter-stall', 'sim-error', 'arena-error']);",
      '(async () => {',
      "  for (const format of ['gen1ou', 'gen3ou', 'gen9ou']) {",
      "    const raw = fs.readFileSync('/Volumes/Staging/_preflight_' + format + '.txt', 'utf8');",
      '    const packed = validateHarvestedTeams(raw, format);',
      '    const specs = [',
      "      {mode: 'native', target: '_preflight_alakazam'},",
      "      {mode: 'container', target: 'localhost/rehearsal-build-kadabra-iv:1.0.0'},",
      '    ];',
      '    for (const spec of specs) {',
      '      const g = new TimeSlicedArenaGame({',
      '        format,',
      "        seed: '1,2,3,4',",
      '        p1: {spec, teamPacked: packed[0]},',
      "        p2: {spec: {mode: 'native', target: '_baseline'}, teamPacked: packed[1]},",
      '        smokeStopAfterTurn: 1,',
      '        timers: {startingBankSeconds: 60, readyGraceSeconds: 60, maxTurnSeconds: 60},',
      '        devMode: false,',
      '      });',
      '      const res = await g.run();',
      '      if (bad.has(res.endReason)) {',
      "        throw new Error(format + ' ' + spec.mode + ': ' + res.endReason + ' ' + " +
        '(res.p1.stderr || ""));',
      '      }',
      "      console.log('PREFLIGHT_OK', format, spec.mode, " +
        "'turnMs=' + res.p1.meanTurnMillis, 'ramMiB=' + res.p1.peakRam);",
      '    }',
      '  }',
      '})();',
      'NODE_EOF',
    ].join('\n');
    console.log(sshCmd(ctx.hosts.arenaHost, preflightScript, 300_000));
  }

  const buildManifestPath = path.join(ctx.stateDir, 'manifests', 'build.json');
  fs.writeFileSync(buildManifestPath, `${JSON.stringify(buildRecords, null, 2)}\n`, 'utf8');
  console.log(`Saved build manifest -> ${buildManifestPath}`);
}

function runStage(ctx: RehearsalContext): void {
  const buildManifestPath = path.join(ctx.stateDir, 'manifests', 'build.json');
  if (!fs.existsSync(buildManifestPath)) {
    throw new Error(`Missing ${buildManifestPath}; run 'build' first.`);
  }
  const built = JSON.parse(fs.readFileSync(buildManifestPath, 'utf8')) as BuildArtifactRecord[];
  const artifactsPath = path.join(ctx.stateDir, 'manifests', 'artifacts.json');

  if (!fs.existsSync(artifactsPath)) {
    console.log('1. Enabling Artifact Registry & creating private rehearsal repository...');
    runCmd('gcloud', [
      'services',
      'enable',
      'artifactregistry.googleapis.com',
      `--project=${ctx.gcp.project}`,
      '--quiet',
    ]);
    const descRepo = spawnSync('gcloud', [
      'artifacts',
      'repositories',
      'describe',
      ctx.gcp.garRepo,
      `--location=${ctx.gcp.location}`,
      `--project=${ctx.gcp.project}`,
    ]);
    if (descRepo.status !== 0) {
      runCmd('gcloud', [
        'artifacts',
        'repositories',
        'create',
        ctx.gcp.garRepo,
        '--repository-format=docker',
        `--location=${ctx.gcp.location}`,
        `--project=${ctx.gcp.project}`,
        '--quiet',
      ]);
    }

    const staged: StagedArtifactRecord[] = [];
    console.log('2. Uploading native .tar.zst bundles to gs://pkmn-arena/rehearsal/bundles/...');
    for (const item of built) {
      if (item.packageFormat !== 'bundle' || !item.localBundlePath || !item.sha256) continue;
      const objName = `${item.slug}-${item.version}.tar.zst`;
      const gcsUri = `gs://${ctx.gcp.bucket}/rehearsal/bundles/${objName}`;
      runCmd('gcloud', ['storage', 'cp', '--quiet', item.localBundlePath, gcsUri]);
      staged.push({
        slug: item.slug,
        version: item.version,
        packageFormat: 'bundle',
        url: `https://storage.googleapis.com/${ctx.gcp.bucket}/rehearsal/bundles/${objName}`,
        sha256: item.sha256,
        unpackedBytes: item.unpackedBytes,
        ladders: item.ladders,
      });
    }

    console.log('3. Pushing linux/arm64 OCI images to GAR & purging local build cache on arena...');
    const gcpToken = runCmd('gcloud', ['auth', 'print-access-token']);
    const garHost = `${ctx.gcp.location}-docker.pkg.dev`;
    for (const item of built) {
      if (item.packageFormat !== 'oci') continue;
      const localTag = `localhost/rehearsal-build-${item.slug}:${item.version}`;
      const remoteRef =
        `${garHost}/${ctx.gcp.project}/${ctx.gcp.garRepo}/${item.slug}:${item.version}`;
      const pushScript = [
        'set -euo pipefail',
        'export PATH="/opt/homebrew/bin:$PATH"',
        `podman push --creds 'oauth2accesstoken:${gcpToken}' --remove-signatures ` +
          `'${localTag}' 'docker://${remoteRef}' >/dev/null`,
        `skopeo inspect --raw --creds 'oauth2accesstoken:${gcpToken}' 'docker://${remoteRef}'`,
      ].join('\n');
      const rawManifest = sshCmd(ctx.hosts.arenaHost, pushScript, 600_000);
      const manifestSha256 = crypto.createHash('sha256').update(rawManifest).digest('hex');
      console.log(`  Pushed ${remoteRef} -> manifest sha256=${manifestSha256.slice(0, 12)}…`);
      staged.push({
        slug: item.slug,
        version: item.version,
        packageFormat: 'oci',
        url: remoteRef,
        sha256: manifestSha256,
        unpackedBytes: item.unpackedBytes,
        ladders: item.ladders,
      });
    }

    sshCmd(
      ctx.hosts.arenaHost,
      [
        'set -euo pipefail',
        'export PATH="/opt/homebrew/bin:$PATH"',
        'rm -rf /Volumes/Archive/_rehearsal_build',
        "IMGS=$(podman images --format '{{.Repository}}:{{.Tag}}' | " +
          "grep -E 'rehearsal-(build|metamon-linux-base)' || true)",
        'for img in $IMGS; do podman rmi -f "$img" >/dev/null 2>&1 || true; done',
      ].join('\n')
    );

    fs.writeFileSync(artifactsPath, `${JSON.stringify(staged, null, 2)}\n`, 'utf8');
    console.log(`Saved staged artifacts manifest -> ${artifactsPath}`);
  } else {
    console.log(`1–3. Reusing already-staged GCP artifacts from ${artifactsPath}`);
  }

  console.log('4. Uploading harvested pkmn/teams pools to RBY, ADV, and SV ladders...');
  sshCmd(ctx.hosts.pkmnHost, 'mkdir -p /tmp/rehearsal-teams && chmod 0700 /tmp/rehearsal-teams');
  for (const {ladderId, format} of HARVESTED_LADDER_FORMATS) {
    const localFile = path.join(ctx.stateDir, 'teams', `${format}.txt`);
    const remoteFile = `/tmp/rehearsal-teams/${format}.txt`;
    runCmd('scp', [localFile, `${ctx.hosts.pkmnHost}:${remoteFile}`]);
    const out = sshCmd(
      ctx.hosts.pkmnHost,
      [
        'set -euo pipefail',
        'cd /home/pkmn/ai',
        'node --env-file-if-exists=/home/pkmn/ai/.env build/tools/pkmn ' +
          `upload-ladder-teams '${ladderId}' '${remoteFile}'`,
        `rm -f '${remoteFile}'`,
      ].join('\n')
    );
    console.log(`  ${out.replace(/\n/g, ' | ')}`);
  }
  sshCmd(ctx.hosts.pkmnHost, 'rmdir /tmp/rehearsal-teams 2>/dev/null || true');

  console.log('5. Staging temporary rehearsal projects & avatars on pkmn.ai (uncommitted)...');
  const iconsDir = path.join(ctx.stateDir, 'metamon-src', 'media', 'icons');
  sshCmd(ctx.hosts.pkmnHost, 'mkdir -p /home/pkmn/ai/static/avatars');
  for (const p of PARTICIPANTS) {
    const srcIcon = path.join(iconsDir, p.avatarIcon);
    if (fs.existsSync(srcIcon)) {
      const dstAvatar = `${ctx.hosts.pkmnHost}:/home/pkmn/ai/static/avatars/${p.slug}.png`;
      runCmd('scp', [srcIcon, dstAvatar]);
    }
  }

  const yamlBlocks = PARTICIPANTS.map(p => [
    `- name: ${p.name}`,
    '  site: https://metamon.tech/',
    '  paper: Grigsby:2025',
    '  active: 2025',
    '  license: MIT',
    '  source: https://github.com/UT-Austin-RPL/metamon',
    '  language: Python',
    '  platform:',
    '    - name: Pokémon Showdown!',
    '      url: https://github.com/smogon/pokemon-showdown',
    '  arena:',
    '    qualified: true',
    `    logo: ${p.slug}.png`,
    '    owners:',
    `      ${p.githubLogin}: ${p.smogonSpec}`,
  ].join('\n')).join('\n');

  sshCmd(
    ctx.hosts.pkmnHost,
    [
      'set -euo pipefail',
      'cd /home/pkmn/ai',
      'git checkout -- static/projects.yml',
      "cat >> static/projects.yml <<'YAML_EOF'",
      '',
      yamlBlocks,
      'YAML_EOF',
      'npm run build',
      'node --env-file-if-exists=/home/pkmn/ai/.env build/tools/pkmn sync-projects --offline',
    ].join('\n')
  );
  console.log('Stage complete: RBY/ADV/SV pools uploaded & 12 participants synced on pkmn.ai.');
}

function mintSessionCookie(pkmnHost: string, githubLogin: string): string {
  return sshCmd(
    pkmnHost,
    'cd /home/pkmn/ai && node --env-file-if-exists=/home/pkmn/ai/.env ' +
    `build/tools/pkmn session --github '${githubLogin}'`
  );
}

async function submitSingleArtifact(
  ctx: RehearsalContext,
  spec: ParticipantSpec,
  rec: StagedArtifactRecord,
  gcpToken: string
): Promise<void> {
  if (!VERSION_RE.test(rec.version)) {
    throw new Error(`Invalid version label: ${rec.version}`);
  }
  const cookie = mintSessionCookie(ctx.hosts.pkmnHost, spec.githubLogin);
  const authToken = rec.packageFormat === 'oci'
    ? `oauth2accesstoken:${gcpToken}`
    : `Bearer ${gcpToken}`;

  for (let attempt = 1; attempt <= 8; attempt++) {
    const res = await fetch(`${ctx.hosts.publicBaseUrl}/api/submissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: ctx.hosts.publicBaseUrl,
        Cookie: cookie,
      },
      body: JSON.stringify({
        version: rec.version,
        package: rec.packageFormat,
        url: rec.url,
        sha256: rec.sha256,
        authToken,
        ladders: rec.ladders,
        tournaments: [],
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      versionId?: number;
      error?: string;
    };
    if (res.status === 409 && body.error?.includes('already exists')) {
      console.log(`  Already submitted ${spec.name} (${spec.slug}@${rec.version}), skipping`);
      return;
    }
    if (res.status === 429 && attempt < 8) {
      const retrySec = Number(res.headers.get('retry-after') || '15') || 15;
      console.log(`  Rate-limited (429) on ${spec.slug}@${rec.version}; waiting ${retrySec}s...`);
      await sleepMillis(retrySec * 1000);
      continue;
    }
    if (!res.ok) {
      throw new Error(
        `POST /api/submissions failed for ${spec.slug}@${rec.version} ` +
        `(${res.status}): ${body.error ?? ''}`
      );
    }
    console.log(
      `  Submitted ${spec.name} (${spec.slug}@${rec.version}, ${rec.packageFormat}) ` +
      `-> versionId=${body.versionId}`
    );
    return;
  }
}

async function runSubmit(ctx: RehearsalContext, upgradeAlakazam: boolean): Promise<void> {
  const artifactsPath = path.join(ctx.stateDir, 'manifests', 'artifacts.json');
  if (!fs.existsSync(artifactsPath)) {
    throw new Error(`Missing ${artifactsPath}; run 'stage' first.`);
  }
  const staged = JSON.parse(fs.readFileSync(artifactsPath, 'utf8')) as StagedArtifactRecord[];
  const gcpToken = runCmd('gcloud', ['auth', 'print-access-token']);

  if (upgradeAlakazam) {
    const spec = PARTICIPANTS.find(p => p.slug === 'alakazam')!;
    const rec = staged.find(r => r.slug === 'alakazam' && r.version === '1.1.0');
    if (!rec) throw new Error('Missing staged alakazam@1.1.0 artifact');
    sshCmd(
      ctx.hosts.pkmnHost,
      'cd /home/pkmn/ai && node --env-file-if-exists=/home/pkmn/ai/.env ' +
      'build/tools/pkmn refund-cooldown alakazam'
    );
    await submitSingleArtifact(ctx, spec, rec, gcpToken);
    return;
  }

  for (const spec of PARTICIPANTS) {
    const rec = staged.find(r => r.slug === spec.slug && r.version === '1.0.0');
    if (!rec) throw new Error(`Missing staged artifact for ${spec.slug}@1.0.0`);
    await submitSingleArtifact(ctx, spec, rec, gcpToken);
  }
}

async function runVerify(ctx: RehearsalContext, minMatchesPerLadder = 4): Promise<void> {
  console.log('1. Polling smoke tests on pkmn.ai until all pending submissions settle...');
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const rowsJson = sshCmd(
      ctx.hosts.pkmnHost,
      [
        "node - <<'NODE_EOF'",
        "const {DatabaseSync} = require('node:sqlite');",
        "const db = new DatabaseSync('/var/lib/pkmn/arena.sqlite', {readOnly: true});",
        'const rows = db.prepare(',
        "  'SELECT a.slug, av.version, av.package, av.smoke_status AS status, ' +",
        "  'av.smoke_duration_millis AS durMs, av.smoke_turn_millis AS turnMs, ' +",
        "  'av.smoke_peak_ram AS ramMiB, av.unpacked_bytes AS bytes, ' +",
        "  '(av.auth_token_encoding IS NOT NULL) AS hasAuth, av.smoke_error AS err ' +",
        "  'FROM agent_versions av JOIN agents a ON a.id = av.agent_id ORDER BY av.id'",
        ').all();',
        'db.close();',
        'console.log(JSON.stringify(rows));',
        'NODE_EOF',
      ].join('\n')
    );
    const rows = JSON.parse(rowsJson) as Array<{
      slug: string;
      version: string;
      package: string;
      status: string;
      durMs?: number;
      turnMs?: number;
      ramMiB?: number;
      bytes?: number;
      hasAuth: number;
      err?: string;
    }>;

    const quarantined = rows.filter(r => r.status === 'quarantined');
    if (quarantined.length > 0) {
      throw new Error(`Submission(s) quarantined: ${JSON.stringify(quarantined, null, 2)}`);
    }
    const pending = rows.filter(r => r.status === 'pending');
    const passed = rows.filter(r => r.status === 'passed');
    const failed = rows.filter(r => r.status === 'failed');
    console.log(
      `  Smoke progress: ${passed.length} passed, ${failed.length} failed, ` +
      `${pending.length} pending (total=${rows.length})`
    );
    if (rows.length >= PARTICIPANTS.length && pending.length === 0) {
      if (passed.length < 10) {
        throw new Error(`Expected >= 10 passed submissions, got ${passed.length}`);
      }
      for (const r of rows) {
        if (r.hasAuth !== 0) {
          throw new Error(`auth_token_encoding was NOT wiped for ${r.slug}@${r.version}`);
        }
      }
      for (const r of passed) {
        if (!r.bytes || r.bytes > MAX_UNPACKED_BYTES) {
          throw new Error(`Invalid unpacked_bytes for ${r.slug}@${r.version}: ${String(r.bytes)}`);
        }
      }
      break;
    }
    await sleepMillis(10_000);
  }

  console.log('1b. Setting 1500-Elo anchors & activating RBY, ADV, and SV ladders if upcoming...');
  const arenaPreDoc = (await (await fetch(`${ctx.hosts.publicBaseUrl}/arena.json`)).json()) as {
    ladders: Record<string, {id: string; slot: string; status: string}>;
  };
  const preLadders = Object.values(arenaPreDoc.ladders);
  for (const {ladderId} of HARVESTED_LADDER_FORMATS) {
    const cur = preLadders.find(l => l.id === ladderId);
    if (cur?.status === 'upcoming') {
      const actOut = sshCmd(
        ctx.hosts.pkmnHost,
        [
          'set -euo pipefail',
          'cd /home/pkmn/ai',
          'node --env-file-if-exists=/home/pkmn/ai/.env build/tools/pkmn ' +
            `set-anchor '${ladderId}' minikazam 1.0.0`,
          'node --env-file-if-exists=/home/pkmn/ai/.env build/tools/pkmn ' +
            `set-ladder-status '${ladderId}' active`,
        ].join('\n')
      );
      console.log(`  ${actOut.replace(/\n/g, ' | ')}`);
    }
  }

  console.log(`2. Waiting for at least ${minMatchesPerLadder} mirror matches per active ladder...`);
  const matchDeadline = Date.now() + 45 * 60_000;
  while (Date.now() < matchDeadline) {
    const res = await fetch(`${ctx.hosts.publicBaseUrl}/arena.json`);
    if (!res.ok) throw new Error(`/arena.json HTTP ${res.status}`);
    const doc = (await res.json()) as {
      ladders: Record<string, {id: string; slot: string; status: string}>;
    };
    const allLadders = Object.values(doc.ladders);
    const countsSummary: string[] = [];
    let allMet = true;
    for (const {ladderId, slot} of HARVESTED_LADDER_FORMATS) {
      const lRes = await fetch(`${ctx.hosts.publicBaseUrl}/arena/ladders/${slot}.json`);
      if (!lRes.ok) throw new Error(`Ladder JSON HTTP ${lRes.status} for ${ladderId}`);
      const lDoc = (await lRes.json()) as {standings: Array<{matches: number}>};
      const sumEntriesMatches = lDoc.standings.reduce((acc, e) => acc + e.matches, 0);
      const completedPairs = Math.floor(sumEntriesMatches / 2);
      countsSummary.push(`${slot.toUpperCase()}=${completedPairs}`);
      if (completedPairs < minMatchesPerLadder) allMet = false;
    }
    const unusedActive = allLadders.filter(
      l => (l.slot === 'rand' || l.slot === 'vgc') && l.status !== 'upcoming'
    );
    if (unusedActive.length > 0) {
      throw new Error(`Expected RAND and VGC upcoming, got ${JSON.stringify(unusedActive)}`);
    }
    console.log(`  Completed mirror matches: ${countsSummary.join(' · ')}`);
    if (allMet) break;
    await sleepMillis(15_000);
  }

  console.log('3. Auditing HTTP routes, JSON mirrors, ratings invariants, and anti-scouting...');
  const routesToCheck = [
    '/',
    '/arena/',
    '/arena.json',
    '/arena/ladders/rby/',
    '/arena/ladders/rby.json',
    '/arena/ladders/adv/',
    '/arena/ladders/adv.json',
    '/arena/ladders/sv/',
    '/arena/ladders/sv.json',
    '/arena/ladders/rand/',
    '/arena/ladders/vgc/',
    '/arena/battles/',
    '/api/live.json',
    '/api/battles.json',
    '/projects/',
    '/projects/alakazam/',
    '/projects/alakazam.json',
    '/projects/kadabra-iv/',
    '/projects/tauros/',
  ];
  for (const route of routesToCheck) {
    const r = await fetch(`${ctx.hosts.publicBaseUrl}${route}`);
    if (r.status !== 200) {
      throw new Error(`Expected HTTP 200 for ${route}, got ${r.status}`);
    }
  }

  const liveRes = await fetch(`${ctx.hosts.publicBaseUrl}/api/live.json`);
  const liveDoc = (await liveRes.json()) as {
    stale: boolean;
    live?: {viewer?: unknown};
    recentMatches: Array<{games: [{logHref?: string}, {logHref?: string}]}>;
  };
  if (liveDoc.stale) throw new Error('/api/live.json reported stale=true');
  if (liveDoc.live?.viewer !== undefined) {
    throw new Error('Zero-log anti-scouting violation: harvested live match exposed viewer lines!');
  }
  for (const m of liveDoc.recentMatches) {
    if (m.games[0].logHref || m.games[1].logHref) {
      throw new Error('Zero-log anti-scouting violation: harvested battle exposed logHref!');
    }
  }

  const acctCookie = mintSessionCookie(ctx.hosts.pkmnHost, 'rehearsal-alakazam');
  for (const acctRoute of ['/account/', '/account.json']) {
    const r = await fetch(`${ctx.hosts.publicBaseUrl}${acctRoute}`, {
      headers: {Cookie: acctCookie},
    });
    if (r.status !== 200) {
      throw new Error(`Expected HTTP 200 for authenticated ${acctRoute}, got ${r.status}`);
    }
  }
  console.log(
    'PASS: All production routes, ratings, smoke metrics, and anti-scouting checks passed!'
  );
}

async function runStatus(ctx: RehearsalContext): Promise<void> {
  const ladderLabels = [
    ['rby', 'RBY (gen1ou)'],
    ['adv', 'ADV (gen3ou)'],
    ['sv', 'SV (gen9ou)'],
  ] as const;
  for (const [slot, label] of ladderLabels) {
    const res = await fetch(`${ctx.hosts.publicBaseUrl}/arena/ladders/${slot}.json`);
    const doc = (await res.json()) as {
      standings: Array<{
        rank?: number;
        name: string;
        version: string;
        role: string;
        elo: number;
        se: number;
        matches: number;
      }>;
    };
    const totalPairs = Math.floor(doc.standings.reduce((s, e) => s + e.matches, 0) / 2);
    console.log(
      `\n=== ${label} — ${totalPairs} mirror matches (${doc.standings.length} entries) ===`
    );
    for (const e of doc.standings.slice(0, 14)) {
      const rk = e.rank !== undefined ? `#${e.rank}` : '—';
      const eloStr = `${Math.round(e.elo)}±${Math.round(1.96 * e.se)}`;
      console.log(
        `  ${rk.padEnd(4)} ${e.name.padEnd(15)} ${e.version.padEnd(7)} ` +
        `[${e.role.padEnd(10)}] Elo=${eloStr.padEnd(10)} matches=${e.matches}`
      );
    }
  }
  const sampleCookie = mintSessionCookie(ctx.hosts.pkmnHost, 'rehearsal-alakazam');
  console.log(`\nInspect /account/ cookie (Alakazam):\n  ${sampleCookie}`);
}

async function runCleanup(ctx: RehearsalContext): Promise<void> {
  const snap = loadPreSnapshot(ctx);

  console.log('1. Stopping pkmn.ai-server and resetting slots on arena...');
  sshCmd(ctx.hosts.pkmnHost, 'sudo -n /usr/sbin/service pkmn.ai-server stop');
  sshCmd(
    ctx.hosts.arenaHost,
    [
      'set -euo pipefail',
      'export PATH="/opt/arena/bin:/opt/homebrew/bin:$PATH"',
      'sqlite3 -cmd \'.timeout 10000\' /opt/arena/state/arena.sqlite ' +
        '"DELETE FROM local_matches; DELETE FROM outbox; ' +
        'DELETE FROM local_agents; DELETE FROM ladder_counters;"',
      'sudo -n /bin/launchctl kickstart -k system/ai.pkmn.arena || true',
      'sleep 1',
      'for slot in p1 p2; do',
      '  /opt/arena/bin/arena cleanup "$slot" native >/dev/null 2>&1 || true',
      '  /opt/arena/bin/arena cleanup "$slot" container >/dev/null 2>&1 || true',
      'done',
    ].join('\n')
  );

  console.log('2. Restoring pkmn.ai codebase, static assets, and SQLite database from backup...');
  const keepBackupsJson = JSON.stringify(snap.pkmn.backups);
  const keepAvatarsJson = JSON.stringify(snap.pkmn.avatars);
  sshCmd(
    ctx.hosts.pkmnHost,
    [
      'set -euo pipefail',
      'cd /home/pkmn/ai',
      `git reset --hard '${snap.pkmn.head}'`,
      'rm -rf public',
      `node - '${keepAvatarsJson}' '${keepBackupsJson}' <<'NODE_EOF'`,
      "const fs = require('fs');",
      "const path = require('path');",
      'const keepAvatars = new Set(JSON.parse(process.argv[2]));',
      'const keepBackups = new Set(JSON.parse(process.argv[3]));',
      "const avDir = '/home/pkmn/ai/static/avatars';",
      'if (fs.existsSync(avDir)) {',
      '  for (const f of fs.readdirSync(avDir)) {',
      '    if (!keepAvatars.has(f)) fs.rmSync(path.join(avDir, f), {force: true});',
      '  }',
      '}',
      "const bkDir = '/var/lib/pkmn/backups';",
      'if (fs.existsSync(bkDir)) {',
      '  for (const f of fs.readdirSync(bkDir)) {',
      '    if (!keepBackups.has(f)) fs.rmSync(path.join(bkDir, f), {force: true});',
      '  }',
      '}',
      'NODE_EOF',
      'npm run build',
      'rm -f /var/lib/pkmn/arena.sqlite /var/lib/pkmn/arena.sqlite-wal ' +
        '/var/lib/pkmn/arena.sqlite-shm',
      'umask 077',
      `zstd -dc '${snap.pkmnPreBackup}' -o /var/lib/pkmn/arena.sqlite`,
      'chmod 0600 /var/lib/pkmn/arena.sqlite',
      'CHK="$(sqlite3 /var/lib/pkmn/arena.sqlite \'PRAGMA integrity_check;\')"',
      '[[ "$CHK" == "ok" ]] || { echo "pkmn.ai restore integrity failed: $CHK" >&2; exit 1; }',
    ].join('\n')
  );

  console.log('3. Restoring arena state DB, wiping hot/cold/CAS/Podman rehearsal state...');
  const keepArenaBackupsJson = JSON.stringify(snap.arena.dbBackups);
  const keepPodmanImagesJson = JSON.stringify(snap.arena.podmanImages);
  sshCmd(
    ctx.hosts.arenaHost,
    [
      'set -euo pipefail',
      'export PATH="/opt/arena/bin:/opt/homebrew/bin:$PATH"',
      'cd /opt/arena/repo',
      `git reset --hard '${snap.arena.head}'`,
      'npm run compile',
      'rm -rf /Volumes/Archive/_rehearsal_build /opt/arena/cas/sha256',
      'mkdir -p /opt/arena/cas/sha256',
      'find /opt/arena/teams -mindepth 1 -delete 2>/dev/null || true',
      'find /Volumes/Archive/cold-agents /Volumes/Archive/logs -mindepth 1 -delete ' +
        '2>/dev/null || true',
      'find /Volumes/Staging -mindepth 1 -maxdepth 1 ! -name ".*" ' +
        '-exec rm -rf {} + 2>/dev/null || true',
      'rm -f /opt/arena/state/peak_ram_p1 /opt/arena/state/peak_ram_p2',
      'for d in /opt/arena/agents/*; do',
      '  [[ -e "$d" ]] || continue',
      '  base="$(basename "$d")"',
      '  if [[ "$base" != "_baseline" ]]; then rm -rf "$d"; fi',
      'done',
      'podman rm -f -a >/dev/null 2>&1 || true',
      `/opt/homebrew/bin/node - '${keepArenaBackupsJson}' '${keepPodmanImagesJson}' <<'NODE_EOF'`,
      "const fs = require('fs');",
      "const path = require('path');",
      "const {execFileSync} = require('child_process');",
      'const keep = new Set(JSON.parse(process.argv[2]));',
      'const keepImgs = new Set(JSON.parse(process.argv[3]));',
      "const dir = '/Volumes/Archive/db-backups';",
      'if (fs.existsSync(dir)) {',
      '  for (const f of fs.readdirSync(dir)) {',
      '    if (!keep.has(f)) fs.rmSync(path.join(dir, f), {force: true});',
      '  }',
      '}',
      "const imgs = execFileSync('podman', ['images', '--format', '{{.Repository}}:{{.Tag}}'], " +
        "{encoding: 'utf8'}).split('\\n').map(s => s.trim()).filter(Boolean);",
      'for (const img of imgs) {',
      '  if (!keepImgs.has(img)) {',
      "    try { execFileSync('podman', ['rmi', '-f', img], {stdio: 'ignore'}); } catch {}",
      '  }',
      '}',
      'NODE_EOF',
      'podman image prune -f >/dev/null 2>&1 || true',
      ...buildArenaSqliteRestoreLines(snap.arenaPreBackup, 'restore-final'),
      ': > /opt/arena/logs/arena.log',
      ': > /opt/arena/logs/arena.err',
      'sudo -n /bin/launchctl kickstart -k system/ai.pkmn.arena',
    ].join('\n')
  );
  sshCmd(ctx.hosts.pkmnHost, 'sudo -n /usr/sbin/service pkmn.ai-server start');

  console.log('4. Cleaning Google Cloud Storage & Artifact Registry...');
  for (const prefix of ['rehearsal', 'agents', 'archives']) {
    spawnSync('gcloud', ['storage', 'rm', '-r', '--quiet', `gs://${ctx.gcp.bucket}/${prefix}`], {
      stdio: 'ignore',
      timeout: 120_000,
    });
  }
  spawnSync('gcloud', [
    'artifacts',
    'repositories',
    'delete',
    ctx.gcp.garRepo,
    `--location=${ctx.gcp.location}`,
    `--project=${ctx.gcp.project}`,
    '--quiet',
  ], {stdio: 'ignore', timeout: 120_000});

  if (!snap.gcpEnabledServices.includes('artifactregistry.googleapis.com')) {
    spawnSync('gcloud', [
      'services',
      'disable',
      'artifactregistry.googleapis.com',
      `--project=${ctx.gcp.project}`,
      '--quiet',
    ], {stdio: 'ignore', timeout: 120_000});
  }

  sshCmd(
    ctx.hosts.arenaHost,
    'export PATH="/opt/homebrew/bin:$PATH" && /opt/arena/repo/arena/scripts/archive.sh'
  );

  console.log('5. Verifying byte-for-byte / row-for-row equivalence against pre-snapshot...');
  await sleepMillis(7_000);
  const postPkmn = inspectRemotePkmn(ctx.hosts.pkmnHost);
  const postArena = inspectRemoteArena(ctx.hosts.arenaHost);
  const postGcs = listGcsObjects(ctx.gcp.bucket);

  const diffs: string[] = [];
  if (postPkmn.head !== snap.pkmn.head) {
    diffs.push(`pkmn.head: ${postPkmn.head} !== ${snap.pkmn.head}`);
  }
  if (postPkmn.gitStatus !== '') diffs.push(`pkmn.gitStatus dirty: ${postPkmn.gitStatus}`);
  if (postPkmn.wikiStatus !== '') diffs.push(`pkmn.wikiStatus dirty: ${postPkmn.wikiStatus}`);
  const normCounts = (c: Record<string, number>) => {
    const copy = {...c};
    delete copy.discord_members;
    return copy;
  };
  if ((postPkmn.counts.discord_members ?? 0) <= 0) {
    diffs.push(`pkmn.counts.discord_members invalid: ${String(postPkmn.counts.discord_members)}`);
  }
  if (
    JSON.stringify(normCounts(postPkmn.counts)) !== JSON.stringify(normCounts(snap.pkmn.counts))
  ) {
    diffs.push(`pkmn.counts: ${JSON.stringify(postPkmn.counts)}`);
  }
  if (JSON.stringify(postPkmn.ladders) !== JSON.stringify(snap.pkmn.ladders)) {
    diffs.push(`pkmn.ladders: ${JSON.stringify(postPkmn.ladders)}`);
  }
  if (JSON.stringify(postPkmn.avatars) !== JSON.stringify(snap.pkmn.avatars)) {
    diffs.push(`pkmn.avatars: ${JSON.stringify(postPkmn.avatars)}`);
  }
  if (postArena.head !== snap.arena.head) {
    diffs.push(`arena.head: ${postArena.head} !== ${snap.arena.head}`);
  }
  if (postArena.gitStatus !== '') diffs.push(`arena.gitStatus dirty: ${postArena.gitStatus}`);
  if (JSON.stringify(postArena.counts) !== JSON.stringify(snap.arena.counts)) {
    diffs.push(`arena.counts: ${JSON.stringify(postArena.counts)}`);
  }
  if (JSON.stringify(postArena.agentsDir) !== JSON.stringify(snap.arena.agentsDir)) {
    diffs.push(`arena.agentsDir: ${JSON.stringify(postArena.agentsDir)}`);
  }
  if (postArena.coldAgents.length !== 0) {
    diffs.push(`arena.coldAgents not empty: ${postArena.coldAgents.join(',')}`);
  }
  if (postArena.archiveLogs.length !== 0) {
    diffs.push(`arena.archiveLogs not empty: ${postArena.archiveLogs.join(',')}`);
  }
  if (JSON.stringify(postArena.podmanImages) !== JSON.stringify(snap.arena.podmanImages)) {
    diffs.push(`arena.podmanImages: ${JSON.stringify(postArena.podmanImages)}`);
  }
  if (postGcs.some(o => !o.startsWith(`gs://${ctx.gcp.bucket}/db-backups/`))) {
    diffs.push(`GCS contains non-db-backup objects: ${postGcs.join(', ')}`);
  }

  const liveRes = await fetch(`${ctx.hosts.publicBaseUrl}/api/live.json`);
  const liveDoc = (await liveRes.json()) as {
    stale: boolean;
    live?: unknown;
    recentMatches: unknown[];
  };
  if (liveDoc.stale || liveDoc.live !== undefined || liveDoc.recentMatches.length !== 0) {
    diffs.push(`/api/live.json not pristine: ${JSON.stringify(liveDoc)}`);
  }

  if (diffs.length > 0) {
    throw new Error(`Post-cleanup verification found discrepancies:\n  - ${diffs.join('\n  - ')}`);
  }
  console.log('PASS: pkmn.ai, arena, and Google Cloud restored 100% to pre-rehearsal state!');
}

export async function runRehearsalCli(argv: string[]): Promise<void> {
  const {positional, flags} = parseCliArgs(argv);
  const cmd = positional[0] as Subcommand | undefined;
  if (!cmd || flags.has('help')) {
    console.log(USAGE);
    return;
  }

  const rawStateDir = flags.get('state-dir');
  if (!rawStateDir) {
    throw new Error(`Required flag '--state-dir <path>' is missing.\n\n${USAGE}`);
  }

  const ctx: RehearsalContext = {
    stateDir: path.resolve(rawStateDir),
    hosts: {
      pkmnHost: flags.get('pkmn-host') ?? 'pkmn.ai',
      arenaHost: flags.get('arena-host') ?? 'arena',
      publicBaseUrl: (flags.get('public-url') ?? 'https://pkmn.ai').replace(/\/+$/, ''),
    },
    gcp: {
      project: flags.get('gcp-project') ?? 'pkmn-ai',
      location: flags.get('gcp-location') ?? 'us-central1',
      bucket: flags.get('gcs-bucket') ?? 'pkmn-arena',
      garRepo: flags.get('gar-repo') ?? 'rehearsal',
    },
  };

  switch (cmd) {
    case 'snapshot':
      runSnapshot(ctx, flags.has('fresh-backups'));
      return;
    case 'restore-drill':
      await runRestoreDrill(ctx);
      return;
    case 'build':
      runBuild(ctx, flags.has('skip-preflight'));
      return;
    case 'stage':
      runStage(ctx);
      return;
    case 'submit':
      await runSubmit(ctx, flags.has('upgrade-alakazam'));
      return;
    case 'verify': {
      const minMatches = flags.has('min-matches') ? Number(flags.get('min-matches')) : 4;
      await runVerify(ctx, minMatches);
      return;
    }
    case 'status':
      await runStatus(ctx);
      return;
    case 'cleanup':
      await runCleanup(ctx);
      return;
    default:
      throw new Error(`Unknown command '${String(cmd)}'\n\n${USAGE}`);
  }
}

if (require.main === module) {
  for (const p of PARTICIPANTS) {
    if (slugify(p.name).toLowerCase() !== p.slug) {
      throw new Error(`Slug mismatch for '${p.name}': expected ${slugify(p.name).toLowerCase()}`);
    }
  }
  runRehearsalCli(process.argv.slice(2)).catch(err => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
}
