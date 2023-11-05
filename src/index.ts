import 'source-map-support/register';

import * as fs from 'fs';
import * as path from 'path';

import * as djot from '@djot/djot';
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
  id?: string;
  title: string;
  header?: string;
  content: string;
  edit: string;
  script?: string;
}

const toHTML = (file: string) => djot.renderHTML(djot.parse(fs.readFileSync(file, 'utf8')));

const render = (name: string, page: Page) => {
  fs.mkdirSync(path.join(PUBLIC, name), {recursive: true});
  const rendered = template.render(LAYOUT, {id: path.basename(name), ...page});
  const minified = html.minify(rendered, {minifyCSS: true, minifyJS: true});
  fs.writeFileSync(path.join(PUBLIC, name, 'index.html'), minified);
};

if (require.main === module) {
  (async () => {
    const icons = await favicons(path.join(PUBLIC, 'favicon.svg'), {path: PUBLIC});
    for (const icon of icons.images) {
      if (/(yandex|startup-image)/.test(icon.name)) continue;
      fs.writeFileSync(path.join(PUBLIC, icon.name), icon.contents);
    }

    const index = fs.readFileSync(path.join(STATIC, 'index.css'), 'utf8');
    fs.writeFileSync(path.join(PUBLIC, 'index.css'), css.minify(index).styles);

    let first = true;
    fs.writeFileSync(path.join(PUBLIC, 'index.html'), html.minify(template.render(LAYOUT, {
      id: 'home',
      title: 'pkmn.ai',
      content: `${toHTML(path.join(STATIC, 'index.dj')).replaceAll('<a', m => {
        if (first) {
          first = false;
          return m;
        }
        return '<a class="default"';
      })}`,
      edit: `${edit}/static/index.dj`,
    }).replace('<a href="/">pkmn.ai</a>', 'pkmn.ai')));

    render('projects', projects.page(STATIC));
    render('research', research.page(STATIC));

    render('concepts', {
      title: 'Concepts | pkmn.ai',
      header: '<h2>Concepts</h2>',
      content: toHTML(path.join(STATIC, 'concepts', 'index.dj')),
      edit: `${edit}/static/concepts/index.dj`,
    });
    for (const title of ['Complexity', 'Engines', 'Variations']) {
      const page = title.toLowerCase();
      render(`concepts/${page}`, {
        title: `Concepts — ${title} | pkmn.ai`,
        header: `<h2>${title}</h2>`,
        content: toHTML(path.join(STATIC, 'concepts', `${page}.dj`)),
        edit: `${edit}/static/concepts/${page}.dj`,
      });
    }

    for (const title of ['Glossary', 'Rules']) {
      const page = title.toLowerCase();
      render(page, {
        title: `${title} | pkmn.ai`,
        header: `<h2>${title}</h2>`,
        content: toHTML(path.join(STATIC, `${page}.dj`)),
        edit: `${edit}/static/${page}.dj`,
      });
    }
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
