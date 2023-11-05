import 'source-map-support/register';

import * as fs from 'fs';
import * as path from 'path';

import * as djot from '@djot/djot';
import * as bibtex from '@retorquere/bibtex-parser';
import CSS from 'clean-css';
import favicons from 'favicons';
import html from 'html-minifier';
import * as template from 'mustache';

import * as projects from './static/projects';
import * as research from './static/research';

const css = new CSS();

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const STATIC = path.join(ROOT, 'src', 'static');

const LAYOUT = fs.readFileSync(path.join(STATIC, 'layout.html.tmpl'), 'utf8');
const edit = 'https://github.com/pkmn/ai/edit/main/src';

interface Page {
  title: string;
  header?: string;
  content: string;
  edit: string;
  script?: string;
}

class References {
  readonly projects!: {[id: string]: bibtex.Entry};
  readonly research!: {[id: string]: bibtex.Entry};

  constructor() {
    for (const source of ['projects', 'research'] as const) {
      const parsed = bibtex.parse(fs.readFileSync(path.join(STATIC, `${source}.bib`), 'utf8'));
      if (parsed.errors.length) {
        throw new Error(`Error parsing ${source}.bib: ${parsed.errors.join(', ')}`);
      }
      parsed.entries.sort(References.compare);

      const references: {[id: string]: bibtex.Entry} = {};
      for (const entry of parsed.entries) {
        if (!entry.fields.author[0].includes(',')) {
          throw new Error(`Improperly formatted author field in citation: '${entry.key}'`);
        }
        references[References.fromKey(entry.key)] = entry;
      }

      this[source] = references;
    }
  }

  links() {
    const buf: string[] = [];
    for (const source of ['projects', 'research'] as const) {
      for (const entry of Object.values(this[source])) {
        buf.push(`[${entry.key}]: /${source}#${entry.key}`);
      }
    }
    return buf.join('\n');
  }

  static compare(a: bibtex.Entry, b: bibtex.Entry) {
    const as = a.key.split(':');
    const bs = b.key.split(':');

    const date = +as[1] - +bs[1];
    if (!date) return date;

    return as[0].localeCompare(bs[0]);
  }

  static fromKey(key: string) {
    const [author, date] = key.split(':');
    return `${author.replace('-', '')} ${date}`;
  }
}

const toHTML = (file: string, refs: References) =>
  djot.renderHTML(djot.parse(fs.readFileSync(file, 'utf8') + '\n\n' + refs.links()));

const render = (name: string, page: Page) => {
  fs.mkdirSync(path.join(PUBLIC, name), {recursive: true});
  const rendered = html.minify(template.render(LAYOUT, page), {minifyCSS: true, minifyJS: true});
  fs.writeFileSync(path.join(PUBLIC, name, 'index.html'), rendered);
};

if (require.main === module) {
  (async () => {
    const icons = await favicons(path.join(PUBLIC, 'favicon.svg'), {path: PUBLIC});
    for (const icon of icons.images) {
      if (/(yandex|startup-image)/.test(icon.name)) continue;
      fs.writeFileSync(path.join(PUBLIC, icon.name), icon.contents);
    }

    const refs = new References();

    const index = fs.readFileSync(path.join(STATIC, 'index.css'), 'utf8');
    fs.writeFileSync(path.join(PUBLIC, 'index.css'), css.minify(index).styles);

    let first = true;
    fs.writeFileSync(path.join(PUBLIC, 'index.html'), html.minify(template.render(LAYOUT, {
      title: 'pkmn.ai',
      content: `<div id="home">${toHTML(path.join(STATIC, 'index.dj'), refs).replaceAll('<a', m => {
        if (first) {
          first = false;
          return m;
        }
        return '<a class="default"';
      })}</div>`,
      edit: `${edit}/static/index.dj`,
    }).replace('<a href="/">pkmn.ai</a>', 'pkmn.ai')));

    render('projects', projects.page(refs.projects, STATIC));
    render('research', research.page(refs.research));

    render('concepts', {
      title: 'Concepts | pkmn.ai',
      header: '<h2>Concepts</h2>',
      content: toHTML(path.join(STATIC, 'concepts', 'index.dj'), refs),
      edit: `${edit}/static/concepts/index.dj`,
    });
    for (const title of ['Engines', 'Variations']) {
      const page = title.toLowerCase();
      render(`concepts/${page}`, {
        title: `Concepts — ${title} | pkmn.ai`,
        header: `<h2>${title}</h2>`,
        content: toHTML(path.join(STATIC, 'concepts', `${page}.dj`), refs),
        edit: `${edit}/static/concepts/${page}.dj`,
      });
    }

    for (const title of ['Glossary', 'Rules']) {
      const page = title.toLowerCase();
      render(page, {
        title: `${title} | pkmn.ai`,
        header: `<h2>${title}</h2>`,
        content: toHTML(path.join(STATIC, `${page}.dj`), refs),
        edit: `${edit}/static/${page}.dj`,
      });
    }
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
