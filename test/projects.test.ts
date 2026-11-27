import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'yaml';

import {parseArenaProjects} from '../db';
import {Project} from '../static/projects';
import {root} from '../static/util';

const STATIC = root('static');
const projectsYaml = fs.readFileSync(path.join(STATIC, 'projects.yml'), 'utf8');
const projects = yaml.parse(projectsYaml) as Project[];

const GITHUB = /^https:\/\/github\.com\/([^\s/]+\/[^\s/]+)\/releases\/tag\/([^\s/]+)$/;
const NPM = /^https:\/\/www\.npmjs\.(?:org|com)\/package\/(\S+)\/v\/([^\s/]+)$/;
const PYPI = /^https:\/\/pypi\.org\/project\/([^\s/]+)\/([^\s/]+)\/$/;
const CHROME = /^https:\/\/chromewebstore.google.com/;

const CHECK_RELEASES = Boolean(
  process.env.CHECK_RELEASES || process.env.GITHUB_EVENT_NAME === 'schedule'
);
const FETCH_TIMEOUT_MILLIS = 5_000;

const GITHUB_HEADERS = process.env.GITHUB_TOKEN
  ? {authorization: `Bearer ${process.env.GITHUB_TOKEN}`}
  : undefined;

const releaseProjects = (projects as Array<{release?: {url: string}}>)
  .filter((p): p is {release: {url: string}} => Boolean(p.release));

describe('projects', () => {
  test('release URLs match supported registry formats', () => {
    for (const {release: {url}} of releaseProjects) {
      const valid = GITHUB.test(url) || NPM.test(url) || PYPI.test(url) || CHROME.test(url);
      if (!valid) throw new Error(`Invalid URL: '${url}'`);
      expect(valid).toBe(true);
    }
  });

  test('arena projects with logos declare positive integer dimensions', () => {
    const avatarsDir = path.join(STATIC, 'avatars');
    const byName = new Map(projects.filter(p => p.name).map(p => [p.name!, p]));
    const withLogos = parseArenaProjects(projectsYaml, avatarsDir).filter(p => p.logo);
    expect(withLogos.length).toBeGreaterThan(0);
    for (const proj of withLogos) {
      const logo = byName.get(proj.name)?.arena?.logo;
      expect(typeof logo).toBe('object');
      const dims = logo as {width: number; height: number};
      expect(Number.isInteger(dims.width) && dims.width > 0).toBe(true);
      expect(Number.isInteger(dims.height) && dims.height > 0).toBe(true);
    }
  });

  if (CHECK_RELEASES) {
    test('releases', async () => {
      await Promise.all(
        releaseProjects.map(async ({release: {url}}) => {
          let m: RegExpExecArray | null;
          if ((m = GITHUB.exec(url))) {
            const res = await fetch(
              `https://api.github.com/repos/${m[1]}/releases?per_page=1`,
              {headers: GITHUB_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLIS)}
            );
            if (!GITHUB_HEADERS && (res.status === 403 || res.status === 429)) return;
            if (!res.ok) throw new Error(`GitHub API ${res.status} for ${m[1]}`);
            const latest = await res.json() as Array<{tag_name?: string}>;
            expect(Array.isArray(latest) && latest.length > 0).toBe(true);
            expect(m[2]).toBe(latest[0].tag_name);
          } else if ((m = NPM.exec(url))) {
            const res = await fetch(
              `https://registry.npmjs.com/${m[1]}/latest`,
              {signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLIS)}
            );
            if (!res.ok) throw new Error(`npm registry ${res.status} for ${m[1]}`);
            const latest = await res.json() as {version?: string};
            expect(m[2]).toBe(latest.version);
          } else if ((m = PYPI.exec(url))) {
            const res = await fetch(
              `https://pypi.org/pypi/${m[1]}/json`,
              {signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLIS)}
            );
            if (!res.ok) throw new Error(`PyPI ${res.status} for ${m[1]}`);
            const data = await res.json() as {info?: {version?: string}};
            expect(m[2]).toBe(data.info?.version);
          } else if (!CHROME.test(url)) {
            throw new Error(`Invalid URL: '${url}'`);
          }
        })
      );
    });
  }
});
