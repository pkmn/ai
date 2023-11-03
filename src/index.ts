/* eslint-disable */
import * as fs from 'fs';
import * as path from 'path';

import html from 'html-minifier';
import CleanCSS from 'clean-css';

const css = new CleanCSS();

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PAGES = path.join(ROOT, 'src', 'pages');

const index = fs.readFileSync(path.join(ROOT, 'src', 'index.css'), 'utf8');
fs.writeFileSync(path.join(PUBLIC, 'index.css'), css.minify(index).styles);
