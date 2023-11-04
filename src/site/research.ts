import * as fs from 'fs';
import * as path from 'path';

import * as bibtex from '@retorquere/bibtex-parser';

// TODO generate listing from research.bib (and tags) - link externally always
export function page(dir: string) {
  const bib = bibtex.parse(fs.readFileSync(path.join(dir, 'research.bib'), 'utf8'));
  if (bib.errors.length) throw new Error(`Error parsing research.bib: ${bib.errors.join(', ')}`);
  const bibliography: {[id: string]: bibtex.Entry} = {};
  for (const entry of bib.entries) bibliography[entry.key] = entry;

  return {
    title: 'Research | pkmn.ai',
    header: '<h2>Research</h2>',
    content: '<p>TODO</p>',
    edit: 'https://github.com/pkmn/ai/edit/main/src/site/research.bib',
  };
}
