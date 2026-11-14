// Visual regression, edge-case coverage & interactive gallery (`npm run shots [-- --only <q>]`).
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
import {parseArgs} from 'util';
import * as zlib from 'zlib';

import {Browser, BrowserContext, Page, Route, chromium} from 'playwright-core';
import polka from 'polka';

import {Database} from '../db';
import * as account from '../server/account';
import * as arena from '../server/arena';
import * as auth from '../server/auth';
import * as render from '../server/render';
import * as teams from '../server/teams';
import * as tournaments from '../server/tournaments';
import * as wiki from '../server/wiki';
import {syncStaticLiveBanner} from '../static/build';
import {ROOT, renderTemplate, root} from '../static/util';

import * as mock from './mock';

const PUBLIC = root('public');
const SHOTS_DIR = root('.shots');
export const BASELINE_DIR = path.join(SHOTS_DIR, 'baseline');
export const DIFF_DIR = path.join(SHOTS_DIR, 'diff');
export const GALLERY_FILE = path.join(SHOTS_DIR, 'index.html');
const SHOTS_HTML = fs.readFileSync(root('tools', 'shots.html'), 'utf8');
const SHOTS_CSS = fs.readFileSync(root('tools', 'shots.css'), 'utf8');

const ORIGIN = 'http://pkmn.test';
const NOW = Date.parse('2026-10-20T12:00:00Z');
const NOW_SECONDS = Math.floor(NOW / 1000);
const VGC_LADDER_ID = 'gen9championsvgc2026regmc';
const RBY_LADDER_ID = 'gen1ou20261109';
const VIEWPORTS = {
  small: {width: 375, height: 667}, // iPhone SE (3rd generation)
  phone: {width: 390, height: 844}, // iPhone 14
  tablet: {width: 744, height: 1133}, // iPad mini (6th generation, portrait)
  desktop: {width: 1280, height: 900},
};
const THEMES = ['light', 'dark'] as const;
const SETTLE_MILLIS = 150;

export type SectionId =
  'content' | 'projects' | 'arena' | 'battles' | 'tournaments' | 'account' | 'wiki';

export interface SectionMeta {
  id: SectionId;
  title: string;
  subtitle: string;
}

export const SECTIONS: readonly SectionMeta[] = [
  {
    id: 'content',
    title: 'Overview & Reference Pages',
    subtitle:
      'Static documentation, domain background, concept deep-dives, academic bibliography, ' +
      'competition rules, and 404 error page.',
  },
  {
    id: 'projects',
    title: 'Projects Directory & Agent Profiles',
    subtitle:
      'Catalog filtering (All / Active / Arena / Inactive) and per-agent statistical profiles ' +
      'across multi-version champions, filters, inline match drawers, provisional, and empty ' +
      'states.',
  },
  {
    id: 'arena',
    title: 'Arena Hub & Ladders',
    subtitle:
      'Central hub, past seasons archive, and continuous leaderboards across Active / Best / All ' +
      'version tabs, harvested & pools modes, and upcoming / settling / archived lifecycles.',
  },
  {
    id: 'battles',
    title: 'Arena Battles',
    subtitle:
      'Live battle telemetry (active turn, idle with tournament banner, stale/offline), format ' +
      'filters, pagination, and inline expandable normal, timeout, crash, and archived-pool rows.',
  },
  {
    id: 'tournaments',
    title: 'Championship Tournaments',
    subtitle:
      'Completed events with 100-game Superfinals and inline Showdown replay viewer, live ' +
      'multi-table broadcasts with active/idle tables, and scheduled upcoming registrations.',
  },
  {
    id: 'account',
    title: 'Account & Submissions',
    subtitle:
      'Every developer persona and eligibility state: 403 unregistered/disabled, Pending ' +
      '(locked vs tournament open), Qualified, Eligible, incremental VGC team validation ' +
      '(0/20, rejections, 10/20, 20/20), submission errors, smoke pending/failed/quarantined, ' +
      '14d cooldown, unsettled provisional, and Smogon-banned.',
  },
  {
    id: 'wiki',
    title: 'Wiki & Authentication',
    subtitle:
      'Git-backed Djot wiki across public, Discord, and developer visibilities, live preview, ' +
      'revision history, snapshots, unified diffs, 403/404 permission gates, and Dev Auth.',
  },
];

export interface Scenario {
  name: string;
  section: SectionId;
  title: string;
  description: string;
  path: string;
  click?: string;
  githubUser?: string;
  serial?: boolean;
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
      'UPDATE schema_migrations SET applied_at = applied_at'
    );
    afterCleanup?.();
  };
}

function setupRotatedSeasons(
  fixture: Fixture,
  mode: 'settling' | 'archived' | 'both'
): () => void {
  const archiveDir = path.join(fixture.publicDir, 'arena', 'ladders', VGC_LADDER_ID);
  const archiveFile = path.join(archiveDir, `${VGC_LADDER_ID}-logs.7z`);
  const writeArchive = mode === 'archived' || mode === 'both';
  if (writeArchive) {
    fs.mkdirSync(archiveDir, {recursive: true});
    fs.writeFileSync(archiveFile, Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]));
  }
  return withSavepoint(
    fixture,
    raw => {
      const targetStatus = mode === 'settling' ? 'settling' : 'archived';
      raw.prepare(
        `UPDATE ladders
         SET name = 'VGC (Reg M-C)', status = ?, archived_at = ?
         WHERE id = ?`
      ).run(targetStatus, NOW_SECONDS - 3600, VGC_LADDER_ID);
      if (mode === 'archived' || mode === 'both') {
        raw.prepare(
          `UPDATE ladder_entries
           SET role = 'retired', retired_at = ?
           WHERE ladder_id = ? AND role IN ('champion', 'challenger')`
        ).run(NOW_SECONDS - 3600, VGC_LADDER_ID);
      }
      if (mode === 'both') {
        raw.prepare(
          `INSERT INTO ladders (
            id, slot, name, format, team, status, min, teams, created_at, archived_at
          ) VALUES (?, 'vgc', 'VGC (Reg M-B)', 'gen9championsvgc2026regmb', 'pools', 'settling',
            4, 20, ?, ?)`
        ).run('gen9championsvgc2026regmb', NOW_SECONDS - 86400 * 14, NOW_SECONDS - 1800);
      }
      raw.prepare(
        `INSERT INTO ladders (
          id, slot, name, format, team, status, min, teams, created_at
        ) VALUES (?, 'vgc', 'VGC', 'gen9championsvgc2026regmd', 'pools', 'active', 4, 20, ?)`
      ).run('gen9championsvgc2026regmd', NOW_SECONDS - 600);
    },
    () => {
      if (writeArchive) {
        fs.rmSync(archiveFile, {force: true});
      }
    }
  );
}

async function setupDiscordWikiPage(fixture: Fixture): Promise<() => void> {
  await fixture.wikiInstance.savePage(
    'Discord_Notes',
    '# Discord Notes\n\nShared metagame notes visible to verified `pkmn.ai` Discord server ' +
      'members.\n\n## Seasonal Pool Observations\n\n- Incineroar + Rillaboom cores remain ' +
      'dominant across Reg M-C pools.',
    'scheibo',
    'Add Discord-restricted notes page',
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
    // 1. Overview & Reference Pages
    // =========================================================================
    {
      name: 'home',
      section: 'content',
      title: 'Home',
      description: 'Landing page (`/`) in the standard state when no tournament is live.',
      path: '/',
    },
    {
      name: 'home-live-banner',
      section: 'content',
      title: 'Home (Live Tournament Banner)',
      description:
        'Landing page (`/`) with the `#topbar` `[LIVE]` tournament broadcast banner ' +
        'shown while a championship event is in progress.',
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
      section: 'content',
      title: 'Background (Under Construction Banner)',
      description:
        'Competitive Pokémon Background guide (`/background/`) displaying its permanent ' +
        '`Under Construction` topbar notice.',
      path: '/background/',
    },
    {
      name: 'concepts',
      section: 'content',
      title: 'Concepts Overview',
      description: 'Technical concepts hub (`/concepts/`) linking the 5 domain deep-dives.',
      path: '/concepts/',
    },
    {
      name: 'concepts-baselines',
      section: 'content',
      title: 'Concepts: Baselines',
      description: 'Heuristic and search baseline agents (`/concepts/baselines/`).',
      path: '/concepts/baselines/',
    },
    {
      name: 'concepts-complexity',
      section: 'content',
      title: 'Concepts: Complexity',
      description: 'Game-tree branching factors and imperfect-information complexity.',
      path: '/concepts/complexity/',
    },
    {
      name: 'concepts-engines',
      section: 'content',
      title: 'Concepts: Simulation Engines',
      description: 'Battle simulator architectures and deterministic state transitions.',
      path: '/concepts/engines/',
    },
    {
      name: 'concepts-protocol',
      section: 'content',
      title: 'Concepts: Protocol',
      description: 'Pokémon Showdown wire protocol and choice grammar (`/concepts/protocol/`).',
      path: '/concepts/protocol/',
    },
    {
      name: 'concepts-variants',
      section: 'content',
      title: 'Concepts: Format Variants',
      description: 'Generational mechanics, Singles vs Doubles VGC, and teambuilding modes.',
      path: '/concepts/variants/',
    },
    {
      name: 'glossary',
      section: 'content',
      title: 'Glossary',
      description: 'Cross-disciplinary competitive Pokémon and AI terminology (`/glossary/`).',
      path: '/glossary/',
    },
    {
      name: 'release',
      section: 'content',
      title: 'Release Announcement',
      description: 'Platform launch essay and benchmark roadmap (`/release/`).',
      path: '/release/',
    },
    {
      name: 'research',
      section: 'content',
      title: 'Research Bibliography',
      description: 'Curated academic literature and BibTeX citations (`/research/`).',
      path: '/research/',
    },
    {
      name: 'rules',
      section: 'content',
      title: 'Arena Rules & Sandboxing',
      description:
        'Hardware quotas, airgapped Seatbelt/Podman sandboxing, Davidson ratings, and ' +
        'qualification rules (`/rules/`).',
      path: '/rules/',
    },
    {
      name: 'not-found',
      section: 'content',
      title: '404 Not Found',
      description: 'Static 404 error page returned for unknown routes (`/nonexistent-page`).',
      path: '/nonexistent-page',
      expectHttpError: 404,
    },

    // =========================================================================
    // 2. Projects Directory & Agent Profiles
    // =========================================================================
    {
      name: 'projects',
      section: 'projects',
      title: 'Projects Directory (All)',
      description:
        'Complete catalog of competitive Pokémon AI projects (`/projects/`) with Arena rank ' +
        'pills and language/license metadata.',
      path: '/projects/',
    },
    {
      name: 'projects-active',
      section: 'projects',
      title: 'Projects Directory (Active Filter)',
      description:
        'Client-side radio filter (`Active`) showing currently maintained projects and ' +
        'updating `#count` dynamically.',
      path: '/projects/',
      click: 'label[for="active"]',
    },
    {
      name: 'projects-arena',
      section: 'projects',
      title: 'Projects Directory (Arena Filter)',
      description:
        'Client-side radio filter (`Arena`) isolating registered `pkmn.ai` Arena competitors.',
      path: '/projects/',
      click: 'label[for="arena"]',
    },
    {
      name: 'projects-inactive',
      section: 'projects',
      title: 'Projects Directory (Inactive Filter)',
      description:
        'Client-side radio filter (`Inactive`) showing historical/archived projects.',
      path: '/projects/',
      click: 'label[for="inactive"]',
    },
    {
      name: 'project-profile',
      section: 'projects',
      title: 'Agent Profile (Multi-Version Champion)',
      description:
        '`0 ERROR` profile (`/projects/0-error/`) with `#1` reign table, multi-ladder SVG ' +
        'rating chart with version handoff markers, H2H table (`+` Best Matchup / `-` Nemesis ' +
        'residuals), and Recent Matches.',
      path: '/projects/0-error/',
    },
    {
      name: 'project-profile-version',
      section: 'projects',
      title: 'Agent Profile (Filtered by Active Version)',
      description:
        'Selecting `1.2.0` in `#ver-select` scopes Head-to-Head statistics and Recent Matches ' +
        'to that specific version.',
      path: '/projects/0-error/',
      act: async page => {
        await page.selectOption('#ver-select', '1.2.0');
      },
    },
    {
      name: 'project-profile-opponent',
      section: 'projects',
      title: 'Agent Profile (Filtered by H2H Opponent)',
      description:
        'Clicking an opponent row in `#matchups` highlights the H2H row, displays the ' +
        '`#matches-opp-chip` filter pill, and filters Recent Matches to that matchup.',
      path: '/projects/0-error/',
      click: '#matchups tbody tr.opp-row td:first-child',
    },
    {
      name: 'project-profile-match-expanded',
      section: 'projects',
      title: 'Agent Profile (Expanded Match Telemetry)',
      description:
        'Clicking a match row in `#matches` expands inline Game 1 & Game 2 telemetry, turn ' +
        'times, peak RAM, and replay links.',
      path: '/projects/0-error/',
      click: '#matches tbody tr.battle-row td:first-child',
    },
    {
      name: 'project-profile-filter-empty',
      section: 'projects',
      title: 'Agent Profile (Empty Filtered Recent Matches)',
      description:
        'Selecting retired version `1.0.0` in `#ver-select` shows historical `1.0.0` H2H rows ' +
        'while displaying `"No matching battles in recent history."` in `#matches`.',
      path: '/projects/0-error/',
      act: async page => {
        await page.selectOption('#ver-select', '1.0.0');
      },
    },
    {
      name: 'project-profile-provisional',
      section: 'projects',
      title: 'Agent Profile (Provisional Entrant)',
      description:
        '`pokerus` profile (`/projects/pokerus/`) with unsettled active entries (`5/25` ' +
        'matches, `Rank: Provisional`, `Peak: Unsettled`, and empty settled H2H notice).',
      path: '/projects/pokerus/',
    },
    {
      name: 'project-profile-qualified-empty',
      section: 'projects',
      title: 'Agent Profile (Qualified · 0 Entries)',
      description:
        '`CynthiAI` profile (`/projects/cynthiai/`) for a newly qualified project before its ' +
        'first submission (`Status: — (No active entries)`).',
      path: '/projects/cynthiai/',
    },
    {
      name: 'project-profile-pending-empty',
      section: 'projects',
      title: 'Agent Profile (Pending Qualification)',
      description:
        '`AsterAI` profile (`/projects/asterai/`) for a registered project awaiting baseline ' +
        'qualification (`Status: — (Pending qualification)`).',
      path: '/projects/asterai/',
    },

    // =========================================================================
    // 3. Arena Hub & Ladders
    // =========================================================================
    {
      name: 'arena',
      section: 'arena',
      title: 'Arena Hub (Active Season)',
      description:
        'Central Arena hub (`/arena/`) summarizing the `#1` champion across all 5 active ' +
        'ladders plus live, scheduled, and completed Championship Tournaments.',
      path: '/arena/',
    },
    {
      name: 'arena-seasons',
      section: 'arena',
      title: 'Arena Hub (With Past Seasons)',
      description:
        'Arena hub after seasonal rotation showing the `#seasons` **Past Seasons** table with ' +
        'both a `Settling` season and an `Archived` season (`-logs.7z` & `teams.json` links).',
      path: '/arena/',
      setup: fixture => setupRotatedSeasons(fixture, 'both'),
    },
    {
      name: 'arena-prelaunch',
      section: 'arena',
      title: 'Arena Hub (Pre-Launch / Upcoming)',
      description:
        'Pre-launch Arena hub when all 5 ladders are in `upcoming` status (`Upcoming`) and no ' +
        'tournaments have been scheduled yet.',
      path: '/arena/',
      setup: fixture => withSavepoint(fixture, raw => {
        raw.exec("UPDATE ladders SET status = 'upcoming'");
        raw.exec('DELETE FROM ladder_entries');
        raw.exec('DELETE FROM tournament_games');
        raw.exec('DELETE FROM tournament_entrants');
        raw.exec('DELETE FROM tournaments');
      }),
    },
    {
      name: 'arena-ladder-rby',
      section: 'arena',
      title: 'Ladder: RBY (Active Versions Tab)',
      description:
        'Harvested ladder (`/arena/ladders/rby/`) default `Active` tab: settled `#1`–`#5` ' +
        'ranks, secondary active `0 ERROR 1.1.0` (`—`), `Metamon 1.0.0` `1500 ±0` anchor, ' +
        '`pokerus` `Provisional`, `W4`/`L4` streaks, Rating History SVG, and Matchups matrix.',
      path: '/arena/ladders/rby/',
    },
    {
      name: 'arena-ladder-rby-best',
      section: 'arena',
      title: 'Ladder: RBY (Best Versions Filter)',
      description:
        '`Best` version filter on `/arena/ladders/rby/` collapsing each project to its ' +
        'highest-rated active version (hiding secondary active `0 ERROR 1.1.0`).',
      path: '/arena/ladders/rby/',
      click: 'label[for="ver-best"]',
    },
    {
      name: 'arena-ladder-rby-all',
      section: 'arena',
      title: 'Ladder: RBY (All Versions Filter)',
      description:
        '`All` version filter on `/arena/ladders/rby/` revealing historical retired versions ' +
        '(`0 ERROR 1.0.0 (retired)`) alongside active versions.',
      path: '/arena/ladders/rby/',
      click: 'label[for="ver-all"]',
    },
    {
      name: 'arena-ladder-vgc',
      section: 'arena',
      title: 'Ladder: VGC (Competitor Pools)',
      description:
        'Seasonal `pools` ladder (`/arena/ladders/vgc/`) where matches sample pairs from ' +
        'competitors’ 20-team rosters with `2/N` skin-in-the-game probability.',
      path: '/arena/ladders/vgc/',
    },
    {
      name: 'arena-ladder-settling',
      section: 'arena',
      title: 'Ladder: Rotated Season (Settling Grace Window)',
      description:
        'Rotated seasonal ladder (`/arena/ladders/gen9championsvgc2026regmc/`) in `settling` ' +
        'status showing `(settling)` in nav and the 48-hour grace window notice.',
      path: `/arena/ladders/${VGC_LADDER_ID}/`,
      setup: fixture => setupRotatedSeasons(fixture, 'settling'),
    },
    {
      name: 'arena-ladder-archived',
      section: 'arena',
      title: 'Ladder: Retired Season (Archived with .7z & teams.json)',
      description:
        'Retired seasonal ladder (`/arena/ladders/gen9championsvgc2026regmc/`) in `archived` ' +
        'status publishing `<id>-logs.7z`, `teams.json`, and `index.json`.',
      path: `/arena/ladders/${VGC_LADDER_ID}/`,
      setup: fixture => setupRotatedSeasons(fixture, 'archived'),
    },
    {
      name: 'arena-ladder-upcoming',
      section: 'arena',
      title: 'Ladder: Upcoming (Empty State)',
      description:
        'Pre-launch ladder in `upcoming` status with 0 entries (`"RBY ladder is upcoming — ' +
        'accepting initial entries before matchmaking begins."`) and hidden chart/matrix.',
      path: '/arena/ladders/rby/',
      setup: fixture => withSavepoint(fixture, raw => {
        raw.prepare("UPDATE ladders SET status = 'upcoming' WHERE id = ?").run(RBY_LADDER_ID);
        raw.prepare('DELETE FROM ladder_entries WHERE ladder_id = ?').run(RBY_LADDER_ID);
      }),
    },

    // =========================================================================
    // 4. Arena Battles
    // =========================================================================
    {
      name: 'arena-battles',
      section: 'battles',
      title: 'Battles (Live Match in Progress)',
      description:
        '`/arena/battles/` during an active VGC match (`Game 2 / 2 · Turn 9`, `p1` `PAUSED`, ' +
        '`p2` `RUNNING`, Game 1 result, and pool team hashes) above Completed Battles.',
      path: '/arena/battles/',
    },
    {
      name: 'arena-battles-expanded',
      section: 'battles',
      title: 'Battles (Expanded Row · Timeout Fault & Pool Hashes)',
      description:
        'Expanding `vgc-0002849` reveals Game 1 & Game 2 telemetry, red `[Timeout]` ' +
        'fault badge on Game 2, and unlinked `P1:<hash>` / `P2:<hash>` pool team badges.',
      path: '/arena/battles/',
      click: 'tr#vgc-0002849 td:first-child',
    },
    {
      name: 'arena-battles-crash-expanded',
      section: 'battles',
      title: 'Battles (Expanded Row · Crash Fault)',
      description:
        'Expanding `gen9ou-0002848` (`SV`) reveals the red `[Crash]` abnormal termination ' +
        'badge on Game 2 alongside per-side turn time and peak RAM.',
      path: '/arena/battles/',
      click: 'tr#gen9ou-0002848 td:first-child',
    },
    {
      name: 'arena-battles-normal-expanded',
      section: 'battles',
      title: 'Battles (Expanded Row · Clean 2-Game Match)',
      description:
        'Expanding `vgc-0002839` without runtime faults shows Game 1 and Game 2 ' +
        '(sides and teams swapped) with turn counts and telemetry.',
      path: '/arena/battles/',
      click: 'tr#vgc-0002839 td:first-child',
    },
    {
      name: 'arena-battles-archived-pool',
      section: 'battles',
      title: 'Battles (Expanded Row · Archived Pool Team Links)',
      description:
        'Once a seasonal `pools` ladder is `archived`, expanding its battle row turns ' +
        '`P1:<hash>` and `P2:<hash>` into links to `/arena/ladders/<id>/teams.json#<hash>`.',
      path: '/arena/battles/',
      click: '#battles-tbody tr.battle-row td:first-child',
      setup: fixture => setupRotatedSeasons(fixture, 'archived'),
    },
    {
      name: 'arena-battles-filter-vgc',
      section: 'battles',
      title: 'Battles (Filtered by Format)',
      description:
        'Selecting the `VGC` format filter fetches `/api/battles.json?ladder=vgc` and ' +
        'updates the pagination count to VGC matches only.',
      path: '/arena/battles/',
      click: 'label[for="bf-vgc"]',
    },
    {
      name: 'arena-battles-page-2',
      section: 'battles',
      title: 'Battles (Paginated History · Page 2)',
      description:
        'Clicking `Older →` (`#battles-next`) loads Page 2 of completed battles and enables ' +
        '`← Newer` (`#battles-prev`).',
      path: '/arena/battles/',
      click: '#battles-next',
    },
    {
      name: 'arena-battles-idle',
      section: 'battles',
      title: 'Battles (Live Idle)',
      description:
        'When the Arena runner is idle between ladder matches, `#live` displays ' +
        '`"No battle currently running — Arena is idle."`.',
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
      title: 'Battles (Live Stale / Offline)',
      description:
        'When the Arena runner heartbeat has expired (`stale: true`), `#live` displays ' +
        '`"No active heartbeat — Arena is offline or idle."`.',
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
      title: 'Battles (Empty History)',
      description:
        '`/arena/battles/` before any matches have completed (`"No completed battles yet."` ' +
        'and hidden pager).',
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
    // 5. Championship Tournaments
    // =========================================================================
    {
      name: 'arena-tournament-1',
      section: 'tournaments',
      title: 'Tournament #1 (Completed · Superfinal & Archive)',
      description:
        'Completed tournament (`/arena/tournaments/1/`) with `SF` badges on `#1`/`#2`, ' +
        '`Superfinal` column in Standings, Crosstable, Games list, and `1-replays.7z` link.',
      path: '/arena/tournaments/1/',
    },
    {
      name: 'arena-tournament-1-replay',
      section: 'tournaments',
      title: 'Tournament #1 (Inline Replay Viewer)',
      description:
        'Clicking a game code in `#games` on a completed tournament opens the inline ' +
        'Pokémon Showdown battle viewer in Replay mode (`Replay · SF1`).',
      path: '/arena/tournaments/1/',
      click: '#games a[data-replay-log]',
    },
    {
      name: 'arena-tournament-2',
      section: 'tournaments',
      title: 'Tournament #2 (Live Broadcast · Table 1)',
      description:
        'Running tournament (`/arena/tournaments/2/`) with multi-table live broadcast (`Table ' +
        '1` active), `thinking…` clock pill, and `● T1` / `● T2` badges across tables.',
      path: '/arena/tournaments/2/',
    },
    {
      name: 'arena-tournament-2-table2',
      section: 'tournaments',
      title: 'Tournament #2 (Live Broadcast · Switched to Table 2)',
      description:
        'Clicking `Table 2` in `#table-nav-wrap` switches the embedded live viewer and player ' +
        'clock bars to Table 2 (`Jaxcalibur vs MissingNo.Zero`).',
      path: '/arena/tournaments/2/',
      click: 'label[for="tb-2-2"]',
    },
    {
      name: 'arena-tournament-2-table2-idle',
      section: 'tournaments',
      title: 'Tournament #2 (Live Broadcast · Idle Table & Watch T1 Pill)',
      description:
        'Viewing Table 2 after its game finishes (`idle: true`) shows `Table 2 (idle)` and ' +
        'reveals the `● Watch T1` quick-switch action pill.',
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
      title: 'Tournament #2 (Live Tournament Viewing Past Replay)',
      description:
        'Clicking a completed round-robin game during a live tournament switches the viewer to ' +
        'Replay mode and displays the `● Return to Live` button.',
      path: '/arena/tournaments/2/',
      click: '#games a[data-replay-log]',
    },
    {
      name: 'arena-tournament-3',
      section: 'tournaments',
      title: 'Tournament #3 (Scheduled · Entrants Registered)',
      description:
        'Scheduled upcoming tournament (`/arena/tournaments/3/`) showing registered entrants ' +
        'with `—` stats and empty Crosstable/Games placeholders.',
      path: '/arena/tournaments/3/',
    },
    {
      name: 'arena-tournament-empty',
      section: 'tournaments',
      title: 'Tournament #3 (Scheduled · 0 Entrants)',
      description:
        'Scheduled upcoming tournament before any project has entered (`"No entrants ' +
        'registered yet."`).',
      path: '/arena/tournaments/3/',
      setup: fixture => withSavepoint(fixture, raw => {
        raw.exec("DELETE FROM tournament_entrants WHERE tournament_id = '3'");
      }),
    },

    // =========================================================================
    // 6. Account & Submissions
    // =========================================================================
    {
      name: 'account-unregistered',
      section: 'account',
      title: 'Account: 403 Unregistered GitHub User',
      description:
        'Visiting `/account/` as `@stranger` returns `403` explaining that the GitHub account ' +
        'is not registered to an approved Arena project.',
      path: '/account/',
      githubUser: 'stranger',
      expectHttpError: 403,
    },
    {
      name: 'account-disabled',
      section: 'account',
      title: 'Account: 403 Disabled Project',
      description:
        'Visiting `/account/` when the project status is `disabled` returns `403` blocking ' +
        'both ladder and tournament access.',
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
      title: 'Account: Pending Qualification (No Open Tournament)',
      description:
        '`AsterAI` (`qualified: false`, Discord `None (link)`) when no scheduled tournament is ' +
        'open: Status `Pending` (`muted`), form disabled awaiting baseline qualification.',
      path: '/account/',
      githubUser: 'asterdev',
      setup: fixture => withSavepoint(fixture, raw => {
        raw.exec("UPDATE tournaments SET status = 'completed' WHERE id = '3'");
      }),
    },
    {
      name: 'account-pending-tournament',
      section: 'account',
      title: 'Account: Pending Qualification (Tournament Open)',
      description:
        '`AsterAI` (`Pending` status): continuous ladder checkboxes are disabled, while ' +
        'scheduled Tournament #3 OCI registration is open and pre-selected.',
      path: '/account/',
      githubUser: 'asterdev',
    },
    {
      name: 'account-qualified-closed',
      section: 'account',
      title: 'Account: Qualified (Ladders Not Open Yet)',
      description:
        'Qualified competitor (`CynthiAI`) when no ladders or tournaments are open yet: Status ' +
        '`Qualified` (`"Ladders are not open for submissions yet."`).',
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
      title: 'Account: Eligible (New Competitor · 0 Submissions)',
      description:
        '`CynthiAI` (`@sisyphus25`, Discord linked): Status `Eligible` (`yes`) with all 5 ' +
        'ladders and Tournament #3 open, and empty Active/History sections.',
      path: '/account/',
      githubUser: 'sisyphus25',
    },
    {
      name: 'account-teams-empty',
      section: 'account',
      title: 'Account: VGC Teams Panel (0 / 20 Saved)',
      description:
        'Checking `VGC` on `/account/` reveals the incremental team pool panel (`0 / 20 ' +
        'distinct teams saved — 20 more needed`, `1-NN >= 1.30`, `Load .txt` & `Validate`).',
      path: '/account/',
      githubUser: 'sisyphus25',
      click: `input[name="ladders"][value="${VGC_LADDER_ID}"]`,
    },
    {
      name: 'account-teams-invalid',
      section: 'account',
      title: 'Account: VGC Teams Validation (Partial Save + Rejections)',
      description:
        'Validating 2 valid teams + 1 near-duplicate (`distance=0.000 < 1.30`) + 1 incomplete ' +
        'moveset (`has 3 move(s); must have 4`) saves `2 / 20` and lists red rejections.',
      path: '/account/',
      githubUser: 'sisyphus25',
      serial: true,
      beforePage: fixture => {
        fixture.db.clearSavedTeams(VGC_LADDER_ID, fixture.cynthiaiId);
      },
      setup: fixture => () => {
        fixture.db.clearSavedTeams(VGC_LADDER_ID, fixture.cynthiaiId);
      },
      act: async (page, fixture) => {
        await page.click(`input[name="ladders"][value="${VGC_LADDER_ID}"]`);
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
        await page.click('#validate-teams-btn');
        await page.waitForSelector('#teams-feedback:not(.hide)');
      },
    },
    {
      name: 'account-teams-partial',
      section: 'account',
      title: 'Account: VGC Teams Validation (10 / 20 Saved)',
      description:
        'Incremental batch validation reaching `10 / 20` saved teams (`50%` progress bar, ' +
        '`(10/20 saved)` checkbox hint, green feedback, and `Clear Saved` button visible).',
      path: '/account/',
      githubUser: 'sisyphus25',
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
        await page.fill(
          '#sub-teams',
          `=== [gen9championsvgc2026regmc] Team 10 ===\n${fixture.rawVgcTeams[9]}`
        );
        await page.click('#validate-teams-btn');
        await page.waitForSelector('#teams-feedback:not(.hide)');
      },
    },
    {
      name: 'account-teams-complete',
      section: 'account',
      title: 'Account: VGC Teams Validation (All 20 / 20 Saved)',
      description:
        'Completing all `20 / 20` distinct VGC teams turns the progress bar green (`100%`), ' +
        'updates the checkbox hint to `(20/20 saved)`, and enables build submission.',
      path: '/account/',
      githubUser: 'sisyphus25',
      serial: true,
      beforePage: fixture => {
        fixture.db.replaceSavedTeams(
          VGC_LADDER_ID,
          fixture.cynthiaiId,
          fixture.canonicalVgcTeams.slice(0, 19),
          NOW_SECONDS
        );
      },
      setup: fixture => () => {
        fixture.db.clearSavedTeams(VGC_LADDER_ID, fixture.cynthiaiId);
      },
      act: async (page, fixture) => {
        await page.click(`input[name="ladders"][value="${VGC_LADDER_ID}"]`);
        await page.fill(
          '#sub-teams',
          `=== [gen9championsvgc2026regmc] Team 20 ===\n${fixture.rawVgcTeams[19]}`
        );
        await page.click('#validate-teams-btn');
        await page.waitForSelector('#teams-feedback:not(.hide)');
      },
    },
    {
      name: 'account-submission-error',
      section: 'account',
      title: 'Account: Submission Form Validation Error',
      description:
        'Submitting a build with a malformed artifact URL or SHA-256 digest displays an inline ' +
        'red error message in `#sub-status.no` without leaving the page.',
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
      title: 'Account: Eligible (Settled Competitor & Locked VGC Pool)',
      description:
        '`Foul Play` (`@pmariglia`): settled across all 5 ladders, VGC teams already locked ' +
        'for the season, Tournament #3 disabled (`entered: 1.4.1-t3`), and `Entered` history.',
      path: '/account/',
      githubUser: 'pmariglia',
    },
    {
      name: 'account-ineligible-smoke-pending',
      section: 'account',
      title: 'Account: Ineligible (Awaiting Smoke Test)',
      description:
        'While version `1.0.0-rc1` has `smoke_status = "pending"`, status is `Ineligible` ' +
        '(`"Version 1.0.0-rc1 is currently awaiting Arena smoke testing."`) and `PENDING`.',
      path: '/account/',
      githubUser: 'sisyphus25',
      setup: fixture => withSavepoint(fixture, raw => {
        raw.prepare(
          `INSERT INTO agent_versions (
            agent_id, version, package, url, sha256, ladders_json, tournaments_json,
            smoke_status, submitted_at, notified
          ) VALUES (?, '1.0.0-rc1', 'bundle',
            'https://github.com/sisyphus25/cynthiai/releases/download/v1.0.0-rc1/agent.tar.zst',
            ?, ?, '["3"]', 'pending', ?, 0)`
        ).run(
          fixture.cynthiaiId,
          'a'.repeat(64),
          JSON.stringify([RBY_LADDER_ID]),
          NOW_SECONDS - 120
        );
      }),
    },
    {
      name: 'account',
      section: 'account',
      title: 'Account: Ineligible (14-Day Cooldown · Tournament Open)',
      description:
        '`0 ERROR` (`@scheibo`): 14-day ladder cooldown active (`10d remaining after 1.2.0`) ' +
        'while Tournament #3 OCI registration remains open; shows Champion + Challenger rows.',
      path: '/account/',
    },
    {
      name: 'account-smoke-log-expanded',
      section: 'account',
      title: 'Account: Expanded Failed Smoke Test Log',
      description:
        'Expanding `Sandbox stderr log` on failed version `0.9.0-rc1` (`FAIL (DM sent)`) ' +
        'reveals the sandboxed stderr stack trace.',
      path: '/account/',
      click: 'details.smoke-log summary',
    },
    {
      name: 'account-ineligible-provisional',
      section: 'account',
      title: 'Account: Ineligible (Unsettled Provisional Active Entry)',
      description:
        '`pokerus` (`@pokerusdev`): blocked from submitting a new ladder version until active ' +
        'version `1.0.2` settles (`SE=55.0, matches=5/25`), while Tournament #3 stays open.',
      path: '/account/',
      githubUser: 'pokerusdev',
    },
    {
      name: 'account-ineligible-quarantined',
      section: 'account',
      title: 'Account: Quarantined Version in History',
      description:
        'When an active version is auto-quarantined for repeated runtime crashes/timeouts, ' +
        'History displays `QUARANTINED (DM sent)` / `Quarantined` with its fault trace.',
      path: '/account/',
      click: 'details.smoke-log summary',
      setup: fixture => withSavepoint(fixture, raw => {
        raw.prepare(
          `UPDATE agent_versions
           SET smoke_status = 'quarantined',
               smoke_error = ?
           WHERE version = '0.9.0-rc1'`
        ).run(
          'Quarantined after 3 consecutive runtime faults on SV (gen9ou):\n' +
          '  Match sv-0001042 (G2, turn 14): process exited with SIGSEGV (code 139)\n' +
          '  Match sv-0001049 (G1, turn 8): choice timeout (> 15000ms)'
        );
      }),
    },
    {
      name: 'account-ineligible-smogon-banned',
      section: 'account',
      title: 'Account: Ineligible (Smogon Standing Bad / Banned)',
      description:
        'When a project owner has `smogon_standing = "bad"`, status is `Ineligible` (`"Smogon ' +
        'account for this project is not in good standing."`) and all submissions are locked.',
      path: '/account/',
      githubUser: 'pmariglia',
      setup: fixture => withSavepoint(fixture, raw => {
        raw.exec(
          "UPDATE developers SET smogon_standing = 'bad' WHERE github_login = 'pmariglia'"
        );
      }),
    },

    // =========================================================================
    // 7. Wiki & Authentication
    // =========================================================================
    {
      name: 'wiki',
      section: 'wiki',
      title: 'Wiki Index (`Home.dj`)',
      description: 'Public community wiki landing page (`/wiki`) with sidebar navigation.',
      path: '/wiki',
    },
    {
      name: 'wiki-pages',
      section: 'wiki',
      title: 'Wiki Pages Directory',
      description:
        'Directory of all wiki pages visible to the current session (`/wiki/pages`).',
      path: '/wiki/pages',
    },
    {
      name: 'wiki-project',
      section: 'wiki',
      title: 'Wiki: Developer-Restricted Project Page',
      description:
        '`0 ERROR` project wiki page (`/wiki/0_ERROR`, `visibility: developers`) viewed by ' +
        'an authorized registered competitor.',
      path: '/wiki/0_ERROR',
    },
    {
      name: 'wiki-discord',
      section: 'wiki',
      title: 'Wiki: Discord-Restricted Page',
      description:
        '`Discord_Notes` wiki page (`/wiki/Discord_Notes`, `visibility: discord`) viewed by a ' +
        'verified `pkmn.ai` Discord server member.',
      path: '/wiki/Discord_Notes',
      setup: fixture => setupDiscordWikiPage(fixture),
    },
    {
      name: 'wiki-edit',
      section: 'wiki',
      title: 'Wiki Editor (General Public Page)',
      description:
        'Editing a non-project wiki page (`/wiki/Gen_9_OU/edit`), which is always public and ' +
        'omits the visibility radio bar.',
      path: '/wiki/Gen_9_OU/edit',
    },
    {
      name: 'wiki-edit-project',
      section: 'wiki',
      title: 'Wiki Editor (Project Page with Visibility Bar)',
      description:
        'Editing a project wiki page (`/wiki/0_ERROR/edit`) as its owner, showing the ' +
        '`Developers — Discord — Public` `#wiki-visibility` selector.',
      path: '/wiki/0_ERROR/edit',
    },
    {
      name: 'wiki-preview',
      section: 'wiki',
      title: 'Wiki Editor (Live Djot Preview)',
      description:
        'Clicking `Preview` in `/wiki/0_ERROR/edit` renders the formatted Djot preview above ' +
        'the editor textarea before committing.',
      path: '/wiki/0_ERROR/edit',
      click: '#wiki-actions button[value="preview"]',
    },
    {
      name: 'wiki-history',
      section: 'wiki',
      title: 'Wiki Revision History',
      description:
        'Git commit log (`/wiki/0_ERROR/history`) mapping GitHub committers (`scheibo`, ' +
        '`coauthor`) to their Smogon usernames (`pre`, `coauthor`) with `(diff)` links.',
      path: '/wiki/0_ERROR/history',
    },
    {
      name: 'wiki-revision',
      section: 'wiki',
      title: 'Wiki Historical Revision Snapshot',
      description:
        'Read-only snapshot of a specific git commit (`/wiki/0_ERROR/<sha>`) with revision ' +
        'banner and link to diff.',
      path: `/wiki/0_ERROR/${wikiSha}`,
    },
    {
      name: 'wiki-diff',
      section: 'wiki',
      title: 'Wiki Revision Unified Diff',
      description:
        'Unified git diff view (`/wiki/0_ERROR/<sha>?diff=1`) highlighting added and removed ' +
        'lines.',
      path: `/wiki/0_ERROR/${wikiSha}?diff=1`,
    },
    {
      name: 'wiki-uncreated-owner',
      section: 'wiki',
      title: 'Wiki: Uncreated Project Page (Owner Redirect to Editor)',
      description:
        'When a project owner (`@pmariglia`) visits their uncreated project page ' +
        '(`/wiki/Foul_Play`), they are redirected to `/wiki/Foul_Play/edit` with starter Djot.',
      path: '/wiki/Foul_Play',
      githubUser: 'pmariglia',
    },
    {
      name: 'wiki-uncreated-other',
      section: 'wiki',
      title: 'Wiki: 404 Uncreated Project Page (Non-Owner)',
      description:
        'When a non-owner visits an uncreated project page (`/wiki/Metamon`), the wiki returns ' +
        '`404` (`"This project page has not been created yet."`).',
      path: '/wiki/Metamon',
      githubUser: 'pmariglia',
      expectHttpError: 404,
    },
    {
      name: 'wiki-forbidden-stranger',
      section: 'wiki',
      title: 'Wiki: 403 Forbidden (Unregistered GitHub User)',
      description:
        'Visiting a `developers`-restricted wiki page (`/wiki/0_ERROR`) as `@stranger` returns ' +
        '`403` (`"GitHub account stranger is not registered for pkmn.ai competitions."`).',
      path: '/wiki/0_ERROR',
      githubUser: 'stranger',
      expectHttpError: 403,
    },
    {
      name: 'wiki-forbidden-nonowner',
      section: 'wiki',
      title: 'Wiki: 403 Forbidden (Editing Another Project’s Page)',
      description:
        'When competitor `@pmariglia` attempts to edit `/wiki/0_ERROR/edit`, the wiki returns ' +
        '`403` (`"GitHub account pmariglia is not a registered developer of 0 ERROR."`).',
      path: '/wiki/0_ERROR/edit',
      githubUser: 'pmariglia',
      expectHttpError: 403,
    },
    {
      name: 'wiki-forbidden-discord',
      section: 'wiki',
      title: 'Wiki: 403 Forbidden (Non-Guild Discord User)',
      description:
        'Visiting a `discord`-visibility page (`/wiki/Discord_Notes`) as a user not in the ' +
        '`pkmn.ai` Discord guild returns `403`.',
      path: '/wiki/Discord_Notes',
      githubUser: 'outsider',
      expectHttpError: 403,
      setup: fixture => setupDiscordWikiPage(fixture),
    },
    {
      name: 'auth-dev',
      section: 'wiki',
      title: 'Dev Auth Persona Switcher (`/auth/dev`)',
      description:
        'Local loopback persona switcher (`DEV_AUTH=1`) for signing in as admin, competitor, ' +
        'unregistered GitHub user, or non-guild Discord user.',
      path: '/auth/dev',
    },
  ];
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

  // Default to the normal everyday state without a `[LIVE]` topbar banner across pages; only the
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

  const app = polka();
  const wikiInstance = new wiki.Wiki({
    wikiDir,
    projectsFile,
    db,
    push: false,
    auth: new auth.Auth({
      config: SHOTS_AUTH,
      db,
      devAuth: true,
      isAuthorizedGitHub: (login): boolean => wikiInstance.isDeveloper(login),
    }),
  });
  wikiInstance.auth.register(app);
  account.register(app, {
    db,
    auth: wikiInstance.auth,
    now: () => NOW_SECONDS,
    poolsByLadder: new Map([[VGC_LADDER_ID, []]]),
    rateLimitMaxAttempts: 1000,
  });
  const arenaHandle = arena.register(app, {
    db,
    auth: wikiInstance.auth,
    publicDir,
    now: () => NOW_SECONDS,
  });
  const defaultLiveState = {
    live: seeded.liveDoc.live,
    stale: seeded.liveDoc.stale,
    updatedAt: seeded.liveDoc.updatedAt,
  };
  arenaHandle.setLiveState(defaultLiveState);
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
  wiki.register(app, {
    wikiDir,
    projectsFile,
    db,
    auth: wikiInstance.auth,
    push: false,
  });

  const server = http.createServer((req, res) => app.handler(req as polka.Request, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as {port: number};
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const mintCookie = (
    id: number,
    login: string,
    discordId?: string,
    discordUser?: string
  ) => {
    const token = auth.signToken(
      {
        ...(login ? {github: {id, login}} : {}),
        ...(discordId && discordUser ? {discord: {id: discordId, username: discordUser}} : {}),
        exp,
      },
      SHOTS_AUTH.sessionSecret
    );
    return `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`;
  };

  return {
    origin: `http://127.0.0.1:${addr.port}`,
    db,
    arenaHandle,
    wikiInstance,
    defaultLiveState,
    defaultBroadcast: seeded.tournamentBroadcast,
    cookies: {
      scheibo: mintCookie(1, 'scheibo', '513513270670262284', 'scheibo'),
      pmariglia: mintCookie(2, 'pmariglia', '283674461268344832', 'pmariglia'),
      sisyphus25: mintCookie(3, 'sisyphus25', '300000000000000012', 'sisyphus25'),
      asterdev: mintCookie(4, 'asterdev'),
      pokerusdev: mintCookie(5, 'pokerusdev', '300000000000000010', 'pokerusdev'),
      stranger: mintCookie(99, 'stranger'),
      outsider: mintCookie(0, '', '999999999999999999', 'outsider'),
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

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC32_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tag = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])), 0);
  return Buffer.concat([len, tag, data, crc]);
}

export function encodePng(image: PngImage): Buffer {
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
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
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

export function decodePng(buf: Buffer): PngImage {
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

  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const rowBytes = width * bpp;
  const stride = 1 + rowBytes;
  const inflated = zlib.inflateSync(Buffer.concat(idatParts));
  const unfiltered = Buffer.alloc(height * rowBytes);

  for (let y = 0; y < height; y++) {
    const filter = inflated[y * stride];
    const srcOff = y * stride + 1;
    const dstOff = y * rowBytes;
    const prevOff = (y - 1) * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const raw = inflated[srcOff + i];
      const left = i >= bpp ? unfiltered[dstOff + i - bpp] : 0;
      const up = y > 0 ? unfiltered[prevOff + i] : 0;
      const upLeft = y > 0 && i >= bpp ? unfiltered[prevOff + i - bpp] : 0;
      if (filter === 0) {
        unfiltered[dstOff + i] = raw;
      } else if (filter === 1) {
        unfiltered[dstOff + i] = (raw + left) & 0xff;
      } else if (filter === 2) {
        unfiltered[dstOff + i] = (raw + up) & 0xff;
      } else if (filter === 3) {
        unfiltered[dstOff + i] = (raw + ((left + up) >>> 1)) & 0xff;
      } else if (filter === 4) {
        unfiltered[dstOff + i] = (raw + paethPredictor(left, up, upLeft)) & 0xff;
      } else {
        throw new Error(`Unsupported PNG filter type: ${filter}`);
      }
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

const spriteCache = new Map<string, Buffer>();

export function standInSprite(urlPath: string): Buffer {
  const cached = spriteCache.get(urlPath);
  if (cached) return cached;

  const isBattleSprite = urlPath.includes('/sprites/');
  const width = isBattleSprite ? 96 : 40;
  const height = isBattleSprite ? 96 : 30;

  let hash = 2166136261;
  for (let i = 0; i < urlPath.length; i++) {
    hash = Math.imul(hash ^ urlPath.charCodeAt(i), 16777619) >>> 0;
  }
  const primary = [70 + (hash & 0x9f), 70 + ((hash >>> 8) & 0x9f), 70 + ((hash >>> 16) & 0x9f)];
  const accent = [
    90 + ((hash >>> 4) & 0x7f),
    90 + ((hash >>> 12) & 0x7f),
    90 + ((hash >>> 20) & 0x7f),
  ];
  const border = [24, 28, 36];

  const data = Buffer.alloc(width * height * 4);
  const gridCols = 8;
  const gridRows = 6;
  const cellW = isBattleSprite ? 10 : 2;
  const cellH = isBattleSprite ? 10 : 2;
  const padX = Math.floor((width - gridCols * cellW) / 2);
  const padY = Math.floor((height - gridRows * cellH) / 2);

  const filled = (gx: number, gy: number): number => {
    if (gx < 0 || gx >= gridCols || gy < 0 || gy >= gridRows) return 0;
    const mx = gx < 4 ? gx : 7 - gx;
    if (mx === 3 && gy >= 1 && gy <= 4) return 1;
    const bit = (gy * 4 + mx) % 31;
    return ((hash >>> bit) & 1) === 1 ? ((gy + mx) % 2 === 0 ? 1 : 2) : 0;
  };

  for (let y = 0; y < height; y++) {
    const gy = Math.floor((y - padY) / cellH);
    const inY = y >= padY && y < padY + gridRows * cellH;
    for (let x = 0; x < width; x++) {
      const gx = Math.floor((x - padX) / cellW);
      const inX = x >= padX && x < padX + gridCols * cellW;
      const px = (y * width + x) * 4;
      const cell = inX && inY ? filled(gx, gy) : 0;
      if (cell > 0) {
        const col = cell === 1 ? primary : accent;
        data[px] = col[0];
        data[px + 1] = col[1];
        data[px + 2] = col[2];
        data[px + 3] = 255;
      } else if (
        inX &&
        inY &&
        (filled(gx - 1, gy) > 0 ||
          filled(gx + 1, gy) > 0 ||
          filled(gx, gy - 1) > 0 ||
          filled(gx, gy + 1) > 0)
      ) {
        data[px] = border[0];
        data[px + 1] = border[1];
        data[px + 2] = border[2];
        data[px + 3] = 255;
      }
    }
  }

  const png = encodePng({width, height, data});
  spriteCache.set(urlPath, png);
  return png;
}

export function diffPngImages(a: PngImage, b: PngImage): {image: PngImage; count: number} {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const data = Buffer.alloc(width * height * 4, 255);
  let count = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      const inBoth = x < a.width && y < a.height && x < b.width && y < b.height;
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      if (inBoth && a.data.readUInt32LE(ia) === b.data.readUInt32LE(ib)) {
        const luma =
          0.3 * (b.data[ib] ?? 0) +
          0.59 * (b.data[ib + 1] ?? 0) +
          0.11 * (b.data[ib + 2] ?? 0);
        const faded = 255 - ((255 - Math.round(luma)) >> 2);
        data[out] = faded;
        data[out + 1] = faded;
        data[out + 2] = faded;
        continue;
      }
      count++;
      data[out + 1] = 0;
      if (inBoth) data[out + 2] = 0;
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
      if (relPrefix === '' && (entry.name === 'baseline' || entry.name === 'diff')) {
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

  const beforeSet = new Set(beforeNames);
  const afterSet = new Set(afterNames);
  const changes: ShotChange[] = [];

  for (const name of names) {
    if (!afterSet.has(name)) {
      changes.push({
        name,
        note: `only in ${path.relative(ROOT, beforeDir) || beforeDir}`,
        status: 'removed',
      });
      continue;
    }
    if (!beforeSet.has(name)) {
      changes.push({
        name,
        note: `only in ${path.relative(ROOT, afterDir) || afterDir}`,
        status: 'added',
      });
      continue;
    }
    const [rawA, rawB] = await Promise.all([
      fsp.readFile(path.join(beforeDir, name)),
      fsp.readFile(path.join(afterDir, name)),
    ]);
    if (rawA.equals(rawB)) continue;
    const a = decodePng(rawA);
    const b = decodePng(rawB);
    const resized = a.width !== b.width || a.height !== b.height;
    if (!resized && a.data.equals(b.data)) continue;

    const {image, count} = diffPngImages(a, b);
    if (count === 0 || (count <= tolerance && !resized)) continue;

    const pctNum = Number(((100 * count) / (image.width * image.height)).toFixed(2));
    const pct = pctNum.toFixed(2);
    const sizeNote = resized ? `, ${a.width}×${a.height} → ${b.width}×${b.height}` : '';
    const diffPath = path.join(diffDir, name);
    await fsp.mkdir(path.dirname(diffPath), {recursive: true});
    await fsp.writeFile(diffPath, encodePng(image));
    changes.push({
      name,
      note: `${count} px (${pct}%)${sizeNote}`,
      diffPath,
      status: 'modified',
      pixels: count,
      percent: pctNum,
    });
  }

  return {same: changes.length === 0, changes};
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

  return renderTemplate(SHOTS_HTML, {
    scenarioCount: scenarios.length,
    sectionCount: SECTIONS.length,
    css: SHOTS_CSS,
    sectionsJson: JSON.stringify(SECTIONS),
    itemsJson: JSON.stringify(
      scenarios.map(s => ({
        name: s.name,
        section: s.section,
        title: s.title,
        description: s.description,
        path: s.path,
        persona: s.githubUser ?? 'scheibo',
      }))
    ),
    viewportsJson: JSON.stringify(VIEWPORTS),
    changesJson: JSON.stringify(changesList),
    hasBaselineJson: JSON.stringify(Boolean(options.hasBaseline || changesList.length > 0)),
  });
}

async function serve(route: Route, fixture: Fixture, cookie: string): Promise<void> {
  const url = new URL(route.request().url());
  if (url.origin !== ORIGIN) {
    if (url.pathname.endsWith('.png')) {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: standInSprite(url.pathname),
      });
      return;
    }
    await route.fulfill({status: 204, body: ''});
    return;
  }
  if (
    url.pathname === '/api/battles/stream' ||
    /^\/api\/tournaments\/[^/]+\/stream$/.test(url.pathname)
  ) {
    await route.fulfill({status: 204, contentType: 'text/event-stream', body: ''});
    return;
  }
  const isStaticArenaAsset = (
    url.pathname === '/arena/viewer' ||
    url.pathname.startsWith('/arena/viewer/') ||
    /\.(?:7z|log)$/i.test(url.pathname)
  );
  const isDynamic = !isStaticArenaAsset && (
    url.pathname === '/wiki' ||
    url.pathname.startsWith('/wiki/') ||
    url.pathname === '/account' ||
    url.pathname.startsWith('/account/') ||
    url.pathname === '/auth' ||
    url.pathname.startsWith('/auth/') ||
    url.pathname === '/projects' ||
    url.pathname.startsWith('/projects/') ||
    url.pathname === '/arena' ||
    url.pathname.startsWith('/arena/') ||
    url.pathname === '/arena.json' ||
    url.pathname.startsWith('/api/')
  );
  if (isDynamic) {
    const req = route.request();
    const body = req.postDataBuffer();
    const reqHeaders = req.headers();
    const res = await fetch(`${fixture.origin}${url.pathname}${url.search}`, {
      method: req.method(),
      headers: {
        ...reqHeaders,
        ...(reqHeaders.origin === ORIGIN ? {origin: fixture.origin} : {}),
        cookie,
      },
      body: body ? new Uint8Array(body) : undefined,
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    await route.fulfill({status: res.status, headers, body: buffer});
    return;
  }
  const file = (
    resolveFileInDir(fixture.publicDir, url.pathname) ??
    resolveFileInDir(PUBLIC, url.pathname)
  );
  if (file) {
    await route.fulfill({path: file});
    return;
  }
  const notFound = path.join(PUBLIC, '404.html');
  if (fs.existsSync(notFound)) {
    await route.fulfill({status: 404, path: notFound});
    return;
  }
  await route.fulfill({status: 404, contentType: 'text/plain', body: 'Not Found'});
}

interface SlotWorker {
  device: string;
  theme: (typeof THEMES)[number];
  context: BrowserContext;
  page: Page;
  problems: string[];
  setCookie: (cookie: string) => void;
}

async function createSlotWorkers(browser: Browser, fixture: Fixture): Promise<SlotWorker[]> {
  const workers: SlotWorker[] = [];
  for (const [device, viewport] of Object.entries(VIEWPORTS)) {
    for (const theme of THEMES) {
      let currentCookie = fixture.cookies.scheibo;
      const context = await browser.newContext({
        viewport,
        colorScheme: theme,
        deviceScaleFactor: 1,
        baseURL: ORIGIN,
        timezoneId: 'UTC',
        locale: 'en-US',
      });
      await context.route('**/*', route => serve(route, fixture, currentCookie));
      const page = await context.newPage();
      const problems: string[] = [];
      page.on('pageerror', error => problems.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error') problems.push(message.text());
      });
      await page.clock.setFixedTime(NOW);
      workers.push({
        device,
        theme,
        context,
        page,
        problems,
        setCookie: (cookie: string) => {
          currentCookie = cookie;
        },
      });
    }
  }
  return workers;
}

async function shootWithWorker(
  worker: SlotWorker,
  scenario: Scenario,
  file: string,
  fixture: Fixture
): Promise<string[]> {
  const cookie = fixture.cookies[scenario.githubUser ?? 'scheibo'] ?? fixture.cookies.scheibo;
  worker.setCookie(cookie);
  worker.problems.length = 0;

  if (scenario.beforePage) {
    await scenario.beforePage(fixture);
  }

  const {page} = worker;
  await page.goto(scenario.path);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(SETTLE_MILLIS);
  if (scenario.click) {
    await page.click(scenario.click);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(SETTLE_MILLIS);
  }
  if (scenario.act) {
    await scenario.act(page, fixture);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(SETTLE_MILLIS);
  }
  await page.evaluate(`(async () => {
    for (const image of document.querySelectorAll("img")) image.loading = "eager";
    await document.fonts.ready;
    const pending = [...document.images].filter((image) => !image.complete);
    await Promise.all(
      pending.map((image) => new Promise((done) => (image.onload = image.onerror = done)))
    );
  })()`);
  await page.evaluate('window.scrollTo(0, 0)');
  await page.waitForTimeout(SETTLE_MILLIS / 2);
  const overflow = await page.evaluate<number>(
    'document.documentElement.scrollWidth - window.innerWidth'
  );
  if (overflow > 0) {
    worker.problems.push(`horizontal overflow: +${overflow}px`);
  }
  await page.screenshot({path: file, fullPage: true, animations: 'disabled', caret: 'hide'});
  const expectedHttpPrefix = scenario.expectHttpError
    ? `Failed to load resource: the server responded with a status of ${scenario.expectHttpError} `
    : undefined;
  return worker.problems.filter(p => !expectedHttpPrefix || !p.startsWith(expectedHttpPrefix));
}

async function run(): Promise<void> {
  const {values} = parseArgs({
    options: {
      only: {type: 'string'},
      baseline: {type: 'boolean', default: false},
      tolerance: {type: 'string', default: '0'},
    },
  });

  if (!fs.existsSync(path.join(PUBLIC, 'index.html'))) {
    console.error('There is no build to screenshot: run `npm run build` first.');
    process.exit(1);
  }

  const fixture = await startFixture();
  const newDir = `${SHOTS_DIR}.new`;
  const allScenarios = buildScenarios(fixture.sha);
  const scenarios = allScenarios.filter(
    scenario => scenario.name.includes(values.only ?? '') ||
      scenario.section.includes(values.only ?? '')
  );
  const browser = await launch();
  await fsp.rm(newDir, {recursive: true, force: true});
  for (const device of Object.keys(VIEWPORTS)) {
    for (const theme of THEMES) {
      await fsp.mkdir(path.join(newDir, device, theme), {recursive: true});
    }
  }

  const shotPaths: string[] = [];
  const errors: string[] = [];
  try {
    const workers = await createSlotWorkers(browser, fixture);
    try {
      for (const scenario of scenarios) {
        const cleanup = scenario.setup ? await scenario.setup(fixture) : undefined;
        try {
          if (scenario.serial) {
            for (const worker of workers) {
              const relPath = path.join(worker.device, worker.theme, `${scenario.name}.png`);
              const problems = await shootWithWorker(
                worker,
                scenario,
                path.join(newDir, relPath),
                fixture
              );
              shotPaths.push(relPath);
              errors.push(
                ...problems.map(
                  problem => `${scenario.name} (${worker.device}/${worker.theme}): ${problem}`
                )
              );
            }
          } else {
            await Promise.all(
              workers.map(async worker => {
                const relPath = path.join(worker.device, worker.theme, `${scenario.name}.png`);
                const problems = await shootWithWorker(
                  worker,
                  scenario,
                  path.join(newDir, relPath),
                  fixture
                );
                shotPaths.push(relPath);
                errors.push(
                  ...problems.map(
                    problem => `${scenario.name} (${worker.device}/${worker.theme}): ${problem}`
                  )
                );
              })
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
    await browser.close();
    await fixture.close();
  }

  if (values.only === undefined) {
    for (const device of Object.keys(VIEWPORTS)) {
      await fsp.rm(path.join(SHOTS_DIR, device), {recursive: true, force: true});
      if (values.baseline) {
        await fsp.rm(path.join(BASELINE_DIR, device), {recursive: true, force: true});
      }
    }
  }
  for (const relPath of shotPaths) {
    const src = path.join(newDir, relPath);
    const dest = path.join(SHOTS_DIR, relPath);
    await fsp.mkdir(path.dirname(dest), {recursive: true});
    if (values.baseline) {
      const baseDest = path.join(BASELINE_DIR, relPath);
      await fsp.mkdir(path.dirname(baseDest), {recursive: true});
      await fsp.copyFile(src, baseDest);
    }
    await fsp.rename(src, dest);
  }
  await fsp.rm(newDir, {recursive: true, force: true});

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
    const only = values.only === undefined ? undefined : shotPaths;
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
