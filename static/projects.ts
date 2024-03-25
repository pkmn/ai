import * as fs from 'fs';
import * as path from 'path';

import * as bibtex from '@retorquere/bibtex-parser';
import {html} from 'site';
import * as yaml from 'yaml';

import {cite, header, style} from './build';

interface Project {
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
  description?: string;
}

const RANKING = [
  'quadraticmuffin/pkmn', // reached #8 in gen8randombattle, ~1693 Elo
  'Athena', // reached #33 in gen7randombattle, ~1800 Elo
  'pmariglia/showdown', // 1716 Elo in OU (~1550 average Elo)
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

export function page(dir: string) {
  const buf: string[] = [];

  const file = (ext: string) => path.join(dir, `projects.${ext}`);

  const bib = bibtex.parse(fs.readFileSync(file('bib'), 'utf8'), {sentenceCase: false});
  if (bib.errors.length) throw new Error(`Error parsing projects.bib: ${bib.errors.join(', ')}`);

  const bibliography: {[key: string]: bibtex.Entry} = {};
  for (const entry of bib.entries) bibliography[entry.key] = entry;

  const projects: Project[] = yaml.parse(fs.readFileSync(file('yml'), 'utf8'));
  const score = (p: Project) => {
    const id = p.name ?? (p.source && /^https:\/\/git(hub|lab).com/.test(p.source)
      ? p.source.slice(19)
      : p.identifier!);
    // TODO: sort by live ranking > static ranking > date
    const index = RANKING.indexOf(id);
    return index >= 0 ? index : Infinity;
  };
  projects.sort((a, b) => score(a) - score(b));

  const filler = fs.readFileSync(file('dj'), 'utf8');
  const split = filler.replaceAll('\n', '').split('.');

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
    buf.push(`<section id="${id}" class="project"${inactive ? '' : ' data-active="true"'}>`);
    const active = Array.isArray(project.active)
      ? (project.active[0] === project.active[1]
        ? `${project.active[0]}`
        : `${project.active[0]} – ${project.active[1]}`)
      : `${project.active} – <em>present</em>`;
    const title = project.name ?? `<em>${project.identifier ?? identifier}</em>`;
    buf.push(`<h3><a href="#${id}" class="subtle">${title}</a></h3>`);
    buf.push('<table>');
    if (project.paper) {
      const p = bibliography[project.paper];
      const paper = `<a href="${p.fields.url[0]}" class="subtle"><em>${p.fields.title[0]}</em></a>`;
      buf.push(`<tr><td><strong>Paper</strong></td><td>${paper}</td></tr>`);
    }
    buf.push(`<tr><td><strong>Active</strong></td><td>${active}</td></tr>`);
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
    const site = project.site ? `<a href="${project.site}">${title}</a>. ` : '';
    const description = project.description
      ? html.render(project.description)
      : `${site}${split.slice(0, 8 + Math.random() * 12).join('.')}.`;
    buf.push(`<div class="description"><p>${description}</p></div>`);
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
    style: `.description { margin: 2em 0; } td:first-child { width: 8ch; } ${style}`,
    header: header('Projects', true),
    content: buf.join(''),
    script:
    `document.addEventListener('DOMContentLoaded', () => {
        document.getElementsByTagName('nav')[0].classList.remove('hide');
        const projects = document.getElementsByClassName('project');
        const radios = document.querySelectorAll('input[name="radio"]');

        for (let i = 0; i < radios.length; i++) {
          radios[i].addEventListener('click', () => {
            for (let j = 0; j < projects.length; j++) {
              if (radios[i].id === 'all') {
                projects[j].classList.remove('hide');
              } else {
                const hide = radios[i].id === 'active'
                  ? !projects[j].dataset.active
                  : projects[j].dataset.active;
                if (hide) {
                  projects[j].classList.add('hide');
                } else {
                  projects[j].classList.remove('hide');
                }
              }
            }
          });
        }
      });`,
  };
}
