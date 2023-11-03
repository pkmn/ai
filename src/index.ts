import 'source-map-support/register';

import * as fs from 'fs';
import * as path from 'path';

import CleanCSS from 'clean-css';
import html from 'html-minifier';
import * as template from 'mustache';

import * as projects from './pages/projects';

const css = new CleanCSS();

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PAGES = path.join(ROOT, 'src', 'pages');

const LAYOUT = fs.readFileSync(path.join(PAGES, 'layout.html.tmpl'), 'utf8');

interface Page {
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
  const index = fs.readFileSync(path.join(ROOT, 'src', 'index.css'), 'utf8');
  fs.writeFileSync(path.join(PUBLIC, 'index.css'), css.minify(index).styles);

  render('projects', projects.page(PAGES));
}
