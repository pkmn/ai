// Visual regression, edge-case coverage & interactive gallery
// (`npm run shots [-- --only <q[,q...]>] [-- --list]`).
//
// Renders every static page, dynamic route, interactive state, and error/edge case across 4
// viewports (`small`, `phone`, `tablet`, `desktop`) and both color schemes (`light`, `dark`) into
// `.shots/<viewport>/<theme>/<scenario>.png`, asserting zero runtime console/page errors and zero
// horizontal overflow on every combination, and writes a self-contained interactive visual gallery
// to `.shots/index.html`.

import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as http from 'http';
import {DatabaseSync} from 'node:sqlite';
import * as os from 'os';
import * as path from 'path';
import {parseArgs, promisify} from 'util';
import * as zlib from 'zlib';

import {Browser, BrowserContext, Page, Request, Route, chromium} from 'playwright-core';
import polka from 'polka';

import {Database} from '../db';
import * as account from '../server/account';
import * as admin from '../server/admin';
import * as arena from '../server/arena';
import * as auth from '../server/auth';
import * as render from '../server/render';
import type * as system from '../server/system';
import * as teams from '../server/teams';
import * as tournaments from '../server/tournaments';
import * as wiki from '../server/wiki';
import {syncStaticLiveBanner} from '../static/build';
import {ROOT, isConnectivityError, raw as rawHtml, root, writeFileAtomic} from '../static/util';

import * as mock from './mock';

const PUBLIC = root('public');
const SHOTS_DIR = root('.shots');
export const BASELINE_DIR = path.join(SHOTS_DIR, 'baseline');
export const DIFF_DIR = path.join(SHOTS_DIR, 'diff');
export const CACHE_DIR = path.join(SHOTS_DIR, 'cache');
export const GALLERY_FILE = path.join(SHOTS_DIR, 'index.html');
export const REGIONS_FILE = path.join(SHOTS_DIR, 'regions.json');
export const BASELINE_REGIONS_FILE = path.join(BASELINE_DIR, 'regions.json');
export const VIEWER_CHANNEL_DELTA = 16;
export const VIEWER_MAX_DIFF_RATIO = 0.25;
const SHOTS_CSS = fs.readFileSync(root('tools', 'shots.css'), 'utf8');

const NOW = Date.parse('2026-10-20T12:00:00Z');
const NOW_SECONDS = Math.floor(NOW / 1000);
const VGC_LADDER_ID = 'gen9championsvgc2026regmc';
const RBY_LADDER_ID = 'gen1ou20261109';
const SV_LADDER_ID = 'gen9ou20261109';
const VIEWPORTS = {
  small: {width: 375, height: 667}, // iPhone SE (3rd generation)
  phone: {width: 390, height: 844}, // iPhone 14
  tablet: {width: 744, height: 1133}, // iPad mini (6th generation, portrait)
  desktop: {width: 1280, height: 900},
};
type ViewportId = keyof typeof VIEWPORTS;
const VIEWPORT_ORDER: readonly ViewportId[] = ['desktop', 'tablet', 'phone', 'small'];
const THEMES = ['light', 'dark'] as const;
const NETWORK_QUIET_MILLIS = 25;
const VIEWER_SETTLE_MILLIS = 50;
const deflateAsync = promisify(zlib.deflate);
const inflateAsync = promisify(zlib.inflate);

export type SectionId =
  'static' | 'projects' | 'ladders' | 'battles' | 'tournaments' | 'account' | 'wiki';

export interface SectionMeta {
  id: SectionId;
  title: string;
}

export const SECTIONS: readonly SectionMeta[] = [
  {id: 'static', title: 'Static'},
  {id: 'projects', title: 'Projects'},
  {id: 'ladders', title: 'Ladders'},
  {id: 'battles', title: 'Battles'},
  {id: 'tournaments', title: 'Tournaments'},
  {id: 'account', title: 'Account'},
  {id: 'wiki', title: 'Wiki'},
];

export interface Scenario {
  name: string;
  section: SectionId;
  title: string;
  path: string;
  click?: string;
  githubUser?: string;
  serial?: boolean;
  offline?: boolean;
  expectHttpError?: number;
  setup?: (fixture: Fixture) => Promise<(() => Promise<void> | void) | void> |
    (() => Promise<void> | void) | void;
  beforePage?: (fixture: Fixture) => Promise<void> | void;
  act?: (page: Page, fixture: Fixture) => Promise<void>;
}

const SHOTS_AUTH: auth.Config = {
  sessionSecret: 'shots-session-secret',
  github: {
    clientId: 'shots-client-id',
    clientSecret: 'shots-client-secret',
  },
  discord: {
    clientId: '689315793569447954',
    clientSecret: 'shots-discord-secret',
  },
};

export interface Fixture {
  origin: string;
  db: Database;
  arenaHandle: ReturnType<typeof arena.register>;
  wikiInstance: wiki.Wiki;
  defaultLiveState: {live?: arena.LiveMatch; stale: boolean; updatedAt?: number};
  defaultBroadcast?: tournaments.LiveBroadcast;
  cookies: Record<string, string>;
  sha: string;
  publicDir: string;
  wikiDir: string;
  cynthiaiId: number;
  rawVgcTeams: string[];
  canonicalVgcTeams: string[];
  setShowLiveBanner: (show: boolean) => void;
  close: () => Promise<void>;
}

function withSavepoint(
  fixture: Fixture,
  mutate: (raw: DatabaseSync) => void,
  afterCleanup?: () => void
): () => void {
  const raw = fixture.db.db;
  raw.exec('SAVEPOINT shots_scenario');
  mutate(raw);
  return () => {
    raw.exec(
      'ROLLBACK TO SAVEPOINT shots_scenario; ' +
      'RELEASE SAVEPOINT shots_scenario; ' +
      "INSERT INTO schema_migrations (version, applied_at) VALUES ('_shots', 0) " +
      'ON CONFLICT(version) DO UPDATE SET applied_at = applied_at + 1'
    );
    afterCleanup?.();
  };
}

function setupRotatedSeasons(
  fixture: Fixture,
  mode: 'settling' | 'archived' | 'both'
): () => void {
  const archiveDir = path.join(fixture.publicDir, 'arena', 'ladders', VGC_LADDER_ID);
  const privateDir = path.join(fixture.publicDir, 'arena', 'ladders', '.private', VGC_LADDER_ID);
  const archiveFile = path.join(archiveDir, `${VGC_LADDER_ID}-logs.tar`);
  const writeArchive = mode === 'archived';
  if (writeArchive) {
    arena.promoteArchivedPoolsLogs(fixture.publicDir, VGC_LADDER_ID);
    fs.mkdirSync(archiveDir, {recursive: true});
    fs.writeFileSync(archiveFile, Buffer.from('mock-tar-vgc-logs'));
  }
  return withSavepoint(
    fixture,
    raw => {
      raw.prepare(
        `INSERT INTO ladders (
          id, slot, name, format, version, team, status, min, teams, created_at
        ) VALUES (?, 'vgc', 'VGC', 'gen9championsvgc2026regmd', '0.11.0', 'pools', 'active',
          4, 20, ?)`
      ).run('gen9championsvgc2026regmd', NOW_SECONDS - 600);
      raw.prepare(
        `INSERT INTO ladder_entries (
          ladder_id, version_id, role, is_anchor, retired_at, elo, se, lcb, gxe,
          rank_current, rank_min, rank_max, matches, ww, wt, split, tl, ll,
          current_win_streak, current_loss_streak, max_win_streak, max_loss_streak,
          best_rank, best_rank_at, max_lcb, max_elo, max_elo_se, max_elo_at,
          max_gxe, max_gxe_at, top1_entered_at, top1_max_streak_seconds, top1_total_seconds,
          top10_entered_at, top10_max_streak_seconds, top10_total_seconds,
          top100_entered_at, top100_max_streak_seconds, top100_total_seconds,
          mean_init_millis, mean_team_preview_millis, team_preview_matches,
          mean_turn_millis, mean_ram, peak_ram, settled_at
        )
        SELECT
          'gen9championsvgc2026regmd', version_id, role, is_anchor, retired_at, elo, se, lcb, gxe,
          rank_current, rank_min, rank_max, matches, ww, wt, split, tl, ll,
          current_win_streak, current_loss_streak, max_win_streak, max_loss_streak,
          best_rank, best_rank_at, max_lcb, max_elo, max_elo_se, max_elo_at,
          max_gxe, max_gxe_at, top1_entered_at, top1_max_streak_seconds, top1_total_seconds,
          top10_entered_at, top10_max_streak_seconds, top10_total_seconds,
          top100_entered_at, top100_max_streak_seconds, top100_total_seconds,
          mean_init_millis, mean_team_preview_millis, team_preview_matches,
          mean_turn_millis, mean_ram, peak_ram, settled_at
        FROM ladder_entries
        WHERE ladder_id = ?`
      ).run(VGC_LADDER_ID);

      if (mode === 'both') {
        raw.prepare(
          `INSERT INTO ladders (
            id, slot, name, format, version, team, status, min, teams, created_at, archived_at
          ) VALUES (?, 'vgc', 'VGC (Reg M-B)', 'gen9championsvgc2026regmb', '0.11.0', 'pools',
            'archived', 4, 20, ?, ?)`
        ).run('gen9championsvgc2026regmb', NOW_SECONDS - 86400 * 14, NOW_SECONDS - 86400 * 7);
        raw.prepare(
          `INSERT INTO ladder_entries (
            ladder_id, version_id, role, is_anchor, retired_at, elo, se, lcb, gxe,
            rank_current, rank_min, rank_max, matches, ww, wt, split, tl, ll,
            current_win_streak, current_loss_streak, max_win_streak, max_loss_streak,
            best_rank, best_rank_at, max_lcb, max_elo, max_elo_se, max_elo_at,
            max_gxe, max_gxe_at, top1_entered_at, top1_max_streak_seconds, top1_total_seconds,
            top10_entered_at, top10_max_streak_seconds, top10_total_seconds,
            top100_entered_at, top100_max_streak_seconds, top100_total_seconds,
            mean_init_millis, mean_team_preview_millis, team_preview_matches,
            mean_turn_millis, mean_ram, peak_ram, settled_at
          )
          SELECT
            'gen9championsvgc2026regmb', version_id, 'retired', is_anchor, ?, elo, se, lcb, gxe,
            rank_current, rank_min, rank_max, matches, ww, wt, split, tl, ll,
            current_win_streak, current_loss_streak, max_win_streak, max_loss_streak,
            best_rank, best_rank_at, max_lcb, max_elo, max_elo_se, max_elo_at,
            max_gxe, max_gxe_at, top1_entered_at, top1_max_streak_seconds, top1_total_seconds,
            top10_entered_at, top10_max_streak_seconds, top10_total_seconds,
            top100_entered_at, top100_max_streak_seconds, top100_total_seconds,
            mean_init_millis, mean_team_preview_millis, team_preview_matches,
            mean_turn_millis, mean_ram, peak_ram, settled_at
          FROM ladder_entries
          WHERE ladder_id = ?`
        ).run(NOW_SECONDS - 86400 * 7, VGC_LADDER_ID);
      }

      const targetStatus = mode === 'archived' ? 'archived' : 'settling';
      raw.prepare(
        `UPDATE ladders
         SET name = 'VGC (Reg M-C)', status = ?, archived_at = ?
         WHERE id = ?`
      ).run(targetStatus, NOW_SECONDS - 3600, VGC_LADDER_ID);
      if (mode === 'archived') {
        raw.prepare(
          `UPDATE ladder_entries
           SET role = 'retired', retired_at = ?
           WHERE ladder_id = ? AND role IN ('champion', 'challenger')`
        ).run(NOW_SECONDS - 3600, VGC_LADDER_ID);
      }
    },
    () => {
      if (writeArchive) {
        fs.rmSync(archiveFile, {force: true});
        if (fs.existsSync(archiveDir)) {
          fs.mkdirSync(path.dirname(privateDir), {recursive: true});
          if (!fs.existsSync(privateDir)) {
            fs.renameSync(archiveDir, privateDir);
          } else {
            for (const f of fs.readdirSync(archiveDir)) {
              if (f.endsWith('.log')) {
                fs.renameSync(path.join(archiveDir, f), path.join(privateDir, f));
              }
            }
            fs.rmSync(archiveDir, {recursive: true, force: true});
          }
        }
      }
    }
  );
}

const WIKI_MOCK_IMAGE_URL = 'https://raw.githubusercontent.com/pkmn/ai/main/docs/reg-mc-cores.png';

function buildWikiMockChartPng(): Buffer {
  const width = 320;
  const height = 140;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const border = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      pixels[idx] = border ? 180 : 245;
      pixels[idx + 1] = border ? 188 : 248;
      pixels[idx + 2] = border ? 198 : 252;
      pixels[idx + 3] = 255;
    }
  }
  const bars = [
    {x0: 28, h: 92, rgb: [45, 125, 210]},
    {x0: 94, h: 74, rgb: [56, 161, 105]},
    {x0: 160, h: 58, rgb: [214, 158, 46]},
    {x0: 226, h: 42, rgb: [229, 62, 62]},
  ];
  for (const bar of bars) {
    for (let y = height - 18 - bar.h; y < height - 18; y++) {
      for (let x = bar.x0; x < bar.x0 + 44; x++) {
        const idx = (y * width + x) * 4;
        pixels[idx] = bar.rgb[0];
        pixels[idx + 1] = bar.rgb[1];
        pixels[idx + 2] = bar.rgb[2];
        pixels[idx + 3] = 255;
      }
    }
  }
  return encodePng({width, height, data: pixels});
}

let cachedWikiMockChartPng: Buffer | undefined;
const MOCK_AVATAR_URL = new URL('https://github.com/scheibo.png?size=64');

async function setupDiscordWikiPage(fixture: Fixture): Promise<() => void> {
  await fixture.wikiInstance.savePage(
    'projects/Foul_Play',
    '# Foul Play\n\nShared metagame notes visible to verified `pkmn.ai` Discord server ' +
      'members.\n\n## Seasonal Pool Observations\n\n- Incineroar + Rillaboom cores remain ' +
      `dominant across Reg M-C pools.\n\n![Reg M-C core usage chart](${WIKI_MOCK_IMAGE_URL})`,
    'pmariglia',
    'Add Discord-restricted Foul Play wiki page',
    'discord'
  );
  return () => {
    execFileSync('git', ['reset', '--hard', fixture.sha], {
      cwd: fixture.wikiDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['clean', '-fd'], {
      cwd: fixture.wikiDir,
      stdio: 'ignore',
    });
  };
}

export function buildScenarios(wikiSha: string): Scenario[] {
  return [
    // =========================================================================
    // 1. Static
    // =========================================================================
    {
      name: 'home',
      section: 'static',
      title: 'Home',
      path: '/',
    },
    {
      name: 'home-signed-out',
      section: 'static',
      title: 'Home (Signed Out)',
      path: '/',
      githubUser: 'anonymous',
    },
    {
      name: 'home-theme-light',
      section: 'static',
      title: 'Home (Light Override)',
      path: '/',
      act: async page => {
        for (let i = 0; i < 3; i++) {
          const mode = await page.evaluate(
            () => document.documentElement.getAttribute('data-theme-mode')
          );
          if (mode === 'light') break;
          await page.locator('#theme-toggle').click();
        }
      },
    },
    {
      name: 'home-theme-dark',
      section: 'static',
      title: 'Home (Dark Override)',
      path: '/',
      act: async page => {
        for (let i = 0; i < 3; i++) {
          const mode = await page.evaluate(
            () => document.documentElement.getAttribute('data-theme-mode')
          );
          if (mode === 'dark') break;
          await page.locator('#theme-toggle').click();
        }
      },
    },
    {
      name: 'home-live-banner',
      section: 'static',
      title: 'Home (Live)',
      path: '/',
      setup: fixture => {
        fixture.setShowLiveBanner(true);
        return () => {
          fixture.setShowLiveBanner(false);
        };
      },
    },
    {
      name: 'background',
      section: 'static',
      title: 'Background',
      path: '/background/',
    },
    {
      name: 'concepts',
      section: 'static',
      title: 'Concepts',
      path: '/concepts/',
    },
    {
      name: 'concepts-baselines',
      section: 'static',
      title: 'Baselines',
      path: '/concepts/baselines/',
    },
    {
      name: 'concepts-complexity',
      section: 'static',
      title: 'Complexity',
      path: '/concepts/complexity/',
    },
    {
      name: 'concepts-engines',
      section: 'static',
      title: 'Engines',
      path: '/concepts/engines/',
    },
    {
      name: 'concepts-protocol',
      section: 'static',
      title: 'Protocol',
      path: '/concepts/protocol/',
    },
    {
      name: 'concepts-variants',
      section: 'static',
      title: 'Variants',
      path: '/concepts/variants/',
    },
    {
      name: 'glossary',
      section: 'static',
      title: 'Glossary',
      path: '/glossary/',
    },
    {
      name: 'release',
      section: 'static',
      title: 'Release',
      path: '/release/',
    },
    {
      name: 'research',
      section: 'static',
      title: 'Research',
      path: '/research/',
    },
    {
      name: 'rules',
      section: 'static',
      title: 'Rules',
      path: '/rules/',
    },
    {
      name: 'not-found',
      section: 'static',
      title: '404',
      path: '/nonexistent-page',
      expectHttpError: 404,
    },

    // =========================================================================
    // 2. Projects
    // =========================================================================
    {
      name: 'projects',
      section: 'projects',
      title: 'Directory',
      path: '/projects/',
    },
    {
      name: 'projects-active',
      section: 'projects',
      title: 'Directory (Active)',
      path: '/projects/',
      click: 'label[for="active"]',
    },
    {
      name: 'projects-inactive',
      section: 'projects',
      title: 'Directory (Inactive)',
      path: '/projects/',
      click: 'label[for="inactive"]',
    },
    {
      name: 'project-profile',
      section: 'projects',
      title: 'Profile',
      path: '/projects/0-error/',
    },
    {
      name: 'project-profile-version',
      section: 'projects',
      title: 'Profile (Version)',
      path: '/projects/0-error/',
      act: async page => {
        await page.selectOption('#ver-select', '1.2.0');
        await page.click('#versions tbody tr.battle-row[data-vrow="1.2.0"] td:first-child');
      },
    },
    {
      name: 'project-profile-opponent',
      section: 'projects',
      title: 'Profile (Opponent)',
      path: '/projects/0-error/',
      click: '#matchups tbody tr.opp-row td:first-child',
    },
    {
      name: 'project-profile-match-expanded',
      section: 'projects',
      title: 'Profile (Expanded)',
      path: '/projects/0-error/',
      click: '#matches tbody tr.battle-row td:first-child',
    },
    {
      name: 'project-profile-filter-empty',
      section: 'projects',
      title: 'Profile (No Matches)',
      path: '/projects/0-error/',
      act: async page => {
        await page.selectOption('#opp-select', 'pokerus');
      },
    },
    {
      name: 'project-profile-provisional',
      section: 'projects',
      title: 'Profile (Provisional)',
      path: '/projects/pokerus/',
      click: '#versions tbody tr.battle-row td:first-child',
    },
    {
      name: 'project-profile-qualified-empty',
      section: 'projects',
      title: 'Profile (Qualified)',
      path: '/projects/cynthiai/',
    },
    {
      name: 'project-profile-pending-empty',
      section: 'projects',
      title: 'Profile (Pending)',
      path: '/projects/asterai/',
    },

    // =========================================================================
    // 3. Ladders
    // =========================================================================
    {
      name: 'arena',
      section: 'ladders',
      title: 'Hub',
      path: '/arena/',
    },
    {
      name: 'arena-seasons',
      section: 'ladders',
      title: 'Hub (Seasons)',
      path: '/arena/',
      setup: fixture => setupRotatedSeasons(fixture, 'both'),
      click: 'tr.battle-row[data-slot="vgc"] .battle-toggle',
    },
    {
      name: 'arena-prelaunch',
      section: 'ladders',
      title: 'Hub (Upcoming)',
      path: '/arena/',
      setup: fixture => withSavepoint(fixture, raw => {
        raw.exec("UPDATE ladders SET status = 'upcoming'");
        raw.exec('DELETE FROM ladder_entries');
        raw.exec('DELETE FROM tournament_games');
        raw.exec('DELETE FROM tournament_matches');
        raw.exec('DELETE FROM tournament_entrants');
        raw.exec('DELETE FROM tournaments');
      }),
    },
    {
      name: 'arena-ladder-rby',
      section: 'ladders',
      title: 'RBY',
      path: '/arena/ladders/rby/',
    },
    {
      name: 'arena-ladder-rby-best',
      section: 'ladders',
      title: 'RBY (Best)',
      path: '/arena/ladders/rby/',
      click: 'label[for="ver-best"]',
    },
    {
      name: 'arena-ladder-rby-all',
      section: 'ladders',
      title: 'RBY (All)',
      path: '/arena/ladders/rby/',
      click: 'label[for="ver-all"]',
    },
    {
      name: 'arena-ladder-rby-anchor',
      section: 'ladders',
      title: 'RBY (Anchor + 2 Active)',
      path: '/arena/ladders/rby/',
      setup: fixture => withSavepoint(fixture, raw => {
        const meta = raw.prepare("SELECT id FROM agents WHERE slug = 'metamon'")
          .get() as {id: number};
        const anchorEntry = raw.prepare(`
          SELECT le.rank_current
          FROM ladder_entries le
          JOIN agent_versions av ON av.id = le.version_id
          WHERE le.ladder_id = ? AND av.agent_id = ? AND le.is_anchor = 1
        `).get(RBY_LADDER_ID, meta.id) as {rank_current: number | null};
        const oldRank = anchorEntry?.rank_current ?? 99;
        raw.prepare(`
          UPDATE ladder_entries
          SET rank_current = rank_current + 1
          WHERE ladder_id = ? AND rank_current >= 2 AND rank_current < ?
        `).run(RBY_LADDER_ID, oldRank);
        raw.prepare(`
          UPDATE ladder_entries
          SET role = 'challenger', rank_current = NULL, rank_min = NULL, rank_max = NULL
          WHERE ladder_id = ?
            AND version_id IN (SELECT id FROM agent_versions WHERE agent_id = ?)
            AND is_anchor = 1
        `).run(RBY_LADDER_ID, meta.id);

        const insVer = raw.prepare(`
          INSERT INTO agent_versions (
            agent_id, version, package, url, sha256, ladders_json, tournaments_json,
            smoke_status, submitted_at, activated_at
          ) VALUES (?, ?, 'oci', ?, ?, ?, '[]', 'passed', ?, ?)
        `);
        const insEntry = raw.prepare(`
          INSERT INTO ladder_entries (
            ladder_id, version_id, role, is_anchor, elo, se, lcb, gxe,
            rank_current, matches, ww, wt, split, tl, ll,
            current_win_streak, settled_at, started_at
          ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 32, 20, 0, 6, 0, 6, 2, ?, ?)
        `);
        const v15 = Number(insVer.run(
          meta.id,
          '1.5.0',
          'ghcr.io/ut-austin-rpl/metamon:1.5.0',
          'e'.repeat(64),
          JSON.stringify([RBY_LADDER_ID]),
          NOW_SECONDS - 86400 * 16,
          NOW_SECONDS - 86400 * 16
        ).lastInsertRowid);
        insEntry.run(
          RBY_LADDER_ID, v15, 'challenger', 1615, 22, 1571.9, 68.4, null,
          NOW_SECONDS - 86400 * 10, NOW_SECONDS - 86400 * 16
        );
        const v20 = Number(insVer.run(
          meta.id,
          '2.0.0',
          'ghcr.io/ut-austin-rpl/metamon:2.0.0',
          'f'.repeat(64),
          JSON.stringify([RBY_LADDER_ID]),
          NOW_SECONDS - 86400,
          NOW_SECONDS - 86400
        ).lastInsertRowid);
        insEntry.run(
          RBY_LADDER_ID, v20, 'champion', 1725, 21, 1683.8, 79.6, 2,
          NOW_SECONDS - 3600, NOW_SECONDS - 86400
        );
      }),
    },
    {
      name: 'arena-ladder-vgc',
      section: 'ladders',
      title: 'VGC',
      path: '/arena/ladders/vgc/',
    },
    {
      name: 'arena-ladder-settling',
      section: 'ladders',
      title: 'VGC (Settling)',
      path: `/arena/ladders/${VGC_LADDER_ID}/`,
      setup: fixture => setupRotatedSeasons(fixture, 'settling'),
    },
    {
      name: 'arena-ladder-archived',
      section: 'ladders',
      title: 'VGC (Archived)',
      path: `/arena/ladders/${VGC_LADDER_ID}/`,
      setup: fixture => setupRotatedSeasons(fixture, 'archived'),
    },
    {
      name: 'arena-ladder-rand',
      section: 'ladders',
      title: 'RAND',
      path: '/arena/ladders/rand/',
    },
    {
      name: 'arena-ladder-upcoming',
      section: 'ladders',
      title: 'RBY (Upcoming)',
      path: '/arena/ladders/rby/',
      setup: fixture => withSavepoint(fixture, raw => {
        raw.prepare("UPDATE ladders SET status = 'upcoming' WHERE id = ?").run(RBY_LADDER_ID);
        raw.prepare(
          `DELETE FROM ladder_entries
           WHERE ladder_id = ?
             AND version_id NOT IN (
               SELECT version_id
               FROM ladder_entries
               WHERE ladder_id = ? AND role IN ('champion', 'challenger')
               ORDER BY version_id ASC
               LIMIT 3
             )`
        ).run(RBY_LADDER_ID, RBY_LADDER_ID);
      }),
    },

    // =========================================================================
    // 4. Battles
    // =========================================================================
    {
      name: 'arena-battles',
      section: 'battles',
      title: 'Live',
      path: '/arena/battles/',
    },
    {
      name: 'arena-battles-init-live',
      section: 'battles',
      title: 'Live (Init /ready)',
      path: '/arena/battles/',
      setup: fixture => {
        fixture.arenaHandle.setLiveState({
          stale: false,
          updatedAt: NOW_SECONDS,
          live: {
            heartbeatSeq: 1,
            matchId: 'gen9championsvgc2026regmc-0009999',
            ladderId: 'gen9championsvgc2026regmc',
            slot: 'vgc',
            format: 'gen9championsvgc2026regmc',
            game: 1,
            phase: 'init',
            turn: 0,
            activeSlot: 'p1',
            turnStartedAt: NOW_SECONDS - 12,
            turnBudgetSeconds: 60,
            incrementSeconds: 0,
            p1: {
              slug: 'missingnozero',
              name: 'MissingNo.Zero',
              version: '2.1.0',
              bankSeconds: 420,
              lastTurnMillis: 0,
              meanTurnMillis: 0,
              ram: 640,
            },
            p2: {
              slug: '0-error',
              name: '0 ERROR',
              version: '1.0.0',
              bankSeconds: 420,
              lastTurnMillis: 0,
              meanTurnMillis: 0,
              ram: 64,
            },
          },
        });
        return () => {
          fixture.arenaHandle.setLiveState(fixture.defaultLiveState);
        };
      },
    },
    {
      name: 'arena-battles-vgc-preview',
      section: 'battles',
      title: 'Live (VGC Preview)',
      path: '/arena/battles/',
      setup: fixture => {
        const base = fixture.defaultLiveState.live!;
        const previewHealth = arena.extractBattlePokemonHealth({
          format: base.format,
          p1Pokemon: [
            {ident: 'p1: Incineroar', condition: '200/200'},
            {ident: 'p1: Flutter Mane', condition: '130/130'},
            {ident: 'p1: Rillaboom', condition: '207/207'},
            {ident: 'p1: Urshifu', condition: '175/175'},
            {ident: 'p1: Raging Bolt', condition: '231/231'},
            {ident: 'p1: Amoonguss', condition: '221/221'},
          ],
          p2Pokemon: [
            {ident: 'p2: Calyrex', condition: '175/175'},
            {ident: 'p2: Zamazenta', condition: '199/199'},
            {ident: 'p2: Chien-Pao', condition: '155/155'},
            {ident: 'p2: Ogerpon', condition: '187/187'},
            {ident: 'p2: Tornadus', condition: '186/186'},
            {ident: 'p2: Landorus', condition: '165/165'},
          ],
        });
        fixture.arenaHandle.setLiveState({
          stale: false,
          updatedAt: NOW_SECONDS,
          live: {
            heartbeatSeq: 1,
            matchId: base.matchId,
            ladderId: base.ladderId,
            slot: base.slot,
            format: base.format,
            game: 1,
            phase: 'preview',
            turn: 0,
            activeSlot: 'p1',
            turnStartedAt: NOW_SECONDS - 2,
            turnBudgetSeconds: 90,
            incrementSeconds: base.incrementSeconds,
            p1: {
              ...base.p1,
              bankSeconds: 420,
              lastTurnMillis: 0,
              meanTurnMillis: 0,
              ram: 790,
              cpuCores: 2.1,
              team: base.p2.team,
              pokemon: previewHealth.p1,
            },
            p2: {
              ...base.p2,
              bankSeconds: 420,
              lastTurnMillis: 0,
              meanTurnMillis: 0,
              ram: 1810,
              cpuCores: 3.8,
              team: base.p1.team,
              pokemon: previewHealth.p2,
            },
          },
        });
        return () => {
          fixture.arenaHandle.setLiveState(fixture.defaultLiveState);
        };
      },
    },
    {
      name: 'arena-battles-vgc-g1',
      section: 'battles',
      title: 'Live (VGC Game 1)',
      path: '/arena/battles/',
      setup: fixture => {
        const base = fixture.defaultLiveState.live!;
        fixture.arenaHandle.setLiveState({
          stale: false,
          updatedAt: NOW_SECONDS,
          live: {
            heartbeatSeq: 12,
            matchId: base.matchId,
            ladderId: base.ladderId,
            slot: base.slot,
            format: base.format,
            game: 1,
            turn: 5,
            activeSlot: 'p2',
            turnStartedAt: NOW_SECONDS - 3,
            turnBudgetSeconds: 55,
            incrementSeconds: base.incrementSeconds,
            p1: {
              ...base.p1,
              bankSeconds: 382,
              lastTurnMillis: 265,
              meanTurnMillis: 262,
              ram: 840,
              cpuCores: 2.9,
              team: base.p2.team,
              pokemon: [
                {percent: 98, color: 'green'},
                {percent: 42, color: 'yellow'},
                {percent: 0, color: 'fainted'},
                {percent: 100, color: 'green'},
              ],
            },
            p2: {
              ...base.p2,
              bankSeconds: 365,
              lastTurnMillis: 310,
              meanTurnMillis: 298,
              ram: 1860,
              cpuCores: 4.1,
              team: base.p1.team,
              pokemon: [
                {percent: 0, color: 'fainted'},
                {percent: 14, color: 'red'},
                {percent: 84, color: 'green'},
                {percent: 35, color: 'yellow'},
              ],
            },
          },
        });
        return () => {
          fixture.arenaHandle.setLiveState(fixture.defaultLiveState);
        };
      },
    },
    {
      name: 'arena-battles-singles-live',
      section: 'battles',
      title: 'Live (6v6 Singles)',
      path: '/arena/battles/',
      setup: fixture => {
        fixture.arenaHandle.setLiveState({
          stale: false,
          updatedAt: NOW_SECONDS,
          live: {
            heartbeatSeq: 64,
            matchId: 'gen9ou-0009997',
            ladderId: 'gen9ou20261109',
            slot: 'sv',
            format: 'gen9ou',
            game: 2,
            turn: 24,
            activeSlot: 'p1',
            turnStartedAt: NOW_SECONDS - 5,
            turnBudgetSeconds: 132,
            incrementSeconds: 10,
            game1Summary: {
              winnerSlot: 'p2',
              turns: 34,
              endReason: 'timeout',
              p1: {
                bankSeconds: 0,
                initMillis: 880,
                teamPreviewMillis: 520,
                meanTurnMillis: 3420,
                ram: 1120,
                cpuCores: 3.1,
                pokemon: [
                  {percent: 29, color: 'yellow'},
                  {percent: 0, color: 'fainted'},
                  {percent: 0, color: 'fainted'},
                  {percent: 62, color: 'green'},
                  {percent: 0, color: 'fainted'},
                  {percent: 0, color: 'fainted'},
                ],
              },
              p2: {
                bankSeconds: 118,
                initMillis: 610,
                teamPreviewMillis: 390,
                meanTurnMillis: 410,
                ram: 940,
                cpuCores: 2.3,
                pokemon: [
                  {percent: 50, color: 'yellow'},
                  {percent: 0, color: 'fainted'},
                  {percent: 88, color: 'green'},
                  {percent: 0, color: 'fainted'},
                  {percent: 19, color: 'red'},
                  {percent: 0, color: 'fainted'},
                ],
              },
            },
            p1: {
              slug: 'foul-play',
              name: 'Foul Play',
              version: '1.4.0',
              bankSeconds: 132,
              lastTurnMillis: 390,
              meanTurnMillis: 415,
              ram: 1090,
              cpuCores: 2.9,
              pokemon: [
                {percent: 24, color: 'yellow'},
                {percent: 100, color: 'green'},
                {percent: 0, color: 'fainted'},
                {percent: 81, color: 'green'},
                {percent: 9, color: 'red'},
                {percent: 50, color: 'yellow'},
              ],
            },
            p2: {
              slug: 'pokerus',
              name: 'Pokérus',
              version: '1.0.2',
              bankSeconds: 126,
              lastTurnMillis: 360,
              meanTurnMillis: 375,
              ram: 920,
              cpuCores: 2.2,
              pokemon: [
                {percent: 45, color: 'yellow'},
                {percent: 0, color: 'fainted'},
                {percent: 94, color: 'green'},
                {percent: 0, color: 'fainted'},
                {percent: 0, color: 'fainted'},
                {percent: 16, color: 'red'},
              ],
            },
          },
        });
        return () => {
          fixture.arenaHandle.setLiveState(fixture.defaultLiveState);
        };
      },
    },
    {
      name: 'arena-battles-rand-live',
      section: 'battles',
      title: 'Live (RAND)',
      path: '/arena/battles/',
      setup: fixture => {
        fixture.arenaHandle.setLiveState({
          stale: false,
          updatedAt: NOW_SECONDS,
          live: {
            heartbeatSeq: 42,
            matchId: 'gen9randombattle-0009998',
            ladderId: 'gen9randombattle20261109',
            slot: 'rand',
            format: 'gen9randombattle',
            game: 1,
            turn: 6,
            activeSlot: 'p1',
            turnStartedAt: NOW_SECONDS - 3,
            turnBudgetSeconds: 145,
            incrementSeconds: 10,
            viewer: {
              lines: [
                '|player|p1|MissingNo.Zero|1',
                '|player|p2|0 ERROR|2',
                '|gametype|singles',
                '|gen|9',
                '|tier|[Gen 9] Random Battle',
                '|teamsize|p1|6',
                '|teamsize|p2|6',
                '|start',
                '|switch|p1a: Great Tusk|Great Tusk, L80|260/260',
                '|switch|p2a: Dragapult|Dragapult, L78|245/245',
                '|turn|1',
                '|move|p2a: Dragapult|Draco Meteor|p1a: Great Tusk',
                '|-damage|p1a: Great Tusk|92/260',
                '|move|p1a: Great Tusk|Knock Off|p2a: Dragapult',
                '|-damage|p2a: Dragapult|0 fnt',
                '|faint|p2a: Dragapult',
                '|switch|p2a: Corviknight|Corviknight, L80|288/288',
                '|turn|2',
                '|switch|p1a: Kingambit|Kingambit, L74|270/270',
                '|move|p2a: Corviknight|Body Press|p1a: Kingambit',
                '|-damage|p1a: Kingambit|48/270',
                '|turn|6',
              ],
              p1: {
                pokemon: [
                  ['Kingambit', 'Kingambit, L74', '48/270', true],
                  ['Great Tusk', 'Great Tusk, L80', '92/260', false],
                  ['Gholdengo', 'Gholdengo, L80', '250/250', false],
                  ['Dragonite', 'Dragonite, L80', '268/268', false],
                  ['Glimmora', 'Glimmora, L80', '244/244', false],
                  ['Iron Valiant', 'Iron Valiant, L80', '238/238', false],
                ].map(([sp, details, condition, active]) => ({
                  ident: `p1: ${sp}`,
                  details,
                  condition,
                  active,
                  stats: {atk: 210, def: 195, spa: 170, spd: 175, spe: 205},
                  moves: ['protect', 'uturn', 'earthquake', 'knockoff'],
                  baseAbility: 'defiant',
                  item: 'leftovers',
                  pokeball: 'pokeball',
                  ability: 'defiant',
                })),
              },
              p2: {
                pokemon: [
                  ['Corviknight', 'Corviknight, L80', '288/288', true],
                  ['Dragapult', 'Dragapult, L78', '0 fnt', false],
                  ['Ting-Lu', 'Ting-Lu, L80', '380/380', false],
                  ['Ogerpon', 'Ogerpon, L80', '247/247', false],
                  ['Raging Bolt', 'Raging Bolt, L80', '320/320', false],
                  ['Slowking', 'Slowking, L80', '310/310', false],
                ].map(([sp, details, condition, active]) => ({
                  ident: `p2: ${sp}`,
                  details,
                  condition,
                  active,
                  stats: {atk: 210, def: 195, spa: 170, spd: 175, spe: 205},
                  moves: ['protect', 'uturn', 'earthquake', 'knockoff'],
                  baseAbility: 'pressure',
                  item: 'leftovers',
                  pokeball: 'pokeball',
                  ability: 'pressure',
                })),
              },
            },
            p1: {
              slug: 'missingnozero',
              name: 'MissingNo.Zero',
              version: '2.1.0',
              bankSeconds: 144,
              lastTurnMillis: 260,
              meanTurnMillis: 255,
              ram: 980,
              cpuCores: 3.4,
              info: {win: 0.634, depth: 6, seldepth: 14, nodes: 142000, nps: 95000},
            },
            p2: {
              slug: '0-error',
              name: '0 ERROR',
              version: '1.0.0',
              bankSeconds: 140,
              lastTurnMillis: 290,
              meanTurnMillis: 280,
              ram: 820,
              cpuCores: 1.9,
              info: {win: 0.412, nodes: 31500, nps: 52000},
            },
            winHistory: [
              {turn: 1, p1: 0.51, p2: 0.49},
              {turn: 2, p1: 0.58, p2: 0.44},
              {turn: 3, p1: 0.55, p2: 0.48},
              {turn: 4, p1: 0.47, p2: 0.56},
              {turn: 5, p1: 0.59, p2: 0.45},
              {turn: 6, p1: 0.634, p2: 0.412},
            ],
          },
        });
        return () => {
          fixture.arenaHandle.setLiveState(fixture.defaultLiveState);
        };
      },
    },
    {
      name: 'arena-battles-rand-replay',
      section: 'battles',
      title: 'Replay (RAND)',
      path: '/arena/battles/',
      click: 'tr.battle-row[data-fmt="rand"] td:first-child',
    },
    {
      name: 'arena-battles-vgc-archived-replay',
      section: 'battles',
      title: 'Replay (Archived Pool)',
      path: '/arena/battles/',
      setup: fixture => setupRotatedSeasons(fixture, 'archived'),
      click: 'tr.battle-row[data-fmt="vgc"] td:first-child',
    },
    {
      name: 'arena-battles-expanded',
      section: 'battles',
      title: 'Expanded (Timeout)',
      path: '/arena/battles/',
      click: 'tr.battle-row:has(td[title*="timeout"]) td:first-child',
    },
    {
      name: 'arena-battles-crash-expanded',
      section: 'battles',
      title: 'Expanded (Crash)',
      path: '/arena/battles/',
      click: 'tr.battle-row:has(td[title*="crash"]) td:first-child',
    },
    {
      name: 'arena-battles-normal-expanded',
      section: 'battles',
      title: 'Expanded (Clean)',
      path: '/arena/battles/',
      click: 'tr.battle-row[data-fmt="vgc"]:not(:has(td[title*="End:"])) td:first-child',
    },
    {
      name: 'arena-battles-filter-vgc',
      section: 'battles',
      title: 'Filter (VGC)',
      path: '/arena/battles/',
      click: 'label[for="bf-vgc"]',
    },
    {
      name: 'arena-battles-page-2',
      section: 'battles',
      title: 'Page 2',
      path: '/arena/battles/',
      click: '#battles-pager-next',
    },
    {
      name: 'arena-battles-idle',
      section: 'battles',
      title: 'Idle',
      path: '/arena/battles/',
      setup: fixture => {
        fixture.arenaHandle.setLiveState({
          live: undefined,
          stale: false,
          updatedAt: NOW_SECONDS,
        });
        return () => {
          fixture.arenaHandle.setLiveState(fixture.defaultLiveState);
        };
      },
    },
    {
      name: 'arena-battles-stale',
      section: 'battles',
      title: 'Stale',
      path: '/arena/battles/',
      setup: fixture => {
        fixture.arenaHandle.setLiveState({
          live: undefined,
          stale: true,
          updatedAt: NOW_SECONDS - 600,
        });
        return () => {
          fixture.arenaHandle.setLiveState(fixture.defaultLiveState);
        };
      },
    },
    {
      name: 'arena-battles-empty',
      section: 'battles',
      title: 'Empty',
      path: '/arena/battles/',
      setup: fixture => {
        fixture.arenaHandle.setLiveState({
          live: undefined,
          stale: false,
          updatedAt: NOW_SECONDS,
        });
        return withSavepoint(
          fixture,
          raw => {
            raw.exec('DELETE FROM matches');
          },
          () => {
            fixture.arenaHandle.setLiveState(fixture.defaultLiveState);
          }
        );
      },
    },

    // =========================================================================
    // 5. Tournaments
    // =========================================================================
    {
      name: 'arena-tournament-1',
      section: 'tournaments',
      title: 'Completed',
      path: '/arena/tournaments/1/',
    },
    {
      name: 'arena-tournament-1-replay',
      section: 'tournaments',
      title: 'Completed (Replay)',
      path: '/arena/tournaments/1/',
      click: '#games tr.battle-row td:first-child',
    },
    {
      name: 'arena-tournament-2',
      section: 'tournaments',
      title: 'Live (Table 1)',
      path: '/arena/tournaments/2/',
    },
    {
      name: 'arena-tournament-2-table2',
      section: 'tournaments',
      title: 'Live (Table 2)',
      path: '/arena/tournaments/2/',
      click: 'label[for="tb-2-2"]',
    },
    {
      name: 'arena-tournament-2-table2-idle',
      section: 'tournaments',
      title: 'Live (Idle Table)',
      path: '/arena/tournaments/2/',
      click: 'label[for="tb-2-2"]',
      setup: fixture => {
        if (fixture.defaultBroadcast) {
          const clone = structuredClone(fixture.defaultBroadcast);
          if (clone.tables[1]) {
            clone.tables[1].idle = true;
            clone.tables[1].live = false;
            clone.tables[1].lines = [];
          }
          fixture.arenaHandle.setTournamentBroadcast(clone);
        }
        return () => {
          if (fixture.defaultBroadcast) {
            fixture.arenaHandle.setTournamentBroadcast(fixture.defaultBroadcast);
          }
        };
      },
    },
    {
      name: 'arena-tournament-2-replay',
      section: 'tournaments',
      title: 'Live (Replay)',
      path: '/arena/tournaments/2/',
      click: '#games tr.battle-row td:first-child',
    },
    {
      name: 'arena-tournament-2-offline',
      section: 'tournaments',
      title: 'Live (Offline)',
      path: '/arena/tournaments/2/',
      offline: true,
    },
    {
      name: 'arena-tournament-3',
      section: 'tournaments',
      title: 'Scheduled',
      path: '/arena/tournaments/3/',
    },
    {
      name: 'arena-tournament-empty',
      section: 'tournaments',
      title: 'Scheduled (Empty)',
      path: '/arena/tournaments/3/',
      setup: fixture => withSavepoint(fixture, raw => {
        raw.exec("DELETE FROM tournament_entrants WHERE tournament_id = '3'");
      }),
    },

    // =========================================================================
    // 6. Account
    // =========================================================================
    {
      name: 'account-disabled',
      section: 'account',
      title: '403 Disabled',
      path: '/account/',
      githubUser: 'asterdev',
      expectHttpError: 403,
      setup: fixture => withSavepoint(fixture, raw => {
        raw.exec("UPDATE agents SET status = 'disabled' WHERE slug = 'asterai'");
      }),
    },
    {
      name: 'account-pending-locked',
      section: 'account',
      title: 'Pending (Locked)',
      path: '/account/',
      githubUser: 'asterdev',
      setup: fixture => withSavepoint(fixture, raw => {
        raw.exec("UPDATE tournaments SET status = 'completed' WHERE id = '3'");
      }),
    },
    {
      name: 'account-pending-tournament',
      section: 'account',
      title: 'Pending (Tournament)',
      path: '/account/',
      githubUser: 'asterdev',
    },
    {
      name: 'account-qualified-closed',
      section: 'account',
      title: 'Qualified',
      path: '/account/',
      githubUser: 'sisyphus25',
      setup: fixture => withSavepoint(fixture, raw => {
        raw.exec("UPDATE ladders SET status = 'archived'");
        raw.exec("UPDATE tournaments SET status = 'completed' WHERE id = '3'");
      }),
    },
    {
      name: 'account-eligible-new',
      section: 'account',
      title: 'Eligible (New)',
      path: '/account/',
      githubUser: 'sisyphus25',
    },
    {
      name: 'account-eligible-partial',
      section: 'account',
      title: 'Eligible (Partial)',
      path: '/account/',
      githubUser: 'sisyphus25',
      setup: fixture => withSavepoint(fixture, raw => {
        raw.prepare(
          "DELETE FROM agent_ladders WHERE agent_id = ? AND slot NOT IN ('rby', 'adv')"
        ).run(fixture.cynthiaiId);
      }),
    },
    {
      name: 'account-teams-empty',
      section: 'account',
      title: 'Teams (0/20)',
      path: '/account/',
      githubUser: 'sisyphus25',
      click: `input[name="ladders"][value="${VGC_LADDER_ID}"]`,
    },
    {
      name: 'account-teams-invalid',
      section: 'account',
      title: 'Teams (Invalid)',
      path: '/account/',
      githubUser: 'sisyphus25',
      expectHttpError: 400,
      serial: true,
      beforePage: fixture => {
        fixture.db.clearSavedTeams(VGC_LADDER_ID, fixture.cynthiaiId);
      },
      setup: fixture => () => {
        fixture.db.clearSavedTeams(VGC_LADDER_ID, fixture.cynthiaiId);
      },
      act: async (page, fixture) => {
        await page.click(`input[name="ladders"][value="${VGC_LADDER_ID}"]`);
        await page.fill('#sub-ver', '1.0.0');
        await page.fill(
          '#sub-url',
          'https://github.com/sisyphus25/cynthiai/releases/download/v1.0.0/cynthiai.tar.zst'
        );
        await page.fill('#sub-sha', 'a'.repeat(64));
        const t1 = fixture.rawVgcTeams[0];
        const t2 = fixture.rawVgcTeams[1];
        const t3Dup = fixture.rawVgcTeams[0];
        const t4Short = fixture.rawVgcTeams[2].replace(/\n- [^\n]+$/, '');
        const paste = [
          `=== [gen9championsvgc2026regmc] Team 1 ===\n${t1}`,
          `=== [gen9championsvgc2026regmc] Team 2 ===\n${t2}`,
          `=== [gen9championsvgc2026regmc] Team 3 (Duplicate) ===\n${t3Dup}`,
          `=== [gen9championsvgc2026regmc] Team 4 (Short Moves) ===\n${t4Short}`,
        ].join('\n\n');
        await page.fill('#sub-teams', paste);
        await page.click('#sub-btn');
        await page.waitForSelector('#teams-feedback:not(.hide)');
      },
    },
    {
      name: 'account-teams-partial',
      section: 'account',
      title: 'Teams (10/20)',
      path: '/account/',
      githubUser: 'sisyphus25',
      expectHttpError: 400,
      serial: true,
      beforePage: fixture => {
        fixture.db.replaceSavedTeams(
          VGC_LADDER_ID,
          fixture.cynthiaiId,
          fixture.canonicalVgcTeams.slice(0, 9),
          NOW_SECONDS
        );
      },
      setup: fixture => () => {
        fixture.db.clearSavedTeams(VGC_LADDER_ID, fixture.cynthiaiId);
      },
      act: async (page, fixture) => {
        await page.click(`input[name="ladders"][value="${VGC_LADDER_ID}"]`);
        await page.fill('#sub-ver', '1.0.0');
        await page.fill(
          '#sub-url',
          'https://github.com/sisyphus25/cynthiai/releases/download/v1.0.0/cynthiai.tar.zst'
        );
        await page.fill('#sub-sha', 'a'.repeat(64));
        await page.fill(
          '#sub-teams',
          `=== [gen9championsvgc2026regmc] Team 10 ===\n${fixture.rawVgcTeams[9]}`
        );
        await page.click('#sub-btn');
        await page.waitForSelector('#teams-feedback:not(.hide)');
      },
    },
    {
      name: 'account-teams-complete',
      section: 'account',
      title: 'Teams (20/20)',
      path: '/account/',
      githubUser: 'sisyphus25',
      setup: fixture => {
        fixture.db.replaceSavedTeams(
          VGC_LADDER_ID,
          fixture.cynthiaiId,
          fixture.canonicalVgcTeams,
          NOW_SECONDS
        );
        return () => {
          fixture.db.clearSavedTeams(VGC_LADDER_ID, fixture.cynthiaiId);
        };
      },
      act: async page => {
        await page.click(`input[name="ladders"][value="${VGC_LADDER_ID}"]`);
        await page.fill('#sub-ver', '1.0.0');
        await page.fill(
          '#sub-url',
          'https://github.com/sisyphus25/cynthiai/releases/download/v1.0.0/cynthiai.tar.zst'
        );
        await page.fill('#sub-sha', 'a'.repeat(64));
      },
    },
    {
      name: 'account-submission-error',
      section: 'account',
      title: 'Form Error',
      path: '/account/',
      githubUser: 'sisyphus25',
      expectHttpError: 400,
      act: async page => {
        await page.click(`input[name="ladders"][value="${RBY_LADDER_ID}"]`);
        await page.fill('#sub-ver', '1.0.0');
        await page.fill(
          '#sub-url',
          'https://github.com/sisyphus25/cynthiai/releases/download/v1.0.0/cynthiai.tar.zst'
        );
        await page.fill('#sub-sha', 'not-a-valid-64-char-hex-sha256');
        await page.click('#sub-btn');
        await page.waitForSelector('#sub-status.no:not(.hide)');
      },
    },
    {
      name: 'account-tournament',
      section: 'account',
      title: 'Eligible (Settled)',
      path: '/account/',
      githubUser: 'pmariglia',
    },
    {
      name: 'account-ineligible-smoke-pending',
      section: 'account',
      title: 'Smoke Pending',
      path: '/account/',
      githubUser: 'sisyphus25',
      setup: fixture => withSavepoint(fixture, raw => {
        raw.prepare(
          `INSERT INTO agent_versions (
            agent_id, version, package, url, sha256, ladders_json, tournaments_json,
            smoke_status, submitted_at, notified
          ) VALUES (?, '1.0.0-rc1', 'bundle',
            'https://github.com/sisyphus25/cynthiai/releases/download/v1.0.0-rc1/agent.tar.zst',
            ?, ?, '[]', 'pending', ?, 0)`
        ).run(
          fixture.cynthiaiId,
          'a'.repeat(64),
          JSON.stringify([RBY_LADDER_ID]),
          NOW_SECONDS - 120
        );
      }),
    },
    {
      name: 'account-diagnostic-live',
      section: 'account',
      title: 'Diagnostic Live',
      path: '/account/',
      githubUser: 'sisyphus25',
      setup: fixture => {
        let versionId = 0;
        const teardownDb = withSavepoint(fixture, raw => {
          const info = raw.prepare(
            `INSERT INTO agent_versions (
              agent_id, version, package, url, sha256, ladders_json, tournaments_json,
              smoke_status, submitted_at, notified
            ) VALUES (?, '1.0.0', 'bundle',
              'https://github.com/sisyphus25/cynthiai/releases/download/v1.0.0/agent.tar.zst',
              ?, ?, '[]', 'pending', ?, 0)`
          ).run(
            fixture.cynthiaiId,
            'a'.repeat(64),
            JSON.stringify([SV_LADDER_ID]),
            NOW_SECONDS - 45
          );
          versionId = Number(info.lastInsertRowid);
        });
        fixture.arenaHandle.setLiveDiagnostic({
          versionId,
          agentId: fixture.cynthiaiId,
          agentSlug: 'cynthiai',
          agentName: 'CynthiAI',
          version: '1.0.0',
          format: 'gen9ou',
          targetName: 'SV',
          phase: 'battle',
          turn: 2,
          activeSlot: 'p1',
          turnStartedAt: NOW_SECONDS - 4,
          turnBudgetSeconds: 150,
          incrementSeconds: 15,
          p1: {
            name: 'CynthiAI (P1)',
            version: '1.0.0',
            bankSeconds: 142,
            thinking: true,
            peakRam: 412,
            info: {win: 0.61, depth: 11, nodes: 24500, nps: 450000},
          },
          p2: {
            name: 'CynthiAI (P2)',
            version: '1.0.0',
            bankSeconds: 145,
            thinking: false,
            peakRam: 398,
            info: {win: 0.39, depth: 10, nodes: 21200, nps: 410000},
          },
          lines: [
            '|player|p1|CynthiAI (P1)|lucas|',
            '|player|p2|CynthiAI (P2)|dawn|',
            '|gametype|singles',
            '|gen|9',
            '|tier|[Gen 9] OU',
            '|teamsize|p1|6',
            '|teamsize|p2|6',
            '|start',
            '|switch|p1a: Great Tusk|Great Tusk|371/371',
            '|switch|p2a: Dragapult|Dragapult|317/317',
            '|turn|1',
            '|move|p2a: Dragapult|Draco Meteor|p1a: Great Tusk',
            '|-damage|p1a: Great Tusk|128/371',
            '|move|p1a: Great Tusk|Knock Off|p2a: Dragapult',
            '|-damage|p2a: Dragapult|0 fnt',
            '|faint|p2a: Dragapult',
            '|switch|p2a: Corviknight|Corviknight|400/400',
            '|turn|2',
          ],
          winHistory: [
            {turn: 1, p1: 0.54, p2: 0.47},
            {turn: 2, p1: 0.61, p2: 0.39},
          ],
        });
        return () => {
          fixture.arenaHandle.setLiveDiagnostic({
            done: true,
            agentId: fixture.cynthiaiId,
            versionId,
          });
          teardownDb();
        };
      },
    },
    {
      name: 'account-staged-diagnostic',
      section: 'account',
      title: 'Staged Diagnostic',
      path: '/account/',
      githubUser: 'sisyphus25',
      click: '#history tbody tr.battle-row td:first-child',
      setup: fixture => withSavepoint(fixture, raw => {
        const res = raw.prepare(
          `INSERT INTO agent_versions (
            agent_id, version, package, url, sha256, ladders_json, tournaments_json,
            unpacked_bytes, smoke_status, smoke_duration_millis, smoke_init_millis,
            smoke_turn_millis, smoke_peak_ram, submitted_at, notified
          ) VALUES (?, '1.0.0', 'bundle',
            'https://github.com/sisyphus25/cynthiai/releases/download/v1.0.0/agent.tar.zst',
            ?, ?, '[]', 248000000, 'staged', 18400, 142, 34, 412, ?, 1)`
        ).run(
          fixture.cynthiaiId,
          'b'.repeat(64),
          JSON.stringify([RBY_LADDER_ID]),
          NOW_SECONDS - 90
        );
        const versionId = Number(res.lastInsertRowid);
        const log = [
          '|player|p1|CynthiAI (P1)|1|',
          '|player|p2|CynthiAI (P2)|1|',
          '|gametype|singles',
          '|gen|1',
          '|tier|[Gen 1] OU',
          '|start',
          '|switch|p1a: Tauros|Tauros|353/353',
          '|switch|p2a: Chansey|Chansey|703/703',
          '|turn|1',
          '|ai|p1|{"win":0.54,"depth":10,"nodes":18400,"nps":420000}',
          '|ai|p2|{"win":0.47,"depth":9,"nodes":16100,"nps":395000}',
          '|move|p1a: Tauros|Body Slam|p2a: Chansey',
          '|-damage|p2a: Chansey|421/703',
          '|move|p2a: Chansey|Thunder Wave|p1a: Tauros',
          '|-status|p1a: Tauros|par',
          '|turn|2',
          '|ai|p1|{"win":0.61,"depth":11,"nodes":24500,"nps":450000}',
          '|ai|p2|{"win":0.39,"depth":10,"nodes":21200,"nps":410000}',
          '|win|CynthiAI (P1)',
        ].join('\n');
        raw.prepare(
          `INSERT INTO smoke_diagnostics (
            version_id, ladder_id, format, turns, end_reason, duration_millis,
            battle_log, p1_stderr, p2_stderr, p1_cpu_cores, p2_cpu_cores,
            p1_peak_ram, p2_peak_ram, info_status, created_at
          ) VALUES (?, ?, 'gen1ou', 2, 'win', 18400, ?, 'init ok\nsearch depth=11',
            'init ok\nsearch depth=10', 4.2, 4.1, 412, 398, 'full', ?)`
        ).run(versionId, RBY_LADDER_ID, log, NOW_SECONDS - 60);
      }),
    },
    {
      name: 'account-ineligible-smoke-limit',
      section: 'account',
      title: 'Smoke Limit',
      path: '/account/',
      githubUser: 'sisyphus25',
      setup: fixture => withSavepoint(fixture, raw => {
        const insertVer = raw.prepare(
          `INSERT INTO agent_versions (
            agent_id, version, package, url, sha256, ladders_json, tournaments_json,
            smoke_status, smoke_duration_millis, smoke_init_millis, smoke_turn_millis,
            smoke_peak_ram, smoke_error, submitted_at, notified
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        );
        const insertDiag = raw.prepare(
          `INSERT INTO smoke_diagnostics (
            version_id, ladder_id, tournament_id, format, turns, end_reason, duration_millis,
            battle_log, p1_stderr, p2_stderr, info_status, created_at
          ) VALUES (?, ?, ?, ?, 2, ?, 11200, '|turn|1\n|win|CynthiAI (P1)',
            'diagnostic stderr', 'diagnostic stderr', ?, ?)`
        );
        const ladderAttempts: Array<{status: 'failed' | 'discarded'; err: string | null}> = [
          {status: 'failed', err: 'Diagnostic test failed in gen1ou: segfault in init'},
          {status: 'discarded', err: null},
          {status: 'failed', err: 'Diagnostic test failed in gen1ou: timeout on turn 4'},
        ];
        for (let i = 0; i < ladderAttempts.length; i++) {
          const att = ladderAttempts[i];
          const ts = NOW_SECONDS - (3 - i) * 3600;
          const r1 = insertVer.run(
            fixture.cynthiaiId,
            '1.0.0',
            'bundle',
            'https://github.com/sisyphus25/cynthiai/releases/download/v1.0.0/agent.tar.zst',
            String(i + 1).repeat(64),
            JSON.stringify([RBY_LADDER_ID]),
            '[]',
            att.status,
            att.status === 'discarded' ? 14200 : null,
            att.status === 'discarded' ? 120 : null,
            att.status === 'discarded' ? 28 : null,
            att.status === 'discarded' ? 380 : null,
            att.err,
            ts
          );
          insertDiag.run(
            Number(r1.lastInsertRowid),
            RBY_LADDER_ID,
            null,
            'gen1ou',
            att.status === 'discarded' ? 'win' : 'crash',
            att.status === 'discarded' ? 'partial' : 'none',
            ts + 30
          );
          const r2 = insertVer.run(
            fixture.cynthiaiId,
            't1.0',
            'oci',
            'ghcr.io/sisyphus25/cynthiai:t1.0',
            String(i + 4).repeat(64),
            '[]',
            JSON.stringify(['3']),
            'failed',
            null,
            null,
            null,
            null,
            'Diagnostic test failed in gen9championsvgc2026regmc: exit code 1',
            NOW_SECONDS - (3 - i) * 1800
          );
          insertDiag.run(
            Number(r2.lastInsertRowid),
            null,
            '3',
            'gen9championsvgc2026regmc',
            'crash',
            'none',
            NOW_SECONDS - (3 - i) * 1800 + 30
          );
        }
      }),
    },
    {
      name: 'account',
      section: 'account',
      title: 'Cooldown',
      path: '/account/',
    },
    {
      name: 'account-ineligible-provisional',
      section: 'account',
      title: 'Unsettled',
      path: '/account/',
      githubUser: 'pokerusdev',
    },
    {
      name: 'account-ineligible-quarantined',
      section: 'account',
      title: 'Quarantined',
      path: '/account/',
      setup: fixture => withSavepoint(fixture, raw => {
        raw.prepare(
          `UPDATE agent_versions
           SET smoke_status = 'quarantined',
               smoke_error = ?
           WHERE version = '0.9.0-rc1'`
        ).run(
          'Auto-quarantined on gen9ou20261109 (10/10 faults, 10 consecutive; last=timeout):\n' +
          '  Match sv-0001042 (G2, turn 14): process exited with SIGSEGV (code 139)\n' +
          '  Match sv-0001049 (G1, turn 8): choice timeout (> 150s)'
        );
      }),
    },
    {
      name: 'account-ineligible-smogon-banned',
      section: 'account',
      title: 'Banned',
      path: '/account/',
      githubUser: 'pmariglia',
      setup: fixture => withSavepoint(fixture, raw => {
        raw.exec(
          "UPDATE developers SET smogon_standing = 'bad' WHERE github_login = 'pmariglia'"
        );
      }),
    },
    {
      name: 'admin-forbidden',
      section: 'account',
      title: 'Admin (403)',
      path: '/admin/',
      githubUser: 'pmariglia',
      expectHttpError: 403,
    },
    {
      name: 'admin',
      section: 'account',
      title: 'Admin',
      path: '/admin/',
      githubUser: 'scheibo',
    },
    {
      name: 'admin-expanded',
      section: 'account',
      title: 'Admin (Expanded)',
      path: '/admin/',
      githubUser: 'scheibo',
      click: 'tr[data-agent-row="0-error"] .row-toggle',
    },
    {
      name: 'admin-diagnostic',
      section: 'account',
      title: 'Admin (Diagnostic)',
      path: '/admin/',
      githubUser: 'scheibo',
      setup: fixture => withSavepoint(fixture, raw => {
        const agentRow = raw.prepare("SELECT id FROM agents WHERE slug = '0-error'").get() as {
          id: number;
        };
        const res = raw.prepare(
          `INSERT INTO agent_versions (
            agent_id, version, package, url, sha256, ladders_json, tournaments_json,
            unpacked_bytes, smoke_status, smoke_duration_millis, smoke_init_millis,
            smoke_turn_millis, smoke_peak_ram, submitted_at, notified
          ) VALUES (?, '1.3.0', 'bundle',
            'https://github.com/pkmn/0-ERROR/releases/download/v1.3.0/agent.tar.zst',
            ?, ?, '[]', 214000000, 'staged', 14200, 128, 38, 612, ?, 1)`
        ).run(
          agentRow.id,
          'c'.repeat(64),
          JSON.stringify([SV_LADDER_ID]),
          NOW_SECONDS - 120
        );
        const versionId = Number(res.lastInsertRowid);
        const log = [
          '|player|p1|0 ERROR (P1)|1|',
          '|player|p2|0 ERROR (P2)|1|',
          '|gametype|singles',
          '|gen|9',
          '|tier|[Gen 9] OU',
          '|start',
          '|switch|p1a: Great Tusk|Great Tusk|371/371',
          '|switch|p2a: Dragapult|Dragapult|317/317',
          '|turn|1',
          '|ai|p1|{"win":0.54,"depth":10,"nodes":18400,"nps":420000}',
          '|ai|p2|{"win":0.47,"depth":9,"nodes":16100,"nps":395000}',
          '|move|p2a: Dragapult|Draco Meteor|p1a: Great Tusk',
          '|-damage|p1a: Great Tusk|128/371',
          '|move|p1a: Great Tusk|Knock Off|p2a: Dragapult',
          '|-damage|p2a: Dragapult|0 fnt',
          '|faint|p2a: Dragapult',
          '|switch|p2a: Corviknight|Corviknight|400/400',
          '|turn|2',
          '|ai|p1|{"win":0.61,"depth":11,"nodes":24500,"nps":450000}',
          '|ai|p2|{"win":0.39,"depth":10,"nodes":21200,"nps":410000}',
          '|win|0 ERROR (P1)',
        ].join('\n');
        raw.prepare(
          `INSERT INTO smoke_diagnostics (
            version_id, ladder_id, format, turns, end_reason, duration_millis,
            battle_log, p1_stderr, p2_stderr, p1_cpu_cores, p2_cpu_cores,
            p1_peak_ram, p2_peak_ram, info_status, created_at
          ) VALUES (?, ?, 'gen9ou', 2, 'win', 14200, ?, 'init ok\nsearch depth=11',
            'init ok\nsearch depth=10', 3.4, 3.3, 612, 598, 'full', ?)`
        ).run(versionId, SV_LADDER_ID, log, NOW_SECONDS - 90);
      }),
      act: async page => {
        await page.locator('tr[data-agent-row="0-error"] .row-toggle').click();
        const diagCell = page
          .locator('tr[data-detail-for="0-error"] tr.battle-row[data-diag-ids] td:first-child')
          .first();
        await diagCell.waitFor({state: 'visible', timeout: 5000});
        await diagCell.click();
        await page
          .locator('tr[data-detail-for="0-error"] .diag-replay-row iframe.replay-viewer-frame')
          .waitFor({state: 'visible', timeout: 5000});
      },
    },
    {
      name: 'admin-paginated',
      section: 'account',
      title: 'Admin (Paginated)',
      path: '/admin/',
      githubUser: 'scheibo',
      setup: async fixture => {
        const undoDb = withSavepoint(fixture, raw => {
          const insertAgent = raw.prepare(
            `INSERT INTO agents (slug, name, status, updated_at)
             VALUES (?, ?, 'pending', ?)`
          );
          for (let i = 1; i <= 22; i++) {
            const num = String(i).padStart(2, '0');
            insertAgent.run(
              `extra-agent-${num}`,
              `Extra Agent ${num}`,
              NOW_SECONDS - i * 3600
            );
          }
        });
        for (let i = 1; i <= 26; i++) {
          const num = String(i).padStart(2, '0');
          await fixture.wikiInstance.savePage(
            `Entry_${num}`,
            `# Entry ${num}\n\nMock wiki entry ${num} for admin pagination.\n`,
            'scheibo',
            `Add wiki note ${num}`
          );
        }
        return () => {
          undoDb();
          execFileSync('git', ['reset', '--hard', fixture.sha], {
            cwd: fixture.wikiDir,
            stdio: 'ignore',
          });
          execFileSync('git', ['clean', '-fd'], {
            cwd: fixture.wikiDir,
            stdio: 'ignore',
          });
        };
      },
      act: async page => {
        const projNext = page.locator('#projects-pager-next');
        await projNext.waitFor({state: 'visible', timeout: 5000});
        await projNext.click();
        await page.waitForFunction(
          () => (document.getElementById('projects-pager-info')?.textContent ?? '')
            .startsWith('Page 2 of'),
          undefined,
          {timeout: 5000}
        );
        const wikiNext = page.locator('#wiki-pager-next');
        await wikiNext.waitFor({state: 'visible', timeout: 5000});
        await wikiNext.click();
        await page.waitForFunction(
          () => (document.getElementById('wiki-pager-info')?.textContent ?? '')
            .startsWith('Page 2 of'),
          undefined,
          {timeout: 5000}
        );
      },
    },

    // =========================================================================
    // 7. Wiki
    // =========================================================================
    {
      name: 'wiki',
      section: 'wiki',
      title: 'Home',
      path: '/wiki',
    },
    {
      name: 'wiki-pages',
      section: 'wiki',
      title: 'Pages',
      path: '/wiki/pages',
    },
    {
      name: 'wiki-projects',
      section: 'wiki',
      title: 'Projects',
      path: '/wiki/projects',
    },
    {
      name: 'wiki-project',
      section: 'wiki',
      title: 'Project (Developers)',
      path: '/wiki/projects/0_ERROR',
    },
    {
      name: 'wiki-discord',
      section: 'wiki',
      title: 'Project (Discord)',
      path: '/wiki/projects/Foul_Play',
      setup: fixture => setupDiscordWikiPage(fixture),
    },
    {
      name: 'wiki-edit',
      section: 'wiki',
      title: 'Edit (Public)',
      path: '/wiki/Gen_9_OU/edit',
    },
    {
      name: 'wiki-edit-project',
      section: 'wiki',
      title: 'Edit (Project)',
      path: '/wiki/projects/0_ERROR/edit',
    },
    {
      name: 'wiki-preview',
      section: 'wiki',
      title: 'Preview',
      path: '/wiki/projects/0_ERROR/edit',
      click: '#wiki-actions button[value="preview"]',
    },
    {
      name: 'wiki-history',
      section: 'wiki',
      title: 'History',
      path: '/wiki/projects/0_ERROR/history',
    },
    {
      name: 'wiki-revision',
      section: 'wiki',
      title: 'Revision',
      path: `/wiki/projects/0_ERROR/${wikiSha}`,
    },
    {
      name: 'wiki-diff',
      section: 'wiki',
      title: 'Diff',
      path: `/wiki/projects/0_ERROR/${wikiSha}?diff=1`,
    },
    {
      name: 'wiki-uncreated-owner',
      section: 'wiki',
      title: 'Uncreated (Owner)',
      path: '/wiki/projects/Foul_Play',
      githubUser: 'pmariglia',
    },
    {
      name: 'wiki-uncreated-other',
      section: 'wiki',
      title: '404 Uncreated',
      path: '/wiki/projects/Metamon',
      githubUser: 'pmariglia',
      expectHttpError: 404,
    },
    {
      name: 'wiki-forbidden-stranger',
      section: 'wiki',
      title: '403 Unregistered',
      path: '/wiki/projects/0_ERROR',
      githubUser: 'stranger',
      expectHttpError: 403,
    },
    {
      name: 'wiki-forbidden-nonowner',
      section: 'wiki',
      title: '403 Non-Owner',
      path: '/wiki/projects/0_ERROR/edit',
      githubUser: 'pmariglia',
      expectHttpError: 403,
    },
    {
      name: 'wiki-forbidden-discord',
      section: 'wiki',
      title: '403 Non-Guild',
      path: '/wiki/projects/Foul_Play',
      githubUser: 'outsider',
      expectHttpError: 403,
      setup: fixture => setupDiscordWikiPage(fixture),
    },
    {
      name: 'auth-dev',
      section: 'wiki',
      title: 'Dev Auth',
      path: '/auth/dev',
    },
  ];
}

export function filterScenarios(
  scenarios: readonly Scenario[],
  only?: readonly string[]
): Scenario[] {
  const tokens = (only ?? [])
    .flatMap(entry => entry.split(','))
    .map(tok => tok.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return [...scenarios];
  return scenarios.filter(scenario => {
    const name = scenario.name.toLowerCase();
    const section = scenario.section.toLowerCase();
    return tokens.some(tok => name.includes(tok) || section.includes(tok));
  });
}

function copyStaticPublicHtml(srcPublic: string, dstPublic: string) {
  const indexHtml = path.join(srcPublic, 'index.html');
  if (fs.existsSync(indexHtml)) {
    fs.copyFileSync(indexHtml, path.join(dstPublic, 'index.html'));
  }
  for (const dir of [
    'background',
    'concepts',
    'glossary',
    'release',
    'research',
    'rules',
  ]) {
    const srcDir = path.join(srcPublic, dir);
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, path.join(dstPublic, dir), {recursive: true});
    }
  }
}

async function startFixture(): Promise<Fixture> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-shots-'));
  const wikiDir = path.join(tmpDir, 'wiki');
  const staticDir = path.join(tmpDir, 'static');
  const avatarsDir = path.join(staticDir, 'avatars');
  const publicDir = path.join(tmpDir, 'public');
  const laddersFile = path.join(tmpDir, 'ladders.yml');
  fs.mkdirSync(publicDir, {recursive: true});
  copyStaticPublicHtml(PUBLIC, publicDir);

  const db = new Database(':memory:', {now: NOW_SECONDS});
  const seeded = await mock.seed({
    db,
    publicDir,
    staticDir,
    avatarsDir,
    wikiDir,
    laddersFile,
    now: NOW_SECONDS,
    render: true,
  });
  const projectsFile = path.join(staticDir, 'projects.yml');

  // Default to the normal everyday state without a `● LIVE` topbar banner across pages; only the
  // explicit `home-live-banner` scenario enables it via `setShowLiveBanner(true)`.
  let showLiveBanner = false;
  const origGetRunningTournament = db.getRunningTournament.bind(db);
  db.getRunningTournament = () => (showLiveBanner ? origGetRunningTournament() : undefined);
  syncStaticLiveBanner(publicDir, undefined);

  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: wikiDir,
    encoding: 'utf8',
  }).trim();

  const rawVgcTeams = mock.generateValidVgcTeams(20, 4);
  const canonicalVgcTeams = teams.validateCompetitorTeamsIncremental(rawVgcTeams, {
    format: VGC_LADDER_ID,
    pools: [],
    teams: 20,
  }).allSaved;
  const cynthiaiId = db.getAgentBySlug('cynthiai')!.id;

  const serveStaticResponse = (res: http.ServerResponse, pathname: string): void => {
    const file = (
      resolveFileInDir(publicDir, pathname) ??
      resolveFileInDir(PUBLIC, pathname)
    );
    if (file) {
      res.writeHead(200, {'Content-Type': contentTypeForPath(file)});
      res.end(fs.readFileSync(file));
      return;
    }
    const notFound = path.join(PUBLIC, '404.html');
    if (fs.existsSync(notFound)) {
      res.writeHead(404, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(fs.readFileSync(notFound));
      return;
    }
    res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
    res.end('Not Found');
  };

  const app = polka({
    onNoMatch: (req, res) => {
      const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      serveStaticResponse(res, pathname);
    },
  });
  const wikiInstance = new wiki.Wiki({
    wikiDir,
    projectsFile,
    db,
    push: false,
    now: () => NOW_SECONDS,
    auth: new auth.Auth({
      config: SHOTS_AUTH,
      db,
      devAuth: true,
      isAuthorizedGitHub: (login): boolean => wikiInstance.isDeveloper(login),
    }),
  });
  wikiInstance.auth.register(app);
  const arenaHandle = arena.register(app, {
    db,
    auth: wikiInstance.auth,
    publicDir,
    now: () => NOW_SECONDS,
  });
  const GIB = 1024 ** 3;
  const MIB = 1024 ** 2;
  const mockVpsSystem: system.VpsSystemInfo = {
    collectedAt: NOW_SECONDS,
    hostname: 'pkmn.ai',
    platform: 'Linux 6.8.0 (x64)',
    nodeVersion: 'v22.21.0',
    gitCommit: '3a816e2f',
    load: {
      load1: 0.42,
      load5: 0.38,
      load15: 0.31,
      cpus: 4,
      uptimeSeconds: 14 * 86400 + 6 * 3600,
      processUptimeSeconds: 3 * 86400 + 2 * 3600,
    },
    memory: {
      totalBytes: 8 * GIB,
      usedBytes: Math.round(2.1 * GIB),
      availableBytes: Math.round(5.9 * GIB),
      swapTotalBytes: 2 * GIB,
      swapUsedBytes: Math.round(0.1 * GIB),
      processRssBytes: 148 * MIB,
    },
    disks: [{
      mount: '/',
      label: 'Root',
      mounted: true,
      totalBytes: 80 * GIB,
      usedBytes: Math.round(18.4 * GIB),
      availableBytes: Math.round(61.6 * GIB),
      readBytesPerSecond: 420 * 1024,
      writeBytesPerSecond: 860 * 1024,
      iops: 24,
      busyPct: 2,
    }],
    network: {
      iface: 'eth0',
      rxBytesPerSecond: 142 * 1024,
      txBytesPerSecond: 88 * 1024,
      rxErrors: 0,
      txErrors: 0,
      internal: {target: 'SSH tunnel :2222', ok: true, checkedAt: NOW_SECONDS},
      external: {target: 'api.github.com', ok: true, rttMillis: 18, checkedAt: NOW_SECONDS - 60},
    },
    updates: {
      pending: 0,
      security: 0,
      rebootRequired: false,
      checkedAt: NOW_SECONDS,
    },
    backups: {
      lastBackupAt: NOW_SECONDS - 4 * 3600,
      lastBackupBytes: Math.round(28.4 * MIB),
      backupCount: 30,
      checkedAt: NOW_SECONDS - 4 * 3600 + 60,
    },
    database: {
      dbBytes: 84 * MIB,
      walBytes: Math.round(3.2 * MIB),
    },
    traffic: {
      sse: {battles: 4, tournaments: 1, admin: 1},
      activeVisitors5m: 12,
      requests1m: 38,
      requests1h: 2140,
      errors4xx1h: 4,
      rateLimited4291h: 1,
      errors5xx1h: 0,
      meanLatencyMillis: 14,
      p95LatencyMillis: 42,
    },
    tlsCert: {
      expiresAt: NOW_SECONDS + 62 * 86400,
      daysRemaining: 62,
      checkedAt: NOW_SECONDS - 2 * 3600,
    },
    arenaFaults24h: {matches: 410, faults: 2},
  };
  const mockArenaSystem: system.ArenaSystemInfo = {
    collectedAt: NOW_SECONDS - 14,
    hostname: 'arena-mini',
    platform: 'Darwin 24.6.0 (arm64)',
    nodeVersion: 'v22.21.0',
    gitCommit: '3a816e2f',
    load: {
      load1: 3.18,
      load5: 2.94,
      load15: 2.75,
      cpus: 14,
      uptimeSeconds: 29 * 86400 + 11 * 3600,
      processUptimeSeconds: 6 * 86400 + 4 * 3600,
    },
    memory: {
      totalBytes: 64 * GIB,
      usedBytes: Math.round(21.4 * GIB),
      availableBytes: Math.round(42.6 * GIB),
      swapTotalBytes: 0,
      swapUsedBytes: 0,
      processRssBytes: 112 * MIB,
      pressure: 'normal',
    },
    disks: [
      {
        mount: '/',
        label: 'Internal',
        mounted: true,
        totalBytes: 460 * GIB,
        usedBytes: 112 * GIB,
        availableBytes: 348 * GIB,
        ioBytesPerSecond: Math.round(4.8 * MIB),
        iops: 95,
      },
      {
        mount: '/Volumes/Archive',
        label: 'Archive',
        mounted: true,
        totalBytes: 1860 * GIB,
        usedBytes: 340 * GIB,
        availableBytes: 1520 * GIB,
        ioBytesPerSecond: 410 * 1024,
        iops: 6,
      },
    ],
    network: {
      iface: 'en0',
      rxBytesPerSecond: 18 * 1024,
      txBytesPerSecond: 12 * 1024,
      rxErrors: 0,
      txErrors: 0,
      internal: {target: 'VPS tunnel', ok: true, rttMillis: 24, checkedAt: NOW_SECONDS - 14},
      external: {target: 'ghcr.io', ok: true, rttMillis: 42, checkedAt: NOW_SECONDS - 120},
    },
    updates: {
      pending: 0,
      rebootRequired: false,
      checkedAt: NOW_SECONDS - 3600,
    },
    backups: {
      lastBackupAt: NOW_SECONDS - 4 * 3600,
      lastBackupBytes: Math.round(3.1 * MIB),
      backupCount: 30,
      lastArchiveUploadAt: NOW_SECONDS - 4 * 3600 + 180,
      checkedAt: NOW_SECONDS - 4 * 3600 + 200,
    },
    database: {
      dbBytes: 12 * MIB,
      walBytes: Math.round(0.4 * MIB),
    },
    outboxPending: 0,
    daemonErrors: 0,
    podmanState: 'running',
    podmanCheckedAt: NOW_SECONDS - 300,
  };
  const mockRegistrations: admin.RegistrationIssuesSnapshot = {
    checkedAt: NOW_SECONDS - 125,
    issues: [
      {
        number: 47,
        title: '[Arena] Noctowl',
        url: 'https://github.com/pkmn/ai/issues/47',
        author: 'noctowldev',
        authorUrl: 'https://github.com/noctowldev',
        createdAt: NOW_SECONDS - 86400,
        updatedAt: NOW_SECONDS - 3600,
        comments: 0,
      },
      {
        number: 19,
        title: '[Arena] Foul Play',
        url: 'https://github.com/pkmn/ai/issues/19',
        author: 'pmariglia',
        authorUrl: 'https://github.com/pmariglia',
        createdAt: NOW_SECONDS - 60 * 86400,
        updatedAt: NOW_SECONDS - 3 * 3600,
        comments: 4,
      },
    ],
  };
  const adminHandle = admin.register(app, {
    db,
    auth: wikiInstance.auth,
    arena: arenaHandle,
    wiki: wikiInstance,
    getVpsSystem: () => mockVpsSystem,
    getRegistrationIssues: () => mockRegistrations,
    now: () => NOW_SECONDS,
  });
  account.register(app, {
    db,
    auth: wikiInstance.auth,
    arena: arenaHandle,
    now: () => NOW_SECONDS,
    poolsByLadder: new Map([[VGC_LADDER_ID, []]]),
    rateLimitMaxAttempts: 1000,
  });
  const defaultLiveState = {
    live: seeded.liveDoc.live,
    stale: seeded.liveDoc.stale,
    updatedAt: seeded.liveDoc.updatedAt,
  };
  arenaHandle.setLiveState(defaultLiveState);
  arenaHandle.setArenaSystem(mockArenaSystem, NOW_SECONDS - 14);
  if (seeded.tournamentBroadcast) {
    arenaHandle.setTournamentBroadcast(seeded.tournamentBroadcast);
  }
  render.register(app, {
    db,
    arena: arenaHandle,
    publicDir,
    staticDir,
    avatarsDir,
    now: () => NOW_SECONDS,
  });
  wiki.register(app, wikiInstance);

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url || '/', 'http://127.0.0.1');
    if (
      parsed.pathname === '/api/battles/stream' ||
      parsed.pathname === '/api/admin/stream' ||
      parsed.pathname === '/api/account/diagnostic/stream' ||
      /^\/api\/tournaments\/[^/]+\/stream$/.test(parsed.pathname)
    ) {
      res.writeHead(204, {'Content-Type': 'text/event-stream'});
      res.end();
      return;
    }
    const isStaticArenaAsset = (
      parsed.pathname === '/arena/viewer' ||
      parsed.pathname.startsWith('/arena/viewer/') ||
      /\.(?:7z|tar)$/i.test(parsed.pathname) ||
      (/\.log$/i.test(parsed.pathname) && !parsed.search)
    );
    if (isStaticArenaAsset) {
      serveStaticResponse(res, parsed.pathname);
      return;
    }
    void app.handler(req as polka.Request, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as {port: number};
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const mintToken = (
    id: number,
    login: string,
    discordId?: string,
    discordUser?: string
  ) => encodeURIComponent(
    auth.signToken(
      {
        ...(login ? {github: {id, login}} : {}),
        ...(discordId && discordUser ? {discord: {id: discordId, username: discordUser}} : {}),
        exp,
      },
      SHOTS_AUTH.sessionSecret
    )
  );

  return {
    origin: `http://127.0.0.1:${addr.port}`,
    db,
    arenaHandle,
    wikiInstance,
    defaultLiveState,
    defaultBroadcast: seeded.tournamentBroadcast,
    cookies: {
      scheibo: mintToken(1, 'scheibo', '513513270670262284', 'scheibo'),
      pmariglia: mintToken(2, 'pmariglia', '283674461268344832', 'pmariglia'),
      sisyphus25: mintToken(3, 'sisyphus25', '300000000000000012', 'sisyphus25'),
      asterdev: mintToken(4, 'asterdev'),
      pokerusdev: mintToken(5, 'pokerusdev', '300000000000000010', 'pokerusdev'),
      stranger: mintToken(99, 'stranger'),
      outsider: mintToken(0, '', '999999999999999999', 'outsider'),
    },
    sha,
    publicDir,
    wikiDir,
    cynthiaiId,
    rawVgcTeams,
    canonicalVgcTeams,
    setShowLiveBanner: (show: boolean) => {
      showLiveBanner = show;
      syncStaticLiveBanner(publicDir, show ? origGetRunningTournament() : undefined);
    },
    close: async () => {
      adminHandle.close();
      arenaHandle.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      db.close();
      fs.rmSync(tmpDir, {recursive: true, force: true});
    },
  };
}

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({
      args: [
        '--disable-gpu',
        '--disable-gpu-rasterization',
        '--disable-partial-raster',
        '--num-raster-threads=1',
        '--force-color-profile=srgb',
      ],
    });
  } catch (error) {
    console.error(
      'Could not start Chromium. Install the one playwright-core expects with\n' +
      '  npx playwright-core install chromium\n'
    );
    throw error;
  }
}

function resolveFileInDir(baseDir: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  const candidate = path.resolve(baseDir, `.${decoded}`);
  if (candidate !== baseDir && !candidate.startsWith(`${baseDir}${path.sep}`)) {
    return undefined;
  }
  if (fs.existsSync(candidate)) {
    const stat = fs.statSync(candidate);
    if (stat.isFile()) return candidate;
    if (stat.isDirectory()) {
      const index = path.join(candidate, 'index.html');
      if (fs.existsSync(index) && fs.statSync(index).isFile()) return index;
    }
  }
  return undefined;
}

export interface PngImage {
  width: number;
  height: number;
  data: Buffer;
}

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tag = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(data, zlib.crc32(tag)) >>> 0, 0);
  return Buffer.concat([len, tag, data, crc]);
}

function buildRawScanlines(image: PngImage): {ihdr: Buffer; raw: Buffer} {
  const {width, height, data} = image;
  const rowBytes = width * 4;
  const raw = Buffer.alloc(height * (1 + rowBytes));
  for (let y = 0; y < height; y++) {
    const dstOff = y * (1 + rowBytes);
    raw[dstOff] = 0;
    data.copy(raw, dstOff + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return {ihdr, raw};
}

export function encodePng(image: PngImage): Buffer {
  const {ihdr, raw} = buildRawScanlines(image);
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, {level: 1})),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function encodePngAsync(image: PngImage): Promise<Buffer> {
  const {ihdr, raw} = buildRawScanlines(image);
  const compressed = await deflateAsync(raw, {level: 1});
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

interface ParsedPngChunks {
  width: number;
  height: number;
  colorType: number;
  palette?: Buffer;
  trns?: Buffer;
  idat: Buffer;
}

function parsePngChunks(buf: Buffer): ParsedPngChunks {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('Invalid PNG signature');
  }
  let width = 0;
  let height = 0;
  let colorType = 6;
  let palette: Buffer | undefined;
  let trns: Buffer | undefined;
  const idatParts: Buffer[] = [];
  let offset = 8;

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const chunk = buf.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      colorType = chunk[9];
    } else if (type === 'PLTE') {
      palette = chunk;
    } else if (type === 'tRNS') {
      trns = chunk;
    } else if (type === 'IDAT') {
      idatParts.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
  }

  return {
    width,
    height,
    colorType,
    palette,
    trns,
    idat: idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts),
  };
}

function unfilterPng(parsed: ParsedPngChunks, inflated: Buffer): PngImage {
  const {width, height, colorType, palette, trns} = parsed;
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const rowBytes = width * bpp;
  const stride = 1 + rowBytes;
  const unfiltered = Buffer.alloc(height * rowBytes);

  for (let y = 0; y < height; y++) {
    const filter = inflated[y * stride];
    const srcOff = y * stride + 1;
    const dstOff = y * rowBytes;
    const prevOff = (y - 1) * rowBytes;
    if (filter === 0) {
      inflated.copy(unfiltered, dstOff, srcOff, srcOff + rowBytes);
    } else if (filter === 1) {
      for (let i = 0; i < bpp; i++) {
        unfiltered[dstOff + i] = inflated[srcOff + i];
      }
      for (let i = bpp; i < rowBytes; i++) {
        unfiltered[dstOff + i] = (inflated[srcOff + i] + unfiltered[dstOff + i - bpp]) & 0xff;
      }
    } else if (filter === 2) {
      if (y === 0) {
        inflated.copy(unfiltered, dstOff, srcOff, srcOff + rowBytes);
      } else {
        for (let i = 0; i < rowBytes; i++) {
          unfiltered[dstOff + i] = (inflated[srcOff + i] + unfiltered[prevOff + i]) & 0xff;
        }
      }
    } else if (filter === 3) {
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= bpp ? unfiltered[dstOff + i - bpp] : 0;
        const up = y > 0 ? unfiltered[prevOff + i] : 0;
        unfiltered[dstOff + i] = (inflated[srcOff + i] + ((left + up) >>> 1)) & 0xff;
      }
    } else if (filter === 4) {
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= bpp ? unfiltered[dstOff + i - bpp] : 0;
        const up = y > 0 ? unfiltered[prevOff + i] : 0;
        const upLeft = y > 0 && i >= bpp ? unfiltered[prevOff + i - bpp] : 0;
        unfiltered[dstOff + i] = (inflated[srcOff + i] + paethPredictor(left, up, upLeft)) & 0xff;
      }
    } else {
      throw new Error(`Unsupported PNG filter type: ${filter}`);
    }
  }

  if (colorType === 6) {
    return {width, height, data: unfiltered};
  }
  const rgba = Buffer.alloc(width * height * 4);
  const pixels = width * height;
  for (let p = 0; p < pixels; p++) {
    const dst = p * 4;
    if (colorType === 2) {
      const src = p * 3;
      rgba[dst] = unfiltered[src];
      rgba[dst + 1] = unfiltered[src + 1];
      rgba[dst + 2] = unfiltered[src + 2];
      rgba[dst + 3] = 255;
    } else if (colorType === 4) {
      const src = p * 2;
      rgba[dst] = unfiltered[src];
      rgba[dst + 1] = unfiltered[src];
      rgba[dst + 2] = unfiltered[src];
      rgba[dst + 3] = unfiltered[src + 1];
    } else if (colorType === 3 && palette) {
      const idx = unfiltered[p];
      rgba[dst] = palette[idx * 3] ?? 0;
      rgba[dst + 1] = palette[idx * 3 + 1] ?? 0;
      rgba[dst + 2] = palette[idx * 3 + 2] ?? 0;
      rgba[dst + 3] = trns && idx < trns.length ? trns[idx] : 255;
    } else {
      const gray = unfiltered[p];
      rgba[dst] = gray;
      rgba[dst + 1] = gray;
      rgba[dst + 2] = gray;
      rgba[dst + 3] = 255;
    }
  }
  return {width, height, data: rgba};
}

export function decodePng(buf: Buffer): PngImage {
  const parsed = parsePngChunks(buf);
  return unfilterPng(parsed, zlib.inflateSync(parsed.idat));
}

async function decodePngAsync(buf: Buffer): Promise<PngImage> {
  const parsed = parsePngChunks(buf);
  return unfilterPng(parsed, await inflateAsync(parsed.idat));
}

const EXTERNAL_HOSTS = new Set(['www.smogon.com', 'play.pokemonshowdown.com', 'github.com']);
const EXTERNAL_FETCH_TIMEOUT_MILLIS = 3_000;
const GIF87A_SIG = Buffer.from('GIF87a', 'ascii');
const GIF89A_SIG = Buffer.from('GIF89a', 'ascii');
const externalAssetCache = new Map<
  string,
  Promise<{contentType: string; body: Buffer} | undefined>
>();
const unreachableHosts = new Set<string>();

function resolveMainWorktreeCacheDir(): string | undefined {
  try {
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}
    ).trim();
    if (!commonDir) return undefined;
    const mainRoot = path.dirname(fs.realpathSync(commonDir));
    if (mainRoot === fs.realpathSync(ROOT)) return undefined;
    const candidate = path.join(mainRoot, '.shots', 'cache');
    return fs.existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

const MAIN_CACHE_DIR = resolveMainWorktreeCacheDir();

export function resetExternalAssetCache(): void {
  externalAssetCache.clear();
  unreachableHosts.clear();
}

export function isValidExternalAsset(
  pathname: string,
  body: Buffer,
  responseContentType?: string
): boolean {
  if (body.length === 0) return false;
  if (responseContentType && /text\/html/i.test(responseContentType)) return false;
  const ext = path.extname(pathname).toLowerCase();
  if (ext === '.png') {
    return body.length >= 8 && body.subarray(0, 8).equals(PNG_SIG);
  }
  if (ext === '.gif') {
    return (
      body.length >= 6 &&
      (body.subarray(0, 6).equals(GIF87A_SIG) || body.subarray(0, 6).equals(GIF89A_SIG))
    );
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  }
  if (ext === '.js' || ext === '.css' || ext === '.svg') {
    const head = body.subarray(0, 256).toString('utf8').trimStart();
    if (/^<!doctype\s+html\b|^<html\b/i.test(head)) return false;
  }
  return true;
}

function contentTypeForPath(pathname: string): string {
  switch (path.extname(pathname).toLowerCase()) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.log':
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.ico':
      return 'image/x-icon';
    case '.webmanifest':
      return 'application/manifest+json; charset=utf-8';
    case '.xml':
      return 'application/xml; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.svg':
      return 'image/svg+xml';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.mp3':
      return 'audio/mpeg';
    case '.ogg':
      return 'audio/ogg';
    case '.woff2':
      return 'font/woff2';
    case '.woff':
      return 'font/woff';
    case '.ttf':
      return 'font/ttf';
    default:
      return 'application/octet-stream';
  }
}

async function readValidCachedFile(
  baseCacheDir: string,
  hostname: string,
  relPath: string,
  pathname: string,
  purgeInvalid: boolean
): Promise<{contentType: string; body: Buffer} | undefined> {
  const hostRoot = path.resolve(baseCacheDir, hostname);
  const diskPath = path.resolve(hostRoot, relPath);
  if (!diskPath.startsWith(`${hostRoot}${path.sep}`)) return undefined;
  if (!fs.existsSync(diskPath) || !fs.statSync(diskPath).isFile()) return undefined;
  const body = await fsp.readFile(diskPath);
  if (!isValidExternalAsset(pathname, body)) {
    if (purgeInvalid) {
      await fsp.rm(diskPath, {force: true});
    }
    return undefined;
  }
  return {contentType: contentTypeForPath(pathname), body};
}

export function fetchExternalAsset(
  url: URL,
  cacheDir = CACHE_DIR
): Promise<{contentType: string; body: Buffer} | undefined> {
  if (!EXTERNAL_HOSTS.has(url.hostname)) return Promise.resolve(undefined);
  const key = `${cacheDir}:${url.origin}${url.pathname}`;
  const cached = externalAssetCache.get(key);
  if (cached) return cached;

  const load = async (): Promise<{contentType: string; body: Buffer} | undefined> => {
    const relPath = path.posix.normalize(url.pathname).replace(/^\/+/, '');
    const hostRoot = path.resolve(cacheDir, url.hostname);
    const diskPath = path.resolve(hostRoot, relPath);
    const safeDisk = diskPath.startsWith(`${hostRoot}${path.sep}`);

    const localHit = await readValidCachedFile(cacheDir, url.hostname, relPath, url.pathname, true);
    if (localHit) return localHit;

    if (cacheDir === CACHE_DIR && MAIN_CACHE_DIR) {
      const mainHit = await readValidCachedFile(
        MAIN_CACHE_DIR,
        url.hostname,
        relPath,
        url.pathname,
        false
      );
      if (mainHit) return mainHit;
    }

    if (unreachableHosts.has(url.hostname)) return undefined;

    try {
      let targetPathname = url.pathname;
      let res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MILLIS),
      });
      if (!res.ok && url.hostname === 'play.pokemonshowdown.com') {
        const fallbackMatch = /^(\/sprites\/[^/]+\/)([a-z0-9]+)-[^/.]+(\.[a-z]+)$/.exec(
          url.pathname
        );
        if (fallbackMatch) {
          const fallbackUrl = new URL(
            `${fallbackMatch[1]}${fallbackMatch[2]}${fallbackMatch[3]}`,
            url.origin
          );
          targetPathname = fallbackUrl.pathname;
          res = await fetch(fallbackUrl.toString(), {
            signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MILLIS),
          });
        }
      }
      if (!res.ok) return undefined;
      const rawContentType = res.headers.get('content-type') ?? undefined;
      const body = Buffer.from(await res.arrayBuffer());
      if (!isValidExternalAsset(targetPathname, body, rawContentType)) {
        // Captive portals frequently answer arbitrary HTTPS/HTTP requests with 200 OK HTML; treat
        // the host as unreachable for this run and never poison `.shots/cache/` with HTML.
        unreachableHosts.add(url.hostname);
        return undefined;
      }
      const contentType = rawContentType ?? contentTypeForPath(targetPathname);
      if (safeDisk) {
        writeFileAtomic(diskPath, body);
      }
      return {contentType, body};
    } catch (err) {
      if (isConnectivityError(err)) {
        unreachableHosts.add(url.hostname);
      }
      return undefined;
    }
  };

  const promise = load();
  externalAssetCache.set(key, promise);
  return promise;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RegionsMap = Record<string, Rect[]>;

export interface DiffOptions {
  viewerRects?: readonly Rect[];
}

function findRectIndex(rects: readonly Rect[], x: number, y: number): number {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
      return i;
    }
  }
  return -1;
}

function rectsMatch(a: readonly Rect[], b: readonly Rect[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      Math.abs(a[i].x - b[i].x) > 1 ||
      Math.abs(a[i].y - b[i].y) > 1 ||
      Math.abs(a[i].width - b[i].width) > 1 ||
      Math.abs(a[i].height - b[i].height) > 1
    ) {
      return false;
    }
  }
  return true;
}

function readRegionsFile(dir: string): RegionsMap | undefined {
  const file = path.join(dir, 'regions.json');
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as RegionsMap;
  } catch {
    return undefined;
  }
}

async function writeRegionsFile(
  file: string,
  updates: RegionsMap,
  mergeExisting: boolean
): Promise<void> {
  const base: RegionsMap = mergeExisting && fs.existsSync(file)
    ? (JSON.parse(await fsp.readFile(file, 'utf8')) as RegionsMap)
    : {};
  for (const [key, rects] of Object.entries(updates)) {
    if (rects.length > 0) {
      base[key] = rects;
    } else {
      delete base[key];
    }
  }
  const sorted: RegionsMap = {};
  for (const key of Object.keys(base).sort()) {
    sorted[key] = base[key];
  }
  await fsp.mkdir(path.dirname(file), {recursive: true});
  await fsp.writeFile(file, `${JSON.stringify(sorted, undefined, 2)}\n`, 'utf8');
}

// Fast zero-allocation pixel-change check used by `compareShots` to skip allocating/rendering a
// faded diff image when images are identical or differ only by tolerated viewer sprite animation.
function exceedsDiffTolerance(
  a: PngImage,
  b: PngImage,
  viewerRects: readonly Rect[] | undefined,
  tolerance: number
): boolean {
  const {width, height} = a;
  const rects = viewerRects ?? [];
  const a32 = new Uint32Array(a.data.buffer, a.data.byteOffset, width * height);
  const b32 = new Uint32Array(b.data.buffer, b.data.byteOffset, width * height);
  const rectDiffCounts = rects.length > 0 ? new Int32Array(rects.length) : undefined;
  let count = 0;

  for (let p = 0; p < a32.length; p++) {
    if (a32[p] === b32[p]) continue;
    if (rectDiffCounts) {
      const x = p % width;
      const y = (p - x) / width;
      const rIdx = findRectIndex(rects, x, y);
      if (rIdx >= 0) {
        const off = p * 4;
        const maxCh = Math.max(
          Math.abs(a.data[off] - b.data[off]),
          Math.abs(a.data[off + 1] - b.data[off + 1]),
          Math.abs(a.data[off + 2] - b.data[off + 2]),
          Math.abs(a.data[off + 3] - b.data[off + 3])
        );
        if (maxCh > VIEWER_CHANNEL_DELTA) {
          rectDiffCounts[rIdx]++;
        }
        continue;
      }
    }
    if (++count > tolerance) return true;
  }

  if (rectDiffCounts) {
    for (let rIdx = 0; rIdx < rects.length; rIdx++) {
      const rect = rects[rIdx];
      const area = Math.max(1, rect.width * rect.height);
      if (rectDiffCounts[rIdx] / area > VIEWER_MAX_DIFF_RATIO) {
        count += rectDiffCounts[rIdx];
        if (count > tolerance) return true;
      }
    }
  }
  return count > tolerance;
}

// Outside `viewerRects`, every 1px RGBA difference counts strictly. Inside each Showdown viewer
// iframe rect, multi-frame animated Pokémon GIFs (`sprites/ani/*.gif`) tick on Blink's C++ clock
// independently of Playwright's `animations: 'disabled'`, so minor corner/icon AA
// (`<= channelDelta`) is ignored and sprite movement up to `maxRatio` of that viewer rect's area
// is tolerated while still catching broken/blank viewers, backdrop changes, or layout shifts.
export function diffPngImages(
  a: PngImage,
  b: PngImage,
  options: DiffOptions = {}
): {image: PngImage; count: number} {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const data = Buffer.alloc(width * height * 4, 255);
  const rects = options.viewerRects ?? [];
  const channelDelta = VIEWER_CHANNEL_DELTA;
  const maxRatio = VIEWER_MAX_DIFF_RATIO;
  const rectDiffOffsets: number[][] = rects.map(() => []);
  let count = 0;

  const writeFaded = (out: number, ib: number) => {
    const luma =
      0.3 * (b.data[ib] ?? 0) +
      0.59 * (b.data[ib + 1] ?? 0) +
      0.11 * (b.data[ib + 2] ?? 0);
    const faded = 255 - ((255 - Math.round(luma)) >> 2);
    data[out] = faded;
    data[out + 1] = faded;
    data[out + 2] = faded;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      const inBoth = x < a.width && y < a.height && x < b.width && y < b.height;
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      if (inBoth && a.data.readUInt32LE(ia) === b.data.readUInt32LE(ib)) {
        writeFaded(out, ib);
        continue;
      }
      if (inBoth && rects.length > 0) {
        const rIdx = findRectIndex(rects, x, y);
        if (rIdx >= 0) {
          const maxCh = Math.max(
            Math.abs(a.data[ia] - b.data[ib]),
            Math.abs(a.data[ia + 1] - b.data[ib + 1]),
            Math.abs(a.data[ia + 2] - b.data[ib + 2]),
            Math.abs(a.data[ia + 3] - b.data[ib + 3])
          );
          writeFaded(out, ib);
          if (maxCh > channelDelta) {
            rectDiffOffsets[rIdx].push(out);
          }
          continue;
        }
      }
      count++;
      data[out + 1] = 0;
      if (inBoth) data[out + 2] = 0;
    }
  }

  for (let rIdx = 0; rIdx < rects.length; rIdx++) {
    const rect = rects[rIdx];
    const area = Math.max(1, rect.width * rect.height);
    const offsets = rectDiffOffsets[rIdx];
    if (offsets.length / area > maxRatio) {
      count += offsets.length;
      for (const out of offsets) {
        data[out] = 255;
        data[out + 1] = 0;
        data[out + 2] = 0;
      }
    }
  }

  return {image: {width, height, data}, count};
}

export interface ShotChange {
  name: string;
  note: string;
  diffPath?: string;
  status?: 'modified' | 'added' | 'removed';
  pixels?: number;
  percent?: number;
}

export interface GalleryOptions {
  changes?: readonly ShotChange[];
  hasBaseline?: boolean;
}

function listPngsRelative(baseDir: string): string[] {
  if (!fs.existsSync(baseDir)) return [];
  const results: string[] = [];
  const walk = (dir: string, relPrefix: string) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (
        relPrefix === '' &&
        (entry.name === 'baseline' || entry.name === 'diff' || entry.name === 'cache')
      ) {
        continue;
      }
      const rel = relPrefix ? path.join(relPrefix, entry.name) : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile() && entry.name.endsWith('.png')) {
        results.push(rel.split(path.sep).join('/'));
      }
    }
  };
  walk(baseDir, '');
  return results.sort();
}

export async function compareShots(
  beforeDir: string,
  afterDir: string,
  diffDir: string,
  tolerance = 0,
  only?: string[]
): Promise<{same: boolean; changes: ShotChange[]}> {
  const onlyNormalized = only ? new Set(only.map(p => p.split(path.sep).join('/'))) : undefined;
  const beforeNames = listPngsRelative(beforeDir);
  const afterNames = listPngsRelative(afterDir);
  const names = [...new Set([...beforeNames, ...afterNames])]
    .filter(name => !onlyNormalized || onlyNormalized.has(name))
    .sort();
  await fsp.rm(diffDir, {recursive: true, force: true});
  await fsp.mkdir(diffDir, {recursive: true});

  const beforeRegions = readRegionsFile(beforeDir);
  const afterRegions = readRegionsFile(afterDir);
  const beforeSet = new Set(beforeNames);
  const afterSet = new Set(afterNames);
  const results = new Array<ShotChange | undefined>(names.length);
  const concurrency = Math.min(names.length, Math.max(1, os.availableParallelism()));
  let nextIdx = 0;

  const compareOne = async (idx: number): Promise<void> => {
    const name = names[idx];
    if (!afterSet.has(name)) {
      results[idx] = {
        name,
        note: `only in ${path.relative(ROOT, beforeDir) || beforeDir}`,
        status: 'removed',
      };
      return;
    }
    if (!beforeSet.has(name)) {
      results[idx] = {
        name,
        note: `only in ${path.relative(ROOT, afterDir) || afterDir}`,
        status: 'added',
      };
      return;
    }
    const [rawA, rawB] = await Promise.all([
      fsp.readFile(path.join(beforeDir, name)),
      fsp.readFile(path.join(afterDir, name)),
    ]);
    if (rawA.equals(rawB)) return;
    const [a, b] = await Promise.all([decodePngAsync(rawA), decodePngAsync(rawB)]);
    const resized = a.width !== b.width || a.height !== b.height;
    if (!resized && a.data.equals(b.data)) return;

    let viewerRects: readonly Rect[] | undefined;
    if (!resized) {
      if (beforeRegions && afterRegions) {
        const bRects = beforeRegions[name] ?? [];
        const aRects = afterRegions[name] ?? [];
        if (rectsMatch(bRects, aRects) && aRects.length > 0) {
          viewerRects = aRects;
        }
      } else {
        const fallback = afterRegions?.[name] ?? beforeRegions?.[name];
        if (fallback?.length) viewerRects = fallback;
      }
    }

    if (!resized && !exceedsDiffTolerance(a, b, viewerRects, tolerance)) return;

    const {image, count} = diffPngImages(a, b, {viewerRects});
    if (count === 0 || (count <= tolerance && !resized)) return;

    const pctNum = Number(((100 * count) / (image.width * image.height)).toFixed(2));
    const pct = pctNum.toFixed(2);
    const sizeNote = resized ? `, ${a.width}×${a.height} → ${b.width}×${b.height}` : '';
    const diffPath = path.join(diffDir, name);
    await fsp.mkdir(path.dirname(diffPath), {recursive: true});
    await fsp.writeFile(diffPath, await encodePngAsync(image));
    results[idx] = {
      name,
      note: `${count} px (${pct}%)${sizeNote}`,
      diffPath,
      status: 'modified',
      pixels: count,
      percent: pctNum,
    };
  };

  await Promise.all(
    Array.from({length: concurrency}, async () => {
      while (nextIdx < names.length) {
        const idx = nextIdx++;
        await compareOne(idx);
      }
    })
  );

  const changes = results.filter((c): c is ShotChange => c !== undefined);
  return {same: changes.length === 0, changes};
}

function buildGalleryScript(opts: {
  sectionsJson: string;
  itemsJson: string;
  viewportsJson: string;
  changesJson: string;
  hasBaselineJson: string;
}): string {
  return `
    (() => {
      const SECTIONS = ${opts.sectionsJson};
      const ITEMS = ${opts.itemsJson};
      const VIEWPORTS = ${opts.viewportsJson};
      const CHANGES = ${opts.changesJson};
      const HAS_BASELINE = ${opts.hasBaselineJson};

      const changeBySlot = {};
      const changesByScenario = {};
      for (const c of CHANGES) {
        changeBySlot[c.name] = c;
        const parts = c.name.split('/');
        if (parts.length >= 3) {
          const vp = parts[0];
          const theme = parts[1];
          const scen = parts.slice(2).join('/').replace(/\\.png$/i, '');
          if (!changesByScenario[scen]) changesByScenario[scen] = [];
          changesByScenario[scen].push({
            vp,
            theme,
            name: c.name,
            note: c.note,
            hasDiff: c.hasDiff,
            status: c.status,
            pixels: c.pixels,
            percent: c.percent,
          });
        }
      }
      const changedScenarioSet = new Set(Object.keys(changesByScenario));

      let currentVp = 'desktop';
      let currentTheme = 'light';
      let currentMode = 'carousel';
      let currentFilter = 'all';
      let currentCompare = 'after';
      let currentSectionFilter = 'all';
      let activeSectionId = SECTIONS[0]?.id || 'static';
      const indexBySection = {};
      for (const sec of SECTIONS) indexBySection[sec.id] = 0;

      const mainEl = document.getElementById('atlas-main');
      const secNavEl = document.getElementById('section-nav');
      const summaryEl = document.getElementById('atlas-summary');
      const diffSummaryWrapEl = document.getElementById('diff-summary-wrap');
      const filterGroupEl = document.getElementById('filter-group');
      const compareGroupEl = document.getElementById('compare-group');

      const slotKey = name => currentVp + '/' + currentTheme + '/' + name + '.png';
      const afterSrc = name => slotKey(name);
      const beforeSrc = name => 'baseline/' + slotKey(name);
      const diffSrc = name => 'diff/' + slotKey(name);

      if (HAS_BASELINE) {
        filterGroupEl.classList.remove('hide');
        compareGroupEl.classList.remove('hide');
      }

      const filteredItemsForSection = secId => ITEMS.filter(
        item => item.section === secId &&
          (currentFilter !== 'changed' || changedScenarioSet.has(item.name))
      );

      const renderDiffHeaderSummary = () => {
        diffSummaryWrapEl.innerHTML = '';
        if (!HAS_BASELINE) return;

        if (CHANGES.length > 0) {
          const pill = document.createElement('button');
          pill.type = 'button';
          pill.className = 'diff-summary-pill';
          pill.title = 'Click to toggle Changed Only filter and 3-Up Diff view';
          pill.textContent =
            'Δ ' + changedScenarioSet.size + ' of ' + ITEMS.length +
            ' states changed (' + CHANGES.length + ' shots)';
          pill.addEventListener('click', () => {
            currentFilter = currentFilter === 'changed' ? 'all' : 'changed';
            if (currentFilter === 'changed' && currentCompare === 'after') {
              currentCompare = 'split';
            }
            syncControlButtons();
            renderAll();
          });
          diffSummaryWrapEl.appendChild(pill);
        } else {
          const clean = document.createElement('span');
          clean.className = 'diff-summary-pill clean';
          clean.textContent = '✓ 0 changes vs baseline';
          diffSummaryWrapEl.appendChild(clean);
        }
      };

      const updateControlBadges = () => {
        const allBtn = filterGroupEl.querySelector('[data-filter="all"]');
        const chgBtn = filterGroupEl.querySelector('[data-filter="changed"]');
        if (allBtn) allBtn.textContent = 'All (' + ITEMS.length + ')';
        if (chgBtn) {
          chgBtn.innerHTML = 'Changed <span class="ctrl-delta">' +
            changedScenarioSet.size + '</span>';
        }

        const vpLabels = {
          desktop: 'Desktop (1280)',
          tablet: 'Tablet (744)',
          phone: 'Phone (390)',
          small: 'Small (375)',
        };
        document.querySelectorAll('#viewport-group button').forEach(btn => {
          const vp = btn.getAttribute('data-vp') || 'desktop';
          const prefix = vp + '/' + currentTheme + '/';
          const count = CHANGES.filter(c => c.name.startsWith(prefix)).length;
          btn.innerHTML = vpLabels[vp] +
            (count > 0 ? ' <span class="ctrl-delta">Δ' + count + '</span>' : '');
        });

        const themeLabels = {light: 'Light', dark: 'Dark'};
        document.querySelectorAll('#theme-group button').forEach(btn => {
          const th = btn.getAttribute('data-theme') || 'light';
          const prefix = currentVp + '/' + th + '/';
          const count = CHANGES.filter(c => c.name.startsWith(prefix)).length;
          btn.innerHTML = themeLabels[th] +
            (count > 0 ? ' <span class="ctrl-delta">Δ' + count + '</span>' : '');
        });
      };

      const renderSectionNav = () => {
        let totalVisible = 0;
        const counts = {};
        const diffCounts = {};
        for (const sec of SECTIONS) {
          const secItems = filteredItemsForSection(sec.id);
          counts[sec.id] = secItems.length;
          diffCounts[sec.id] = secItems.filter(i => changedScenarioSet.has(i.name)).length;
          totalVisible += secItems.length;
        }
        summaryEl.textContent =
          totalVisible + (currentFilter === 'changed' ? ' changed' : '') +
          ' states across ' + SECTIONS.length + ' sections';

        secNavEl.innerHTML = '';
        const allBtn = document.createElement('button');
        allBtn.type = 'button';
        allBtn.textContent = 'All (' + totalVisible + ')';
        if (currentSectionFilter === 'all') allBtn.classList.add('active');
        allBtn.addEventListener('click', () => {
          currentSectionFilter = 'all';
          renderAll();
        });
        secNavEl.appendChild(allBtn);

        SECTIONS.forEach((sec, idx) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.setAttribute('data-sec', sec.id);
          const dCount = diffCounts[sec.id];
          if (dCount > 0) btn.classList.add('has-diff');
          btn.innerHTML =
            '<span>' + (idx + 1) + '. ' + sec.title + ' (' + counts[sec.id] + ')</span>' +
            (dCount > 0 ? '<span class="ctrl-delta">Δ' + dCount + '</span>' : '');
          if (currentSectionFilter === sec.id) btn.classList.add('active');
          btn.addEventListener('click', () => {
            currentSectionFilter = currentSectionFilter === sec.id ? 'all' : sec.id;
            activeSectionId = sec.id;
            renderAll();
          });
          secNavEl.appendChild(btn);
        });
      };

      const stepSection = (secId, delta) => {
        const items = filteredItemsForSection(secId);
        if (!items.length) return;
        const cur = indexBySection[secId] || 0;
        const next = (cur + delta + items.length) % items.length;
        indexBySection[secId] = next;
        activeSectionId = secId;
        const chosen = items[next];
        if (chosen) history.replaceState(undefined, '', '#' + chosen.name);
        renderAll();
      };

      const renderAll = () => {
        document.documentElement.setAttribute('data-ui-theme', currentTheme);
        renderDiffHeaderSummary();
        updateControlBadges();
        renderSectionNav();
        mainEl.innerHTML = '';

        const vpWidth = VIEWPORTS[currentVp]?.width || 1280;
        let renderedSections = 0;

        SECTIONS.forEach((sec, secIdx) => {
          if (currentSectionFilter !== 'all' && currentSectionFilter !== sec.id) return;
          const items = filteredItemsForSection(sec.id);
          if (!items.length) return;
          renderedSections++;

          let activeIdx = indexBySection[sec.id] || 0;
          if (activeIdx >= items.length) {
            activeIdx = 0;
            indexBySection[sec.id] = 0;
          }
          const currentItem = items[activeIdx];
          const secDiffCount = items.filter(i => changedScenarioSet.has(i.name)).length;

          const card = document.createElement('section');
          card.className = 'section-card';
          card.id = 'section-' + sec.id;
          card.addEventListener('mouseenter', () => {
            activeSectionId = sec.id;
          });

          const head = document.createElement('div');
          head.className = 'section-head';
          head.innerHTML =
            '<h2>' + (secIdx + 1) + '. ' + sec.title +
            (secDiffCount > 0
              ? ' <span class="ctrl-delta">Δ ' + secDiffCount + ' changed</span>'
              : '') +
            '</h2>' +
            '<span class="section-counter">' +
            (currentMode === 'carousel'
              ? ('State ' + (activeIdx + 1) + ' of ' + items.length)
              : (items.length + ' states')) +
            '</span>';
          card.appendChild(head);

          const strip = document.createElement('div');
          strip.className = 'state-strip';
          items.forEach((item, idx) => {
            const slotChg = changeBySlot[slotKey(item.name)];
            const scenChgs = changesByScenario[item.name] || [];
            const pill = document.createElement('button');
            pill.type = 'button';
            let cls = 'state-pill';
            if (currentMode === 'carousel' && idx === activeIdx) cls += ' active';
            if (slotChg) cls += ' has-diff';
            else if (scenChgs.length > 0) cls += ' has-other-diff';
            pill.className = cls;

            const deltaHtml = slotChg
              ? '<span class="pill-delta" title="Changed in ' + currentVp + '/' + currentTheme +
                ': ' + slotChg.note + '">Δ</span>'
              : scenChgs.length > 0
                ? '<span class="pill-delta" title="Changed in ' +
                  scenChgs.map(c => c.vp + '/' + c.theme).join(', ') + '">Δ</span>'
                : '';

            pill.innerHTML =
              '<span class="num">' + (idx + 1) + '.</span>' +
              '<span>' + item.title + '</span>' +
              deltaHtml;
            pill.title = item.name + ' (' + item.path + ')' +
              (slotChg ? ' — ' + slotChg.note : '');
            pill.addEventListener('click', () => {
              indexBySection[sec.id] = idx;
              activeSectionId = sec.id;
              if (currentMode === 'grid') {
                currentMode = 'carousel';
                syncControlButtons();
              }
              history.replaceState(undefined, '', '#' + item.name);
              renderAll();
            });
            strip.appendChild(pill);
          });
          card.appendChild(strip);

          if (currentMode === 'carousel') {
            const slotChg = changeBySlot[slotKey(currentItem.name)];
            const scenChgs = changesByScenario[currentItem.name] || [];

            const bar = document.createElement('div');
            bar.className = 'carousel-bar';

            const titleRow = document.createElement('div');
            titleRow.className = 'carousel-title-row';

            const titleSpan = document.createElement('span');
            titleSpan.className = 'carousel-title';
            titleSpan.textContent = currentItem.title;
            titleRow.appendChild(titleSpan);

            const idBadge = document.createElement('code');
            idBadge.className = 'badge';
            idBadge.textContent = currentItem.name;
            titleRow.appendChild(idBadge);

            const routeBadge = document.createElement('code');
            routeBadge.className = 'badge';
            routeBadge.textContent = currentItem.path + ' · @' + currentItem.persona;
            titleRow.appendChild(routeBadge);

            if (slotChg) {
              const diffBadge = document.createElement('span');
              diffBadge.className = 'badge diff-badge';
              diffBadge.textContent = 'Δ ' + slotChg.note;
              titleRow.appendChild(diffBadge);
            }

            const rawLink = document.createElement('a');
            rawLink.className = 'badge';
            rawLink.href = afterSrc(currentItem.name);
            rawLink.target = '_blank';
            rawLink.rel = 'noopener';
            rawLink.textContent = HAS_BASELINE ? 'After PNG ↗' : 'Open PNG ↗';
            titleRow.appendChild(rawLink);

            if (HAS_BASELINE) {
              const beforeLink = document.createElement('a');
              beforeLink.className = 'badge';
              beforeLink.href = beforeSrc(currentItem.name);
              beforeLink.target = '_blank';
              beforeLink.rel = 'noopener';
              beforeLink.textContent = 'Before PNG ↗';
              titleRow.appendChild(beforeLink);
            }

            if (slotChg && slotChg.hasDiff) {
              const diffLink = document.createElement('a');
              diffLink.className = 'badge diff-badge';
              diffLink.href = diffSrc(currentItem.name);
              diffLink.target = '_blank';
              diffLink.rel = 'noopener';
              diffLink.textContent = 'Diff PNG ↗';
              titleRow.appendChild(diffLink);
            }

            bar.appendChild(titleRow);

            const nav = document.createElement('div');
            nav.className = 'carousel-nav';
            const prevBtn = document.createElement('button');
            prevBtn.type = 'button';
            prevBtn.className = 'nav-btn';
            prevBtn.textContent = '‹ Prev';
            prevBtn.addEventListener('click', () => stepSection(sec.id, -1));

            const nextBtn = document.createElement('button');
            nextBtn.type = 'button';
            nextBtn.className = 'nav-btn';
            nextBtn.textContent = 'Next ›';
            nextBtn.addEventListener('click', () => stepSection(sec.id, 1));

            nav.appendChild(prevBtn);
            nav.appendChild(nextBtn);
            bar.appendChild(nav);
            card.appendChild(bar);

            if (scenChgs.length > 0) {
              const callout = document.createElement('div');
              callout.className = 'diff-callout';
              const lbl = document.createElement('span');
              lbl.className = 'diff-callout-label';
              lbl.textContent =
                'Δ Changed in ' + scenChgs.length + ' of 8 slots ' +
                '(red changed, magenta beyond an edge):';
              callout.appendChild(lbl);

              scenChgs.forEach(c => {
                const slotBtn = document.createElement('button');
                slotBtn.type = 'button';
                const isCur = c.vp === currentVp && c.theme === currentTheme;
                slotBtn.className = 'diff-slot-btn' + (isCur ? ' active' : '');
                slotBtn.textContent = c.vp + ' / ' + c.theme + ' · ' + c.note;
                slotBtn.addEventListener('click', () => {
                  currentVp = c.vp;
                  currentTheme = c.theme;
                  if (currentCompare === 'after') currentCompare = 'split';
                  syncControlButtons();
                  renderAll();
                });
                callout.appendChild(slotBtn);
              });
              card.appendChild(callout);
            }

            const stage = document.createElement('div');
            stage.className = 'stage';

            if (currentCompare === 'split' && HAS_BASELINE) {
              const splitGrid = document.createElement('div');
              splitGrid.className = 'split-grid';

              const makeCol = (label, src, isDiffCol) => {
                const col = document.createElement('div');
                col.className = 'split-col' + (isDiffCol && slotChg ? ' diff-col-changed' : '');
                const colHead = document.createElement('div');
                colHead.className = 'split-col-head';
                colHead.innerHTML =
                  '<span>' + label + '</span>' +
                  (src
                    ? '<a class="badge" href="' + src +
                      '" target="_blank" rel="noopener">Open ↗</a>'
                    : '');
                col.appendChild(colHead);

                const colBody = document.createElement('div');
                colBody.className = 'split-col-body';
                if (src) {
                  const im = document.createElement('img');
                  im.src = src;
                  im.alt = currentItem.title + ' (' + label + ')';
                  im.title = 'Click to advance to next state in ' + sec.title;
                  im.addEventListener('click', () => stepSection(sec.id, 1));
                  colBody.appendChild(im);
                } else {
                  const msg = document.createElement('div');
                  msg.className = 'split-unchanged';
                  msg.textContent = slotChg
                    ? slotChg.note
                    : '✓ Identical in ' + currentVp + '/' + currentTheme + ' (0 px changed)';
                  colBody.appendChild(msg);
                }
                col.appendChild(colBody);
                return col;
              };

              const beforeColSrc = slotChg && slotChg.status === 'added'
                ? ''
                : beforeSrc(currentItem.name);
              const afterColSrc = slotChg && slotChg.status === 'removed'
                ? ''
                : afterSrc(currentItem.name);
              const diffColSrc = slotChg && slotChg.hasDiff ? diffSrc(currentItem.name) : '';

              splitGrid.appendChild(makeCol('Before (Baseline)', beforeColSrc, false));
              splitGrid.appendChild(makeCol('After (Current)', afterColSrc, false));
              splitGrid.appendChild(
                makeCol(
                  slotChg ? ('Pixel Diff · ' + slotChg.note) : 'Pixel Diff',
                  diffColSrc,
                  true
                )
              );
              stage.appendChild(splitGrid);
            } else {
              let displaySrc = afterSrc(currentItem.name);
              let isDiffFrame = false;
              if (currentCompare === 'before' && HAS_BASELINE) {
                displaySrc = beforeSrc(currentItem.name);
              } else if (currentCompare === 'diff' && HAS_BASELINE) {
                if (slotChg && slotChg.hasDiff) {
                  displaySrc = diffSrc(currentItem.name);
                  isDiffFrame = true;
                  const note = document.createElement('div');
                  note.className = 'stage-notice diff-active';
                  note.textContent =
                    'Pixel Diff (' + currentVp + '/' + currentTheme + '): ' + slotChg.note +
                    ' — Red changed pixels, magenta beyond resized edge.';
                  stage.appendChild(note);
                } else {
                  const note = document.createElement('div');
                  note.className = 'stage-notice';
                  note.textContent = slotChg
                    ? ('Status in ' + currentVp + '/' + currentTheme + ': ' + slotChg.note)
                    : ('✓ No pixel changes in ' + currentVp + '/' + currentTheme +
                      ' vs baseline (showing After screenshot).');
                  stage.appendChild(note);
                }
              }

              const frame = document.createElement('div');
              frame.className = 'shot-frame' + (isDiffFrame ? ' diff-frame' : '');
              frame.style.width = vpWidth + 'px';

              const img = document.createElement('img');
              img.src = displaySrc;
              img.alt = currentItem.title;
              img.title = 'Click to advance to next state in ' + sec.title;
              img.addEventListener('click', () => stepSection(sec.id, 1));
              frame.appendChild(img);
              stage.appendChild(frame);
            }
            card.appendChild(stage);

            const nextItem = items[(activeIdx + 1) % items.length];
            const prevItem = items[(activeIdx - 1 + items.length) % items.length];
            for (const neighbor of [nextItem, prevItem]) {
              if (neighbor && neighbor.name !== currentItem.name) {
                const pre = new Image();
                pre.src = afterSrc(neighbor.name);
              }
            }
          } else {
            const grid = document.createElement('div');
            grid.className = 'grid-view';
            items.forEach((item, idx) => {
              const slotChg = changeBySlot[slotKey(item.name)];
              const scenChgs = changesByScenario[item.name] || [];
              const cell = document.createElement('div');
              cell.className = 'grid-item' +
                (slotChg ? ' has-diff' : scenChgs.length > 0 ? ' has-other-diff' : '');

              let thumbSrc = afterSrc(item.name);
              if (currentCompare === 'before' && HAS_BASELINE) {
                thumbSrc = beforeSrc(item.name);
              } else if (
                (currentCompare === 'diff' || currentCompare === 'split') &&
                slotChg &&
                slotChg.hasDiff
              ) {
                thumbSrc = diffSrc(item.name);
              }

              const deltaBadge = slotChg
                ? '<span class="badge diff-badge">Δ ' + slotChg.note + '</span>'
                : scenChgs.length > 0
                  ? '<span class="badge diff-badge">Δ ' + scenChgs.length + ' slots</span>'
                  : '';

              cell.innerHTML =
                '<div class="grid-item-head">' +
                '<div class="grid-item-title"><span>' + (idx + 1) + '. ' + item.title + '</span>' +
                deltaBadge + '</div>' +
                '</div>' +
                '<div class="grid-item-img-wrap">' +
                '<img loading="lazy" src="' + thumbSrc + '" alt="' + item.title + '">' +
                '</div>';
              cell.addEventListener('click', () => {
                indexBySection[sec.id] = idx;
                activeSectionId = sec.id;
                currentMode = 'carousel';
                syncControlButtons();
                history.replaceState(undefined, '', '#' + item.name);
                renderAll();
                document.getElementById('section-' + sec.id)?.scrollIntoView({behavior: 'smooth'});
              });
              grid.appendChild(cell);
            });
            card.appendChild(grid);
          }

          mainEl.appendChild(card);
        });

        if (renderedSections === 0) {
          const empty = document.createElement('div');
          empty.className = 'empty-notice';
          empty.innerHTML = currentFilter === 'changed' && changedScenarioSet.size === 0
            ? '<strong>✓ All ' + ITEMS.length + ' states match baseline!</strong> ' +
              'Switch filter to <em>All</em> to browse the full Visual Atlas.'
            : 'No states match the current filter.';
          mainEl.appendChild(empty);
        }
      };

      const syncControlButtons = () => {
        document.querySelectorAll('#filter-group button').forEach(btn => {
          btn.classList.toggle('active', btn.getAttribute('data-filter') === currentFilter);
        });
        document.querySelectorAll('#compare-group button').forEach(btn => {
          btn.classList.toggle('active', btn.getAttribute('data-compare') === currentCompare);
        });
        document.querySelectorAll('#viewport-group button').forEach(btn => {
          btn.classList.toggle('active', btn.getAttribute('data-vp') === currentVp);
        });
        document.querySelectorAll('#theme-group button').forEach(btn => {
          btn.classList.toggle('active', btn.getAttribute('data-theme') === currentTheme);
        });
        document.querySelectorAll('#mode-group button').forEach(btn => {
          btn.classList.toggle('active', btn.getAttribute('data-mode') === currentMode);
        });
      };

      document.querySelectorAll('#filter-group button').forEach(btn => {
        btn.addEventListener('click', () => {
          currentFilter = btn.getAttribute('data-filter') || 'all';
          syncControlButtons();
          renderAll();
        });
      });

      document.querySelectorAll('#compare-group button').forEach(btn => {
        btn.addEventListener('click', () => {
          currentCompare = btn.getAttribute('data-compare') || 'after';
          syncControlButtons();
          renderAll();
        });
      });

      document.querySelectorAll('#viewport-group button').forEach(btn => {
        btn.addEventListener('click', () => {
          currentVp = btn.getAttribute('data-vp') || 'desktop';
          syncControlButtons();
          renderAll();
        });
      });

      document.querySelectorAll('#theme-group button').forEach(btn => {
        btn.addEventListener('click', () => {
          currentTheme = btn.getAttribute('data-theme') || 'light';
          syncControlButtons();
          renderAll();
        });
      });

      document.querySelectorAll('#mode-group button').forEach(btn => {
        btn.addEventListener('click', () => {
          currentMode = btn.getAttribute('data-mode') || 'carousel';
          syncControlButtons();
          renderAll();
        });
      });

      const selectHashScenario = hash => {
        const clean = (hash || '').replace(/^#/, '').trim();
        if (!clean) return;
        if (clean === 'diff' && HAS_BASELINE) {
          currentFilter = changedScenarioSet.size > 0 ? 'changed' : 'all';
          currentCompare = 'split';
          syncControlButtons();
          renderAll();
          return;
        }
        const found = ITEMS.find(item => item.name === clean);
        if (!found) return;
        if (currentFilter === 'changed' && !changedScenarioSet.has(found.name)) {
          currentFilter = 'all';
          syncControlButtons();
        }
        const secItems = filteredItemsForSection(found.section);
        const idx = secItems.findIndex(item => item.name === clean);
        if (idx >= 0) {
          indexBySection[found.section] = idx;
          activeSectionId = found.section;
          renderAll();
          document.getElementById('section-' + found.section)?.scrollIntoView();
        }
      };

      window.addEventListener('keydown', e => {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          stepSection(activeSectionId, 1);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          stepSection(activeSectionId, -1);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const visibleSecs = SECTIONS.filter(
            s => (currentSectionFilter === 'all' || currentSectionFilter === s.id) &&
              filteredItemsForSection(s.id).length > 0
          );
          if (!visibleSecs.length) return;
          const curIdx = Math.max(0, visibleSecs.findIndex(s => s.id === activeSectionId));
          const delta = e.key === 'ArrowDown' ? 1 : -1;
          const nextSec = visibleSecs[(curIdx + delta + visibleSecs.length) % visibleSecs.length];
          if (nextSec) {
            e.preventDefault();
            activeSectionId = nextSec.id;
            document.getElementById('section-' + nextSec.id)?.scrollIntoView({behavior: 'smooth'});
          }
        } else if (e.key === 't' || e.key === 'T') {
          currentTheme = currentTheme === 'light' ? 'dark' : 'light';
          syncControlButtons();
          renderAll();
        } else if (e.key === 'g' || e.key === 'G') {
          currentMode = currentMode === 'carousel' ? 'grid' : 'carousel';
          syncControlButtons();
          renderAll();
        } else if ((e.key === 'c' || e.key === 'C') && HAS_BASELINE) {
          currentFilter = currentFilter === 'all' ? 'changed' : 'all';
          syncControlButtons();
          renderAll();
        } else if ((e.key === 'd' || e.key === 'D') && HAS_BASELINE) {
          const order = ['after', 'split', 'diff', 'before'];
          currentCompare = order[(order.indexOf(currentCompare) + 1) % order.length];
          syncControlButtons();
          renderAll();
        } else if (e.key === '1') {
          currentVp = 'desktop';
          syncControlButtons();
          renderAll();
        } else if (e.key === '2') {
          currentVp = 'tablet';
          syncControlButtons();
          renderAll();
        } else if (e.key === '3') {
          currentVp = 'phone';
          syncControlButtons();
          renderAll();
        } else if (e.key === '4') {
          currentVp = 'small';
          syncControlButtons();
          renderAll();
        }
      });

      syncControlButtons();
      renderAll();
      if (location.hash) selectHashScenario(location.hash);
    })();
  `;
}

export function renderGalleryHtml(
  scenarios: readonly Scenario[],
  options: GalleryOptions = {}
): string {
  const changesList = (options.changes ?? []).map(c => ({
    name: c.name.split(path.sep).join('/'),
    note: c.note,
    hasDiff: Boolean(c.diffPath),
    status: c.status ?? 'modified',
    pixels: c.pixels ?? 0,
    percent: c.percent ?? 0,
  }));

  const scriptText = buildGalleryScript({
    sectionsJson: JSON.stringify(SECTIONS),
    itemsJson: JSON.stringify(
      scenarios.map(s => ({
        name: s.name,
        section: s.section,
        title: s.title,
        path: s.path,
        persona: s.githubUser ?? 'scheibo',
      }))
    ),
    viewportsJson: JSON.stringify(VIEWPORTS),
    changesJson: JSON.stringify(changesList),
    hasBaselineJson: JSON.stringify(Boolean(options.hasBaseline || changesList.length > 0)),
  });

  const doc = (
    <html lang='en'>
      <head>
        <meta charSet='utf-8' />
        <meta name='viewport' content='width=device-width, initial-scale=1' />
        <title>{`pkmn.ai Visual Atlas (${scenarios.length} States)`}</title>
        <style>{rawHtml(SHOTS_CSS)}</style>
      </head>
      <body>
        <header className='topbar'>
          <div className='topbar-row'>
            <div className='brand'>
              <h1>pkmn.ai Visual Atlas</h1>
              <span id='atlas-summary'>
                {`${scenarios.length} states across ${SECTIONS.length} sections`}
              </span>
              <span id='diff-summary-wrap'></span>
              <span className='kbd-hint'>
                Keys: ←/→ state · ↑/↓ section · 1–4 viewport · t theme · g grid · c changed · d
                diff
              </span>
            </div>
            <div className='controls'>
              <div
                className='ctrl-group hide'
                id='filter-group'
                title='Filter states by diff status (key: c)'
              >
                <button type='button' data-filter='all' className='active'>All</button>
                <button type='button' data-filter='changed'>Changed</button>
              </div>
              <div
                className='ctrl-group hide'
                id='compare-group'
                title='Comparison view mode (key: d)'
              >
                <button type='button' data-compare='after' className='active'>After</button>
                <button type='button' data-compare='before'>Before</button>
                <button type='button' data-compare='diff'>Diff</button>
                <button type='button' data-compare='split'>3-Up Diff</button>
              </div>
              <div className='ctrl-group' id='viewport-group' title='Viewport size (keys: 1–4)'>
                <button type='button' data-vp='desktop' className='active'>Desktop (1280)</button>
                <button type='button' data-vp='tablet'>Tablet (744)</button>
                <button type='button' data-vp='phone'>Phone (390)</button>
                <button type='button' data-vp='small'>Small (375)</button>
              </div>
              <div className='ctrl-group' id='theme-group' title='Color scheme (key: t)'>
                <button type='button' data-theme='light' className='active'>Light</button>
                <button type='button' data-theme='dark'>Dark</button>
              </div>
              <div className='ctrl-group' id='mode-group' title='Display mode (key: g)'>
                <button type='button' data-mode='carousel' className='active'>Carousel</button>
                <button type='button' data-mode='grid'>Grid</button>
              </div>
            </div>
          </div>
          <nav className='section-nav' id='section-nav'></nav>
        </header>
        <main id='atlas-main'></main>
        <script>{rawHtml(scriptText)}</script>
      </body>
    </html>
  );

  return `<!doctype html>\n${String(doc)}`;
}

async function serveExternal(route: Route, forceOffline: boolean): Promise<void> {
  const url = new URL(route.request().url());
  if (url.href === WIKI_MOCK_IMAGE_URL) {
    cachedWikiMockChartPng ??= buildWikiMockChartPng();
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: cachedWikiMockChartPng,
    });
    return;
  }
  if (
    !forceOffline &&
    (url.hostname === 'avatars.githubusercontent.com' || url.hostname === 'cdn.discordapp.com')
  ) {
    const asset = await fetchExternalAsset(MOCK_AVATAR_URL);
    if (asset) {
      await route.fulfill({
        status: 200,
        contentType: asset.contentType,
        headers: {'access-control-allow-origin': '*'},
        body: asset.body,
      });
      return;
    }
  }
  if (!forceOffline && EXTERNAL_HOSTS.has(url.hostname)) {
    const asset = await fetchExternalAsset(url);
    if (asset) {
      await route.fulfill({
        status: 200,
        contentType: asset.contentType,
        headers: {'access-control-allow-origin': '*'},
        body: asset.body,
      });
      return;
    }
  }
  await route.fulfill({status: 204, body: ''});
}

type Theme = (typeof THEMES)[number];

interface SlotWorker {
  assignedDevice: ViewportId;
  assignedTheme: Theme;
  context: BrowserContext;
  page: Page;
  problems: string[];
  configure: (
    device: ViewportId,
    theme: Theme,
    cookieToken: string,
    offline: boolean
  ) => Promise<void>;
  resetPendingRequests: () => void;
  waitForNetworkQuiet: () => Promise<void>;
}

interface SlotSpec {
  device: ViewportId;
  viewport: {width: number; height: number};
  theme: Theme;
}

const SLOT_SPECS: readonly SlotSpec[] = VIEWPORT_ORDER.flatMap(
  device => THEMES.map(theme => ({device, viewport: VIEWPORTS[device], theme}))
);

async function createSlotWorkers(
  browsers: readonly Browser[],
  fixture: Fixture
): Promise<SlotWorker[]> {
  return Promise.all(
    SLOT_SPECS.map(async ({device, viewport, theme}, idx) => {
      const browser = browsers[idx % browsers.length];
      let currentDevice: ViewportId = device;
      let currentTheme: Theme = theme;
      let currentToken: string | undefined;
      let currentOffline = false;
      const pendingRequests = new Set<Request>();
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      const quietResolvers: Array<() => void> = [];

      const flushQuiet = () => {
        quietTimer = undefined;
        if (pendingRequests.size !== 0) return;
        const pending = quietResolvers.splice(0);
        for (const resolve of pending) resolve();
      };
      const scheduleQuiet = () => {
        if (quietTimer !== undefined) clearTimeout(quietTimer);
        quietTimer = setTimeout(flushQuiet, NETWORK_QUIET_MILLIS);
      };
      const waitForNetworkQuiet = (): Promise<void> => new Promise(resolve => {
        quietResolvers.push(resolve);
        if (pendingRequests.size === 0) scheduleQuiet();
      });

      const context = await browser.newContext({
        viewport,
        colorScheme: theme,
        deviceScaleFactor: 1,
        baseURL: fixture.origin,
        timezoneId: 'UTC',
        locale: 'en-US',
      });
      await context.route(
        url => (url.protocol === 'http:' || url.protocol === 'https:') &&
          url.origin !== fixture.origin,
        route => serveExternal(route, currentOffline)
      );
      const page = await context.newPage();
      const problems: string[] = [];
      page.on('pageerror', error => problems.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error') problems.push(message.text());
      });
      page.on('request', req => {
        pendingRequests.add(req);
        if (quietTimer !== undefined) {
          clearTimeout(quietTimer);
          quietTimer = undefined;
        }
      });
      const finishRequest = (req: Request) => {
        pendingRequests.delete(req);
        if (pendingRequests.size === 0 && quietResolvers.length > 0) {
          scheduleQuiet();
        }
      };
      page.on('requestfinished', finishRequest);
      page.on('requestfailed', finishRequest);
      await page.clock.setFixedTime(NOW);

      return {
        assignedDevice: device,
        assignedTheme: theme,
        context,
        page,
        problems,
        configure: async (
          nextDevice: ViewportId,
          nextTheme: Theme,
          nextToken: string,
          offline: boolean
        ) => {
          currentOffline = offline;
          if (nextDevice !== currentDevice) {
            await page.setViewportSize(VIEWPORTS[nextDevice]);
            currentDevice = nextDevice;
          }
          if (nextTheme !== currentTheme) {
            await page.emulateMedia({colorScheme: nextTheme});
            currentTheme = nextTheme;
          }
          if (nextToken !== currentToken) {
            if (nextToken) {
              await context.addCookies([
                {name: auth.SESSION_COOKIE, value: nextToken, url: fixture.origin},
              ]);
            } else {
              await context.clearCookies();
            }
            currentToken = nextToken;
          }
        },
        resetPendingRequests: () => {
          pendingRequests.clear();
          if (quietTimer !== undefined) {
            clearTimeout(quietTimer);
            quietTimer = undefined;
          }
        },
        waitForNetworkQuiet,
      };
    })
  );
}

const WAIT_PAINT_EXPR =
  'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))';

const WAIT_IMAGES_EXPR = `(async () => {
  for (const image of document.querySelectorAll("img")) image.loading = "eager";
  await document.fonts.ready;
  const pending = [...document.images].filter((image) => !image.complete);
  await Promise.all(
    pending.map((image) => new Promise((done) => (image.onload = image.onerror = done)))
  );
  const bgUrls = new Set();
  for (const el of document.querySelectorAll('[style*="url("]')) {
    const m = /url\\(["']?([^"')]+)["']?\\)/.exec(el.getAttribute("style") || "");
    if (m && m[1]) bgUrls.add(m[1]);
  }
  await Promise.all(
    [...bgUrls].map(
      (src) =>
        new Promise((done) => {
          const img = new Image();
          img.onload = img.onerror = done;
          img.src = src;
        })
    )
  );
})()`;

interface FrameOverlay {
  x: number;
  y: number;
  png: Buffer;
}

const SETTLE_VIEWER_EXPR = `(() => {
  if (window.jQuery) {
    window.jQuery.fx.off = true;
    window.jQuery(":animated").stop(true, true);
  }
})()`;

// Chromium's `Page.captureScreenshot(captureBeyondViewport: true)` omits out-of-process
// `sandbox="allow-scripts"` (opaque-origin) iframe surfaces that sit below the initial viewport.
// Measuring all viewer coordinates at `(0, 0)` first, scrolling each frame to a deterministic
// integer offset before capture, and compositing onto the full-page PNG keeps production
// `sandbox="allow-scripts"` intact without 1px scroll-rounding shifts or blank replay shots.
async function waitForViewerFrames(page: Page): Promise<FrameOverlay[]> {
  const handles = await page.locator('iframe.viewer-frame').elementHandles();
  if (handles.length === 0) return [];
  const overlays: FrameOverlay[] = [];
  await page.evaluate('window.scrollTo(0, 0)');
  const measured = await Promise.all(
    handles.map(async handle => {
      const info = await handle.evaluate((el: Element) => {
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        const isLiveFrame = el.id === 'ps-viewer-frame';
        const checked = document.querySelector<HTMLInputElement>(
          '#table-nav-wrap input[type="radio"]:checked'
        );
        const label = checked
          ? document.querySelector(`label[for="${checked.id}"]`)
          : undefined;
        const isIdleTable = Boolean(
          isLiveFrame && label?.textContent?.includes('(idle)')
        );
        return {
          visible,
          isIdleTable,
          x: Math.round(rect.left),
          y: Math.round(rect.top),
        };
      });
      return {handle, info};
    })
  );

  for (const {handle, info} of measured) {
    if (!info.visible) continue;
    const scrollTargetY = Math.max(0, info.y - 16);
    await page.evaluate((sy: number) => window.scrollTo(0, sy), scrollTargetY);
    const frame = await handle.contentFrame();
    if (!frame) continue;
    await frame.waitForFunction(
      expectIdle => {
        const status = document.getElementById('status');
        if (!status) return false;
        if (status.textContent === 'Loading battle viewer…') return false;
        if (status.dataset.offline === 'true') {
          return document.body?.dataset.settled === 'true';
        }
        if (expectIdle) return status.textContent === 'Waiting for battle…';
        return status.hidden && Boolean(document.querySelector('#battle .innerbattle'));
      },
      info.isIdleTable,
      {timeout: 10000}
    );
    await frame.evaluate(WAIT_IMAGES_EXPR);
    await frame.evaluate(SETTLE_VIEWER_EXPR);
    await page.waitForTimeout(VIEWER_SETTLE_MILLIS);
    const png = await handle.screenshot({animations: 'disabled', caret: 'hide'});
    overlays.push({x: info.x, y: info.y, png});
  }
  return overlays;
}

async function compositeFrameOverlays(
  basePng: Buffer,
  overlays: FrameOverlay[]
): Promise<{png: Buffer; rects: Rect[]}> {
  if (overlays.length === 0) return {png: basePng, rects: []};
  const [base, ...patches] = await Promise.all([
    decodePngAsync(basePng),
    ...overlays.map(ov => decodePngAsync(ov.png)),
  ]);
  const rects: Rect[] = [];
  for (let i = 0; i < overlays.length; i++) {
    const ov = overlays[i];
    const patch = patches[i];
    const dstX = Math.max(0, ov.x);
    const dstY = Math.max(0, ov.y);
    const maxRows = Math.min(patch.height, base.height - dstY);
    const maxCols = Math.min(patch.width, base.width - dstX);
    if (maxRows <= 0 || maxCols <= 0) continue;
    for (let r = 0; r < maxRows; r++) {
      const dstRow = dstY + r;
      const srcStart = r * patch.width * 4;
      const srcEnd = srcStart + maxCols * 4;
      const dstStart = (dstRow * base.width + dstX) * 4;
      patch.data.copy(base.data, dstStart, srcStart, srcEnd);
    }
    rects.push({x: dstX, y: dstY, width: maxCols, height: maxRows});
  }
  return {png: await encodePngAsync(base), rects};
}

async function shootWithWorker(
  worker: SlotWorker,
  scenario: Scenario,
  device: ViewportId,
  theme: Theme,
  file: string,
  fixture: Fixture
): Promise<{problems: string[]; viewerRects: Rect[]}> {
  const token = scenario.githubUser === 'anonymous'
    ? ''
    : (fixture.cookies[scenario.githubUser ?? 'scheibo'] ?? fixture.cookies.scheibo);
  await worker.configure(device, theme, token, Boolean(scenario.offline));
  worker.problems.length = 0;

  if (scenario.beforePage) {
    await scenario.beforePage(fixture);
  }

  const {page} = worker;
  if (page.url().startsWith(fixture.origin)) {
    await page.evaluate("try { localStorage.removeItem('theme'); } catch {}");
  }
  worker.resetPendingRequests();
  const navRes = await page.goto(scenario.path);
  await worker.waitForNetworkQuiet();
  await page.evaluate(WAIT_IMAGES_EXPR);
  if (scenario.click) {
    await page.click(scenario.click);
    await page.waitForLoadState('load');
    await worker.waitForNetworkQuiet();
    await page.evaluate(WAIT_IMAGES_EXPR);
  }
  if (scenario.act) {
    await scenario.act(page, fixture);
    await page.waitForLoadState('load');
    await worker.waitForNetworkQuiet();
    await page.evaluate(WAIT_IMAGES_EXPR);
  }
  const overlays = await waitForViewerFrames(page);
  if (overlays.length > 0) {
    await page.evaluate(WAIT_IMAGES_EXPR);
  }
  await page.evaluate('window.scrollTo(0, 0)');
  await page.evaluate(WAIT_PAINT_EXPR);
  const overflow = await page.evaluate<number>(
    'document.documentElement.scrollWidth - window.innerWidth'
  );
  if (overflow > 0) {
    worker.problems.push(`horizontal overflow: +${overflow}px`);
  }
  // Chromium's `captureBeyondViewport` full-page screenshot intermittently shifts sticky
  // table-column compositor tiles by 1px on tall mobile pages even when `scrollLeft === 0`.
  await page.evaluate(`(() => {
    const sel = "table.matrix th:first-child, table.matrix td:first-child";
    for (const el of document.querySelectorAll(sel)) {
      const wrap = el.closest(".table-wrap");
      if (!wrap || wrap.scrollLeft === 0) el.style.position = "static";
    }
  })()`);
  const rawShot = await page.screenshot({fullPage: true, animations: 'disabled', caret: 'hide'});
  const composited = await compositeFrameOverlays(rawShot, overlays);
  await fsp.writeFile(file, composited.png);
  const expectedHttpPrefix = scenario.expectHttpError
    ? `Failed to load resource: the server responded with a status of ${scenario.expectHttpError} `
    : undefined;
  if (
    scenario.expectHttpError &&
    navRes?.status() !== scenario.expectHttpError &&
    (!expectedHttpPrefix || !worker.problems.some(p => p.startsWith(expectedHttpPrefix)))
  ) {
    worker.problems.push(
      `expected HTTP ${scenario.expectHttpError}, got ${navRes?.status() ?? 'no error'}`
    );
  }
  return {
    problems: worker.problems.filter(p => !expectedHttpPrefix || !p.startsWith(expectedHttpPrefix)),
    viewerRects: composited.rects,
  };
}

function printScenarioList(scenarios: readonly Scenario[]): void {
  for (const section of SECTIONS) {
    const names = scenarios.filter(s => s.section === section.id).map(s => s.name);
    if (names.length === 0) continue;
    console.log(`${section.id} (${names.length}): ${names.join(', ')}`);
  }
}

async function run(): Promise<void> {
  const {values} = parseArgs({
    options: {
      only: {type: 'string', multiple: true},
      baseline: {type: 'boolean', default: false},
      tolerance: {type: 'string', default: '0'},
      list: {type: 'boolean', default: false},
    },
  });

  const onlyFilters = values.only ?? [];
  const previewScenarios = filterScenarios(buildScenarios(''), onlyFilters);
  if (values.list) {
    printScenarioList(previewScenarios);
    return;
  }
  if (previewScenarios.length === 0) {
    console.error(
      `No scenarios matched --only ${onlyFilters.join(',')}. ` +
      `Valid sections: ${SECTIONS.map(s => s.id).join(', ')} (use --list to inspect all names).`
    );
    process.exit(1);
  }

  if (!fs.existsSync(path.join(PUBLIC, 'index.html'))) {
    console.error('There is no build to screenshot: run `npm run build` first.');
    process.exit(1);
  }

  const newDir = `${SHOTS_DIR}.new`;
  const browserCount = previewScenarios.every(s => s.serial)
    ? 1
    : Math.min(SLOT_SPECS.length, Math.max(1, os.availableParallelism()));

  const prepareStagingDirs = async (): Promise<void> => {
    await fsp.rm(newDir, {recursive: true, force: true});
    await Promise.all(
      SLOT_SPECS.map(({device, theme}) => fsp.mkdir(
        path.join(newDir, device, theme),
        {recursive: true}
      ))
    );
  };

  const [fixture, browsers] = await Promise.all([
    startFixture(),
    Promise.all(Array.from({length: browserCount}, () => launch())),
    prepareStagingDirs(),
  ]);

  const allScenarios = buildScenarios(fixture.sha);
  const scenarios = filterScenarios(allScenarios, onlyFilters);
  const parallelScenarios = scenarios.filter(s => !s.setup && !s.beforePage && !s.serial);
  const exclusiveScenarios = scenarios.filter(s => Boolean(s.setup || s.beforePage || s.serial));

  const shotPaths: string[] = [];
  const shotRegions: RegionsMap = {};
  const errors: string[] = [];
  const recordShot = async (
    worker: SlotWorker,
    scenario: Scenario,
    device: ViewportId,
    theme: Theme
  ): Promise<void> => {
    const relPath = path.join(device, theme, `${scenario.name}.png`);
    const {problems, viewerRects} = await shootWithWorker(
      worker,
      scenario,
      device,
      theme,
      path.join(newDir, relPath),
      fixture
    );
    shotPaths.push(relPath);
    shotRegions[relPath.split(path.sep).join('/')] = viewerRects;
    errors.push(
      ...problems.map(
        problem => `${scenario.name} (${device}/${theme}): ${problem}`
      )
    );
  };

  try {
    const workers = await createSlotWorkers(browsers, fixture);
    try {
      // Read-only scenarios share the pristine default fixture; dispatch (scenario, viewport,
      // theme) jobs from a single heaviest-first queue so all browser processes stay busy until
      // the last shot rather than idling behind slower desktop/viewer slots.
      if (parallelScenarios.length > 0) {
        const isHeavy = (s: Scenario) =>
          s.section === 'tournaments' || s.name.includes('replay') || s.name.includes('rand-live');
        const ordered = [...parallelScenarios].sort(
          (a, b) => Number(isHeavy(b)) - Number(isHeavy(a))
        );
        const jobs = ordered.flatMap(
          scenario => SLOT_SPECS.map(({device, theme}) => ({scenario, device, theme}))
        );
        const remaining = new Map(parallelScenarios.map(s => [s.name, SLOT_SPECS.length]));
        let nextJob = 0;
        await Promise.all(
          workers.map(async worker => {
            while (nextJob < jobs.length) {
              const job = jobs[nextJob++];
              await recordShot(worker, job.scenario, job.device, job.theme);
              const left = (remaining.get(job.scenario.name) ?? 1) - 1;
              remaining.set(job.scenario.name, left);
              if (left === 0) console.log(`  ${job.scenario.name}`);
            }
          })
        );
      }

      for (const scenario of exclusiveScenarios) {
        const cleanup = scenario.setup ? await scenario.setup(fixture) : undefined;
        try {
          if (scenario.serial) {
            for (const worker of workers) {
              await recordShot(worker, scenario, worker.assignedDevice, worker.assignedTheme);
            }
          } else {
            await Promise.all(
              workers.map(
                w => recordShot(w, scenario, w.assignedDevice, w.assignedTheme)
              )
            );
          }
          console.log(`  ${scenario.name}`);
        } finally {
          if (cleanup) await cleanup();
        }
      }
    } finally {
      await Promise.all(workers.map(w => w.context.close()));
    }
  } finally {
    await Promise.all([
      ...browsers.map(browser => browser.close()),
      fixture.close(),
    ]);
  }

  const isFiltered = onlyFilters.length > 0;
  if (!isFiltered) {
    await Promise.all(
      Object.keys(VIEWPORTS).flatMap(device => [
        fsp.rm(path.join(SHOTS_DIR, device), {recursive: true, force: true}),
        ...(values.baseline
          ? [fsp.rm(path.join(BASELINE_DIR, device), {recursive: true, force: true})]
          : []),
      ])
    );
  }
  await Promise.all(
    SLOT_SPECS.flatMap(({device, theme}) => [
      fsp.mkdir(path.join(SHOTS_DIR, device, theme), {recursive: true}),
      ...(values.baseline
        ? [fsp.mkdir(path.join(BASELINE_DIR, device, theme), {recursive: true})]
        : []),
    ])
  );
  await Promise.all(
    shotPaths.map(async relPath => {
      const src = path.join(newDir, relPath);
      const dest = path.join(SHOTS_DIR, relPath);
      if (values.baseline) {
        await fsp.copyFile(src, path.join(BASELINE_DIR, relPath));
      }
      await fsp.rename(src, dest);
    })
  );
  await fsp.rm(newDir, {recursive: true, force: true});
  await writeRegionsFile(REGIONS_FILE, shotRegions, isFiltered);
  if (values.baseline) {
    await writeRegionsFile(BASELINE_REGIONS_FILE, shotRegions, isFiltered);
  }

  const presentScenarios = allScenarios.filter(
    s => fs.existsSync(path.join(SHOTS_DIR, 'desktop', 'light', `${s.name}.png`))
  );
  const galleryScenarios = presentScenarios.length > 0 ? presentScenarios : scenarios;
  const hasBaseline = fs.existsSync(BASELINE_DIR);
  let changes: ShotChange[] = [];
  let same = true;

  if (values.baseline) {
    await fsp.rm(DIFF_DIR, {recursive: true, force: true});
  } else if (hasBaseline) {
    const tolerance = Number(values.tolerance) || 0;
    const only = isFiltered ? shotPaths : undefined;
    const cmp = await compareShots(BASELINE_DIR, SHOTS_DIR, DIFF_DIR, tolerance, only);
    changes = cmp.changes;
    same = cmp.same;
  }

  await fsp.mkdir(SHOTS_DIR, {recursive: true});
  await fsp.writeFile(
    GALLERY_FILE,
    renderGalleryHtml(galleryScenarios, {changes, hasBaseline}),
    'utf8'
  );

  const targetLabel = values.baseline
    ? path.relative(ROOT, BASELINE_DIR)
    : path.relative(ROOT, SHOTS_DIR);
  console.log(
    `Screenshots of ${scenarios.length} scenarios in ${targetLabel} ` +
    `(gallery: ${path.relative(ROOT, GALLERY_FILE)}).`
  );
  if (unreachableHosts.size > 0) {
    console.log(
      `  note: external host(s) unreachable (${[...unreachableHosts].sort().join(', ')}); ` +
      'rendered with offline fallbacks.'
    );
  }
  for (const error of new Set(errors)) console.warn(`  error: ${error}`);

  if (!values.baseline && hasBaseline) {
    for (const {name, note} of changes) {
      console.log(`  changed  ${name}  ${note}`);
    }
    if (same) {
      console.log(`All compared screenshots match ${path.relative(ROOT, BASELINE_DIR)}.`);
    } else {
      console.log(
        `${changes.length} screenshot(s) changed. ` +
        `See ${path.relative(ROOT, GALLERY_FILE)}`
      );
    }
  }

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
