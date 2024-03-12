import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'yaml';

const STATIC = path.join(__dirname, '..', 'static');
const projects = yaml.parse(fs.readFileSync(path.join(STATIC, 'projects.yml'), 'utf8'));

const GITHUB = /^https:\/\/github\.com\/([^\s/]+\/[^\s/]+)\/releases\/tag\/([^\s/]+)$/;
const NPM = /^https:\/\/www\.npmjs\.(?:org|com)\/package\/(\S+)\/v\/([^\s/]+)$/;
const PYPI = /^https:\/\/pypi\.org\/project\/([^\s/]+)\/([^\s/]+)\/$/;
const CHROME = /^https:\/\/chromewebstore.google.com/;

const json = async (url: string, init?: RequestInit) => (await fetch(url, init)).json();
const TOKEN = process.env.GITHUB_TOKEN
  ? {headers: {authorization: `Bearer ${process.env.GITHUB_TOKEN}`}}
  : undefined;

describe('projects', () => {
  test('releases', async () => {
    for (const project of projects) {
      if (!project.release) continue;

      let m: RegExpExecArray | null = null;
      if ((m = GITHUB.exec(project.release.url))) {
        const latest = await json(`https://api.github.com/repos/${m[1]}/releases`, TOKEN);
        expect(m[2]).toBe(latest[0].tag_name);
      } else if ((m = NPM.exec(project.release.url))) {
        const latest = await json(`https://registry.npmjs.com/${m[1]}/latest`);
        expect(m[2]).toBe(latest.version);
      } else if ((m = PYPI.exec(project.release.url))) {
        const data = await json(`https://pypi.org/pypi/${m[1]}/json`);
        const releases = Object.keys(data.releases);
        const latest = releases[releases.length - 1];
        expect(m[2]).toBe(latest);
      } else if (!CHROME.test(project.release.url)) {
        throw new Error(`Invalid URL: '${project.release.url}'`);
      }
    }
  });
});
