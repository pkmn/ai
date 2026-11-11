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
import {
  type StandingsJsonDocument,
  type TournamentLiveBroadcast,
  renderArenaPages,
} from '../server/render';
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

describe('Static Arena Views (/arena, ladders, tournaments, /projects/:bot)', () => {
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

  it('renders clean empty states on /arena, ladders, and 0-entry /projects/:bot', () => {
    renderArenaPages({db, publicDir: tmpPublic, now: NOW});

    for (const rel of [
      ['projects', 'index.html'],
      ['projects', 'foul-play', 'index.html'],
      ['projects', 'technical-machine', 'index.html'],
      ['arena', 'index.html'],
      ['arena', 'index.json'],
      ['arena', 'ladders', 'rby', 'index.html'],
      ['arena', 'ladders', 'rby', 'index.json'],
      ['arena', 'ladders', 'vgc', 'index.html'],
      ['arena', 'battles', 'index.html'],
    ]) {
      const full = path.join(tmpPublic, ...rel);
      expect(fs.existsSync(full)).toBe(true);
      const dirEntries = fs.readdirSync(path.dirname(full));
      expect(dirEntries.some(f => f.includes('.tmp.'))).toBe(false);
    }

    const arenaHtml = fs.readFileSync(path.join(tmpPublic, 'arena', 'index.html'), 'utf8');
    expect(arenaHtml).toContain('<h2>Arena</h2>');
    expect(arenaHtml).toContain('href="/rules/"');
    expect(arenaHtml).toContain('href="/arena/battles/"');
    expect(arenaHtml).toContain('href="/arena/ladders/rby/"');
    expect(arenaHtml).toContain('href="/arena/ladders/vgc/"');
    expect(arenaHtml).toContain('Upcoming');
    expect(arenaHtml).toContain('No championship tournaments scheduled yet.');

    const rbyLadderHtml = fs.readFileSync(
      path.join(tmpPublic, 'arena', 'ladders', 'rby', 'index.html'),
      'utf8'
    );
    expect(rbyLadderHtml).toContain('RBY ladder is upcoming');
    expect(rbyLadderHtml).toContain('href="/arena/ladders/rby/"');
    expect(rbyLadderHtml).toContain('href="/arena/ladders/adv/"');
    expect(rbyLadderHtml).toContain('href="/arena/ladders/sv/"');
    expect(rbyLadderHtml).toContain('href="/arena/ladders/rand/"');
    expect(rbyLadderHtml).toContain('href="/arena/ladders/vgc/"');
    expect(rbyLadderHtml).toMatch(/<section[^>]*id="history"[^>]*class="hide"/);
    expect(rbyLadderHtml).toMatch(/<section[^>]*id="matchups"[^>]*class="hide"/);

    const standingsJson = JSON.parse(
      fs.readFileSync(path.join(tmpPublic, 'arena', 'index.json'), 'utf8')
    ) as StandingsJsonDocument;
    expect(standingsJson.updated_at).toBe(NOW);
    expect(Object.keys(standingsJson.ladders)).toEqual(['rby', 'adv', 'sv', 'rand', 'vgc']);
    expect(standingsJson.ladders.rby.standings).toEqual([]);

    const battlesHtml = fs.readFileSync(
      path.join(tmpPublic, 'arena', 'battles', 'index.html'),
      'utf8'
    );
    expect(battlesHtml).toContain('No battle currently running — Arena is idle.');
    expect(battlesHtml).toContain('No completed battles yet.');
  });

  it('renders /arena hub #1 summary rows, /arena/ladders/:name, /projects/:bot & Battles', () => {
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

    const avatarsDir = path.join(tmpDir, 'avatars');
    fs.mkdirSync(avatarsDir, {recursive: true});
    const png1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk' +
      '+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    fs.writeFileSync(path.join(avatarsDir, 'metamon.png'), png1x1);
    db.syncProjectsFromYaml(TEST_PROJECTS_YAML, avatarsDir, DAY_3 + 800);

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

    renderArenaPages({
      db,
      publicDir: tmpPublic,
      avatarsDir,
      liveDoc,
      recentMatchesLimit: 25,
      now: NOW,
    });

    // 1. Verify /arena hub (#1 rows for RBY=Jaxcalibur & ADV=Metamon) and /arena/ladders/rby/
    const arenaHubHtml = fs.readFileSync(path.join(tmpPublic, 'arena', 'index.html'), 'utf8');
    expect(arenaHubHtml).toContain('href="/arena/ladders/rby/"');
    expect(arenaHubHtml).toContain('href="/arena/ladders/adv/"');
    expect(arenaHubHtml).toContain('href="/projects/jaxcalibur/"');
    expect(arenaHubHtml).toContain('href="/projects/metamon/"');

    const lbHtml = fs.readFileSync(
      path.join(tmpPublic, 'arena', 'ladders', 'rby', 'index.html'),
      'utf8'
    );
    const standings = JSON.parse(
      fs.readFileSync(path.join(tmpPublic, 'arena', 'index.json'), 'utf8')
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

    // Link resolution: Arena bots link to /projects/<slug>/ profile pages!
    expect(lbHtml).toContain('href="/projects/jaxcalibur/"');
    expect(lbHtml).toContain('href="/projects/metamon/"');

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

    // 2. Verify Projects HTML: Arena nav filter, data-slug, /projects/<slug>/ & /arena/ladders/
    const projHtml = fs.readFileSync(path.join(tmpPublic, 'projects', 'index.html'), 'utf8');
    expect(projHtml).toContain('main{width:100%}');
    expect(projHtml).toContain('id="arena"');
    expect(projHtml).toContain('data-arena="true"');
    expect(projHtml).toContain('data-slug="foul-play"');
    expect(projHtml).toContain('href="/projects/metamon/"');
    expect(projHtml).toContain('href="/arena/ladders/rby/"');
    expect(projHtml).toContain('href="/arena/ladders/adv/"');
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
    const batHtml = fs.readFileSync(
      path.join(tmpPublic, 'arena', 'battles', 'index.html'),
      'utf8'
    );
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

    // 4. Verify Bot Profile pages (/projects/metamon/index.html & logo copy)
    expect(fs.existsSync(path.join(tmpPublic, 'projects', 'metamon.png'))).toBe(true);
    const metaProfileHtml = fs.readFileSync(
      path.join(tmpPublic, 'projects', 'metamon', 'index.html'),
      'utf8'
    );
    expect(metaProfileHtml).toContain('src="/projects/metamon.png"');
    expect(metaProfileHtml).toContain('UT-Austin-RPL/metamon');
    expect(metaProfileHtml).toContain('id="ver-select"');
    expect(metaProfileHtml).toContain('1.2.0 (active)');
    expect(metaProfileHtml).toContain('1.0.0 (active)');
    expect(metaProfileHtml).toContain('viewBox="0 0 760 220"');
    expect(metaProfileHtml).toContain('class="h2h-table"');
    expect(metaProfileHtml).toContain('Top 10');

    // Registered Pending Arena project (Technical Machine) also gets /projects/technical-machine/
    expect(projHtml).toContain('href="/projects/technical-machine/"');
    const tmProfileHtml = fs.readFileSync(
      path.join(tmpPublic, 'projects', 'technical-machine', 'index.html'),
      'utf8'
    );
    expect(tmProfileHtml).toContain('davidstone/technical-machine');
    expect(tmProfileHtml).toContain('No Arena ladder entries yet.');

    // 5. Run hyperlink --check-anchors across the entire populated tmpPublic directory!
    const hyperlinkBin = root('node_modules', '.bin', 'hyperlink');
    const hlOut = execFileSync(hyperlinkBin, [tmpPublic, '--check-anchors'], {
      encoding: 'utf8',
    });
    expect(hlOut).toContain('Found 0 bad links');
    expect(hlOut).toContain('Found 0 bad anchors');

    // Disabling/removing a project from projects.yml prunes its /projects/<slug>/ directory & logo
    const withoutAthena = TEST_PROJECTS_YAML.replace(/- name: Athena[\s\S]*?40001\n/, '');
    db.syncProjectsFromYaml(withoutAthena, avatarsDir, NOW + 5);
    renderArenaPages({db, publicDir: tmpPublic, avatarsDir, now: NOW + 10});
    expect(fs.existsSync(path.join(tmpPublic, 'projects', 'athena'))).toBe(false);
    expect(fs.existsSync(path.join(tmpPublic, 'projects', 'index.html'))).toBe(true);
  });

  it('renders /arena/tournaments/:num pages and /arena ongoing + historical summaries', () => {
    db.setLadderStatus('gen9ou20261109', 'active', DAY_1);
    const vMeta = createVersionAndPassSmoke(db, 'metamon', '1.3.0', ['gen9ou20261109'], DAY_1);
    const vFoul = createVersionAndPassSmoke(db, 'foul-play', '1.4.0', ['gen9ou20261109'], DAY_1);
    const vJax = createVersionAndPassSmoke(db, 'jaxcalibur', '2.1.0', ['gen9ou20261109'], DAY_1);

    const botMeta = db.getBotBySlug('metamon')!;
    const botFoul = db.getBotBySlug('foul-play')!;
    const botJax = db.getBotBySlug('jaxcalibur')!;

    db.upsertTournament({
      id: '2',
      name: 'Autumn ’26 — [Gen 9] OU (BYOT)',
      format_id: 'gen9ou',
      games_per_matchup: 50,
      parallel_tables: 4,
      hardware_desc: 'Isolated GCP g2-custom-24-49152 VMs (1× NVIDIA L4 24GB)',
      status: 'running',
      starts_at: DAY_2,
    });
    db.upsertTournament({
      id: '1',
      name: 'Spring ’26 — [Gen 1] OU',
      format_id: 'gen1ou',
      games_per_matchup: 50,
      parallel_tables: 2,
      hardware_desc: 'Isolated GCP c3-standard-22 VMs',
      status: 'completed',
      starts_at: DAY_1,
      completed_at: DAY_1 + 86400,
    });

    db.upsertTournamentEntrant({
      tournament_id: '1',
      bot_id: botJax.id,
      version_id: vJax,
      seed_number: 1,
      points: 72.0,
      sb_score: 2400,
      game_wins: 70,
      game_losses: 26,
      game_ties: 4,
      tourney_elo: 1740,
      tourney_se: 15,
      final_rank: 1,
    });
    db.upsertTournamentEntrant({
      tournament_id: '1',
      bot_id: botMeta.id,
      version_id: vMeta,
      seed_number: 2,
      points: 55.0,
      sb_score: 1800,
      game_wins: 54,
      game_losses: 44,
      game_ties: 2,
      tourney_elo: 1650,
      tourney_se: 15,
      final_rank: 2,
    });

    db.upsertTournamentEntrant({
      tournament_id: '2',
      bot_id: botMeta.id,
      version_id: vMeta,
      seed_number: 1,
      points: 65.5,
      sb_score: 2150,
      game_wins: 64,
      game_losses: 33,
      game_ties: 3,
      tourney_elo: 1710,
      tourney_se: 16,
      final_rank: 1,
    });
    db.upsertTournamentEntrant({
      tournament_id: '2',
      bot_id: botFoul.id,
      version_id: vFoul,
      seed_number: 2,
      points: 54.0,
      sb_score: 1820,
      game_wins: 52,
      game_losses: 44,
      game_ties: 4,
      tourney_elo: 1645,
      tourney_se: 16,
      final_rank: 2,
    });
    db.upsertTournamentEntrant({
      tournament_id: '2',
      bot_id: botJax.id,
      version_id: vJax,
      seed_number: 3,
      points: 30.5,
      sb_score: 980,
      game_wins: 30,
      game_losses: 69,
      game_ties: 1,
      tourney_elo: 1490,
      tourney_se: 18,
      final_rank: 3,
    });

    const teamA = [
      '|Dragapult|Choice Specs',
      '|Great Tusk|Booster Energy',
      '|Gholdengo|Air Balloon',
      '|Kingambit|Leftovers',
      '|Glimmora|Focus Sash',
      '|Ogerpon-Wellspring|Wellspring Mask',
    ].join(']');
    const teamB = [
      '|Ting-Lu|Leftovers',
      '|Zamazenta|Heavy-Duty Boots',
      '|Slowking-Galar|Heavy-Duty Boots',
      '|Raging Bolt|Booster Energy',
      '|Darkrai|Focus Sash',
      '|Corviknight|Rocky Helmet',
    ].join(']');

    db.upsertTournamentGame({
      id: 'gen9ou-0000000101',
      tournament_id: '2',
      stage: 'rr',
      macro_cycle: 1,
      h2h_game_num: 1,
      p1_version_id: vMeta,
      p2_version_id: vFoul,
      seed: '1,2,3,101',
      status: 'completed',
      p1_team_packed: teamA,
      p2_team_packed: teamB,
      outcome: 'W',
      turns: 34,
      end_reason: 'normal',
      p1_bank_left_s: 145,
      p2_bank_left_s: 112,
      completed_at: DAY_3,
    });
    db.upsertTournamentGame({
      id: 'gen9ou-0000000102',
      tournament_id: '2',
      stage: 'rr',
      macro_cycle: 2,
      h2h_game_num: 1,
      p1_version_id: vMeta,
      p2_version_id: vJax,
      seed: '1,2,3,102',
      status: 'completed',
      p1_team_packed: teamA,
      p2_team_packed: '|Pikachu|Light Ball',
      outcome: 'T',
      turns: 100,
      end_reason: 'tie_100_turns',
      p1_bank_left_s: 90,
      p2_bank_left_s: 80,
      completed_at: DAY_3 + 60,
    });
    db.upsertTournamentGame({
      id: 'gen9ou-0000000201',
      tournament_id: '2',
      stage: 'sf',
      macro_cycle: 1,
      h2h_game_num: 63,
      p1_version_id: vFoul,
      p2_version_id: vMeta,
      seed: '1,2,3,201',
      status: 'completed',
      p1_team_packed: teamB,
      p2_team_packed: teamA,
      outcome: 'L',
      turns: 29,
      end_reason: 'normal',
      p1_bank_left_s: 115,
      p2_bank_left_s: 150,
      completed_at: DAY_3 + 120,
    });

    const broadcast: TournamentLiveBroadcast = {
      tournamentId: '2',
      tables: [
        {label: 'Table 1 (Superfinal)'},
        {label: 'Table 2', idle: true},
      ],
      seriesLeftHtml: '<strong>Superfinal</strong> · Game 64 / 100',
      seriesRightHtml:
        '<strong>Metamon</strong> <strong>35.5</strong> — <strong>27.5</strong> ' +
        '<strong>Foul Play</strong> <span class="muted">(+65 Elo)</span>',
      p1: {
        name: 'Metamon',
        bankSeconds: 145,
        thinking: false,
        incrementSeconds: 10,
      },
      p2: {
        name: 'Foul Play',
        bankSeconds: 112,
        thinking: true,
        incrementSeconds: 10,
      },
      lines: [
        '|gametype|singles',
        '|player|p1|Metamon|1',
        '|player|p2|Foul Play|2',
        '|gen|9',
        '|tier|[Gen 9] OU',
        '|start',
        '|switch|p1a: Kingambit|Kingambit, M|100/100',
        '|switch|p2a: Zamazenta|Zamazenta|100/100',
        '|turn|22',
      ],
    };

    renderArenaPages({
      db,
      publicDir: tmpPublic,
      tournamentBroadcast: broadcast,
      now: NOW,
    });

    // Verify /arena/viewer/index.html exists and hides .trainersprite
    const viewerHtml = fs.readFileSync(
      path.join(tmpPublic, 'arena', 'viewer', 'index.html'),
      'utf8'
    );
    expect(viewerHtml).toContain('.trainersprite');
    expect(viewerHtml).toContain('play.pokemonshowdown.com');

    // Verify /arena hub lists BOTH ongoing tournament #2 AND past tournament #1 winner + record
    const arenaHubHtml = fs.readFileSync(path.join(tmpPublic, 'arena', 'index.html'), 'utf8');
    expect(arenaHubHtml).toContain('href="/arena/tournaments/2/"');
    expect(arenaHubHtml).toContain('href="/arena/tournaments/1/"');
    expect(arenaHubHtml).toContain('Live');
    expect(arenaHubHtml).toContain('70–26–4');
    expect(arenaHubHtml).toContain('href="/projects/jaxcalibur/"');

    const tourney2Html = fs.readFileSync(
      path.join(tmpPublic, 'arena', 'tournaments', '2', 'index.html'),
      'utf8'
    );
    const tourney1Html = fs.readFileSync(
      path.join(tmpPublic, 'arena', 'tournaments', '1', 'index.html'),
      'utf8'
    );
    expect(tourney2Html).toContain('id="event-select"');
    expect(tourney2Html).toContain('value="/arena/tournaments/2/"');
    expect(tourney2Html).toContain('value="/arena/tournaments/1/"');
    expect(tourney1Html).toContain('Spring ’26 — [Gen 1] OU');
    expect(tourney1Html).toMatch(/<section[^>]*id="live"[^>]*class="hide"/);

    // Clocks sit above the sandboxed /arena/viewer/ iframe on live tournament #2
    expect(tourney2Html).toContain('class="clock-bar"');
    expect(tourney2Html).toContain('02:25');
    expect(tourney2Html).toContain('01:52');
    expect(tourney2Html).toContain('thinking…');
    expect(tourney2Html).toContain('src="/arena/viewer/"');
    expect(tourney2Html).toContain('sandbox="allow-scripts"');

    // Standings, Crosstable, Games shorthand & Smogon party minisprites
    expect(tourney2Html).toContain('<span class="muted">SF</span>');
    expect(tourney2Html).toContain('<code>SF63</code>');
    expect(tourney2Html).toContain('<code>RR1</code>');
    expect(tourney2Html).toContain('½–½');
    expect(tourney2Html).toContain('https://www.smogon.com/forums/media/minisprites/dragapult.png');
    expect(tourney2Html).toContain('https://www.smogon.com/forums/media/minisprites/pikachu.png');
    expect(tourney2Html).toContain('href="/arena/tournaments/2/index.json"');
    const tourney2Json = JSON.parse(
      fs.readFileSync(path.join(tmpPublic, 'arena', 'tournaments', '2', 'index.json'), 'utf8')
    ) as {id: string; standings: Array<{bot_slug: string}>};
    expect(tourney2Json.id).toBe('2');
    expect(tourney2Json.standings[0].bot_slug).toBe('metamon');

    // Verify 0 broken links or anchors across the entire tmpPublic site!
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

      const batHtml = fs.readFileSync(
        path.join(tmpPublic, 'arena', 'battles', 'index.html'),
        'utf8'
      );
      expect(batHtml).toContain('gen1ou-0000000abc');

      const standings = JSON.parse(
        fs.readFileSync(path.join(tmpPublic, 'arena', 'index.json'), 'utf8')
      ) as StandingsJsonDocument;
      expect(standings.ladders.rby.standings.length).toBe(2);

      // Also verify `pkmn set-anchor` updates public/arena/index.json immediately
      const logs: string[] = [];
      await runPkmnCli(['set-anchor', 'gen1ou20261109', 'foul-play', '1.4.0'], {
        db,
        publicDir: tmpPublic,
        now: NOW + 10,
        log: line => logs.push(line),
      });
      const updatedStandings = JSON.parse(
        fs.readFileSync(path.join(tmpPublic, 'arena', 'index.json'), 'utf8')
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
