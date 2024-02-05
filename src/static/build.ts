// Based on the MIT licensed matklad/matklad.github.io:
// https://github.com/matklad/matklad.github.io/blob/master/LICENSE-MIT

require('source-map-support').install();

import * as path from 'path';

import favicons from 'favicons';
import * as site from 'site';

import * as glossary from './glossary';
import * as projects from './projects';
import * as research from './research';

const fs = site.fs;

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const STATIC = path.join(ROOT, 'src', 'static');

export const renderer = new site.page.Renderer({
  public: PUBLIC,
  analytics: 'G-LQ8TW28Z7Q',
  description: 'The home of competitive Pokémon artificial intelligence',
  url: 'https://pkmn.ai',
  stylesheet: path.join(STATIC, 'index.css'),
});

export const header = (title: string, wip = false) =>
  `${wip ? '<div id="topbar">Under Construction: planned completion date April 2024</div>' : ''}
  <h1><a href="/" class="subtle">pkmn.ai</a></h1>
  <h2>${title}</h2>`;

export const style = ' [id] { scroll-margin-top: 2rem; }';

const build = async (rebuild?: boolean) => {
  fs.mkdir(path.join(PUBLIC));

  let actual = fs.list(PUBLIC);
  let expected = new Set([
    'projects', 'research', 'concepts', 'glossary', 'rules', 'chat', 'leaderboard', 'background',
    'index.html', 'favicon.svg', 'cc.svg', 'by.svg', 'sa.svg', 'projects.bib', 'research.bib',
  ]);
  if (!rebuild) {
    const icons = await favicons(path.join(STATIC, 'favicon.svg'), {path: PUBLIC});
    for (const icon of icons.images) {
      if (/(yandex|apple)/.test(icon.name)) continue;
      fs.write(path.join(PUBLIC, icon.name), icon.contents);
      expected.add(icon.name);
    }
  }

  for (const placeholder of ['chat', 'leaderboard']) {
    const file = path.join(PUBLIC, placeholder, 'index.html');
    if (!fs.exists(file)) {
      fs.mkdir(path.dirname(file));
      fs.write(file, '');
    }
  }

  const files = ['favicon.svg', 'cc.svg', 'by.svg', 'sa.svg', 'projects.bib', 'research.bib'];
  for (const file of files) {
    fs.copy(path.join(STATIC, file), path.join(PUBLIC, file));
  }
  fs.write(path.join(PUBLIC, 'index.html'), renderer.render({
    id: 'home',
    title: 'pkmn.ai',
    header: '<h1>pkmn.ai</h1>',
    path: '',
    content: `${site.html.render(fs.read(path.join(STATIC, 'index.dj'))
      .replace('<a', '<a class="subtle"'))}`,
  }));

  renderer.create('glossary', glossary.page(STATIC));
  renderer.create('projects', projects.page(STATIC));
  renderer.create('research', research.page(STATIC));

  for (const title of ['Background', 'Rules']) {
    const page = title.toLowerCase();
    renderer.create(page, {
      path: `/${page}/`,
      style,
      title: `${title} | pkmn.ai`,
      header: header(title, true),
      content: `${site.html.render(fs.read(path.join(STATIC, `${page}.dj`)))}`,
    });
  }

  renderer.create('concepts', {
    path: '/concepts/',
    title: 'Concepts | pkmn.ai',
    style: `
    ul {
      margin-top: 3em;
      padding: 0;
      text-align: center;
    }
    li {
      margin-bottom: 0.5rem;
      line-height: 1.15;
      list-style: none;
    }`,
    header: header('Concepts'),
    content: `${site.html.render(fs.read(path.join(STATIC, 'concepts.dj')))}`,
  });

  if (!rebuild) {
    const now = new Date();
    for (const file of actual) {
      const full = path.join(PUBLIC, file);
      if (!expected.has(file) && !renderer.retain(full, now)) {
        fs.remove(full);
      }
    }
  }

  actual = fs.list(path.join(PUBLIC, 'concepts'));
  expected = new Set(['index.html']);

  const titles = ['Complexity', 'Engines', 'Protocol', 'Variants'];
  for (const title of titles) {
    const page = title.toLowerCase();
    expected.add(page);
    const wip = title !== 'Variants';
    renderer.create(`concepts/${page}`, {
      path: `/concepts/${page}/`,
      title: `Concepts — ${title} | pkmn.ai`,
      style: wip ? style : '',
      header: header(title, wip),
      content: site.html.render(fs.read(path.join(STATIC, 'concepts', `${page}.dj`))),
    });
  }

  for (const file of actual) {
    if (!expected.has(file)) fs.remove(path.join(PUBLIC, 'concepts', file));
  }
};

if (require.main === module) {
  (async () => {
    await build(process.argv[2] === '--rebuild');
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
