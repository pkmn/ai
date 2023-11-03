import * as fs from 'fs';
import * as path from 'path';

import {minify} from 'html-minifier';
import {marked} from 'marked';
import * as mustache from 'mustache';
import * as yaml from 'yaml';

interface Project {
  name?: string;
  identifier?: string;
  framework?: true;
  site?: string;
  paper?: { name: string; url: string };
  active: number | [number, number];
  license?: string;
  source?: string;
  engine?: string | { name: string; url: string };
  language?: string | string[];
  platform?: { name: string; url: string }[];
  release?: { name: string; url: string };
}

const RANKING = [
  'Athena', // Athena - reached #33 in gen7randombattle, ~1800 Elo
  'Future Sight', // reached top 1000 in gen8ou, ~1550-1650 Elo
  'Metagrok', // beat pmariglia 61.2% of the time in gen7randombattle
  'pmariglia/showdown', // ~1610 Elo in gen7randombattle (~1450 Elo in standard)
  'Technical Machine', // ??? (1300-1400 Elo?), even record against weaker version of pmariglia
  'leolellisr/poke_RL', // 99.5% vs. RandomPlayer, 60-85% vs MaxDamage
  'Chun Him Tse', // 96.6% vs. RandomPlayer, 78.2% vs. MaxDamage. ~1350 Elo (VGC)
  'Percymon', // 1270 Elo in gen6randombattle
  'hsahovic/reinforcement-learning-pokemon-bot', // "~90% vs. RandomPlayer"
  'Chen, Lin', //  "~85% vs. RandomPlayer
  'Showdown AI Competition', // 85% vs. RandomPlayer = *equivalent* to MaxDamage
  'Kalose, Kaya, Kim', // ~60-65% vs. RandomPlayer (Gen 1)
];

const root = path.join(__dirname, '..', '..');
const file = path.join(root, 'src', 'pages', 'projects.yml');

const LAYOUT = fs.readFileSync(path.join(root, 'src', 'pages', 'layout.html.tmpl'), 'utf8');

interface Config {
  header?: string;
  content: string;
  edit: string;
  script?: string;
}

const render = (config: Config) =>
  minify(mustache.render(LAYOUT, config), {minifyCSS: true, minifyJS: true});

const FILLER =
`Lorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque ultrices,
tortor sed iaculis mollis, odio ex porta ante, ac malesuada est elit eu elit.
Etiam dapibus quam id lorem condimentum mollis. Donec non dolor ipsum. Praesent
vel ultrices ex. Donec nibh dui, hendrerit a erat et, tincidunt semper orci.
Cras in lectus sapien. Proin vehicula eros varius, eleifend neque laoreet,
iaculis leo. Lorem ipsum dolor sit amet, consectetur adipiscing elit.
Suspendisse in quam condimentum, eleifend felis vitae, congue lectus. Maecenas
arcu urna, dictum et auctor quis, vestibulum sit amet odio. Aliquam felis neque,
fringilla et porttitor a, posuere at magna. Morbi sodales maximus sapien commodo
venenatis.

In nunc felis, porta non diam in, faucibus condimentum nulla. Quisque eu
vulputate odio. Sed pharetra massa et venenatis dignissim. Vivamus aliquet
consequat nibh, non tristique libero ullamcorper eu. Fusce eget suscipit metus.
Quisque volutpat ultricies erat sit amet dignissim. In commodo pellentesque
sapien, ut commodo felis fermentum laoreet. Fusce placerat purus turpis, vitae
imperdiet libero rutrum non. Pellentesque eu justo ligula. Sed venenatis, tortor
a vehicula placerat, augue erat porta magna, et tincidunt mi neque eu neque. Sed
eleifend sem ut tellus sollicitudin, in iaculis lorem eleifend. Mauris eget
massa non leo scelerisque ultrices iaculis ut eros.`;

const SPLIT = FILLER.replaceAll('\n', '').split('.');

const projects = yaml.parse(fs.readFileSync(file, 'utf8')) as Project[];
const score = (p: Project) => {
  const id = p.name ?? (p.source && /^https:\/\/git(hub|lab).com/.test(p.source)
    ? p.source.slice(19)
    : p.identifier!);
  // TODO: sort by live ranking > static ranking > date
  const index = RANKING.indexOf(id);
  return index >= 0 ? index : Infinity;
};
projects.sort((a, b) => score(a) - score(b));

const buf: string[] = [];
const markdown =
  marked.parse(fs.readFileSync(path.join(root, 'src', 'pages', 'projects.md'), 'utf8'));
buf.push(`<div class="description">${markdown}</div>`);
buf.push(`<nav>
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
</nav>`);
for (const project of projects) {
  const inactive = Array.isArray(project.active);
  buf.push(`<div class="project"${inactive ? '' : ' data-active="true"'}>`);
  const active = Array.isArray(project.active)
    ? (project.active[0] === project.active[1]
      ? `${project.active[0]}`
      : `${project.active[0]} - ${project.active[1]}`)
    : `${project.active} - <em>present</em>`;
  const identifier = project.source && /^https:\/\/git(hub|lab).com/.test(project.source)
    ? project.source.slice(19)
    : undefined;
  {
    const name = project.name ?? `<em>${identifier ?? project.identifier}</em>`;
    buf.push(project.site
      ? `<h3><a href="${project.site}">${name}</a></h3>`
      : `<h3>${name}</h3>`);
  }
  buf.push('<table>');
  if (project.paper) {
    const paper = `<a href="${project.paper.url}"><em>${project.paper.name}</em></a>`;
    buf.push(`<tr><td><strong>Paper</strong></td><td>${paper}</td></tr>`);
  }
  buf.push(`<tr><td><strong>Active</strong></td><td>${active}</td></tr>`);
  if (project.license) {
    buf.push(`<tr><td><strong>License</strong></td><td><tt>${project.license}</tt></td></tr>`);
  } else if (project.source) {
    buf.push('<tr><td><strong>License</strong></td><td>None</td></tr>');
  }
  if (project.source) {
    const src = `<a href="${project.source}" class="default">${identifier ?? project.source}</a>`;
    buf.push(`<tr><td><strong>Source</strong></td><td>${src}</td></tr>`);
  }
  if (project.engine) {
    const engine = Array.isArray(project.engine)
      ? project.engine.map(({name, url}) =>
        `<a href="${url}">${name}</a>`).join(', ')
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
        `<a href="${url}">${name}</a>`).join(', ')
      : project.platform;
    buf.push(`<tr><td><strong>Platform</strong></td><td>${platform}</td></tr>`);
  }
  if (project.release) {
    const release = `<a href="${project.release.url}">${project.release.name}</a>`;
    buf.push(`<tr><td><strong>Latest Release</strong></td><td>${release}</td></tr>`);
  }
  buf.push('</table>');
  const description = SPLIT.slice(0, 8 + Math.random() * 12).join('.');
  buf.push(`<div class="description"><p>${description}.</p></div>`);
  buf.push('</div>');
}

console.log(render({
  title: 'Projects | pkmn.ai',
  header: '<h2>Projects</h2>',
  content: buf.join(''),
  edit: 'https://github.com/pkmn/ai/edit/main/src/pages/projects.yml',
  script: `<script>
    document.addEventListener('DOMContentLoaded', () => {
      const projects = document.getElementsByClassName("project");
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
    });
  </script>`,
}));
