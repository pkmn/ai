import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as setup from '../tools/setup';

const TEST_SPEC: setup.SubmoduleSpec = {
  path: 'teams/teams',
  sparseDir: 'gen9championsvgc2026regmc',
  sparseArgs: ['set', 'gen9championsvgc2026regmc'],
};

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function createTempDir(prefix = 'pkmn-setup-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createTempGitRoot(): {rootDir: string; gitDir: string} {
  const rootDir = createTempDir();
  execFileSync('git', ['init', '--template='], {cwd: rootDir, env: GIT_ENV, stdio: 'ignore'});
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
    const rootDir = createTempDir();
    tempDirs.push(rootDir);
    fs.mkdirSync(path.join(rootDir, TEST_SPEC.path), {recursive: true});

    const state = setup.checkSubmoduleState(rootDir, path.join(rootDir, '.git'), TEST_SPEC);
    expect(state).toEqual({ready: false});
  });

  test('checkSubmoduleState flags symlinked submodule directory', () => {
    const rootDir = createTempDir();
    tempDirs.push(rootDir);
    const targetDir = createTempDir('pkmn-setup-target-');
    tempDirs.push(targetDir);
    fs.mkdirSync(path.join(rootDir, 'teams'), {recursive: true});
    fs.symlinkSync(targetDir, path.join(rootDir, TEST_SPEC.path));

    const state = setup.checkSubmoduleState(rootDir, path.join(rootDir, '.git'), TEST_SPEC);
    expect(state).toEqual({ready: false, problem: 'it is a symlink'});
  });

  test('checkSubmoduleState flags directory lacking its own git repository', () => {
    const {rootDir, gitDir} = createTempGitRoot();
    tempDirs.push(rootDir);
    const subDir = path.join(rootDir, TEST_SPEC.path);
    fs.mkdirSync(subDir, {recursive: true});
    fs.writeFileSync(path.join(subDir, 'README.md'), 'placeholder\n', 'utf8');

    const state = setup.checkSubmoduleState(rootDir, gitDir, TEST_SPEC);
    expect(state).toEqual({ready: false, problem: 'it has no .git of its own'});
  });

  test('clearBrokenCheckout unlinks symlink without deleting target contents', () => {
    const rootDir = createTempDir();
    tempDirs.push(rootDir);
    const targetDir = createTempDir('pkmn-setup-target-');
    tempDirs.push(targetDir);
    const sentinel = path.join(targetDir, 'keep.txt');
    fs.writeFileSync(sentinel, 'preserve', 'utf8');
    fs.mkdirSync(path.join(rootDir, 'teams'), {recursive: true});
    fs.symlinkSync(targetDir, path.join(rootDir, TEST_SPEC.path));

    const aside = setup.clearBrokenCheckout(rootDir, TEST_SPEC.path);
    expect(aside).toBeUndefined();
    expect(fs.existsSync(path.join(rootDir, TEST_SPEC.path))).toBe(false);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('preserve');
  });

  test('clearBrokenCheckout moves unverified directory to backup path', () => {
    const rootDir = createTempDir();
    tempDirs.push(rootDir);
    const subDir = path.join(rootDir, TEST_SPEC.path);
    fs.mkdirSync(subDir, {recursive: true});
    fs.writeFileSync(path.join(subDir, 'local.txt'), 'dirty', 'utf8');

    const aside = setup.clearBrokenCheckout(rootDir, TEST_SPEC.path);
    expect(aside).toMatch(/^teams\/teams\.bak-\d{8}T\d{6}$/);
    expect(fs.existsSync(subDir)).toBe(false);
    expect(fs.readFileSync(path.join(rootDir, aside!, 'local.txt'), 'utf8')).toBe('dirty');
  });

  test('findPrivateTsconfigs discovers nested configs while skipping excluded directories', () => {
    const privateDir = createTempDir('pkmn-private-');
    tempDirs.push(privateDir);
    const pkgCfg = path.join(privateDir, 'verifier', 'tsconfig.json');
    const ignoredCfg = path.join(privateDir, 'node_modules', 'pkg', 'tsconfig.json');
    fs.mkdirSync(path.dirname(pkgCfg), {recursive: true});
    fs.mkdirSync(path.dirname(ignoredCfg), {recursive: true});
    fs.writeFileSync(pkgCfg, '{}', 'utf8');
    fs.writeFileSync(ignoredCfg, '{}', 'utf8');

    expect(setup.findPrivateTsconfigs(privateDir)).toEqual([pkgCfg]);
  });

  test('setUpSubmodule advances ready submodule to pinned commit when update is true', () => {
    const {rootDir, gitDir} = createTempGitRoot();
    tempDirs.push(rootDir);
    const git = (cwd: string, args: string[]) =>
      execFileSync('git', args, {cwd, env: GIT_ENV, encoding: 'utf8'}).trim();

    const subDir = path.join(rootDir, TEST_SPEC.path);
    const moduleDir = path.join(gitDir, 'modules', TEST_SPEC.path);
    fs.mkdirSync(path.dirname(moduleDir), {recursive: true});
    git(rootDir, ['init', '-b', 'main', '--template=', `--separate-git-dir=${moduleDir}`, subDir]);

    const sparsePath = path.join(subDir, TEST_SPEC.sparseDir);
    fs.mkdirSync(sparsePath, {recursive: true});
    fs.writeFileSync(path.join(sparsePath, 'a.txt'), 'v1\n', 'utf8');
    git(subDir, ['add', '.']);
    git(subDir, ['commit', '-m', 'v1']);
    const v1 = git(subDir, ['rev-parse', 'HEAD']);

    fs.writeFileSync(path.join(sparsePath, 'b.txt'), 'v2\n', 'utf8');
    git(subDir, ['add', '.']);
    git(subDir, ['commit', '-m', 'v2']);
    const v2 = git(subDir, ['rev-parse', 'HEAD']);

    git(rootDir, ['update-index', '--add', '--cacheinfo', `160000,${v2},${TEST_SPEC.path}`]);
    git(subDir, ['checkout', '-q', v1]);

    const logs: string[] = [];
    setup.setUpSubmodule(rootDir, TEST_SPEC, msg => logs.push(msg), false);
    expect(git(subDir, ['rev-parse', 'HEAD'])).toBe(v1);

    setup.setUpSubmodule(rootDir, TEST_SPEC, msg => logs.push(msg), true);
    expect(git(subDir, ['rev-parse', 'HEAD'])).toBe(v2);
    expect(fs.existsSync(path.join(sparsePath, 'b.txt'))).toBe(true);
  });

  test('deploy passes --update to setup --submodules-only', () => {
    const vpsDeploy = fs.readFileSync(path.join(__dirname, '..', 'deploy'), 'utf8');
    expect(vpsDeploy).toContain('node build/tools/setup --submodules-only --update');
  });

  test('deploy scripts install pinned sim/0.11.0 worker directory', () => {
    const vpsDeploy = fs.readFileSync(path.join(__dirname, '..', 'deploy'), 'utf8');
    const arenaDeploy = fs.readFileSync(
      path.join(__dirname, '..', 'arena', 'scripts', 'deploy.sh'),
      'utf8'
    );
    expect(vpsDeploy).toContain('node build/tools/pkmn install-sim 0.11.0');
    expect(arenaDeploy).toContain('node build/tools/pkmn install-sim 0.11.0');
  });
});
