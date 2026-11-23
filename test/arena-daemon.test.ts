import {execFileSync} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as arenaIndex from '../arena';
import * as coordinator from '../arena/coordinator';
import * as arenaDb from '../arena/db';
import * as packages from '../arena/packages';
import * as tournament from '../arena/tournament';
import * as serverArena from '../server/arena';
import * as sim from '../server/sim';
import {validateCompetitorTeamsIncremental} from '../server/teams';
import {root} from '../static/util';
import * as mock from '../tools/mock';

import {
  OU_TEAM_ONE,
  OU_TEAM_TWO,
  RBY_TEAM_ONE,
  RBY_TEAM_TWO,
  TEAM_ONE,
  TEAM_TWO,
  createCoordBundleArchive,
  getArenaTestBins,
  linkOrCopyExecutable,
  seedSampleTeams,
  withRealArenaServer,
} from './arena-helpers';

describe('Coordinator HTTP & TournamentCoordinator', () => {
  let tmpDir: string;
  let relayBin: string;
  let defaultAgentScript: string;
  let bundleTar: string;
  let bundleSha: string;
  let vgcPools: string[][];

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-daemon-'));
    ({relayBin, defaultAgentScript} = getArenaTestBins());
    const utmLogFile = path.join(tmpDir, 'daemon-utm.log');
    ({bundleTar, bundleSha} = createCoordBundleArchive(tmpDir, defaultAgentScript, utmLogFile));
    vgcPools = [0, 1, 2, 3].map(idx => validateCompetitorTeamsIncremental(
      mock.generateValidVgcTeams(20, idx),
      {format: 'gen9championsvgc2026regmc', pools: [], teams: 20}
    ).allSaved);
  }, 30_000);

  afterAll(async () => {
    await sim.closeAllWorkers();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('records LW split category over HTTP while evicting 4xx outbox items', async () => {
    await withRealArenaServer(
      tmpDir,
      'lw-split',
      async ({db, client, serverUrl, secret, publicDir}) => {
        const stateDb = new arenaDb.Database(':memory:');
        try {
          db.syncLaddersFromYaml([
            '- name: RAND',
            '  id: gen9randombattle202611',
            '  format: gen9randombattle',
            '  version: 0.11.0',
            '  team: random',
            '  status: active',
            '  min: 2',
          ].join('\n'));
          db.syncProjectsFromYaml([
            '- name: 0 ERROR',
            '  active: 2026',
            '  arena: {owners: {scheibo: pre.10544}}',
            '- name: Foul Play',
            '  active: 2026',
            '  arena: {owners: {pmariglia: pmariglia.535629}}',
          ].join('\n'));
          db.setAgentLadders('0-error', ['rand']);
          db.setAgentLadders('foul-play', ['rand']);
          const a1 = db.getAgentBySlug('0-error')!;
          const a2 = db.getAgentBySlug('foul-play')!;
          const sub1 = db.createSubmission({
            agentId: a1.id,
            version: '1.0.0',
            package: 'bundle',
            url: 'https://github.com/pkmn/a1.tar.zst',
            sha256: 'a'.repeat(64),
            ladderIds: ['gen9randombattle202611'],
          });
          const sub2 = db.createSubmission({
            agentId: a2.id,
            version: '1.0.0',
            package: 'bundle',
            url: 'https://github.com/pkmn/a2.tar.zst',
            sha256: 'b'.repeat(64),
            ladderIds: ['gen9randombattle202611'],
          });
          db.applySubmissionStatus({versionId: sub1.id, smokeStatus: 'passed'});
          db.applySubmissionStatus({versionId: sub2.id, smokeStatus: 'passed'});

          const loseRoot = path.join(tmpDir, 'lose-as-p1');
          const loseAsP1Dir = path.join(packages.dirsForRoot(loseRoot).agents, 'lose-p1');
          fs.mkdirSync(loseAsP1Dir, {recursive: true});
          fs.writeFileSync(
            path.join(loseAsP1Dir, 'run'),
            [
              '#!/usr/bin/env node',
              'const readline = require("readline");',
              'process.stdout.write("/ready\\n");',
              'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
              'rl.on("line", line => {',
              '  if (line.startsWith("|player|p1|")) process.exit(1);',
              '  if (!line.startsWith("|request|")) return;',
              '  const raw = line.slice(9).trim();',
              '  if (!raw || raw === "null") return;',
              '  const req = JSON.parse(raw);',
              '  if (!req.wait) process.stdout.write("default\\n");',
              '});',
            ].join('\n'),
            {mode: 0o755}
          );

          for (const [vid, aid, slug] of [
            [sub1.id, a1.id, '0-error'],
            [sub2.id, a2.id, 'foul-play'],
          ] as const) {
            stateDb.upsertLocalAgent({
              versionId: vid,
              agentId: aid,
              slug,
              version: '1.0.0',
              mode: 'native',
              target: 'lose-p1',
              residency: 'hot',
              unpackedBytes: 1024,
            });
          }

          const coord = new coordinator.Coordinator({
            client,
            stateDb,
            baselineSpec: {mode: 'native', target: defaultAgentScript},
            rootDir: loseRoot,
            devMode: true,
          });

          stateDb.enqueueOutbox(
            'match-complete',
            {match: {id: 'bad'}} as unknown as serverArena.MatchCompletePayload
          );

          const snapRes = await fetch(`${serverUrl}/api/arena/ladders`, {
            headers: {Authorization: `Bearer ${secret}`},
          });
          const {ladders} = await snapRes.json() as {ladders: coordinator.LadderSnapshot[]};
          const origError = console.error;
          console.error = () => undefined;
          let played: Awaited<ReturnType<typeof coord.playNextScheduledMatch>>;
          try {
            played = await coord.playNextScheduledMatch(ladders);
          } finally {
            console.error = origError;
          }
          expect(played?.ladderId).toBe('gen9randombattle202611');
          expect(stateDb.listOutbox()).toHaveLength(0);

          const recorded = db.getRecentMatches(5);
          expect(recorded).toHaveLength(1);
          expect(recorded[0].games[0].outcome).toBe('L');
          expect(recorded[0].games[1].outcome).toBe('W');
          expect(recorded[0].category).toBe('LW');
          const randLogDir = path.join(publicDir, 'arena', 'ladders', 'gen9randombattle202611');
          const g1Published = fs.readFileSync(
            path.join(randLogDir, `${recorded[0].id}a.log`),
            'utf8'
          );
          const g2Published = fs.readFileSync(
            path.join(randLogDir, `${recorded[0].id}b.log`),
            'utf8'
          );
          expect(g1Published).toContain('|player|p1|');
          expect(g1Published).toContain('|split|p1\n');
          expect(g1Published).toContain('|split|p2\n');
          expect(g1Published).not.toContain('Agent A');
          expect(g1Published).not.toContain('Agent B');
          expect(g2Published).toContain('|player|p1|');
          expect(g2Published).not.toContain('Agent A');

          expect(await coord.publishLadderArchive('gen9randombattle202611')).toBe(true);
          expect(
            fs.existsSync(path.join(randLogDir, 'gen9randombattle202611-logs.tar'))
          ).toBe(true);
        } finally {
          stateDb.close();
        }
      }
    );
  }, 15_000);

  test('executes pools ladder VGC matches and publishes retired tar archive via runDaemon',
    async () => {
      await withRealArenaServer(
        tmpDir,
        'pools-arch',
        async ({db, serverUrl, secret, publicDir}) => {
          db.syncLaddersFromYaml([
            '- name: VGC',
            '  id: gen9championsvgc2026regmc',
            '  format: gen9championsvgc2026regmc',
            "  version: '0.11.0'",
            '  team: pools',
            '  status: active',
            '  teams: 20',
          ].join('\n'));
          db.syncProjectsFromYaml([
            '- name: 0 ERROR',
            '  active: 2026',
            '  arena: {owners: {scheibo: pre.10544}}',
            '- name: Foul Play',
            '  active: 2026',
            '  arena: {owners: {pmariglia: pmariglia.535629}}',
            '- name: Metamon',
            '  active: 2026',
            '  arena: {owners: {jake: jake.10001}}',
            '- name: PokeChamp',
            '  active: 2026',
            '  arena: {owners: {seth: seth.10002}}',
          ].join('\n'));
          for (const s of ['0-error', 'foul-play', 'metamon', 'pokechamp']) {
            db.setAgentLadders(s, ['vgc']);
          }

          const daemonStatePath = path.join(tmpDir, 'daemon-pools-arch.sqlite');
          const daemonRoot = path.join(tmpDir, 'daemon-pools-arch');
          const defaultRunDir = path.join(packages.dirsForRoot(daemonRoot).agents, 'default-vgc');
          fs.mkdirSync(defaultRunDir, {recursive: true});
          linkOrCopyExecutable(defaultAgentScript, path.join(defaultRunDir, 'run'));

          const seedStateDb = new arenaDb.Database(daemonStatePath);
          const slugs = ['0-error', 'foul-play', 'metamon', 'pokechamp'];
          for (let idx = 0; idx < slugs.length; idx++) {
            const ag = db.getAgentBySlug(slugs[idx])!;
            const sub = db.createSubmission({
              agentId: ag.id,
              version: '1.0.0',
              package: 'bundle',
              url: `https://github.com/pkmn/${slugs[idx]}.tar.zst`,
              sha256: String(idx + 1).repeat(64),
              ladderIds: ['gen9championsvgc2026regmc'],
              teamsByLadder: {gen9championsvgc2026regmc: vgcPools[idx]},
            });
            db.applySubmissionStatus({
              versionId: sub.id,
              smokeStatus: 'passed',
              unpackedBytes: 1024,
            });
            seedStateDb.upsertLocalAgent({
              versionId: sub.id,
              agentId: ag.id,
              slug: ag.slug,
              version: '1.0.0',
              mode: 'native',
              target: 'default-vgc',
              residency: 'hot',
              unpackedBytes: 1024,
            });
          }
          seedStateDb.close();

          const prevDev = process.env.ARENA_DEV;
          process.env.ARENA_DEV = '1';
          try {
            await arenaIndex.runDaemon({
              serverUrl,
              arenaSecret: secret,
              stateDbPath: daemonStatePath,
              rootDir: daemonRoot,
              maxTurns: 1,
              once: true,
            });

            const vgcMatches = db.getRecentMatches(10);
            expect(vgcMatches).toHaveLength(1);
            expect(vgcMatches[0].id).toBe('gen9championsvgc2026regmc-0000001');
            expect(vgcMatches[0].p1.teamLabel).toMatch(/^(?:P[12]:)?[0-9a-f]{12}$/);
            expect(vgcMatches[0].p2.teamLabel).toMatch(/^(?:P[12]:)?[0-9a-f]{12}$/);

            const vgcPubDir = path.join(publicDir, 'arena', 'ladders', 'gen9championsvgc2026regmc');
            const vgcPrivDir = path.join(
              publicDir,
              'arena',
              'ladders',
              '.private',
              'gen9championsvgc2026regmc'
            );
            expect(fs.existsSync(vgcPubDir)).toBe(false);
            expect(
              fs.existsSync(path.join(vgcPrivDir, 'gen9championsvgc2026regmc-0000001a.log'))
            ).toBe(true);
            expect(
              fs.existsSync(path.join(vgcPrivDir, 'gen9championsvgc2026regmc-0000001b.log'))
            ).toBe(true);

            db.setLadderStatus(
              'gen9championsvgc2026regmc',
              'archived',
              Math.floor(Date.now() / 1000)
            );
            await arenaIndex.runDaemon({
              serverUrl,
              arenaSecret: secret,
              stateDbPath: daemonStatePath,
              rootDir: daemonRoot,
              maxTurns: 1,
              once: true,
            });

            expect(fs.existsSync(vgcPrivDir)).toBe(false);
            expect(
              fs.existsSync(path.join(vgcPubDir, 'gen9championsvgc2026regmc-logs.tar'))
            ).toBe(true);
            expect(
              fs.existsSync(path.join(vgcPubDir, 'gen9championsvgc2026regmc-0000001a.log'))
            ).toBe(true);
            expect(
              fs.existsSync(path.join(vgcPubDir, 'gen9championsvgc2026regmc-0000001b.log'))
            ).toBe(true);
          } finally {
            if (prevDev === undefined) delete process.env.ARENA_DEV;
            else process.env.ARENA_DEV = prevDev;
          }
        }
      );
    });

  test('reuses locked active pools team roster when smoke testing a new version', async () => {
    await withRealArenaServer(tmpDir, 'locked-active-teams', async ({db, client}) => {
      const stateDb = new arenaDb.Database(':memory:');
      try {
        db.syncLaddersFromYaml([
          '- name: VGC',
          '  id: gen9championsvgc2026regmc',
          '  format: gen9championsvgc2026regmc',
          '  version: 0.11.0',
          '  team: pools',
          '  status: active',
          '  min: 4',
          '  teams: 20',
        ].join('\n'));
        db.syncProjectsFromYaml([
          '- name: Foul Play',
          '  active: 2026',
          '  arena: {owners: {pmariglia: pmariglia.535629}}',
        ].join('\n'));
        db.setAgentLadders('foul-play', ['vgc']);
        const ag = db.getAgentBySlug('foul-play')!;
        const first = db.createSubmission({
          agentId: ag.id,
          version: '1.0.0',
          package: 'bundle',
          url: `file://${bundleTar}`,
          sha256: bundleSha,
          ladderIds: ['gen9championsvgc2026regmc'],
          teamsByLadder: {gen9championsvgc2026regmc: vgcPools[0]},
          now: 1000,
        });
        db.applySubmissionStatus({
          versionId: first.id,
          smokeStatus: 'passed',
          unpackedBytes: 1024,
          now: 1001,
        });
        db.db.prepare(
          'UPDATE ladder_entries SET se = 35, matches = 25, settled_at = 1002 ' +
            'WHERE version_id = ?'
        ).run(first.id);

        // Subsequent version omits `teamsByLadder` to reuse the locked active 20-team roster
        const next = db.createSubmission({
          agentId: ag.id,
          version: '1.0.1',
          package: 'bundle',
          url: `file://${bundleTar}`,
          sha256: bundleSha,
          ladderIds: ['gen9championsvgc2026regmc'],
          now: 1000 + 15 * 86400,
        });
        const pending = await client.getPendingSubmissions({target: 'ladder'});
        expect(pending.submissions[0]?.teamsByLadder?.gen9championsvgc2026regmc).toHaveLength(20);

        const coord = new coordinator.Coordinator({
          client,
          stateDb,
          baselineSpec: {mode: 'native', target: defaultAgentScript},
          rootDir: path.join(tmpDir, 'locked-active'),
          devMode: true,
        });
        await coord.processPendingSubmissions();
        expect(db.getVersionById(next.id)?.smokeStatus).toBe('passed');
      } finally {
        stateDb.close();
      }
    });
  });

  test('resolves upcoming ladder formats while leaving tournament OCI queued', async () => {
    await withRealArenaServer(tmpDir, 'upcoming-fmt', async ({db, client}) => {
      const stateDb = new arenaDb.Database(':memory:');
      try {
        db.syncLaddersFromYaml([
          '- name: RBY',
          '  id: gen1ou20261109',
          '  format: gen1ou',
          '  version: 0.11.0',
          '  team: harvested',
          '  status: upcoming',
          '  min: 2',
        ].join('\n'));
        db.syncProjectsFromYaml([
          '- name: Mew\'s Truck',
          '  active: 2026',
          '  arena: {owners: {truckdev: truckdev.10003}}',
        ].join('\n'));
        db.setAgentLadders('mews-truck', ['rby']);
        const mewAgent = db.getAgentBySlug('mews-truck')!;
        db.upsertTournament({
          id: '9',
          name: 'Tournament #9',
          format: 'gen9ou',
          version: '0.11.0',
          gamesPerMatchup: 8,
          parallelTables: 2,
          hardware: 'GCP L4',
          status: 'scheduled',
          startsAt: Math.floor(Date.now() / 1000) + 86400 * 7,
        });

        const gen1OnlyDir = path.join(tmpDir, 'gen1-strict-bundle');
        fs.mkdirSync(gen1OnlyDir, {recursive: true});
        fs.writeFileSync(
          path.join(gen1OnlyDir, 'run'),
          [
            '#!/usr/bin/env node',
            'const readline = require("readline");',
            'process.stdout.write("/ready\\n");',
            'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
            'let sawGen1Tier = false;',
            'rl.on("line", line => {',
            '  if (line === "|tier|[Gen 1] OU") sawGen1Tier = true;',
            '  if (line.startsWith("|tier|") && line !== "|tier|[Gen 1] OU") process.exit(2);',
            '  if (!line.startsWith("|request|")) return;',
            '  const raw = line.slice(9).trim();',
            '  if (!raw || raw === "null") return;',
            '  const req = JSON.parse(raw);',
            '  if (req.wait) return;',
            '  if (!sawGen1Tier) process.exit(3);',
            '  process.stdout.write("default\\n");',
            '});',
          ].join('\n'),
          {mode: 0o755}
        );
        const gen1Tar = path.join(tmpDir, 'gen1-strict.tar.gz');
        execFileSync('tar', ['-czf', gen1Tar, '-C', gen1OnlyDir, '.']);
        const gen1Sha = crypto.createHash('sha256')
          .update(fs.readFileSync(gen1Tar))
          .digest('hex');

        const upcomingSub = db.createSubmission({
          agentId: mewAgent.id,
          version: '3.0.0',
          package: 'bundle',
          url: `file://${gen1Tar}`,
          sha256: gen1Sha,
          ladderIds: ['gen1ou20261109'],
        });
        const tourneySub = db.createSubmission({
          agentId: mewAgent.id,
          version: '3.0.0-t9',
          package: 'oci',
          url: 'ghcr.io/pkmn/mews-truck:3.0.0-t9',
          sha256: 'c'.repeat(64),
          ladderIds: [],
          tournamentIds: ['9'],
        });

        const ladderPending = await client.getPendingSubmissions({target: 'ladder'});
        expect(ladderPending.submissions.map(s => s.versionId)).toEqual([upcomingSub.id]);
        const tourneyPending = await client.getPendingSubmissions({
          target: 'tournament',
          tournamentId: '9',
        });
        expect(tourneyPending.submissions.map(s => s.versionId)).toEqual([tourneySub.id]);

        const upcomingRoot = path.join(tmpDir, 'upcoming');
        seedSampleTeams(upcomingRoot, 'gen1ou', [RBY_TEAM_ONE, RBY_TEAM_TWO]);
        const coord = new coordinator.Coordinator({
          client,
          stateDb,
          baselineSpec: {mode: 'native', target: defaultAgentScript},
          rootDir: upcomingRoot,
          devMode: true,
        });
        expect(await coord.processPendingSubmissions()).toBe(1);
        expect(db.getVersionById(upcomingSub.id)?.smokeStatus).toBe('passed');
        expect(db.getVersionById(tourneySub.id)?.smokeStatus).toBe('pending');
      } finally {
        stateDb.close();
      }
    });
  });

  test('TournamentCoordinator validates OCI entrants then runs RR plus Superfinal', async () => {
    await withRealArenaServer(tmpDir, 'tour-coord', async ({db, client, publicDir}) => {
      db.syncProjectsFromYaml([
        '- name: 0 ERROR',
        '  active: 2026',
        '  arena: {owners: {scheibo: pre.10544}}',
        '- name: Foul Play',
        '  active: 2026',
        '  arena: {owners: {pmariglia: pmariglia.535629}}',
        '- name: Mew\'s Truck',
        '  active: 2026',
        '  arena: {owners: {truckdev: truckdev.10003}}',
      ].join('\n'));
      db.upsertTournament({
        id: '9',
        name: 'Tournament #9',
        format: 'gen9ou',
        version: '0.11.0',
        gamesPerMatchup: 2,
        batchSize: 2,
        parallelTables: 2,
        hardware: 'GCP L4',
        status: 'scheduled',
        startsAt: Math.floor(Date.now() / 1000) + 86400 * 7,
      });

      for (const [idx, slug] of ['0-error', 'foul-play', 'mews-truck'].entries()) {
        const ag = db.getAgentBySlug(slug)!;
        db.createSubmission({
          agentId: ag.id,
          version: '3.0.0-t9',
          package: 'oci',
          url: `ghcr.io/pkmn/${slug}:3.0.0-t9`,
          sha256: String(idx + 3).repeat(64),
          ladderIds: [],
          tournamentIds: ['9'],
        });
      }

      const tourCoord = new tournament.Coordinator({
        client,
        baselineSpec: {
          agentId: '_baseline',
          displayName: 'Baseline',
          vmHost: '127.0.0.1',
          controlSocket: '',
          localCommand: relayBin,
          localArgs: [root('arena', 'bin', 'baseline')],
        },
        rootDir: path.join(tmpDir, 'gcp-tourney'),
        superfinalGames: 2,
        maxTurns: 1,
        prepareSubmissionRootfs: () => 2048,
        resolveEntrantSpec: entrant => ({
          agentId: `${entrant.agentSlug}-${entrant.versionId}`,
          displayName: entrant.agentName,
          vmHost: '127.0.0.1',
          controlSocket: '',
          localCommand: relayBin,
          localArgs: entrant.version.endsWith('-t9')
            ? [defaultAgentScript, '--utm', OU_TEAM_ONE]
            : [defaultAgentScript],
        }),
      });

      expect(await tourCoord.processPendingSubmissions('9')).toBe(3);
      expect(db.getTournamentEntrants('9')).toHaveLength(3);

      db.seedTournamentEntrants('9');
      const tourRun = await tourCoord.runTournament('9');
      expect(tourRun.roundRobinGames).toBe(6);
      expect(tourRun.superfinalGames).toBe(2);
      expect(db.getTournament('9')?.status).toBe('completed');
      expect(db.getTournamentEntrants('9').map(e => e.finalRank)).toEqual([1, 2, 3]);
      const tourLogDir = path.join(publicDir, 'arena', 'tournaments', '9');
      expect(fs.readdirSync(tourLogDir).filter(f => f.endsWith('.log'))).toHaveLength(8);

      // Verify a harvested tournament locks the identical CRN team pair across all RR pairings
      db.syncLaddersFromYaml([
        '- name: SV',
        '  id: gen9customgame',
        '  format: gen9customgame',
        '  version: 0.11.0',
        '  team: harvested',
        '  status: active',
        '  min: 2',
      ].join('\n'));
      db.replaceLadderTeams('gen9customgame', [TEAM_ONE, TEAM_TWO]);
      db.upsertTournament({
        id: '10',
        name: 'Tournament #10',
        format: 'gen9customgame',
        version: '0.11.0',
        team: 'harvested',
        gamesPerMatchup: 2,
        batchSize: 2,
        parallelTables: 2,
        hardware: 'GCP L4',
        status: 'scheduled',
        startsAt: Math.floor(Date.now() / 1000) + 86400 * 7,
      });
      const noSfCoord = new tournament.Coordinator({
        client,
        baselineSpec: {
          agentId: '_baseline',
          displayName: 'Baseline',
          vmHost: '127.0.0.1',
          controlSocket: '',
          localCommand: relayBin,
          localArgs: [root('arena', 'bin', 'baseline')],
        },
        superfinalGames: 0,
        maxTurns: 1,
        resolveEntrantSpec: entrant => ({
          agentId: `${entrant.agentSlug}-${entrant.versionId}`,
          displayName: entrant.agentName,
          vmHost: '127.0.0.1',
          controlSocket: '',
          localCommand: relayBin,
          localArgs: [defaultAgentScript],
        }),
      });
      for (const [idx, slug] of ['0-error', 'foul-play', 'mews-truck'].entries()) {
        const ag = db.getAgentBySlug(slug)!;
        const v = db.createSubmission({
          agentId: ag.id,
          version: '3.0.0-t10',
          package: 'oci',
          url: `ghcr.io/pkmn/${slug}:3.0.0-t10`,
          sha256: String(idx + 6).repeat(64),
          ladderIds: [],
          tournamentIds: ['10'],
        });
        db.applySubmissionStatus({versionId: v.id, smokeStatus: 'passed', unpackedBytes: 2048});
      }
      db.seedTournamentEntrants('10');
      const noSfRes = await noSfCoord.runTournament('10');
      expect(noSfRes).toEqual({roundRobinGames: 6, superfinalGames: 0});
      const t10Games = db.getTournamentGames('10').filter(g => g.stage === 'Round Robin');
      expect(t10Games).toHaveLength(6);
      const oddSeeds = new Set(
        t10Games.filter(g => g.matchupGame === 1).map(g => g.games[0].seed)
      );
      const evenSeeds = new Set(
        t10Games.filter(g => g.matchupGame === 2).map(g => g.games[0].seed)
      );
      expect(oddSeeds.size).toBe(1);
      expect(evenSeeds).toEqual(oddSeeds);
      expect(db.getTournament('10')?.status).toBe('completed');
      expect(() => db.seedTournamentEntrants('10')).toThrow(/status 'completed'/);
    });
  });

  test('runDaemon wakes immediately from idle poll sleep on SIGUSR1 drain signal', async () => {
    await withRealArenaServer(tmpDir, 'drain-sleep', async ({serverUrl, secret}) => {
      const start = Date.now();
      const daemonPromise = arenaIndex.runDaemon({
        serverUrl,
        arenaSecret: secret,
        stateDbPath: ':memory:',
        pollIntervalMillis: 60_000,
      });
      setTimeout(() => {
        process.emit('SIGUSR1');
      }, 50);
      await daemonPromise;
      expect(Date.now() - start).toBeLessThan(2000);
    });
  });

  function createTournamentSmokeHarness(opts: {
    id: string;
    versionId: number;
    version: string;
    format: string;
    team: 'random' | 'harvested' | 'pools';
    teamPool?: string[];
    rootName: string;
    baseline?: {command: string; args: string[]};
    entrant?: {command: string; args: string[]};
  }) {
    const alerts: serverArena.StaffAlertPayload[] = [];
    const reported: serverArena.SubmissionStatusPayload[] = [];
    const fakeClient = {
      getPendingSubmissions: () => Promise.resolve({
        ladders: [],
        tournaments: [{
          id: opts.id,
          format: opts.format,
          version: '0.11.0',
          team: opts.team,
          customRules: [],
          teamPool: opts.teamPool ?? [],
        }],
        submissions: [{
          versionId: opts.versionId,
          agentId: 1,
          agentSlug: 'foul-play',
          agentName: 'Foul Play',
          version: opts.version,
          package: 'oci' as const,
          url: `ghcr.io/pkmn/foul-play:${opts.version}`,
          sha256: opts.id.slice(-1).repeat(64),
          ladders: [],
          tournaments: [opts.id],
          teamsByLadder: {},
        }],
      }),
      reportSubmissionStatus: (payload: serverArena.SubmissionStatusPayload) => {
        reported.push(payload);
        return Promise.resolve({
          ok: true as const,
          versionId: payload.versionId,
          smokeStatus: payload.smokeStatus,
          retiredByLadder: {},
        });
      },
      sendAlert: (payload: serverArena.StaffAlertPayload) => {
        alerts.push(payload);
        return Promise.resolve({ok: true as const});
      },
    } as unknown as serverArena.Client;

    const rootDir = path.join(tmpDir, opts.rootName);
    const baseline = opts.baseline ?? {
      command: relayBin,
      args: [root('arena', 'bin', 'baseline')],
    };
    const entrantCmd = opts.entrant ?? {
      command: relayBin,
      args: [defaultAgentScript],
    };
    const coord = new tournament.Coordinator({
      client: fakeClient,
      baselineSpec: {
        agentId: '_baseline',
        displayName: 'Baseline',
        vmHost: '127.0.0.1',
        controlSocket: '',
        localCommand: baseline.command,
        localArgs: baseline.args,
      },
      rootDir,
      prepareSubmissionRootfs: () => 1024,
      resolveEntrantSpec: entrant => ({
        agentId: `${entrant.agentSlug}-${entrant.versionId}`,
        displayName: entrant.agentName,
        vmHost: '127.0.0.1',
        controlSocket: '',
        localCommand: entrantCmd.command,
        localArgs: entrantCmd.args,
      }),
    });
    return {coord, rootDir, reported, alerts};
  }

  test('TournamentCoordinator aborts GCP smoke test on baseline fault', async () => {
    const h = createTournamentSmokeHarness({
      id: '91',
      versionId: 91,
      version: '9.1.0',
      format: 'gen9randombattle',
      team: 'random',
      rootName: 'tourney-smoke-alert',
      baseline: {command: defaultAgentScript, args: ['--crash']},
    });
    await expect(h.coord.processPendingSubmissions('91')).rejects.toThrow(
      /baseline\/infrastructure fault/i
    );
    expect(h.reported).toEqual([]);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0].key).toBe('tourney-smoke-infra');
    expect(h.alerts[0].message).toContain('foul-play 9.1.0');
  });

  test('TournamentCoordinator fails GCP smoke test on double-crash tie', async () => {
    const h = createTournamentSmokeHarness({
      id: '92',
      versionId: 92,
      version: '9.2.0',
      format: 'gen9randombattle',
      team: 'random',
      rootName: 'gcp-smoke-double-crash',
      baseline: {command: process.execPath, args: ['-e', 'process.exit(1)']},
      entrant: {command: process.execPath, args: ['-e', 'process.exit(1)']},
    });
    await h.coord.processPendingSubmissions('92');
    expect(h.reported).toHaveLength(1);
    expect(h.reported[0].smokeStatus).toBe('failed');
  });

  test('TournamentCoordinator smoke tests harvested OU tournaments using sample teams',
    async () => {
      const h = createTournamentSmokeHarness({
        id: '93',
        versionId: 93,
        version: '9.3.0',
        format: 'gen9ou',
        team: 'harvested',
        rootName: 'gcp-smoke-samples',
      });
      seedSampleTeams(h.rootDir, 'gen9ou', [OU_TEAM_ONE, OU_TEAM_TWO]);
      expect(await h.coord.processPendingSubmissions('93')).toBe(1);
      expect(h.reported).toHaveLength(1);
      expect(h.reported[0].smokeStatus).toBe('passed');
    });

  test('TournamentCoordinator aborts harvested smoke test without falling back to harvested pool',
    async () => {
      const h = createTournamentSmokeHarness({
        id: '94',
        versionId: 94,
        version: '9.4.0',
        format: 'gen9customgame',
        team: 'harvested',
        teamPool: [TEAM_ONE, TEAM_TWO],
        rootName: 'gcp-smoke-no-fallback',
      });
      await expect(h.coord.processPendingSubmissions('94')).rejects.toThrow(
        /missing sample team pool/
      );
      expect(h.reported).toEqual([]);
      expect(h.alerts).toHaveLength(1);
      expect(h.alerts[0].key).toBe('tourney-smoke-infra');
      expect(h.alerts[0].detail).toContain('missing sample team pool');
    });
});
