import * as fs from 'fs';
import * as path from 'path';

import {minify} from 'html-minifier';
import * as yaml from 'yaml';

interface Agent {
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

const pre = `<!doctype html>
<html lang=en>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="icon" href="https://pkmn.cc/ai.svg">
    <title>pkmn.ai</title>
    <style>
      body {
        font-family: "Roboto", "Helvetica Neue", "Helvetica", "Arial", sans-serif;
      }

      header {
        text-align: center;
      }

      h1 {
        font-weight: 900;
        margin-bottom: 0.33em;
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

      th {
        border-bottom: 1px solid black;
      }

      td {
        border-top: 1px solid #CDCDCD;
      }

      tr:first-child {
        border-top: 1px solid black;
      }

      td:first-child {
        width: 20%;
      }

      a, a:visited {
        text-decoration: none;
      }

      a:hover, a:focus, a:active  {
        text-decoration: underline;
      }

      a.unlink, a.unlink:hover, a.unlink:visited, a.unlink:focus, a.unlink:active {
        text-decoration: none;
        color: inherit;
      }

      /* Mobile - Small */
      table { font-size: 10px; }
      h1 { font-size: 24px; }

      /* Mobile - Medium */
      @media(min-width: 375px) {
        table { font-size: 12px; }
        h1 { font-size: 32px; }
        #container { max-width: 400px; }
      }

      /* Mobile - Large */
      @media(min-width: 425px) {
        table { font-size: 13px; }
        h1 { font-size: 36px; }
        #container { max-width: 500px; }
      }

      /* Tablet */
      @media(min-width: 768px) {
        table { font-size: 15px; }
        h1 { font-size: 40px; }
        #container { max-width: 600px; }
      }

      /* Laptop */
      @media(min-width: 1024px) {
        table { font-size: 16px; }
        h1 { font-size: 44px; }
        #container { max-width: 700px; }
      }
    </style>
  </head>
  <body>
    <div id="container">`;
const post = `
    </div>
  </body>
</html>`;

const file = path.join(__dirname, '..', 'agents.yml');
const agents = yaml.parse(fs.readFileSync(file, 'utf8')) as Agent[];
const score = (a: Agent) => {
  const id = a.name ?? (a.source && a.source.startsWith('https://github.com/')
    ? a.source.slice(19)
    : a.identifier!);
  // TODO: sort by live ranking > static ranking > date
  const index = RANKING.indexOf(id);
  return index >= 0 ? index : Infinity;
};
agents.sort((a, b) => score(a) - score(b));

const buf: string[] = [];
buf.push(pre);

for (const agent of agents) {
  const inactive = Array.isArray(agent.active);
  buf.push(`<div class="${inactive ? 'inactive' : 'active'}">`);
  const active = Array.isArray(agent.active)
    ? (agent.active[0] === agent.active[1]
      ? `${agent.active[0]}`
      : `${agent.active[0]} - ${agent.active[1]}`)
    : `${agent.active} - <em>present</em>`;
  const identifier = agent.source && agent.source.startsWith('https://github.com/')
    ? agent.source.slice(19)
    : undefined;
  {
    const name = agent.name ?? `<em>${identifier ?? agent.identifier}</em>`;
    buf.push(agent.site
      ? `<h2><a href="${agent.site}" class="unlink">${name}</a></h2>`
      : `<h2>${name}</h2>`);
  }
  buf.push('<table>');
  if (agent.paper) {
    const paper = `<a href="${agent.paper.url}" class="unlink"><em>${agent.paper.name}</em></a>`;
    buf.push(`<tr><td><strong>Paper</strong></td><td>${paper}</td></tr>`);
  }
  buf.push(`<tr><td><strong>Active</strong></td><td>${active}</td></tr>`);
  if (agent.license) {
    buf.push(`<tr><td><strong>License</strong></td><td><tt>${agent.license}</tt></td></tr>`);
  } else if (agent.source) {
    buf.push('<tr><td><strong>License</strong></td><td>None</td></tr>');
  }
  if (agent.source) {
    const source = `<a href="${agent.source}">${identifier ?? agent.source}</a>`;
    buf.push(`<tr><td><strong>Source</strong></td><td>${source}</td></tr>`);
  }
  if (agent.engine) {
    const engine = Array.isArray(agent.engine)
      ? agent.engine.map(({name, url}) =>
        `<a href="${url}" class="unlink">${name}</a>`).join(', ')
      : agent.engine as string;
    buf.push(`<tr><td><strong>Engine</strong></td><td>${engine}</td></tr>`);
  }
  if (agent.language) {
    const language = Array.isArray(agent.language) ? agent.language.join(', ') : agent.language;
    buf.push(`<tr><td><strong>Language</strong></td><td>${language}</td></tr>`);
  }
  if (agent.platform) {
    const platform = Array.isArray(agent.platform)
      ? agent.platform.map(({name, url}) =>
        `<a href="${url}" class="unlink">${name}</a>`).join(', ')
      : agent.platform;
    buf.push(`<tr><td><strong>Platform</strong></td><td>${platform}</td></tr>`);
  }
  if (agent.release) {
    const release = `<a href="${agent.release.url}">${agent.release.name}</a>`;
    buf.push(`<tr><td><strong>Latest Release</strong></td><td>${release}</td></tr>`);
  }
  buf.push('</table>');
  buf.push('</div>');
}
buf.push(post);
console.log(minify(buf.join(''), {minifyCSS: true, minifyJS: true}));
