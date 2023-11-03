import * as fs from 'fs';
import * as path from 'path';

import {minify} from 'html-minifier';
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

const pre = `<!doctype html>
<html lang=en>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="icon" href="https://pkmn.cc/ai.svg">
    <title>Projects | pkmn.ai</title>
    <style>
      body {
        font-family: "Roboto", "Helvetica Neue", "Helvetica", "Arial", sans-serif;
      }

      header {
        font-weight: 900;
        text-align: center;
      }

      h1, h2 {
        margin-bottom: 0.33em;
      }

      h2 {
        text-transform: uppercase;
        margin-top: 0;
      }

      #container {
        padding-top: 0.5em;
        margin: 0px auto;
        max-width: 800px;
      }

      table {
        border-collapse: collapse;
        min-width: 100%;
        margin: 0px auto;
        text-align: left;
        border-spacing: 0px;
        line-height: 1.15em;
      }

      td, th {
        padding: 0.33em;
      }

      td {
        border-top: 1px solid #CDCDCD;
      }

      tr:first-child td {
        border: none;
      }

      tr:first-child {
        border-top: 1px solid black;
      }

      td:first-child {
        width: 15%;
      }

      a, a:visited {
        text-decoration: none;
      }

      a:hover, a:focus, a:active  {
        text-decoration: underline;
      }

      h1 a:hover, h1 a:focus, h1 a:active  {
        text-decoration: none;
      }

      a, a:hover, a:visited, a:focus, a:active {
        color: unset;
      }

      a.default, a.default:hover, a.default:visited, a.default:focus, a.default:active {
        color: revert;
      }

      .description {
        margin: 2em 0;
      }

      p {
        line-height: 1.4em;
      }

      nav {
        text-align: center;
      }
      nav ul {
        margin: 0;
        padding: 0;
        list-style: none;
      }
      nav li {
        display: inline-block;
      }
      nav input {
        clip: rect(0 0 0 0);
        clip-path: inset(100%);
        height: 1px;
        overflow: hidden;
        position: absolute;
        white-space: nowrap;
        width: 1px;
      }
      nav label {
        cursor: pointer;
      }
      nav input:checked + label {
        font-weight: bold;
      }

      .hide {
        display: none;
      }

      /* Mobile - Small */
      table, p { font-size: 10px; }
      h1 { font-size: 24px; }
      h2 { font-size: 18px; }
      h3 { font-size: 15px; }
      nav { font-size: 12px; }

      /* Mobile - Medium */
      @media(min-width: 375px) {
        table, p { font-size: 12px; }
        h1 { font-size: 32px; }
        h2 { font-size: 24px; }
        h3 { font-size: 20px; }
        nav { font-size: 13px; }
        #container { max-width: 400px; }
      }

      /* Mobile - Large */
      @media(min-width: 425px) {
        table, p { font-size: 13px; }
        h1 { font-size: 36px; }
        h2 { font-size: 27px; }
        h3 { font-size: 23px; }
        nav { font-size: 14px; }
        #container { max-width: 500px; }
      }

      /* Tablet */
      @media(min-width: 768px) {
        table, p { font-size: 15px; }
        h1 { font-size: 40px; }
        h2 { font-size: 30px; }
        h3 { font-size: 25px; }
        nav { font-size: 15px; }
        #container { max-width: 600px; }
      }

      /* Laptop */
      @media(min-width: 1024px) {
        table, p { font-size: 16px; }
        h1 { font-size: 44px; }
        h2 { font-size: 33px; }
        h3 { font-size: 28px; }
        nav { font-size: 18px; }
        #container { max-width: 700px; }
      }
    </style>
  </head>
  <body>
    <header>
      <h1><a href="/">pkmn.ai</a></h1>
      <h2>Projects</h2>
    </header>
    <div id="container">
    <div class="description">
      <p>${FILLER.replace('\n\n', '</p><p>')}</p>
    </div>
    <nav>
      <ul>
        <li>
          <input type="radio" value="active" name="radio" id="active" />
          <label for="active">Active</label>
        </li>
        -
        <li>
          <input type="radio" value="all" name="radio" id="all" checked="checked" />
          <label for="all">All</label>
        </li>
        -
        <li>
          <input type="radio" value="inactive" name="radio" id="inactive" />
          <label for="inactive">Inactive</label>
        </li>
      </ul>
    </nav>`;
const post = `
    </div>
    <script>
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
    </script>
  </body>
</html>`;

const root = path.join(__dirname, '..', '..');
const file = path.join(root, 'src', 'pages', 'projects.yml');
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
buf.push(pre);
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
buf.push(post);
console.log(minify(buf.join(''), {minifyCSS: true, minifyJS: true}));
