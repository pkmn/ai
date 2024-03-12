import * as fs from 'fs';
import * as path from 'path';

import * as bibtex from '@retorquere/bibtex-parser';

import {header} from './build';

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

const TYPES: {[type: string]: (entry: bibtex.Entry) => string} = {
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
  const dt = `<div id="${e.key}"><dt><a href="#${e.key}" class="subtle">[${id}]</a></dt>`;
  const dd = `<dd><a href="${urls[0]}" class="subtle">${parts.join('')}</a>${sm}</dd></div>`;
  return `${dt}${dd}`;
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
    style: `
    main {
      max-width: min(105ch, calc(100% - 4vh));
      margin: 1rem auto;
      line-height: 1.15;
    }
    dl > div {
      display: flex;
      flex-wrap: wrap;
    }
    dt {
      display: block;
      width: 20%;
      padding-right: 2ch;
      font-weight: normal;
    }
    dd {
      width: 80%;
      margin-bottom: 1rem;
      margin-left: auto;
    }
    @media(width < 768px) {
      dt { display: none; }
      dd { width: 100%; }
    }`,
    header: header('Research'),
    content: buf.join(''),
  };
}
