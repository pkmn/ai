import * as fs from 'fs';
import * as path from 'path';

import * as bibtex from '@retorquere/bibtex-parser';

const names = (e: bibtex.Entry) => {
  const buf: string[] = [];
  const authors = e.creators.author;
  for (let i = 0; i < authors.length; i++) {
    const author = authors[i];
    const initials = author.firstName!.split(' ').map(n => n.endsWith('.') ? n : `${n[0]}.`);
    const name = `${author.lastName}, ${initials.join(' ')}`;
    buf.push(name);
    if (authors.length - 1 === i) break;
    buf.push(i === authors.length - 2 ? ' and ' : ', ');
  }
  return buf.join('');
};

const TYPES: {[type: string]: (entry: bibtex.Entry) => string } = {
  'article': e => {
    const volume = e.fields.number
      ? `${e.fields.volume[0]}(${e.fields.number[0]})`
      : e.fields.volume[0];
    return (e.fields.pages
      ? `${e.fields.journal[0]}, ${volume}:${e.fields.pages[0]}.`
      : `${e.fields.journal[0]}, ${volume}.`);
  },
  'inproceedings': e => e.fields.pages
    ? `${e.fields.booktitle[0]}, pages ${e.fields.pages[0]}.`
    : `${e.fields.booktitle[0]}.`,
  'mastersthesis': e => `Master's thesis, ${e.fields.school[0]}, ${e.fields.address[0]}.`,
  'phdthesis': e => `PhD thesis, ${e.fields.school[0]}, ${e.fields.address[0]}.`,
  'misc': e => e.fields.archiveprefix
    ? `${e.fields.archiveprefix[0]}:${e.fields.eprint[0]} [${e.fields.primaryclass[0]}].` : '',
};

function format(e: bibtex.Entry) {
  const [author, date] = e.key.split(':');
  const name = /[A-Z][a-z]+[A-Z]/.test(author)
    ? author.replaceAll(/[A-Z]/g, m => ` ${m}`).trimStart()
    : author;
  const id = `${name} ${date}`;

  const parts: string[] = [];
  parts.push(`<em>${e.fields.title[0]}</em>. `);
  parts.push(names(e));
  parts.push(` (${e.fields.year[0]}) `);
  parts.push(TYPES[e.type](e));

  const urls = e.fields.url[0].split(',');
  const sm = urls.length > 1
    ? ` <a href="${urls[1]}" class="subtle"><em>(Includes supplementary text).</em></a>`
    : '';
  const definition = `<a href="${urls[0]}" class="subtle">${parts.join('')}</a>${sm}`;
  return `<dt id="${e.key}">[${id}]</dt><dd>${definition}</dd>`;
}

export function page(dir: string) {
  const buf: string[] = [];

  const file = fs.readFileSync(path.join(dir, 'research.bib'), 'utf8');
  const bib = bibtex.parse(file, {sentenceCase: false});
  if (bib.errors.length) {
    console.error(bib.errors);
    throw new Error('Error parsing research.bib');
  }
  bib.entries.sort((a: bibtex.Entry, b: bibtex.Entry) => {
    const as = a.key.split(':');
    const bs = b.key.split(':');

    const date = parseInt(bs[1]) - parseInt(as[1]);
    if (date) return date;

    return as[0].localeCompare(bs[0]);
  });

  buf.push('<dl>');
  for (const entry of bib.entries) {
    buf.push(format(entry));
  }
  buf.push('</dl>');

  return {
    path: '/research/',
    title: 'Research | pkmn.ai',
    header: 'Research',
    content: buf.join(''),
    edit: 'https://github.com/pkmn/ai/edit/main/src/static/research.bib',
  };
}
