import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  SubmoduleSpec,
  checkSubmoduleState,
  clearBrokenCheckout,
  findPrivateTsconfigs,
} from '../tools/setup';

const TEST_SPEC: SubmoduleSpec = {
  path: 'teams/teams',
  sparseDir: 'gen9championsvgc2026regmc',
  sparseArgs: ['set', 'gen9championsvgc2026regmc'],
};

function createTempGitRoot(): {rootDir: string; gitDir: string} {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-setup-test-'));
  execFileSync('git', ['init'], {cwd: rootDir, stdio: 'ignore'});
  const gitDir = path.join(rootDir, '.git');
  return {rootDir, gitDir};
}

describe('setup', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  test('checkSubmoduleState reports empty directory as not ready without problem', () => {
    const {rootDir, gitDir} = createTempGitRoot();
    tempDirs.push(rootDir);
    fs.mkdirSync(path.join(rootDir, TEST_SPEC.path), {recursive: true});

    const state = checkSubmoduleState(rootDir, gitDir, TEST_SPEC);
    expect(state).toEqual({ready: false});
  });

  test('checkSubmoduleState flags symlinked submodule directory', () => {
    const {rootDir, gitDir} = createTempGitRoot();
    tempDirs.push(rootDir);
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-setup-target-'));
    tempDirs.push(targetDir);
    fs.mkdirSync(path.join(rootDir, 'teams'), {recursive: true});
    fs.symlinkSync(targetDir, path.join(rootDir, TEST_SPEC.path));

    const state = checkSubmoduleState(rootDir, gitDir, TEST_SPEC);
    expect(state).toEqual({ready: false, problem: 'it is a symlink'});
  });

  test('checkSubmoduleState flags directory lacking its own git repository', () => {
    const {rootDir, gitDir} = createTempGitRoot();
    tempDirs.push(rootDir);
    const subDir = path.join(rootDir, TEST_SPEC.path);
    fs.mkdirSync(subDir, {recursive: true});
    fs.writeFileSync(path.join(subDir, 'README.md'), 'placeholder\n', 'utf8');

    const state = checkSubmoduleState(rootDir, gitDir, TEST_SPEC);
    expect(state).toEqual({ready: false, problem: 'it has no .git of its own'});
  });

  test('clearBrokenCheckout unlinks symlink without deleting target contents', () => {
    const {rootDir} = createTempGitRoot();
    tempDirs.push(rootDir);
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-setup-target-'));
    tempDirs.push(targetDir);
    const sentinel = path.join(targetDir, 'keep.txt');
    fs.writeFileSync(sentinel, 'preserve', 'utf8');
    fs.mkdirSync(path.join(rootDir, 'teams'), {recursive: true});
    fs.symlinkSync(targetDir, path.join(rootDir, TEST_SPEC.path));

    const aside = clearBrokenCheckout(rootDir, TEST_SPEC.path);
    expect(aside).toBeUndefined();
    expect(fs.existsSync(path.join(rootDir, TEST_SPEC.path))).toBe(false);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('preserve');
  });

  test('clearBrokenCheckout moves unverified directory to backup path', () => {
    const {rootDir} = createTempGitRoot();
    tempDirs.push(rootDir);
    const subDir = path.join(rootDir, TEST_SPEC.path);
    fs.mkdirSync(subDir, {recursive: true});
    fs.writeFileSync(path.join(subDir, 'local.txt'), 'dirty', 'utf8');

    const aside = clearBrokenCheckout(rootDir, TEST_SPEC.path);
    expect(aside).toMatch(/^teams\/teams\.bak-\d{8}T\d{6}$/);
    expect(fs.existsSync(subDir)).toBe(false);
    expect(fs.readFileSync(path.join(rootDir, aside!, 'local.txt'), 'utf8')).toBe('dirty');
  });

  test('findPrivateTsconfigs discovers nested configs while skipping excluded directories', () => {
    const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-private-'));
    tempDirs.push(privateDir);
    const pkgCfg = path.join(privateDir, 'verifier', 'tsconfig.json');
    const ignoredCfg = path.join(privateDir, 'node_modules', 'pkg', 'tsconfig.json');
    fs.mkdirSync(path.dirname(pkgCfg), {recursive: true});
    fs.mkdirSync(path.dirname(ignoredCfg), {recursive: true});
    fs.writeFileSync(pkgCfg, '{}', 'utf8');
    fs.writeFileSync(ignoredCfg, '{}', 'utf8');

    expect(findPrivateTsconfigs(privateDir)).toEqual([pkgCfg]);
  });
});
