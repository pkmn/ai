import 'source-map-support/register';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmna.ai-'));
process.on('exit', () => fs.rmSync(TMP, {recursive: true, force: true}));

export const list = (dir: string) => fs.readdirSync(dir);
export const mkdir = (dir: string) => fs.mkdirSync(dir, {recursive: true});
export const remove = (file: string) => fs.rmSync(file, {recursive: true, force: true});
export const exists = (file: string) => fs.existsSync(file);
export const read = (file: string) => fs.readFileSync(file, 'utf8');
export const write = (file: string, data: string | NodeJS.ArrayBufferView) => {
  const tmp = path.join(TMP, crypto.randomBytes(16).toString('hex'));
  try {
    fs.writeFileSync(tmp, data, {flag: 'wx'});
    fs.renameSync(tmp, file);
  } finally {
    remove(tmp);
  }
};
export const copy = (src: string, dst: string) => {
  const tmp = path.join(TMP, crypto.randomBytes(16).toString('hex'));
  try {
    fs.copyFileSync(src, tmp, fs.constants.COPYFILE_EXCL);
    fs.renameSync(tmp, dst);
  } finally {
    remove(tmp);
  }
};

const LAYOUT = read(path.join(STATIC, 'layout.html.tmpl'));
const EDIT = 'https://github.com/pkmn/ai/edit/main/src';

export interface Page {
  id?: string;
  path: string;
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

const make = (name: string, page: Page) => {
  mkdir(path.join(PUBLIC, name));
  write(path.join(PUBLIC, name, 'index.html'), render(name, page));
};

export const topbar = 'Under Construction: planned completion date January 2024';

interface AstNode {attributes?: {[key: string]: string}}

const hasClass = (node: AstNode, cls: string) => {
  node.attributes = node.attributes || {};
  const attr = node.attributes?.['class'] || '';
  return attr.split(' ').includes(cls);
};

const addClass = (node: AstNode, cls: string) => {
  node.attributes = node.attributes || {};
  const attr = node.attributes['class'];
  node.attributes['class'] = attr ? `${attr} ${cls}` : cls;
};

const extractCaption = (node: AstNode) => {
  if (!node.attributes?.cap) return undefined;
  const result = node.attributes.cap;
  delete node.attributes.cap;
  return result;
};

const toHTML = (file: string) =>
  djot.renderHTML(djot.parse(read(file)), {
    overrides: {
      inline_math: node => katex.renderToString(node.text, {output: 'mathml'}),
      display_math: node => katex.renderToString(node.text, {output: 'mathml'}),
      div: (node, r): string => {
        if (hasClass(node, 'block')) {
          let cap = extractCaption(node);
          if (cap) {
            cap = `<div class="title">${cap}</div>`;
          } else {
            cap = '';
          }
          return [
            `<aside${r.renderAttributes(node)}>`, cap, r.renderChildren(node), '</aside>',
          ].join('\n');
        }

        if (hasClass(node, 'details')) {
          return [
            '<details>', `<summary>${extractCaption(node)}</summary>`,
            r.renderChildren(node), '</details>'].join('\n');
        }

        return r.renderAstNodeDefault(node);
      },
      code_block: (node) => {
        let cap = extractCaption(node);
        if (cap) {
          cap = `<figcaption class="title">${cap}</figcaption>\n`;
        } else {
          cap = '';
        }
        // const pre = highlight(node.text, node.lang, node.attributes?.highlight).value;
        const pre = node.text;
        return `<figure class="code">\n${cap}\n${pre}\n</figure>`;
      },
      span: (node, r) => {
        if (hasClass(node, 'code')) {
          const children = r.renderChildren(node);
          return `<code>${children}</code>`;
        }
        if (hasClass(node, 'dfn')) {
          const children = r.renderChildren(node);
          return `<dfn>${children}</dfn>`;
        }
        if (hasClass(node, 'kbd')) {
          const children = r.renderChildren(node)
            .split('+')
            .map((it) => `<kbd>${it}</kbd>`)
            .join('+');
          return `<kbd>${children}</kbd>`;
        }
        return r.renderAstNodeDefault(node);
      },
      str: (node, r) => {
        if (hasClass(node, 'dfn')) {
          return `<dfn>${node.text}</dfn>`;
        }
        return r.renderAstNodeDefault(node);
      },
      url: (node, r) => {
        addClass(node, 'url');
        return r.renderAstNodeDefault(node);
      },
    },
  });

const build = async (rebuild?: boolean) => {
  mkdir(path.join(PUBLIC));

  let actual = list(PUBLIC);
  let expected = new Set([
    'projects', 'research', 'concepts', 'glossary', 'rules', 'chat', 'leaderboard', 'background',
    'index.css', 'favicon.svg', 'github.svg', 'index.html', 'projects.bib', 'research.bib',
  ]);
  if (!rebuild) {
    const icons = await favicons(path.join(STATIC, 'favicon.svg'), {path: PUBLIC});
    for (const icon of icons.images) {
      if (/(yandex|apple)/.test(icon.name)) continue;
      write(path.join(PUBLIC, icon.name), icon.contents);
      expected.add(icon.name);
    }
  }

  const index = read(path.join(STATIC, 'index.css'));
  write(path.join(PUBLIC, 'index.css'), css.minify(index).styles);

  for (const placeholder of ['chat', 'leaderboard']) {
    const file = path.join(PUBLIC, placeholder, 'index.html');
    if (!exists(file)) {
      mkdir(path.dirname(file));
      write(file, '');
    }
  }

  for (const file of ['favicon.svg', 'github.svg', 'projects.bib', 'research.bib']) {
    copy(path.join(STATIC, file), path.join(PUBLIC, file));
  }

  write(path.join(PUBLIC, 'index.html'), html.minify(template.render(LAYOUT, {
    id: 'home',
    title: 'pkmn.ai',
    content: `${toHTML(path.join(STATIC, 'index.dj')).replace('<a', '<a class="subtle"')}`,
    edit: `${EDIT}/static/index.dj`,
  }).replace('<a href="/">pkmn.ai</a>', 'pkmn.ai'), OPTIONS));

  make('projects', {...projects.page(STATIC), topbar});
  make('research', research.page(STATIC));

  for (const title of ['Glossary', 'Background', 'Rules']) {
    const page = title.toLowerCase();
    make(page, {
      path: `/${page}/`,
      topbar,
      title: `${title} | pkmn.ai`,
      header: title,
      content: `${toHTML(path.join(STATIC, `${page}.dj`))}`,
      edit: `${EDIT}/static/${page}.dj`,
    });
  }

  make('concepts', {
    path: '/concepts/',
    title: 'Concepts | pkmn.ai',
    topbar,
    header: 'Concepts',
    content: `${toHTML(path.join(STATIC, 'concepts', 'index.dj'))}`,
    edit: `${EDIT}/static/concepts/index.dj`,
  });

  if (!rebuild) {
    for (const file of actual) {
      if (!expected.has(file)) remove(path.join(PUBLIC, file));
    }
  }

  actual = list(path.join(PUBLIC, 'concepts'));
  expected = new Set(['index.html']);

  for (const title of ['Abstraction', 'Complexity', 'Engines', 'Protocol', 'Variants']) {
    const page = title.toLowerCase();
    expected.add(page);
    make(`concepts/${page}`, {
      path: `/concepts/${page}/`,
      title: `Concepts — ${title} | pkmn.ai`,
      topbar,
      header: title,
      content: toHTML(path.join(STATIC, 'concepts', `${page}.dj`)),
      edit: `${EDIT}/static/concepts/${page}.dj`,
    });
  }

  for (const file of actual) {
    if (!expected.has(file)) remove(path.join(PUBLIC, 'concepts', file));
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
