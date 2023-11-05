import * as fs from 'fs';
import * as path from 'path';

import * as bibtex from '@retorquere/bibtex-parser';

// TODO: improve citation format
function format(entry: bibtex.Entry) {
  const title = `<em>${entry.fields.title[0]}</em>`;
  const date = entry.fields.year[0];
  const definition = `<a href="${entry.fields.url[0]}">${title}</a> — ${date}`;
  const [author, d] = entry.key.split(':');
  if (d !== date) throw new Error(`Date mismatch for ${entry.key}: '${d}' vs. ${date}`);
  const name = author.replaceAll('-', ',').replaceAll(/[A-Z]/g, m => ` ${m}`).trimStart();
  const id = `${name} ${date}`;
  return `<dt id="${entry.key}">[${id}]</dt><dd>${definition}</dd>`;
}

export function page(dir: string) {
  const buf: string[] = [];

  const file = fs.readFileSync(path.join(dir, 'research.bib'), 'utf8');
  const bib = bibtex.parse(file, {sentenceCase: false});
  if (bib.errors.length) throw new Error(`Error parsing research.bib: ${bib.errors.join(', ')}`);
  bib.entries.sort((a: bibtex.Entry, b: bibtex.Entry) => {
    const as = a.key.split(':');
    const bs = b.key.split(':');

    const date = +bs[1] - +as[1];
    if (date) return date;

    return as[0].localeCompare(bs[0]);
  });

  buf.push('<dl>');
  for (const entry of bib.entries) {
    buf.push(format(entry));
  }
  buf.push('</dl>');

  return {
    title: 'Research | pkmn.ai',
    header: '<h2>Research</h2>',
    content: `<div id="research">${buf.join('')}</div>`,
    edit: 'https://github.com/pkmn/ai/edit/main/src/static/research.bib',
  };
}
