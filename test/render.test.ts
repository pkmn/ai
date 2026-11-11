import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import polka from 'polka';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {ArenaDB} from '../db';
import * as arena from '../server/arena';
import type {GameOutcome, MatchCategory} from '../server/ratings';
import {type StandingsJsonDocument, renderArenaPages} from '../server/render';
import {root} from '../static/util';
import {runPkmnCli} from '../tools/pkmn';

const NOW = 1_762_800_000;
const DAY_1 = 1_762_600_000;
const DAY_2 = 1_762_700_000;
const DAY_3 = 1_762_790_000;
const ARENA_SECRET = 'test-arena-render-secret';

const TEST_PROJECTS_YAML = `
- name: Foul Play
  active: 2019
  license: GPL-3.0
  source: https://github.com/pmariglia/showdown
  arena:
    qualified: true
    owners:
      pmariglia: pmariglia.535629
- name: Metamon
  active: 2024
  license: MIT
  source: https://github.com/UT-Austin-RPL/metamon
  arena:
    qualified: true
    owners:
      jake: jake.20001
- name: Jaxcalibur
  active: 2026
  arena:
    qualified: true
    owners:
      jaxdev: jaxdev.30001
- name: Athena
  active: [2020, 2023]
  arena:
    qualified: true
    owners:
      athenadev: athenadev.40001
- name: Technical Machine
  active: 2010
  license: BSL-1.0
  source: https://github.com/davidstone/technical-machine
  arena:
    owners:
      davidstone: davidstone.50001
`;

function createVersionAndPassSmoke(
  db: ArenaDB,
  botSlug: string,
  versionStr: string,
  ladders: string[],
  createdAt: number
): number {
  const bot = db.getBotBySlug(botSlug);
  if (!bot) throw new Error(`Missing bot ${botSlug}`);
  const dev = db.getDevelopersForBot(bot.id)[0];
  if (!dev) throw new Error(`Missing developer for ${botSlug}`);
  const ver = db.createSubmission({
    botId: bot.id,
    submittedByDevId: dev.id,
    versionStr,
    formatType: 'bundle',
    downloadUrl: `https://example.com/${botSlug}-${versionStr}.tar.zst`,
    sha256: versionStr.padEnd(64, 'a').slice(0, 64),
    authTokenEnc: null,
    ladderIds: ladders,
    now: createdAt,
  });
  db.applySubmissionStatus({
    versionId: ver.id,
    smokeStatus: 'passed',
    unpackedBytes: 20_000_000,
    smokeDurationMs: 1200,
    smokeTurnMs: 250,
    smokePeakRamMb: 512,
    now: createdAt + 5,
  });
  return ver.id;
}

let matchSeq = 0;
function playMatch(
  db: ArenaDB,
  ladderId: string,
  v1Id: number,
  v2Id: number,
  g1: GameOutcome,
  g2: GameOutcome,
  completedAt: number
) {
  matchSeq++;
  const hex = matchSeq.toString(16).padStart(10, '0');
  const formatPrefix = ladderId.startsWith('gen3ou') ? 'gen3ou' : 'gen1ou';
  const cat = `${g1}${g2}` as MatchCategory;
  db.recordCompletedMatch({
    match: {
      id: `${formatPrefix}-${hex}`,
      ladder_id: ladderId,
      v1_id: v1Id,
      v2_id: v2Id,
      seed: `1,2,3,${matchSeq}`,
      g1_outcome: g1,
      g2_outcome: g2,
      match_category: cat,
      g1_turns: 28,
      g2_turns: 32,
      g1_end_reason: 'normal',
      g2_end_reason: 'normal',
      v1_peak_ram_mb: 1180,
      v2_peak_ram_mb: 1420,
      v1_g1_bank_s: 150,
      v1_g2_bank_s: 142,
      v2_g1_bank_s: 148,
      v2_g2_bank_s: 136,
      v1_avg_turn_ms: 390,
      v2_avg_turn_ms: 480,
      completed_at: completedAt,
    },
  });
}

function seedStaticPublicAssets(tmpPublic: string) {
  fs.mkdirSync(tmpPublic, {recursive: true});
  const realPublic = root('public');
  for (const name of ['index.html', 'favicon.svg', 'cc.svg', 'by.svg', 'sa.svg']) {
    const src = path.join(realPublic, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(tmpPublic, name));
    }
  }
  for (const name of fs.readdirSync(realPublic)) {
    if (name.endsWith('.png') && name.startsWith('favicon')) {
      fs.copyFileSync(path.join(realPublic, name), path.join(tmpPublic, name));
    }
  }
  for (const dir of [
    'glossary', 'research', 'concepts', 'rules', 'release', 'background', 'chat', 'account',
  ]) {
    const srcDir = path.join(realPublic, dir);
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, path.join(tmpPublic, dir), {recursive: true});
    }
  }
}

describe('Static Arena Views Part 1 (Leaderboard, Projects, Battles)', () => {
  let tmpDir: string;
  let tmpPublic: string;
  let db: ArenaDB;

  beforeEach(() => {
    matchSeq = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-render-test-'));
    tmpPublic = path.join(tmpDir, 'public');
    seedStaticPublicAssets(tmpPublic);
    db = new ArenaDB(':memory:', {now: DAY_1});
    db.syncLadders(undefined, DAY_1);
    db.syncProjectsFromYaml(TEST_PROJECTS_YAML, path.join(tmpDir, 'avatars'), DAY_1);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  it('renders clean empty states on upcoming ladders with zero leftover .tmp files', () => {
    renderArenaPages({db, publicDir: tmpPublic, now: NOW});

    for (const rel of [
      ['projects', 'index.html'],
      ['leaderboard', 'index.html'],
      ['leaderboard', 'standings.json'],
      ['battles', 'index.html'],
    ]) {
      const full = path.join(tmpPublic, ...rel);
      expect(fs.existsSync(full)).toBe(true);
      const dirEntries = fs.readdirSync(path.dirname(full));
      expect(dirEntries.some(f => f.includes('.tmp.'))).toBe(false);
    }

    const leaderboardHtml = fs.readFileSync(
      path.join(tmpPublic, 'leaderboard', 'index.html'),
      'utf8'
    );
    expect(leaderboardHtml).toContain('RBY ladder is upcoming');
    expect(leaderboardHtml).toContain('id="rby"');
    expect(leaderboardHtml).toContain('id="adv"');
    expect(leaderboardHtml).toContain('id="sv"');
    expect(leaderboardHtml).toContain('id="rand"');
    expect(leaderboardHtml).toContain('id="vgc"');
    expect(leaderboardHtml).toMatch(/<section[^>]*id="history"[^>]*class="hide"/);
    expect(leaderboardHtml).toMatch(/<section[^>]*id="matchups"[^>]*class="hide"/);

    const standingsJson = JSON.parse(
      fs.readFileSync(path.join(tmpPublic, 'leaderboard', 'standings.json'), 'utf8')
    ) as StandingsJsonDocument;
    expect(standingsJson.updated_at).toBe(NOW);
    expect(Object.keys(standingsJson.ladders)).toEqual(['rby', 'adv', 'sv', 'rand', 'vgc']);
    expect(standingsJson.ladders.rby.standings).toEqual([]);

    const battlesHtml = fs.readFileSync(path.join(tmpPublic, 'battles', 'index.html'), 'utf8');
    expect(battlesHtml).toContain('No battle currently running — Arena is idle.');
    expect(battlesHtml).toContain('No completed battles yet.');
  });

  it('renders populated Leaderboard, History SVG, Matchups matrix, Projects & Battles', () => {
    db.setLadderStatus('gen1ou20261109', 'active', DAY_1);
    db.setLadderStatus('gen3ou20261109', 'active', DAY_1);

    // Create versions across multiple bots:
    // -Jaxcalibur: 1.0.0 (retired) -> 1.1.0 (champion #1 on RBY)
    // -Metamon: 1.0.0 (anchor, secondary active) + 1.2.0 (champion #2 on RBY, #1 on ADV)
    // -Foul Play: 1.4.0 (champion #3 on RBY, #2 on ADV)
    // -Athena: 0.9.0 (provisional < 10 matches on RBY)
    const jaxV1 = createVersionAndPassSmoke(db, 'jaxcalibur', '1.0.0', ['gen1ou20261109'], DAY_1);
    const metaAnchor = createVersionAndPassSmoke(db, 'metamon', '1.0.0', ['gen1ou20261109'], DAY_1);
    const foulV1 = createVersionAndPassSmoke(
      db,
      'foul-play',
      '1.4.0',
      ['gen1ou20261109', 'gen3ou20261109'],
      DAY_1
    );

    db.setLadderAnchor('gen1ou20261109', 'metamon', '1.0.0', DAY_1 + 10);

    // Day 1: play enough competitive matches (>= 25 matches, SE <= 30) so v1s settle
    for (let i = 0; i < 36; i++) {
      const g2: GameOutcome = i % 4 === 0 ? 'L' : 'W';
      playMatch(db, 'gen1ou20261109', jaxV1, metaAnchor, 'W', g2, DAY_1 + 100 + i * 5);
      playMatch(db, 'gen1ou20261109', jaxV1, foulV1, 'W', g2, DAY_1 + 400 + i * 5);
      playMatch(db, 'gen1ou20261109', metaAnchor, foulV1, 'W', 'L', DAY_1 + 700 + i * 5);
    }

    // Day 2: Metamon submits 1.2.0 on RBY & ADV; Jaxcalibur upgrades to 1.1.0 (retiring 1.0.0)
    db.refundCooldown('metamon', DAY_2);
    const metaV2 = createVersionAndPassSmoke(
      db,
      'metamon',
      '1.2.0',
      ['gen1ou20261109', 'gen3ou20261109'],
      DAY_2
    );
    db.refundCooldown('jaxcalibur', DAY_2);
    const jaxV2 = createVersionAndPassSmoke(db, 'jaxcalibur', '1.1.0', ['gen1ou20261109'], DAY_2);
    db.applySubmissionStatus({
      versionId: jaxV2,
      smokeStatus: 'passed',
      retiredVersionIdsByLadder: {gen1ou20261109: jaxV1},
      now: DAY_2 + 20,
    });

    for (let i = 0; i < 28; i++) {
      const g2: GameOutcome = i % 6 === 0 ? 'L' : 'W';
      playMatch(db, 'gen1ou20261109', metaV2, foulV1, 'W', g2, DAY_2 + 100 + i * 5);
      playMatch(db, 'gen1ou20261109', metaV2, metaAnchor, 'W', g2, DAY_2 + 300 + i * 5);
      playMatch(db, 'gen3ou20261109', metaV2, foulV1, 'W', g2, DAY_2 + 500 + i * 5);
    }

    // Day 3: Jaxcalibur 1.1.0 leads RBY (finishing on a W4 streak; Foul Play on L4 streak)
    for (let i = 0; i < 32; i++) {
      const g2: GameOutcome = i < 28 && i % 4 === 0 ? 'L' : 'W';
      playMatch(db, 'gen1ou20261109', jaxV2, metaV2, 'W', g2, DAY_3 + 100 + i * 5);
      playMatch(db, 'gen1ou20261109', jaxV2, foulV1, 'W', g2, DAY_3 + 300 + i * 5);
    }

    // Athena submits provisional version with only 3 matches
    const athenaV1 = createVersionAndPassSmoke(db, 'athena', '0.9.0', ['gen1ou20261109'], DAY_3);
    for (let i = 0; i < 3; i++) {
      playMatch(db, 'gen1ou20261109', athenaV1, foulV1, 'W', 'L', DAY_3 + 700 + i * 10);
    }

    // Simulate a generated profile page for Jaxcalibur so link resolution tests both branches!
    fs.mkdirSync(path.join(tmpPublic, 'leaderboard', 'jaxcalibur'), {recursive: true});
    fs.writeFileSync(
      path.join(tmpPublic, 'leaderboard', 'jaxcalibur', 'index.html'),
      '<!doctype html><html lang="en"><head><title>Jaxcalibur</title></head><body></body></html>',
      'utf8'
    );

    const liveDoc: arena.LiveJsonDocument = {
      updated_at: NOW - 2,
      stale: false,
      live: {
        heartbeat_seq: 142,
        match_id: 'gen1ou-0000000999',
        ladder_id: 'gen1ou20261109',
        slot: 'rby',
        format_id: 'gen1ou',
        game_num: 2,
        turn: 27,
        active_slot: 'p2',
        turn_started_at: NOW - 3,
        turn_budget_s: 135,
        increment_s: 10,
        g1_summary: {winner_slot: 'p1', turns: 31},
        p1: {
          slug: 'jaxcalibur',
          name: 'Jaxcalibur',
          version: '1.1.0',
          bank_s: 150,
          last_turn_ms: 380,
          mean_turn_ms: 405,
          ram_mb: 1180,
        },
        p2: {
          slug: 'foul-play',
          name: 'Foul Play',
          version: '1.4.0',
          bank_s: 135,
          last_turn_ms: 520,
          mean_turn_ms: 495,
          ram_mb: 1420,
        },
      },
      recent_matches: db.getRecentMatches(50),
    };

    renderArenaPages({db, publicDir: tmpPublic, liveDoc, now: NOW});

    // 1. Verify Leaderboard HTML & standings.json
    const lbHtml = fs.readFileSync(path.join(tmpPublic, 'leaderboard', 'index.html'), 'utf8');
    const standings = JSON.parse(
      fs.readFileSync(path.join(tmpPublic, 'leaderboard', 'standings.json'), 'utf8')
    ) as StandingsJsonDocument;

    const rbyRows = standings.ladders.rby.standings;
    const rankedRby = rbyRows.filter(r => r.rank !== null);
    expect(rankedRby.map(r => r.rank)).toEqual([1, 2, 3]);
    expect(rankedRby.map(r => r.bot_slug)).toEqual(['jaxcalibur', 'metamon', 'foul-play']);
    expect(rankedRby[0].los_next).not.toBeNull();
    expect(rankedRby[0].los_next!).toBeGreaterThan(90);
    expect(rankedRby[1].los_next).not.toBeNull();
    expect(rankedRby[2].los_next).toBeNull();

    // Anchor has ±0 CI and secondary active status
    const anchorRow = rbyRows.find(r => r.bot_slug === 'metamon' && r.version === '1.0.0');
    expect(anchorRow).toBeDefined();
    expect(anchorRow!.is_anchor).toBe(true);
    expect(anchorRow!.elo).toBe(1500);
    expect(anchorRow!.ci95).toBe(0);
    expect(anchorRow!.rank).toBeNull();
    expect(lbHtml).toContain('±0');

    // Provisional Athena row & Retired Jaxcalibur 1.0.0 row
    const athenaRow = rbyRows.find(r => r.bot_slug === 'athena');
    expect(athenaRow?.provisional).toBe(true);
    expect(athenaRow?.rank).toBeNull();
    expect(athenaRow?.streak).toBe('T1');
    expect(lbHtml).toContain('class="provisional"');

    const retiredRow = rbyRows.find(r => r.bot_slug === 'jaxcalibur' && r.version === '1.0.0');
    expect(retiredRow?.role).toBe('retired');
    expect(lbHtml).toContain('(retired)');
    expect(lbHtml).toContain('data-retired="true"');

    // Link resolution: Jaxcalibur links to /leaderboard/jaxcalibur/, Metamon to /projects/#Metamon
    expect(lbHtml).toContain('href="/leaderboard/jaxcalibur/"');
    expect(lbHtml).toContain('href="/projects/#Metamon"');

    // Win/Loss streak semantic badges (.yes for W>=3, .no for L>=3)
    expect(lbHtml).toMatch(/<span class="yes">W\d+<\/span>/);
    expect(lbHtml).toMatch(/<span class="no">L\d+<\/span>/);

    // History SVG: 760x245 viewBox, Rank 1 --hl-symbol CI polygon + version milestone circle
    expect(lbHtml).toContain('viewBox="0 0 760 245"');
    expect(lbHtml).toContain('var(--hl-symbol)');
    expect(lbHtml).toContain('var(--hl-string)');
    expect(lbHtml).toContain('var(--hl-name)');
    expect(lbHtml).toContain('<polygon ');
    expect(lbHtml).toContain('title="1.1.0"');

    // Matchup matrix: top-left corner <th> preserved through html-minifier, .diag, .hm-w4 / .hm-l4
    const matrixHeadMatch =
      /<table class="matrix">\s*<thead>\s*<tr>([\s\S]*?)<\/tr>\s*<\/thead>/.exec(lbHtml);
    expect(matrixHeadMatch).not.toBeNull();
    const thCount = (matrixHeadMatch![1].match(/<th\b/g) ?? []).length;
    expect(thCount).toBe(4); // 1 corner <th> + 3 ranked participants!
    expect(lbHtml).toContain('<td class="diag">—</td>');
    expect(lbHtml).toContain('hm-w4');
    expect(lbHtml).toContain('hm-l4');

    // 2. Verify Projects HTML: Arena nav filter, Arena table rows, live rank priority sort
    const projHtml = fs.readFileSync(path.join(tmpPublic, 'projects', 'index.html'), 'utf8');
    expect(projHtml).toContain('main{width:100%}');
    expect(projHtml).toContain('id="arena"');
    expect(projHtml).toContain('data-arena="true"');
    expect(projHtml).toContain('href="/leaderboard/#rby"');
    expect(projHtml).toContain('href="/leaderboard/#adv"');
    expect(projHtml).toContain('<em>(provisional)</em>');

    // Ranked bots (#1 Jaxcalibur, #1 Metamon on ADV, #2 Foul Play on ADV) sort BEFORE unranked
    // eevenator, while provisional-only Athena stays behind Foul Play / IHTFP Abra!
    const posMetamon = projHtml.indexOf('id="Metamon"');
    const posFoulPlay = projHtml.indexOf('id="FoulPlay"');
    const posEevenator = projHtml.indexOf('id="eevenator"');
    const posAthena = projHtml.indexOf('id="Athena"');
    const posAbra = projHtml.indexOf('id="IHTFPAbra"');
    expect(posMetamon).toBeGreaterThan(0);
    expect(posMetamon).toBeLessThan(posEevenator);
    expect(posFoulPlay).toBeLessThan(posEevenator);
    expect(posAbra).toBeLessThan(posAthena);

    // 3. Verify Battles HTML: Live PAUSED / RUNNING slots, integer timers, RAM %, 6-col history
    const batHtml = fs.readFileSync(path.join(tmpPublic, 'battles', 'index.html'), 'utf8');
    expect(batHtml).toContain('gen1ou-0000000999');
    expect(batHtml).toContain('[Gen 1] OU');
    expect(batHtml).toContain('Game 2 / 2');
    expect(batHtml).toContain('PAUSED');
    expect(batHtml).toContain('RUNNING');
    expect(batHtml).toContain('>3s<');
    expect(batHtml).toContain('>132s<');
    expect(batHtml).toContain('8.2%');
    expect(batHtml).toContain('9.9%');
    expect(batHtml).toContain('<strong>2</strong>–0');
    expect(batHtml).toContain('1–1');
    expect(batHtml).not.toContain('minisprites');

    // 4. Run hyperlink --check-anchors across the entire populated tmpPublic directory!
    const hyperlinkBin = root('node_modules', '.bin', 'hyperlink');
    const hlOut = execFileSync(hyperlinkBin, [tmpPublic, '--check-anchors'], {
      encoding: 'utf8',
    });
    expect(hlOut).toContain('Found 0 bad links');
    expect(hlOut).toContain('Found 0 bad anchors');
  });

  it('re-renders static views on Arena HTTP match-complete and pkmn set-anchor', async () => {
    db.setLadderStatus('gen1ou20261109', 'active', DAY_1);
    const v1 = createVersionAndPassSmoke(db, 'metamon', '1.0.0', ['gen1ou20261109'], DAY_1);
    const v2 = createVersionAndPassSmoke(db, 'foul-play', '1.4.0', ['gen1ou20261109'], DAY_1);

    const app = polka();
    const handle = arena.register(app, {
      db,
      arenaSecret: ARENA_SECRET,
      sessionSecret: 'test-session-secret',
      publicDir: tmpPublic,
      now: () => NOW,
      onUpdate: () => {
        renderArenaPages({db, publicDir: tmpPublic, now: NOW});
      },
    });

    const server = http.createServer((req, res) => {
      void app.handler(req as never, res);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as {port: number}).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/arena/match-complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ARENA_SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          match: {
            id: 'gen1ou-0000000abc',
            ladder_id: 'gen1ou20261109',
            v1_id: v1,
            v2_id: v2,
            seed: '1,2,3,4',
            g1_outcome: 'W',
            g2_outcome: 'W',
            match_category: 'WW',
            g1_turns: 25,
            g2_turns: 30,
            g1_end_reason: 'normal',
            g2_end_reason: 'normal',
            v1_peak_ram_mb: 900,
            v2_peak_ram_mb: 1100,
            v1_g1_bank_s: 150,
            v1_g2_bank_s: 150,
            v2_g1_bank_s: 140,
            v2_g2_bank_s: 135,
            v1_avg_turn_ms: 300,
            v2_avg_turn_ms: 420,
            completed_at: NOW,
          },
        }),
      });
      expect(res.status).toBe(200);

      // Give async onUpdate promise microtask a tick
      await new Promise(resolve => setTimeout(resolve, 25));

      const batHtml = fs.readFileSync(path.join(tmpPublic, 'battles', 'index.html'), 'utf8');
      expect(batHtml).toContain('gen1ou-0000000abc');

      const standings = JSON.parse(
        fs.readFileSync(path.join(tmpPublic, 'leaderboard', 'standings.json'), 'utf8')
      ) as StandingsJsonDocument;
      expect(standings.ladders.rby.standings.length).toBe(2);

      // Also verify `pkmn set-anchor` updates public/leaderboard/standings.json immediately
      const logs: string[] = [];
      await runPkmnCli(['set-anchor', 'gen1ou20261109', 'foul-play', '1.4.0'], {
        db,
        publicDir: tmpPublic,
        now: NOW + 10,
        log: line => logs.push(line),
      });
      const updatedStandings = JSON.parse(
        fs.readFileSync(path.join(tmpPublic, 'leaderboard', 'standings.json'), 'utf8')
      ) as StandingsJsonDocument;
      const foulAnchor = updatedStandings.ladders.rby.standings.find(
        s => s.bot_slug === 'foul-play'
      );
      expect(foulAnchor?.is_anchor).toBe(true);
      expect(foulAnchor?.elo).toBe(1500);
      expect(foulAnchor?.ci95).toBe(0);
    } finally {
      handle.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
