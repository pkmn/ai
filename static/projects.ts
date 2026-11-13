import * as fs from 'fs';
import * as path from 'path';

import * as bibtex from '@retorquere/bibtex-parser';
import {html} from 'site';
import * as yaml from 'yaml';

import {cite, header, style} from './build';
import {EXT_ICON, escapeHtml, slugify} from './util';

export interface ArenaBadge {
  slot: string;
  name: string;
  rank?: number;
  provisional: boolean;
}

export interface ArenaInfo {
  slug: string;
  name: string;
  profileHref?: string;
  bestRank?: number;
  bestLcb?: number;
  ladders: ArenaBadge[];
}

export interface Project {
  name?: string;
  identifier?: string;
  framework?: true;
  site?: string;
  paper?: string;
  active: number | [number, number];
  license?: string;
  source?: string;
  engine?: string | {name: string; url: string};
  language?: string | string[];
  platform?: {name: string; url: string}[];
  release?: {name: string; url: string};
  arena?: {
    owners: {[github: string]: string | number};
    logo?: string;
    qualified?: boolean;
  };
}

// Hand-curated historical strength ordering used to sort non-Arena projects (and to break ties
// among Arena projects that do not yet have a settled live rank). Settled Arena entrants always
// sort ahead of unranked catalog projects by `bestRank`, then `bestLcb`.
const RANKING = [
  'Jaxcalibur', // top gen9randbats (94.6% GXE) & beat MDB Bo9
  'eevenator', // top gen9randbats (2594 Elo/94.0% GXE/2019 Glicko)
  'AWRorus', // top gen9ag & #2 gen9randbats (2432 Elo/93.9% GXE/2015 Glicko)
  'MissingNo.Zero', // #1 in 5 randbats gens & #5 gen9randbats (2453 Elo/93.4% GXE/1999 Glicko)
  'Xatu Zero', // top gen9ou (2002 Elo/88.0% GXE/1876 Glicko), gen9uu & gen9monotype
  'pokerus', // top gen9ou (1955 Elo/82.4% GXE/1791 Glicko) & #5 gen9ubers
  'MysteriousWind', // top VGC Bo1 & Bo3 (1889 Elo/91.0% GXE/1937 Glicko) & #1 vgc.bot OTS/CTS
  'mikumiku', // top VGC (1857 Elo/81.2% GXE/ 1775 Glicko)
  'nessie', // top VGC Bo3 (1639 Elo/75.7% GXE/1714 Glicko)
  'Mew\'s Truck', // top VGC (1942 Elo/81.0% GXE/1774 Glicko)
  'openvgc', // top VGC (1929 Elo/80.8% GXE/1771 Glicko)
  'Porygoned', // top VGC (1986 Elo/72.4% GXE/1682 Glicko) & #1 vgc.bot CTS
  'Mocca', // #1 vgc.bot OTS, CTS & CTS Random
  'AsterAI', // #1 vgc.bot CTS (1700+ Glicko)
  'Numbrion', // top gen9randomdoublesbattle (2136 Elo/88.5% GXE/1829 Glicko)
  'Foul Play', // reached #2 in gen9randbats (~92% GXE) & #10 CG OU (~83% GXE)
  'Metamon', // reached #1 gen1ou, 83.6% GXE/1743 Elo/82.4%
  'PokeCHAD', // 2000+ gen9randbats Elo, ~par with Foul Play
  'RotomDotExe', // 16th on VGC, 1833 Elo/75.6% GXE/1713 Glicko
  'Springtime Haze', // 27th on VGC Bo3, 1639 Elo/75.9% GXE/1716 Glicko & #5 vgc.bot OTS
  'Incinference', // 46th on VGC , 1583 Elo/77% GXE/1730 Glicko
  'Chimera3', // #6 vgc.bot OTS Random & #10 OTS
  'hotpot01', // #4 vgc.bot CTS Random & #12 CTS
  'CalmMindAI', // VGC 1627 Elo/70.5% GXE/1664 Glicko & #8 vgc.bot CTS
  'IHTFP Abra', // reached #8 in gen4randombattle, ~1693 Elo
  'Athena', // reached #33 in gen7randombattle, ~1800 Elo
  'Future Sight', // reached top 1000 in gen8ou, ~1550-1650 Elo
  'Metagrok', // beat pmariglia 61.2% of the time in gen7randombattle
  'Technical Machine', // ??? (1300-1400 Elo?), even record against weaker version of pmariglia
  'Tse', // 96.6% vs. RandomPlayer, 78.2% vs. MaxDamage. ~1350 Elo (VGC)
  'leolellisr/poke_RL', // 99.5%* vs. RandomPlayer, 60-85%* vs MaxDamage
  'reuniclusVGC', // "like 98%* vs RandomPlayer and 90%* against MaxDamage"
  'Percymon', // 1270 Elo in gen6randombattle
  'taylorhansen/pokemonshowdown-ai', // beats MaxExpectedDamage "a bit under half of its matches"
  'hsahovic/reinforcement-learning-pokemon-bot', // "~90% vs. RandomPlayer"
  'alphaPoke', // "87-88% vs. RandomPlayer = ~1150 Elo"
  'Showdown AI Competition', // 85% vs. RandomPlayer = *equivalent* to MaxDamage
  'kvchen/showdown-rl', //  ~58% vs. RP(0), ~85% vs. RP(~100%), 10% vs. greedy
  'alexzhang13/reward-shaping-rl', // 95%+ vs. RP(~100%), 50-55% vs. RP(0), <10% vs. MaxAttack
  'blue-sky-sea/Pokemon-MCTS-AI-Master', // 68% vs. RandomPlayer (Gen 4 Doubles)
  'Kalose, Kaya & Kim', // ~60-65% vs. RandomPlayer (Gen 1)
];

// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
// eslint-disable-next-line max-len
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function page(
  dir: string,
  arenaByName?: ReadonlyMap<string, ArenaInfo>
) {
  const buf: string[] = [];

  const file = (ext: string) => path.join(dir, `projects.${ext}`);

  const bib = bibtex.parse(fs.readFileSync(file('bib'), 'utf8'), {sentenceCase: false});
  if (bib.errors.length) {
    throw new Error(`Error parsing projects.bib: ${bib.errors.map(e => e.error).join(', ')}`);
  }

  const bibliography: {[key: string]: bibtex.Entry} = {};
  for (const entry of bib.entries) {
    const key = entry.key === 'DellAcqua:2022'
      ? 'Dell’Acqua:2022'
      : entry.key;
    bibliography[key] = entry;
  }

  const projects: Project[] = yaml.parse(fs.readFileSync(file('yml'), 'utf8'));
  const rankIndex = (p: Project) => {
    const id = p.name ?? (p.source && /^https:\/\/git(hub|lab).com/.test(p.source)
      ? p.source.slice(19)
      : p.identifier!);
    const index = RANKING.indexOf(id);
    return index >= 0 ? index : Infinity;
  };
  const startYear = (p: Project) => Array.isArray(p.active) ? p.active[0] : p.active;
  projects.sort((a, b) => {
    const aArena = a.name ? arenaByName?.get(a.name) : undefined;
    const bArena = b.name ? arenaByName?.get(b.name) : undefined;
    const aLiveRank = aArena?.bestRank;
    const bLiveRank = bArena?.bestRank;

    if (aLiveRank !== undefined && bLiveRank !== undefined) {
      if (aLiveRank !== bLiveRank) return aLiveRank - bLiveRank;
      const lcbDiff = (bArena?.bestLcb ?? 0) - (aArena?.bestLcb ?? 0);
      if (lcbDiff !== 0) return lcbDiff;
    } else if (aLiveRank !== undefined) {
      return -1;
    } else if (bLiveRank !== undefined) {
      return 1;
    }

    const aIdx = rankIndex(a);
    const bIdx = rankIndex(b);
    if (aIdx !== bIdx) return aIdx - bIdx;

    return startYear(a) - startYear(b);
  });

  const filler = fs.readFileSync(file('dj'), 'utf8');
  const markdown = html.render(filler);
  buf.push(`<section><div class="description">${markdown}</div></section>`);
  buf.push(
    `<nav class="hide">
      <ul>
        <li>
          <input type="radio" value="active" name="radio" id="active" />
          <label for="active">Active</label>
        </li>
        —
        <li>
          <input type="radio" value="arena" name="radio" id="arena" />
          <label for="arena">Arena</label>
        </li>
        —
        <li>
          <input type="radio" value="all" name="radio" id="all" checked="checked" />
          <label for="all">All</label>
        </li>
        —
        <li>
          <input type="radio" value="inactive" name="radio" id="inactive" />
          <label for="inactive">Inactive</label>
        </li>
      </ul>
     </nav>`
  );
  for (const project of projects) {
    const inactive = Array.isArray(project.active);
    const identifier = project.source && /^https:\/\/git(hub|lab).com/.test(project.source)
      ? project.source.slice(19)
      : undefined;
    const id =
      (project.name ?? identifier ?? project.paper ?? project.identifier)!.replaceAll(' ', '');
    const rawLabel = project.name ?? identifier ?? project.paper ?? project.identifier ?? '';
    const slug = slugify(rawLabel).toLowerCase();
    const arenaInfo = project.name ? arenaByName?.get(project.name) : undefined;
    const isArena = Boolean(project.arena || arenaInfo);
    const dataAttrs = ` data-slug="${escapeHtml(slug)}"` +
      `${inactive ? '' : ' data-active="true"'}` +
      `${isArena ? ' data-arena="true"' : ''}`;
    buf.push(`<section id="${id}" class="project"${dataAttrs}>`);
    const active = Array.isArray(project.active)
      ? (project.active[0] === project.active[1]
        ? `${project.active[0]}`
        : `${project.active[0]} – ${project.active[1]}`)
      : `${project.active} – <em>present</em>`;
    const title = project.name ?? `<em>${project.identifier ?? identifier}</em>`;
    const site = project.site ? `<a href="${project.site}" class="subtle">${EXT_ICON}</a>` : '';
    buf.push(`<h3><a href="#${id}" class="subtle">${title}</a>${site}</h3>`);
    buf.push('<table>');
    if (project.paper) {
      const p = bibliography[project.paper];
      const paper = `<a href="${p.fields.url}" class="subtle"><em>${p.fields.title}</em></a>`;
      buf.push(`<tr><td><strong>Paper</strong></td><td>${paper}</td></tr>`);
    }
    buf.push(`<tr><td><strong>Active</strong></td><td>${active}</td></tr>`);
    if (isArena) {
      const displayName = project.name ?? arenaInfo?.name ?? (project.identifier ?? identifier)!;
      const defaultProfileHref = slug ? `/projects/${encodeURIComponent(slug)}/` : `#${id}`;
      const profileHref = arenaInfo?.profileHref ?? defaultProfileHref;
      const badgesHtml = arenaInfo && arenaInfo.ladders.length > 0
        ? ' · ' + arenaInfo.ladders.map(b => (
          b.provisional || b.rank === undefined
            ? `<a href="/arena/ladders/${escapeHtml(b.slot)}/" class="subtle">` +
              `<tt>${escapeHtml(b.name)}</tt> <em>(provisional)</em></a>`
            : `<a href="/arena/ladders/${escapeHtml(b.slot)}/" class="subtle">` +
              `<tt>${escapeHtml(b.name)}</tt> #${b.rank}</a>`
        )).join(', ')
        : '';
      const nameLink = `<a href="${escapeHtml(profileHref)}" class="arena-agent">` +
        `<strong>${escapeHtml(displayName)}</strong></a>`;
      buf.push(`<tr><td><strong>Arena</strong></td><td>${nameLink}${badgesHtml}</td></tr>`);
    }
    if (project.license) {
      buf.push(`<tr><td><strong>License</strong></td><td><tt>${project.license}</tt></td></tr>`);
    } else if (project.source) {
      buf.push('<tr><td><strong>License</strong></td><td>None</td></tr>');
    }
    if (project.source) {
      const src = `<a href="${project.source}">${identifier ?? project.source}</a>`;
      buf.push(`<tr><td><strong>Source</strong></td><td>${src}</td></tr>`);
    }
    if (project.engine) {
      const engine = Array.isArray(project.engine)
        ? project.engine.map(({name, url}) =>
          `<a href="${url}" class="subtle">${name}</a>`).join(', ')
        : project.engine as string;
      buf.push(`<tr><td><strong>Engine</strong></td><td>${engine}</td></tr>`);
    }
    if (project.language) {
      const lang = Array.isArray(project.language) ? project.language.join(', ') : project.language;
      buf.push(`<tr><td><strong>Language</strong></td><td>${lang}</td></tr>`);
    }
    if (project.platform) {
      const platform = Array.isArray(project.platform)
        ? project.platform.map(({name, url}) =>
          `<a href="${url}" class="subtle">${name}</a>`).join(', ')
        : project.platform;
      buf.push(`<tr><td><strong>Platform</strong></td><td>${platform}</td></tr>`);
    }
    if (project.release) {
      const name = SEMVER.test(project.release.name)
        ? `<code>${project.release.name}</code>`
        : `<i>${project.release.name}</i>`;
      const release = `<a href="${project.release.url}" class="subtle">${name}</a>`;
      buf.push(`<tr><td><strong>Release</strong></td><td>${release}</td></tr>`);
    }
    buf.push('</table>');
    buf.push('</section>');
  }

  let latest = new Date(0);
  for (const extension of ['bib', 'dj', 'ts', 'yml']) {
    const date = fs.statSync(file(extension)).mtime;
    if (latest < date) latest = date;
  }
  buf.push(cite('Projects', latest));

  return {
    path: '/projects/',
    title: 'Projects | pkmn.ai',
    style: `
      main { width: 100%; }
      .description { text-align: center; }
      .arena-agent { white-space: nowrap; }
      td:first-child { width: 8ch; }
      h3 svg {
        display: inline-block;
        width: 0.7em;
        height: 0.7em;
        margin-left: 0.25em;
        vertical-align: middle;
      }
      ${style}`,
    header: header('Projects'),
    content: buf.join(''),
    script:
    `document.addEventListener('DOMContentLoaded', () => {
        document.getElementsByTagName('nav')[0].classList.remove('hide');
        const projects = document.getElementsByClassName('project');
        const radios = document.querySelectorAll('input[name="radio"]');
        const applyFilter = mode => {
          for (let j = 0; j < projects.length; j++) {
            let hide = false;
            if (mode === 'active') hide = !projects[j].dataset.active;
            else if (mode === 'arena') hide = !projects[j].dataset.arena;
            else if (mode === 'inactive') hide = Boolean(projects[j].dataset.active);
            projects[j].classList.toggle('hide', hide);
          }
        };

        for (let i = 0; i < radios.length; i++) {
          radios[i].addEventListener('click', () => applyFilter(radios[i].id));
        }

        const checkHash = () => {
          if (!location.hash) return;
          const raw = decodeURIComponent(location.hash.slice(1));
          let el = document.getElementById(raw);
          if (!el) {
            const slug = raw.toLowerCase();
            for (let k = 0; k < projects.length; k++) {
              if (projects[k].dataset.slug === slug) {
                el = projects[k];
                break;
              }
            }
          }
          if (el && el.classList.contains('project')) {
            el.classList.remove('hide');
            el.scrollIntoView();
          }
        };
        window.addEventListener('hashchange', checkHash);
        checkHash();
      });`,
  };
}
