import 'source-map-support/register';

import * as fs from 'fs';
import * as path from 'path';

import * as djot from '@djot/djot';
import CSS from 'clean-css';
import favicons from 'favicons';
import html from 'html-minifier';
import katex from 'katex';
import * as template from 'mustache';

import * as projects from './projects';
import * as research from './research';

const css = new CSS();

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const STATIC = path.join(ROOT, 'src', 'static');

const LAYOUT = fs.readFileSync(path.join(STATIC, 'layout.html.tmpl'), 'utf8');
const edit = 'https://github.com/pkmn/ai/edit/main/src';

export interface Page {
  id?: string;
  title: string;
  topbar?: string;
  header?: string;
  content: string;
  edit: string;
  script?: string;
}

const OPTIONS = {
  collapseBooleanAttributes: true,
  collapseWhitespace: true,
  conservativeCollapse: true,
  decodeEntities: true,
  minifyCSS: true,
  quoteCharacter: '"',
  removeEmptyAttributes: true,
  removeEmptyElements: true,
  removeRedundantAttributes: true,
  removeScriptTypeAttributes: true,
  removeStyleLinkTypeAttributes: true,
  minifyJS: true,
  sortAttributes: true,
  sortClassName: true,
};

export const render = (name: string, page: Page) => {
  const rendered = template.render(LAYOUT, {id: path.basename(name), ...page});
  const minified = html.minify(rendered, OPTIONS);
  return minified;
};

export const write = (name: string, page: Page) => {
  fs.mkdirSync(path.join(PUBLIC, name), {recursive: true});
  fs.writeFileSync(path.join(PUBLIC, name, 'index.html'), render(name, page));
};

export const topbar =
  '<div class="topbar">Under Construction: planned completion date January 2024</div>';

const toHTML = (file: string) =>
  djot.renderHTML(djot.parse(fs.readFileSync(file, 'utf8')), {
    overrides: {
      inline_math: node => katex.renderToString(node.text, {output: 'mathml'}),
      display_math: node => katex.renderToString(node.text, {output: 'mathml'}),
    },
  });

export const build = async () => {
  fs.mkdirSync(path.join(PUBLIC), {recursive: true});

  const icons = await favicons(path.join(STATIC, 'favicon.svg'), {path: PUBLIC});
  for (const icon of icons.images) {
    if (/(yandex|startup-image)/.test(icon.name)) continue;
    fs.writeFileSync(path.join(PUBLIC, icon.name), icon.contents);
  }

  const index = fs.readFileSync(path.join(STATIC, 'index.css'), 'utf8');
  fs.writeFileSync(path.join(PUBLIC, 'index.css'), css.minify(index).styles);

  fs.copyFileSync(path.join(STATIC, 'favicon.svg'), path.join(PUBLIC, 'favicon.svg'));
  fs.copyFileSync(path.join(STATIC, 'github.svg'), path.join(PUBLIC, 'github.svg'));

  let first = true;
  fs.writeFileSync(path.join(PUBLIC, 'index.html'), html.minify(template.render(LAYOUT, {
    id: 'home',
    title: 'pkmn.ai',
    content: `<section>${toHTML(path.join(STATIC, 'index.dj')).replaceAll('<a', m => {
      if (first) {
        first = false;
        return m;
      }
      return '<a class="default"';
    })}</section>`,
    edit: `${edit}/static/index.dj`,
  }).replace('<a href="/">pkmn.ai</a>', 'pkmn.ai'), OPTIONS));

  write('projects', {...projects.page(STATIC), topbar});
  write('research', research.page(STATIC));

  write('concepts', {
    topbar,
    title: 'Concepts | pkmn.ai',
    header: '<h2>Concepts</h2>',
    content: `<section>${toHTML(path.join(STATIC, 'concepts', 'index.dj'))}</section>`,
    edit: `${edit}/static/concepts/index.dj`,

  });
  for (const title of ['Complexity', 'Engines', 'Variants']) {
    const page = title.toLowerCase();
    write(`concepts/${page}`, {
      topbar,
      title: `Concepts — ${title} | pkmn.ai`,
      header: `<h2>${title}</h2>`,
      content: `<section>${toHTML(path.join(STATIC, 'concepts', `${page}.dj`))}</section>`,
      edit: `${edit}/static/concepts/${page}.dj`,
    });
  }

  for (const title of ['Glossary', 'Rules']) {
    const page = title.toLowerCase();
    write(page, {
      topbar,
      title: `${title} | pkmn.ai`,
      header: `<h2>${title}</h2>`,
      content: `<section>${toHTML(path.join(STATIC, `${page}.dj`))}</section>`,
      edit: `${edit}/static/${page}.dj`,
    });
  }
};

if (require.main === module) {
  (async () => {
    await build();
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
