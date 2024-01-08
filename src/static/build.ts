// Based on the MIT licensed matklad/matklad.github.io:
// https://github.com/matklad/matklad.github.io/blob/master/LICENSE-MIT

require('source-map-support').install();

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

import * as glossary from './glossary';
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
let stylesheet = '';

const EXPIRY = process.env.NODE_ENV === 'development' ? 0 : 14 * (24 * 60 * 60 * 1000);
const retain = (file: string, now: number) =>
  file === stylesheet || (/index\..*\.css/.test(file) &&
  now - fs.statSync(path.join(PUBLIC, file)).ctimeMs < EXPIRY);

export interface Page {
  id?: string;
  path: string;
  title: string;
  style?: string;
  topbar?: string;
  header?: string;
  content: string;
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
  if (!stylesheet) throw new Error('call to render before assets have been built');
  const rendered = template.render(LAYOUT, {id: path.basename(name), ...page, stylesheet});
  const minified = html.minify(rendered, OPTIONS);
  return minified;
};

const make = (name: string, page: Page) => {
  mkdir(path.join(PUBLIC, name));
  write(path.join(PUBLIC, name, 'index.html'), render(name, page));
};

export const topbar = 'Under Construction: planned completion date April 2024';

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

const extract = (node: AstNode, r: djot.HTMLRenderer, attr: string) => {
  if (!node.attributes?.[attr]) return '';
  const result = r.renderAstNodeDefault(djot.parse(node.attributes[attr])).slice(3, -5);
  delete node.attributes[attr];
  return result;
};

export const toHTML = (str: string) =>
  djot.renderHTML(djot.parse(str), {
    overrides: {
      inline_math: node => katex.renderToString(node.text, {output: 'mathml', displayMode: false}),
      display_math: node => katex.renderToString(node.text, {output: 'mathml', displayMode: true}),
      div: (node, r): string => {
        if (hasClass(node, 'aside')) {
          node.attributes = node.attributes || {};
          const title = extract(node, r, 'title');
          return `
            <aside${r.renderAttributes(node)}>
              <div class="title">${title}</div>
              ${r.renderChildren(node)}
            </aside>
          `;
        }
        if (hasClass(node, 'details')) {
          return `
            <details><summary>${extract(node, r, 'summary')}</summary>
              ${r.renderChildren(node)}
            </details>
          `;
        }
        return r.renderAstNodeDefault(node);
      },
      code_block: (node, r) => {
        const title = extract(node, r, 'title');
        const cite = extract(node, r, 'cite');
        const caption =
          title ? `<figcaption class="title">${title}</figcaption>`
          : cite ? `<figcaption class="cite"><cite>${cite}</cite></figcaption>` : '';
        // const code = highlight(node.text, node.lang).trimEnd();
        const code = node.text;
        return `
          <figure class="code">
            ${caption}
            <pre><code>${code}</code></pre>
          </figure>
        `;
      },
      para: (node, r) => {
        if (node.children.length === 1 && node.children[0].tag === 'image') {
          node.attributes = node.attributes || {};
          const caption = extract(node, r, 'caption');
          return `
            <figure${r.renderAttributes(node)}>
              <figcaption class="title">${caption}</figcaption>
              ${r.renderChildren(node)}
            </figure>
          `;
        }
        return r.renderAstNodeDefault(node);
      },
      block_quote: (node, r) => {
        let caption = '';
        if (node.children.length > 0) {
          const last_child: { tag: string; children?: AstNode[] } =
            node.children[node.children.length - 1];
          const cite =
            last_child.tag !== 'thematic_break' &&
            last_child?.children?.length === 1 &&
            (last_child?.children[0] as any).tag === 'link';
          if (cite) {
            caption = `
              <figcaption class="cite">
               <cite>${r.renderAstNode(last_child.children![0] as any)}</cite>
              </figcaption>
            `;
            node.children.pop();
          }
        }
        return `
          <figure class="blockquote">
            <blockquote>${r.renderChildren(node)}</blockquote>
            ${caption}
          </figure>
        `;
      },
      span: (node, r) => {
        if (hasClass(node, 'code')) return `<code>${r.renderChildren(node)}</code>`;
        if (hasClass(node, 'dfn')) return `<dfn>${r.renderChildren(node)}</dfn>`;
        if (hasClass(node, 'kbd')) {
          const children = r.renderChildren(node).split('+').map(s => `<kbd>${s}</kbd>`).join('+');
          return `<kbd>${children}</kbd>`;
        }
        if (hasClass(node, 'email')) {
          const obfuscated = r.renderChildren(node).split('.').join('<b>.spam</b>.');
          return `<span class="email">${obfuscated}</span>`;
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
    'index.html', 'favicon.svg', 'cc.svg', 'by.svg', 'sa.svg', 'projects.bib', 'research.bib',
  ]);
  if (!rebuild) {
    const icons = await favicons(path.join(STATIC, 'favicon.svg'), {path: PUBLIC});
    for (const icon of icons.images) {
      if (/(yandex|apple)/.test(icon.name)) continue;
      write(path.join(PUBLIC, icon.name), icon.contents);
      expected.add(icon.name);
    }
  }

  const index = css.minify(read(path.join(STATIC, 'index.css'))).styles;
  const hash = crypto.createHash('sha256').update(index).digest('hex').slice(0, 8);
  stylesheet = `index.${hash}.css`;
  write(path.join(PUBLIC, stylesheet), index);

  for (const placeholder of ['chat', 'leaderboard']) {
    const file = path.join(PUBLIC, placeholder, 'index.html');
    if (!exists(file)) {
      mkdir(path.dirname(file));
      write(file, '');
    }
  }

  const files = ['favicon.svg', 'cc.svg', 'by.svg', 'sa.svg', 'projects.bib', 'research.bib'];
  for (const file of files) {
    copy(path.join(STATIC, file), path.join(PUBLIC, file));
  }

  write(path.join(PUBLIC, 'index.html'), html.minify(template.render(LAYOUT, {
    id: 'home',
    title: 'pkmn.ai',
    stylesheet,
    content: `${toHTML(read(path.join(STATIC, 'index.dj')).replace('<a', '<a class="subtle"'))}`,
  }).replace('<a href="/" class="subtle">pkmn.ai</a>', 'pkmn.ai'), OPTIONS));

  make('glossary', {...glossary.page(STATIC), topbar});
  make('projects', {...projects.page(STATIC), topbar});
  make('research', research.page(STATIC));

  for (const title of ['Background', 'Rules']) {
    const page = title.toLowerCase();
    make(page, {
      path: `/${page}/`,
      topbar,
      title: `${title} | pkmn.ai`,
      header: title,
      content: `${toHTML(read(path.join(STATIC, `${page}.dj`)))}`,
    });
  }

  make('concepts', {
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
    header: 'Concepts',
    content: `${toHTML(read(path.join(STATIC, 'concepts.dj')))}`,
  });

  if (!rebuild) {
    const now = Date.now();
    for (const file of actual) {
      if (!expected.has(file) && !retain(file, now)) {
        remove(path.join(PUBLIC, file));
      }
    }
  }

  actual = list(path.join(PUBLIC, 'concepts'));
  expected = new Set(['index.html']);

  const titles = ['Complexity', 'Engines', 'Protocol', 'Variants'];
  for (const title of titles) {
    const page = title.toLowerCase();
    expected.add(page);
    make(`concepts/${page}`, {
      path: `/concepts/${page}/`,
      title: `Concepts — ${title} | pkmn.ai`,
      topbar: title === 'Variants' ? '' : topbar,
      header: title,
      content: toHTML(read(path.join(STATIC, 'concepts', `${page}.dj`))),
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
