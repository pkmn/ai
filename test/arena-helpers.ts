import {execFileSync} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as zlib from 'zlib';

import polka from 'polka';

import {Database} from '../db';
import * as serverArena from '../server/arena';
import * as auth from '../server/auth';
import {root} from '../static/util';

export const TEAM_ONE =
  'Pikachu||lightball|static|thunderbolt,quickattack,irontail,volttackle|' +
  'Jolly|,252,,,4,252|||||' +
  ']Charizard||heavydutyboots|blaze|flamethrower,airslash,roost,willowisp|' +
  'Timid|,4,,,252,252|||||' +
  ']Blastoise||leftovers|torrent|scald,icebeam,rapidspin,toxic|Bold|252,252,,,,4|||||' +
  ']Venusaur||blacksludge|overgrow|gigadrain,sludgebomb,synthesis,sleeppowder|' +
  'Calm|252,,,4,252,|||||' +
  ']Snorlax||leftovers|thickfat|bodyslam,earthquake,rest,sleeptalk|' +
  'Careful|252,4,252,,,|||||' +
  ']Gengar||focussash|cursedbody|shadowball,sludgewave,focusblast,destinybond|' +
  'Timid|,,,252,4,252|||||';

export const TEAM_TWO =
  'Dragonite||heavydutyboots|multiscale|extremespeed,earthquake,roost,dragondance|' +
  'Adamant|,252,4,,,252|||||' +
  ']Tyranitar||leftovers|sandstream|stoneedge,crunch,stealthrock,earthquake|' +
  'Careful|252,4,252,,,|||||' +
  ']Garchomp||rockyhelmet|roughskin|earthquake,outrage,stealthrock,swordsdance|' +
  'Jolly|,252,,,4,252|||||' +
  ']Scizor||choiceband|technician|bulletpunch,uturn,closecombat,knockoff|' +
  'Adamant|248,252,,,8,|||||' +
  ']Rotom-Wash||leftovers|levitate|hydropump,voltswitch,willowisp,painsplit|' +
  'Bold|252,,252,,4,|||||' +
  ']Clefable||leftovers|magicguard|moonblast,softboiled,stealthrock,thunderwave|' +
  'Calm|252,,4,,252,|||||';

export const OU_TEAM_ONE =
  'Great Tusk||BoosterEnergy|Protosynthesis|HeadlongRush,IceSpinner,RapidSpin,KnockOff|' +
  'Jolly|,252,4,,,252|||||' +
  ']Kingambit||Leftovers|SupremeOverlord|KowtowCleave,SuckerPunch,IronHead,SwordsDance|' +
  'Adamant|212,252,,,,44|M||||' +
  ']Gholdengo||ChoiceScarf|GoodasGold|MakeItRain,ShadowBall,Trick,Recover|' +
  'Timid|,,4,252,,252||,0,,,,|||' +
  ']Dragapult||ChoiceSpecs|Infiltrator|DracoMeteor,ShadowBall,Uturn,Flamethrower|' +
  'Timid|,,4,252,,252|M||||' +
  ']Glimmora||FocusSash|ToxicDebris|StealthRock,MortalSpin,PowerGem,EarthPower|' +
  'Timid|,,4,252,,252|F|,0,,,,|||' +
  ']Iron Valiant||BoosterEnergy|QuarkDrive|Moonblast,CloseCombat,KnockOff,Encore|' +
  'Naive|,4,,252,,252|||||';

export const OU_TEAM_TWO =
  'Alomomola||HeavyDutyBoots|Regenerator|FlipTurn,Protect,Scald,Wish|' +
  'Impish|252,,252,,4,|||||' +
  ']Blissey||HeavyDutyBoots|NaturalCure|CalmMind,SeismicToss,SoftBoiled,StealthRock|' +
  'Bold|252,,252,,4,|||||' +
  ']Clefable||Leftovers|MagicGuard|KnockOff,Moonblast,Moonlight,StealthRock|' +
  'Bold|252,,252,,4,|||||' +
  ']Dondozo||Leftovers|Unaware|Curse,Rest,SleepTalk,Waterfall|' +
  'Impish|252,,252,,4,|||||' +
  ']Garganacl||Leftovers|PurifyingSalt|IronDefense,Protect,Recover,SaltCure|' +
  'Careful|252,,4,,252,|||||' +
  ']Zapdos||HeavyDutyBoots|Static|Discharge,Hurricane,Roost,VoltSwitch|' +
  'Bold|252,,252,,,4|||||';

export const RBY_TEAM_ONE =
  'Alakazam|||NoAbility|Psychic,Recover,SeismicToss,ThunderWave||252,252,252,252,252,252|||||' +
  ']Chansey|||NoAbility|IceBeam,SoftBoiled,Thunderbolt,ThunderWave||252,252,252,252,252,252|||||' +
  ']Exeggutor|||NoAbility|Psychic,SleepPowder,StunSpore,Explosion||252,252,252,252,252,252|||||' +
  ']Snorlax|||NoAbility|BodySlam,HyperBeam,Earthquake,SelfDestruct||252,252,252,252,252,252|||||' +
  ']Starmie|||NoAbility|Blizzard,Thunderbolt,Recover,ThunderWave||252,252,252,252,252,252|||||' +
  ']Tauros|||NoAbility|BodySlam,HyperBeam,Blizzard,Earthquake||252,252,252,252,252,252|||||';

export const RBY_TEAM_TWO =
  'Cloyster|||NoAbility|Blizzard,Clamp,HyperBeam,Explosion||252,252,252,252,252,252|||||' +
  ']Gengar|||NoAbility|Hypnosis,NightShade,Thunderbolt,Explosion||252,252,252,252,252,252|||||' +
  ']Jolteon|||NoAbility|Thunderbolt,ThunderWave,DoubleKick,PinMissile||' +
  '252,252,252,252,252,252|||||' +
  ']Lapras|||NoAbility|Blizzard,Thunderbolt,BodySlam,ConfuseRay||252,252,252,252,252,252|||||' +
  ']Rhydon|||NoAbility|Earthquake,RockSlide,BodySlam,Substitute||252,252,252,252,252,252|||||' +
  ']Zapdos|||NoAbility|Thunderbolt,DrillPeck,ThunderWave,Agility||252,252,252,252,252,252|||||';

export function seedSampleTeams(
  samplesDir: string,
  format: string,
  sampleTeams: readonly string[]
): void {
  const dir = path.join(samplesDir, format);
  fs.mkdirSync(dir, {recursive: true});
  for (let i = 0; i < sampleTeams.length; i++) {
    fs.writeFileSync(path.join(dir, `sample-${i + 1}`), sampleTeams[i], 'utf8');
  }
}

export function buildTestTarGz(entries: Array<{
  name: string;
  type: '0' | '1' | '2' | '5' | '6' | 'L' | 'K' | 'x';
  linkname?: string;
  prefix?: string;
  data?: Buffer;
  mode?: number;
  base256Size?: boolean;
}>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512, 0);
    header.write(entry.name, 0, 100, 'utf8');
    const mode = entry.mode ?? (entry.type === '2' ? 0o777 : 0o644);
    header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    const size = entry.data?.length ?? 0;
    if (entry.base256Size) {
      header[124] = 0x80;
      let rem = size;
      for (let i = 135; i >= 125; i--) {
        header[i] = rem & 0xff;
        rem = Math.floor(rem / 256);
      }
    } else {
      header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    }
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header.write(entry.type, 156, 1, 'ascii');
    if (entry.linkname) header.write(entry.linkname, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    if (entry.prefix) header.write(entry.prefix, 345, 155, 'utf8');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header);
    if (size > 0 && entry.data) {
      blocks.push(entry.data);
      const rem = size % 512;
      if (rem > 0) blocks.push(Buffer.alloc(512 - rem, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

const TEST_BINS_DIR = root('build', 'test-bins');

export function buildTestBin(name: string, srcPath: string): string {
  fs.mkdirSync(TEST_BINS_DIR, {recursive: true});
  const outPath = path.join(TEST_BINS_DIR, name);
  const srcMtime = fs.statSync(srcPath).mtimeMs;
  if (fs.existsSync(outPath) && fs.statSync(outPath).mtimeMs >= srcMtime) {
    return outPath;
  }
  const tmpBin = `${outPath}.${process.pid}.tmp`;
  try {
    execFileSync('clang', ['-O1', '-Wall', '-Wextra', '-Werror', '-o', tmpBin, srcPath]);
    try {
      fs.renameSync(tmpBin, outPath);
    } catch {
      if (!fs.existsSync(outPath)) throw new Error(`Failed to build test binary ${outPath}`);
    }
  } finally {
    fs.rmSync(tmpBin, {force: true});
  }
  return outPath;
}

export function linkOrCopyExecutable(src: string, dst: string) {
  try {
    fs.linkSync(src, dst);
  } catch {
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
  }
}

export interface ArenaTestBins {
  relayBin: string;
  limitBin: string;
  sandboxProbeBin: string;
  defaultAgentScript: string;
}

export function getArenaTestBins(
  opts: {darwinBins?: boolean; relay?: boolean} = {}
): ArenaTestBins {
  const defaultAgentScript = buildTestBin(
    'mock-agent',
    root('test', 'fixtures', 'mock-agent.c')
  );
  const relayBin = opts.relay !== false
    ? buildTestBin('tourney-relay', root('arena', 'bin', 'tourney-relay.c'))
    : '';
  let limitBin = '';
  let sandboxProbeBin = '';
  if (opts.darwinBins && process.platform === 'darwin') {
    limitBin = buildTestBin('limit', root('arena', 'bin', 'limit.c'));
    sandboxProbeBin = buildTestBin(
      'sandbox-probe',
      root('test', 'fixtures', 'sandbox-probe.c')
    );
  }
  return {
    relayBin,
    limitBin,
    sandboxProbeBin,
    defaultAgentScript,
  };
}

export function createValidBundleArchive(
  tmpDir: string,
  defaultAgentScript: string
): {archivePath: string; sha256: string} {
  const bundleSrc = path.join(tmpDir, 'bundle-src');
  fs.mkdirSync(bundleSrc, {recursive: true});
  fs.writeFileSync(
    path.join(bundleSrc, 'run'),
    `#!/bin/sh\nexec ${JSON.stringify(defaultAgentScript)}\n`,
    {mode: 0o755}
  );
  fs.writeFileSync(path.join(bundleSrc, 'weights.bin'), Buffer.alloc(70_000, 0x42));
  const archivePath = path.join(tmpDir, 'valid-agent.tar.gz');
  execFileSync('tar', ['-czf', archivePath, '-C', bundleSrc, '.']);
  const sha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(archivePath))
    .digest('hex');
  return {archivePath, sha256};
}

export function createCoordBundleArchive(
  tmpDir: string,
  defaultAgentScript: string,
  utmLogFile: string
): {bundleTar: string; bundleSha: string} {
  const bundleDir = path.join(tmpDir, 'coord-bundle');
  fs.mkdirSync(bundleDir, {recursive: true});
  fs.writeFileSync(
    path.join(bundleDir, 'run'),
    `#!/bin/sh\nexec ${JSON.stringify(defaultAgentScript)} ` +
      `--utm-log ${JSON.stringify(utmLogFile)}\n`,
    {mode: 0o755}
  );
  const bundleTar = path.join(tmpDir, 'coord-agent.tar.gz');
  execFileSync('tar', ['-czf', bundleTar, '-C', bundleDir, '.']);
  const bundleSha = crypto.createHash('sha256').update(fs.readFileSync(bundleTar)).digest('hex');
  return {bundleTar, bundleSha};
}

export async function withRealArenaServer<T>(
  tmpDir: string,
  prefix: string,
  fn: (ctx: {
    db: Database;
    client: serverArena.Client;
    serverUrl: string;
    secret: string;
    publicDir: string;
    samplesDir: string;
    heartbeats: Array<{at: number; hasLive: boolean}>;
  }) => Promise<T>
): Promise<T> {
  const db = new Database(':memory:');
  const app = polka();
  const secret = 'real-http-arena-secret-32-bytes-ok';
  const authInst = new auth.Auth({
    config: {sessionSecret: 'session-secret-32-bytes-minimum-ok'},
    db,
  });
  const publicDir = path.join(tmpDir, `${prefix}-public`);
  const samplesDir = path.join(tmpDir, `${prefix}-samples`);
  fs.mkdirSync(publicDir, {recursive: true});
  const heartbeats: Array<{at: number; hasLive: boolean}> = [];
  const ctrl = serverArena.register(app, {
    db,
    auth: authInst,
    arenaSecret: secret,
    publicDir,
    samplesDir,
    onHeartbeat: ev => {
      heartbeats.push({at: ev.at, hasLive: Boolean(ev.live)});
    },
  });
  const server = http.createServer((req, res) => app.handler(req as polka.Request, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const serverUrl = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const client = new serverArena.Client({serverUrl, arenaSecret: secret});

  try {
    return await fn({db, client, serverUrl, secret, publicDir, samplesDir, heartbeats});
  } finally {
    ctrl.close();
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    db.close();
  }
}
