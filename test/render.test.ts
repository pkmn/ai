import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import polka from 'polka';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {Database} from '../db';
import * as arena from '../server/arena';
import * as ratings from '../server/ratings';
import * as render from '../server/render';
import * as tournaments from '../server/tournaments';
import {root} from '../static/util';
import {runPkmnCli} from '../tools/pkmn';

const NOW = 1_762_800_000;
const DAY_1 = 1_761_800_000; // 10+ days before DAY_2 to test proportional SVG timestamp spacing
const DAY_2 = 1_762_664_000;
const DAY_3 = 1_762_750_400;
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
  db: Database,
  agentSlug: string,
  version: string,
  ladders: string[],
  createdAt: number
): number {
  const agent = db.getAgentBySlug(agentSlug);
  if (!agent) throw new Error(`Missing agent ${agentSlug}`);
  const dev = db.getDevelopersForAgent(agent.id)[0];
  if (!dev) throw new Error(`Missing developer for ${agentSlug}`);
  const ver = db.createSubmission({
    agentId: agent.id,
    developerId: dev.id,
    version,
    package: 'bundle',
    url: `https://example.com/${agentSlug}-${version}.tar.zst`,
    sha256: version.padEnd(64, 'a').slice(0, 64),
    ladderIds: ladders,
    now: createdAt,
  });
  db.applySubmissionStatus({
    versionId: ver.id,
    smokeStatus: 'passed',
    unpackedBytes: 20_000_000,
    smokeDurationMillis: 1200,
    smokeTurnMillis: 250,
    smokePeakRam: 512,
    now: createdAt + 5,
  });
  return ver.id;
}

let matchSeq = 0;
function playMatch(
  db: Database,
  ladderId: string,
  p1VersionId: number,
  p2VersionId: number,
  g1: ratings.GameOutcome,
  g2: ratings.GameOutcome,
  completedAt: number
) {
  matchSeq++;
  const hex = matchSeq.toString(16).padStart(10, '0');
  const formatPrefix = ladderId.startsWith('gen3ou') ? 'gen3ou' : 'gen1ou';
  const cat = `${g1}${g2}` as ratings.MatchCategory;
  db.recordCompletedMatch({
    match: {
      id: `${formatPrefix}-${hex}`,
      ladderId,
      p1VersionId,
      p2VersionId,
      seed: `1,2,3,${matchSeq}`,
      game1Outcome: g1,
      game2Outcome: g2,
      category: cat,
      game1Turns: 28,
      game2Turns: 32,
      game1EndReason: 'normal',
      game2EndReason: 'normal',
      p1PeakRam: 1180,
      p2PeakRam: 1420,
      p1Game1BankSeconds: 150,
      p1Game2BankSeconds: 142,
      p2Game1BankSeconds: 148,
      p2Game2BankSeconds: 136,
      p1MeanTurnMillis: 390,
      p2MeanTurnMillis: 480,
      completedAt,
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

describe('Static Arena Views (/arena, ladders, tournaments, /projects/:agent)', () => {
  let tmpDir: string;
  let tmpPublic: string;
  let db: Database;

  beforeEach(() => {
    matchSeq = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-render-test-'));
    tmpPublic = path.join(tmpDir, 'public');
    seedStaticPublicAssets(tmpPublic);
    db = new Database(':memory:', {now: DAY_1});
    db.syncLadders(undefined, DAY_1);
    db.syncProjectsFromYaml(TEST_PROJECTS_YAML, path.join(tmpDir, 'avatars'), DAY_1);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  it('renders clean empty states on /arena, ladders, and 0-entry /projects/:agent', () => {
    render.renderArenaPages({db, publicDir: tmpPublic, now: NOW});

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
    expect(arenaHtml).toContain('<th>Agent</th>');
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
    ) as render.StandingsDocument;
    expect(standingsJson.updatedAt).toBe(NOW);
    expect(Object.keys(standingsJson.ladders)).toEqual(['rby', 'adv', 'sv', 'rand', 'vgc']);
    expect(standingsJson.ladders.rby.standings).toEqual([]);

    const battlesHtml = fs.readFileSync(
      path.join(tmpPublic, 'arena', 'battles', 'index.html'),
      'utf8'
    );
    expect(battlesHtml).toContain('No battle currently running — Arena is idle.');
    expect(battlesHtml).toContain('No completed battles yet.');
  });

  it('renders /arena hub #1 rows, ladders, proportional charts, /projects/:agent & Battles', () => {
    db.setLadderStatus('gen1ou20261109', 'active', DAY_1);
    db.setLadderStatus('gen3ou20261109', 'active', DAY_1);

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

    // Day 1 (10 days before Day 2): settle initial versions
    for (let i = 0; i < 36; i++) {
      const g2: ratings.GameOutcome = i % 4 === 0 ? 'L' : 'W';
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
      const g2: ratings.GameOutcome = i % 6 === 0 ? 'L' : 'W';
      playMatch(db, 'gen1ou20261109', metaV2, foulV1, 'W', g2, DAY_2 + 100 + i * 5);
      playMatch(db, 'gen1ou20261109', metaV2, metaAnchor, 'W', g2, DAY_2 + 300 + i * 5);
      playMatch(db, 'gen3ou20261109', metaV2, foulV1, 'W', g2, DAY_2 + 500 + i * 5);
    }

    // Day 3 (1 day after Day 2): Jaxcalibur 1.1.0 leads RBY
    for (let i = 0; i < 32; i++) {
      const g1: ratings.GameOutcome = i < 2 ? 'L' : 'W';
      const g2: ratings.GameOutcome = i < 2 ? 'L' : (i < 28 && i % 4 === 0 ? 'L' : 'W');
      playMatch(db, 'gen1ou20261109', jaxV2, metaV2, g1, g2, DAY_3 + 100 + i * 5);
      playMatch(db, 'gen1ou20261109', jaxV2, foulV1, 'W', g2, DAY_3 + 300 + i * 5);
    }

    // Athena submits provisional version with only 3 matches (must NOT trigger H2H Best/Nemesis!)
    const athenaV1 = createVersionAndPassSmoke(db, 'athena', '0.9.0', ['gen1ou20261109'], DAY_3);
    for (let i = 0; i < 3; i++) {
      playMatch(db, 'gen1ou20261109', athenaV1, foulV1, 'W', 'W', DAY_3 + 700 + i * 10);
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

    const liveDoc: arena.LiveDocument = {
      updatedAt: NOW - 2,
      stale: false,
      live: {
        heartbeatSeq: 142,
        matchId: 'gen1ou-0000000999',
        ladderId: 'gen1ou20261109',
        slot: 'rby',
        format: 'gen1ou',
        game: 2,
        turn: 27,
        activeSlot: 'p2',
        turnStartedAt: NOW - 3,
        turnBudgetSeconds: 135,
        incrementSeconds: 10,
        game1Summary: {winnerSlot: 'p1', turns: 31},
        p1: {
          slug: 'jaxcalibur',
          name: 'Jaxcalibur',
          version: '1.1.0',
          bankSeconds: 150,
          lastTurnMillis: 380,
          meanTurnMillis: 405,
          ram: 1180,
        },
        p2: {
          slug: 'foul-play',
          name: 'Foul Play',
          version: '1.4.0',
          bankSeconds: 135,
          lastTurnMillis: 520,
          meanTurnMillis: 495,
          ram: 1420,
        },
      },
      recentMatches: db.getRecentMatches(50),
    };

    render.renderArenaPages({
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
    expect(lbHtml).toContain('<th>Agent</th>');
    const standings = JSON.parse(
      fs.readFileSync(path.join(tmpPublic, 'arena', 'index.json'), 'utf8')
    ) as render.StandingsDocument;

    const rbyRows = standings.ladders.rby.standings;
    const rankedRby = rbyRows.filter(r => r.rank !== undefined);
    expect(rankedRby.map(r => r.rank)).toEqual([1, 2, 3]);
    expect(rankedRby.map(r => r.slug)).toEqual(['jaxcalibur', 'metamon', 'foul-play']);
    expect(rankedRby[0].losNext).toBeDefined();
    expect(rankedRby[0].losNext!).toBeGreaterThan(90);
    expect(rankedRby[1].losNext).toBeDefined();
    expect(rankedRby[2].losNext).toBeUndefined();

    // Anchor has ±0 CI and secondary active status
    const anchorRow = rbyRows.find(r => r.slug === 'metamon' && r.version === '1.0.0');
    expect(anchorRow).toBeDefined();
    expect(anchorRow!.isAnchor).toBe(true);
    expect(anchorRow!.elo).toBe(1500);
    expect(anchorRow!.ci95).toBe(0);
    expect(anchorRow!.rank).toBeUndefined();
    expect(lbHtml).toContain('±0');

    // Provisional Athena row & Retired Jaxcalibur 1.0.0 row
    const athenaRow = rbyRows.find(r => r.slug === 'athena');
    expect(athenaRow?.provisional).toBe(true);
    expect(athenaRow?.rank).toBeUndefined();
    expect(athenaRow?.streak).toBe('W3');
    expect(lbHtml).toContain('class="provisional"');

    const retiredRow = rbyRows.find(r => r.slug === 'jaxcalibur' && r.version === '1.0.0');
    expect(retiredRow?.role).toBe('retired');
    expect(lbHtml).toContain('(retired)');
    expect(lbHtml).toContain('data-retired="true"');

    // Link resolution & Win/Loss streak semantic badges
    expect(lbHtml).toContain('href="/projects/jaxcalibur/"');
    expect(lbHtml).toContain('href="/projects/metamon/"');
    expect(lbHtml).toMatch(/<span class="yes">W\d+<\/span>/);
    expect(lbHtml).toMatch(/<span class="no">L\d+<\/span>/);

    // History SVG: proportional UTC day spacing (10-day gap >> 1-day gap on Foul Play polyline)
    expect(lbHtml).toContain('viewBox="0 0 760 245"');
    expect(lbHtml).toContain('var(--hl-symbol)');
    expect(lbHtml).toContain('<polygon ');
    expect(lbHtml).toContain('title="1.1.0"');
    const polyMatch = /<polyline[^>]*points="([^"]+)"/.exec(lbHtml);
    expect(polyMatch).not.toBeNull();
    const xs = polyMatch![1].trim().split(/\s+/).map(pt => Number(pt.split(',')[0]));
    if (xs.length >= 3) {
      expect(xs[1] - xs[0]).toBeGreaterThan((xs[2] - xs[1]) * 5);
    }

    // Matchup matrix
    const matrixHeadMatch =
      /<table class="matrix">\s*<thead>\s*<tr>([\s\S]*?)<\/tr>\s*<\/thead>/.exec(lbHtml);
    expect(matrixHeadMatch).not.toBeNull();
    const thCount = (matrixHeadMatch![1].match(/<th\b/g) ?? []).length;
    expect(thCount).toBe(4);
    expect(lbHtml).toContain('<td class="diag">—</td>');
    expect(lbHtml).toContain('hm-w4');
    expect(lbHtml).toContain('hm-l4');

    // 2. Verify Projects HTML
    const projHtml = fs.readFileSync(path.join(tmpPublic, 'projects', 'index.html'), 'utf8');
    expect(projHtml).toContain('main{width:100%}');
    expect(projHtml).toContain('id="arena"');
    expect(projHtml).toContain('data-arena="true"');
    expect(projHtml).toContain('data-slug="foul-play"');
    expect(projHtml).toContain('href="/projects/metamon/"');
    expect(projHtml).toContain('href="/arena/ladders/rby/"');
    expect(projHtml).toContain('href="/arena/ladders/adv/"');
    expect(projHtml).toContain('<em>(provisional)</em>');

    const posMetamon = projHtml.indexOf('id="Metamon"');
    const posFoulPlay = projHtml.indexOf('id="FoulPlay"');
    const posEevenator = projHtml.indexOf('id="eevenator"');
    const posAthena = projHtml.indexOf('id="Athena"');
    const posAbra = projHtml.indexOf('id="IHTFPAbra"');
    expect(posMetamon).toBeGreaterThan(0);
    expect(posMetamon).toBeLessThan(posEevenator);
    expect(posFoulPlay).toBeLessThan(posEevenator);
    expect(posAbra).toBeLessThan(posAthena);

    // 3. Verify Battles HTML
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

    // 4. Verify Agent Profile pages (/projects/metamon/index.html, .project-logo, H2H sample gate)
    expect(fs.existsSync(path.join(tmpPublic, 'projects', 'metamon.png'))).toBe(true);
    const metaProfileHtml = fs.readFileSync(
      path.join(tmpPublic, 'projects', 'metamon', 'index.html'),
      'utf8'
    );
    expect(metaProfileHtml).toContain('id="agent-profile"');
    expect(metaProfileHtml).toContain('class="project-logo"');
    expect(metaProfileHtml).toContain('src="/projects/metamon.png"');
    expect(metaProfileHtml).toContain('UT-Austin-RPL/metamon');
    expect(metaProfileHtml).toContain('id="ver-select"');
    expect(metaProfileHtml).toContain('1.2.0 (active)');
    expect(metaProfileHtml).toContain('1.0.0 (active)');
    expect(metaProfileHtml).toContain('viewBox="0 0 760 220"');
    expect(metaProfileHtml).toContain('class="h2h-table"');
    expect(metaProfileHtml).toContain('Top 10');

    // Foul Play only played 3 matches vs Athena (< 10 sample gate) -> Athena must NOT be Nemesis
    const foulProfileHtml = fs.readFileSync(
      path.join(tmpPublic, 'projects', 'foul-play', 'index.html'),
      'utf8'
    );
    expect(foulProfileHtml).not.toMatch(/Athena[\s\S]{0,80}Nemesis/);

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

    const withoutAthena = TEST_PROJECTS_YAML.replace(/- name: Athena[\s\S]*?40001\n/, '');
    db.syncProjectsFromYaml(withoutAthena, avatarsDir, NOW + 5);
    render.renderArenaPages({db, publicDir: tmpPublic, avatarsDir, now: NOW + 10});
    expect(fs.existsSync(path.join(tmpPublic, 'projects', 'athena'))).toBe(false);
    expect(fs.existsSync(path.join(tmpPublic, 'projects', 'index.html'))).toBe(true);
  });

  it('renders /arena/tournaments/:num pages and /arena ongoing + historical summaries', () => {
    db.setLadderStatus('gen9ou20261109', 'active', DAY_1);
    const vMeta = createVersionAndPassSmoke(db, 'metamon', '1.3.0', ['gen9ou20261109'], DAY_1);
    const vFoul = createVersionAndPassSmoke(db, 'foul-play', '1.4.0', ['gen9ou20261109'], DAY_1);
    const vJax = createVersionAndPassSmoke(db, 'jaxcalibur', '2.1.0', ['gen9ou20261109'], DAY_1);

    const agentMeta = db.getAgentBySlug('metamon')!;
    const agentFoul = db.getAgentBySlug('foul-play')!;
    const agentJax = db.getAgentBySlug('jaxcalibur')!;

    db.upsertTournament({
      id: '2',
      name: 'Autumn ’26 — [Gen 9] OU (BYOT)',
      format: 'gen9ou',
      gamesPerMatchup: 50,
      parallelTables: 4,
      hardware: 'Isolated GCP g2-custom-24-49152 VMs (1× NVIDIA L4 24GB)',
      status: 'running',
      startsAt: DAY_2,
    });
    db.upsertTournament({
      id: '1',
      name: 'Spring ’26 — [Gen 1] OU',
      format: 'gen1ou',
      gamesPerMatchup: 50,
      parallelTables: 2,
      hardware: 'Isolated GCP c3-standard-22 VMs',
      status: 'completed',
      startsAt: DAY_1,
      completedAt: DAY_1 + 86400,
    });

    db.upsertTournamentEntrant({
      tournamentId: '1',
      agentId: agentJax.id,
      versionId: vJax,
      seed: 1,
      points: 72.0,
      sonnebornBerger: 2400,
      gameWins: 70,
      gameLosses: 26,
      gameTies: 4,
      elo: 1740,
      se: 15,
      finalRank: 1,
    });
    db.upsertTournamentEntrant({
      tournamentId: '1',
      agentId: agentMeta.id,
      versionId: vMeta,
      seed: 2,
      points: 55.0,
      sonnebornBerger: 1800,
      gameWins: 54,
      gameLosses: 44,
      gameTies: 2,
      elo: 1650,
      se: 15,
      finalRank: 2,
    });

    db.upsertTournamentEntrant({
      tournamentId: '2',
      agentId: agentMeta.id,
      versionId: vMeta,
      seed: 1,
      points: 65.5,
      sonnebornBerger: 2150,
      gameWins: 64,
      gameLosses: 33,
      gameTies: 3,
      elo: 1710,
      se: 16,
      finalRank: 1,
    });
    db.upsertTournamentEntrant({
      tournamentId: '2',
      agentId: agentFoul.id,
      versionId: vFoul,
      seed: 2,
      points: 54.0,
      sonnebornBerger: 1820,
      gameWins: 52,
      gameLosses: 44,
      gameTies: 4,
      elo: 1645,
      se: 16,
      finalRank: 2,
    });
    db.upsertTournamentEntrant({
      tournamentId: '2',
      agentId: agentJax.id,
      versionId: vJax,
      seed: 3,
      points: 30.5,
      sonnebornBerger: 980,
      gameWins: 30,
      gameLosses: 69,
      gameTies: 1,
      elo: 1490,
      se: 18,
      finalRank: 3,
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
      tournamentId: '2',
      stage: 'Round Robin',
      cycle: 1,
      matchupGame: 1,
      p1VersionId: vMeta,
      p2VersionId: vFoul,
      seed: '1,2,3,101',
      status: 'completed',
      p1Team: teamA,
      p2Team: teamB,
      outcome: 'W',
      turns: 34,
      endReason: 'normal',
      p1BankSeconds: 145,
      p2BankSeconds: 112,
      completedAt: DAY_3,
    });
    db.upsertTournamentGame({
      id: 'gen9ou-0000000102',
      tournamentId: '2',
      stage: 'Round Robin',
      cycle: 2,
      matchupGame: 1,
      p1VersionId: vMeta,
      p2VersionId: vJax,
      seed: '1,2,3,102',
      status: 'completed',
      p1Team: teamA,
      p2Team: '|Pikachu|Light Ball',
      outcome: 'T',
      turns: 100,
      endReason: 'tie_100_turns',
      p1BankSeconds: 90,
      p2BankSeconds: 80,
      completedAt: DAY_3 + 60,
    });
    db.upsertTournamentGame({
      id: 'gen9ou-0000000201',
      tournamentId: '2',
      stage: 'Superfinal',
      cycle: 1,
      matchupGame: 63,
      p1VersionId: vFoul,
      p2VersionId: vMeta,
      seed: '1,2,3,201',
      status: 'completed',
      p1Team: teamB,
      p2Team: teamA,
      outcome: 'L',
      turns: 29,
      endReason: 'normal',
      p1BankSeconds: 115,
      p2BankSeconds: 150,
      completedAt: DAY_3 + 120,
    });

    const broadcast: tournaments.LiveBroadcast = {
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

    render.renderArenaPages({
      db,
      publicDir: tmpPublic,
      tournamentBroadcast: broadcast,
      now: NOW,
    });

    const viewerHtml = fs.readFileSync(
      path.join(tmpPublic, 'arena', 'viewer', 'index.html'),
      'utf8'
    );
    expect(viewerHtml).toContain('.trainersprite');
    expect(viewerHtml).toContain('play.pokemonshowdown.com');

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
    expect(tourney2Html).toContain('<th>Agent</th>');
    expect(tourney2Html).toContain('id="event-select"');
    expect(tourney2Html).toContain('value="/arena/tournaments/2/"');
    expect(tourney2Html).toContain('value="/arena/tournaments/1/"');
    expect(tourney1Html).toContain('Spring ’26 — [Gen 1] OU');
    expect(tourney1Html).toMatch(/<section[^>]*id="live"[^>]*class="hide"/);

    expect(tourney2Html).toContain('class="clock-bar"');
    expect(tourney2Html).toContain('02:25');
    expect(tourney2Html).toContain('01:52');
    expect(tourney2Html).toContain('thinking…');
    expect(tourney2Html).toContain('src="/arena/viewer/"');
    expect(tourney2Html).toContain('sandbox="allow-scripts"');

    expect(tourney2Html).toContain('<span class="muted">SF</span>');
    expect(tourney2Html).toContain('<code>SF63</code>');
    expect(tourney2Html).toContain('<code>RR1</code>');
    expect(tourney2Html).toContain('½–½');
    expect(tourney2Html).toContain('https://www.smogon.com/forums/media/minisprites/dragapult.png');
    expect(tourney2Html).toContain('https://www.smogon.com/forums/media/minisprites/pikachu.png');
    expect(tourney2Html).toContain('href="/arena/tournaments/2/index.json"');
    const tourney2Json = JSON.parse(
      fs.readFileSync(path.join(tmpPublic, 'arena', 'tournaments', '2', 'index.json'), 'utf8')
    ) as {id: string; standings: Array<{slug: string; sonnebornBerger: number}>};
    expect(tourney2Json.id).toBe('2');
    expect(tourney2Json.standings[0].slug).toBe('metamon');
    expect(tourney2Json.standings[0].sonnebornBerger).toBe(2150);

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
        render.renderArenaPages({db, publicDir: tmpPublic, now: NOW});
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
            ladderId: 'gen1ou20261109',
            p1VersionId: v1,
            p2VersionId: v2,
            seed: '1,2,3,4',
            game1Outcome: 'W',
            game2Outcome: 'W',
            category: 'WW',
            game1Turns: 25,
            game2Turns: 30,
            game1EndReason: 'normal',
            game2EndReason: 'normal',
            p1PeakRam: 900,
            p2PeakRam: 1100,
            p1Game1BankSeconds: 150,
            p1Game2BankSeconds: 150,
            p2Game1BankSeconds: 140,
            p2Game2BankSeconds: 135,
            p1MeanTurnMillis: 300,
            p2MeanTurnMillis: 420,
            completedAt: NOW,
          },
        }),
      });
      expect(res.status).toBe(200);

      await new Promise(resolve => setTimeout(resolve, 25));

      const batHtml = fs.readFileSync(
        path.join(tmpPublic, 'arena', 'battles', 'index.html'),
        'utf8'
      );
      expect(batHtml).toContain('gen1ou-0000000abc');

      const standings = JSON.parse(
        fs.readFileSync(path.join(tmpPublic, 'arena', 'index.json'), 'utf8')
      ) as render.StandingsDocument;
      expect(standings.ladders.rby.standings.length).toBe(2);

      const logs: string[] = [];
      await runPkmnCli(['set-anchor', 'gen1ou20261109', 'foul-play', '1.4.0'], {
        db,
        publicDir: tmpPublic,
        now: NOW + 10,
        log: line => logs.push(line),
      });
      const updatedStandings = JSON.parse(
        fs.readFileSync(path.join(tmpPublic, 'arena', 'index.json'), 'utf8')
      ) as render.StandingsDocument;
      const foulAnchor = updatedStandings.ladders.rby.standings.find(
        s => s.slug === 'foul-play'
      );
      expect(foulAnchor?.isAnchor).toBe(true);
      expect(foulAnchor?.elo).toBe(1500);
      expect(foulAnchor?.ci95).toBe(0);
    } finally {
      handle.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
