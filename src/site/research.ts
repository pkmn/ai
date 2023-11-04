import * as fs from 'fs';
import * as path from 'path';

import * as bibtex from '@retorquere/bibtex-parser';

export function page(dir: string) {
  const buf: string[] = [];

  const bib = bibtex.parse(fs.readFileSync(path.join(dir, 'research.bib'), 'utf8'));
  if (bib.errors.length) throw new Error(`Error parsing research.bib: ${bib.errors.join(', ')}`);

  buf.push('<ul>');
  for (const entry of bib.entries) {
    // TODO: improve citation format
    const title = `<em>${entry.fields.title[0]}</em>`;
    const date = entry.fields.year[0];
    buf.push(`<li><a href="${entry.fields.url[0]}">${title}</a> — ${date}</li>`);
  }
  buf.push('</ul>');

  return {
    title: 'Research | pkmn.ai',
    header: '<h2>Research</h2>',
    content: `<div id="research">${buf.join('')}</div>`,
    edit: 'https://github.com/pkmn/ai/edit/main/src/site/research.bib',
  };
}
