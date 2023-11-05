import * as bibtex from '@retorquere/bibtex-parser';

// TODO: improve citation format
function format(id: string, entry: bibtex.Entry) {
  const title = `<em>${entry.fields.title[0]}</em>`;
  const date = entry.fields.year[0];
  const definition = `<a href="${entry.fields.url[0]}">${title}</a> — ${date}`;
  return `<dt id="${entry.key}">[${id}]</dt><dd>${definition}</dd>`;
}

export function page(bib: {[id: string]: bibtex.Entry}) {
  const buf: string[] = [];

  buf.push('<dl>');
  for (const id in bib) {
    buf.push(format(id, bib[id]));
  }
  buf.push('</dl>');

  return {
    title: 'Research | pkmn.ai',
    header: '<h2>Research</h2>',
    content: `<div id="research">${buf.join('')}</div>`,
    edit: 'https://github.com/pkmn/ai/edit/main/src/static/research.bib',
  };
}
