import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'yaml';

import {root} from '../static/util';

const STATIC = root('static');
const projects = yaml.parse(fs.readFileSync(path.join(STATIC, 'projects.yml'), 'utf8'));

const GITHUB = /^https:\/\/github\.com\/([^\s/]+\/[^\s/]+)\/releases\/tag\/([^\s/]+)$/;
const NPM = /^https:\/\/www\.npmjs\.(?:org|com)\/package\/(\S+)\/v\/([^\s/]+)$/;
const PYPI = /^https:\/\/pypi\.org\/project\/([^\s/]+)\/([^\s/]+)\/$/;
const CHROME = /^https:\/\/chromewebstore.google.com/;

const TOKEN = process.env.GITHUB_TOKEN
  ? {headers: {authorization: `Bearer ${process.env.GITHUB_TOKEN}`}}
  : undefined;

describe('projects', () => {
  test('validates project release URL formats', () => {
    for (const project of projects) {
      if (!project.release) continue;
      expect(typeof project.release.name).toBe('string');
      expect(project.release.name.length).toBeGreaterThan(0);
      const valid =
        GITHUB.test(project.release.url) ||
        NPM.test(project.release.url) ||
        PYPI.test(project.release.url) ||
        CHROME.test(project.release.url);
      if (!valid) {
        throw new Error(`Invalid URL: '${project.release.url}'`);
      }
    }
  });

  test('matches latest upstream release versions', async () => {
    if (!process.env.LIVE_RELEASES) return;
    for (const project of projects) {
      if (!project.release) continue;

      let m: RegExpExecArray | null;
      if ((m = GITHUB.exec(project.release.url))) {
        const res = await fetch(`https://api.github.com/repos/${m[1]}/releases`, TOKEN);
        if (!TOKEN && (res.status === 403 || res.status === 429)) continue;
        if (!res.ok) throw new Error(`GitHub API ${res.status} for ${m[1]}`);
        const latest = await res.json() as Array<{tag_name?: string}>;
        expect(Array.isArray(latest) && latest.length > 0).toBe(true);
        expect(m[2]).toBe(latest[0].tag_name);
      } else if ((m = NPM.exec(project.release.url))) {
        const res = await fetch(`https://registry.npmjs.com/${m[1]}/latest`);
        if (!res.ok) throw new Error(`npm registry ${res.status} for ${m[1]}`);
        const latest = await res.json() as {version?: string};
        expect(m[2]).toBe(latest.version);
      } else if ((m = PYPI.exec(project.release.url))) {
        const res = await fetch(`https://pypi.org/pypi/${m[1]}/json`);
        if (!res.ok) throw new Error(`PyPI ${res.status} for ${m[1]}`);
        const data = await res.json() as {info?: {version?: string}};
        expect(m[2]).toBe(data.info?.version);
      } else if (!CHROME.test(project.release.url)) {
        throw new Error(`Invalid URL: '${project.release.url}'`);
      }
    }
  });
});
