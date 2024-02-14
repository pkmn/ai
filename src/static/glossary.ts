import * as fs from 'fs';
import * as path from 'path';

import * as site from 'site';
import * as yaml from 'yaml';

import {header} from './build';

const slugify = (s: string) =>
  s.replace(/\s+/g, '-') // Replace spaces with -
    .replace(/[^\w-]+/g, '') // Remove all non-word chars
    .replace(/--+/g, '-') // Replace multiple - with single -
    .replace(/^-+/, '') // Trim - from start of text
    .replace(/-+$/, ''); // Trim - from end of text

export function page(dir: string) {
  const buf: string[] = [];

  buf.push(site.html.render(fs.readFileSync(path.join(dir, 'glossary.dj'), 'utf8')));

  const glossary: {[term: string]: string} =
    yaml.parse(fs.readFileSync(path.join(dir, 'glossary.yml'), 'utf8'));

  const terms = Object.keys(glossary).sort((a, b) =>
    a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase()));

  buf.push('<dl>');
  for (const term of terms) {
    const id = slugify(term);
    buf.push(`<div id="${id}"><dt><a href="#${id}" class="subtle">${term}</a></dt>`);
    buf.push(`<dd>${site.html.render(glossary[term])}</dd></div>`);
  }
  buf.push('</dl>');

  return {
    path: '/glossary/',
    title: 'Glossary | pkmn.ai',
    header: header('Glossary'),
    content: buf.join(''),
  };
}
