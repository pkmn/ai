import 'source-map-support/register';

import * as fs from 'fs';
import * as path from 'path';

import CleanCSS from 'clean-css';
import favicons from 'favicons';
import html from 'html-minifier';
import {marked} from 'marked';
import * as template from 'mustache';

import * as projects from './site/projects';
import * as research from './site/research';

const css = new CleanCSS();

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SITE = path.join(ROOT, 'src', 'site');

const LAYOUT = fs.readFileSync(path.join(SITE, 'layout.html.tmpl'), 'utf8');
const edit = 'https://github.com/pkmn/ai/edit/main/src';

interface Page {
  title: string;
  header?: string;
  content: string;
  edit: string;
  script?: string;
}

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

    const index = fs.readFileSync(path.join(SITE, 'index.css'), 'utf8');
    fs.writeFileSync(path.join(PUBLIC, 'index.css'), css.minify(index).styles);

    const content = marked.parse(fs.readFileSync(path.join(SITE, 'index.md'), 'utf8'));
    let first = true;
    fs.writeFileSync(path.join(PUBLIC, 'index.html'), html.minify(template.render(LAYOUT, {
      title: 'pkmn.ai',
      content: `<div id="home">${content.replaceAll('<a', m => {
        if (first) {
          first = false;
          return m;
        }
        return '<a class="default"';
      })}</div>`,
      edit: `${edit}/site/index.md`,
    }).replace('<a href="/">pkmn.ai</a>', 'pkmn.ai')));

    render('projects', projects.page(SITE));
    render('research', research.page(SITE));

    render('concepts', {
      title: 'Concepts | pkmn.ai',
      header: '<h2>Concepts</h2>',
      content: marked.parse(fs.readFileSync(path.join(SITE, 'concepts', 'index.md'), 'utf8')),
      edit: `${edit}/site/concepts/index.md`,
    });
    for (const title of ['Engines', 'Variations']) {
      const page = title.toLowerCase();
      render(`concepts/${page}`, {
        title: `Concepts — ${title} | pkmn.ai`,
        header: `<h2>${title}</h2>`,
        content: marked.parse(fs.readFileSync(path.join(SITE, 'concepts', `${page}.md`), 'utf8')),
        edit: `${edit}/site/concepts/${page}.md`,
      });
    }

    for (const title of ['Glossary', 'Rules']) {
      const page = title.toLowerCase();
      render(page, {
        title: `${title} | pkmn.ai`,
        header: `<h2>${title}</h2>`,
        content: marked.parse(fs.readFileSync(path.join(SITE, `${page}.md`), 'utf8')),
        edit: `${edit}/site/${page}.md`,
      });
    }
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
