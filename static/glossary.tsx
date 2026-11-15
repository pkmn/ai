import * as fs from 'fs';
import * as path from 'path';

import * as site from 'site';
import * as yaml from 'yaml';

import {header} from './build';
import {raw, slugify} from './util';

export function page(dir: string) {
  const intro = site.html.render(fs.readFileSync(path.join(dir, 'glossary.dj'), 'utf8'));

  const glossary: {[term: string]: string} =
    yaml.parse(fs.readFileSync(path.join(dir, 'glossary.yml'), 'utf8'));

  const terms = Object.keys(glossary).sort((a, b) =>
    a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase()));

  return {
    path: '/glossary/',
    title: 'Glossary | pkmn.ai',
    header: header('Glossary'),
    content: <>
      {raw(intro)}
      <dl>
        {terms.map(term => {
          const id = slugify(term);
          return <div id={id}>
            <dt><a href={`#${id}`} className='subtle'>{term}</a></dt>
            <dd>{raw(site.html.render(glossary[term]))}</dd>
          </div>;
        })}
      </dl>
    </>,
  };
}
