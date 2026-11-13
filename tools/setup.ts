require('source-map-support').install();

import {execFileSync, spawnSync} from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {ROOT} from '../static/util';

export interface SubmoduleSpec {
  path: string;
  sparseDir: string;
  sparseArgs: string[];
  stdinFile?: string;
}

export const SUBMODULES: readonly SubmoduleSpec[] = [
  {
    path: 'teams/teams',
    sparseDir: 'gen9championsvgc2026regmc',
    sparseArgs: ['set', 'gen9championsvgc2026regmc'],
  },
  {
    path: 'teams/pkmn_stuff',
    sparseDir: 'teams',
    sparseArgs: ['set', '--no-cone', '--stdin'],
    stdinFile: 'teams/pkmn_stuff.txt',
  },
];

export interface SubmoduleState {
  ready: boolean;
  problem?: string;
  foreignGitDir?: string;
}

function runGit(
  args: string[],
  options: {cwd?: string; input?: Buffer | string} = {}
): {ok: boolean; stdout: string; stderr: string} {
  const res = spawnSync('git', args, {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
  });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
}

function execGit(args: string[], options: {cwd?: string; input?: Buffer | string} = {}): string {
  const res = runGit(args, options);
  if (!res.ok) {
    throw new Error(res.stderr || res.stdout || `git ${args.join(' ')} failed`);
  }
  return res.stdout;
}

export function isGitRepository(gitDir: string): boolean {
  const stat = fs.lstatSync(gitDir, {throwIfNoEntry: false});
  if (!stat?.isDirectory()) return false;
  return runGit(['--git-dir', gitDir, 'rev-parse', '--git-dir']).ok;
}

export function checkSubmoduleState(
  rootDir: string,
  gitDir: string,
  spec: SubmoduleSpec
): SubmoduleState {
  const dir = path.join(rootDir, spec.path);
  const stats = fs.lstatSync(dir, {throwIfNoEntry: false});
  if (!stats) return {ready: false};
  if (stats.isSymbolicLink()) return {ready: false, problem: 'it is a symlink'};
  if (!stats.isDirectory()) return {ready: false, problem: 'it is not a directory'};
  if (fs.readdirSync(dir).length === 0) return {ready: false};

  const top = runGit(['rev-parse', '--show-toplevel'], {cwd: dir});
  if (!top.ok) {
    return {ready: false, problem: `its .git leads nowhere (${top.stderr})`};
  }
  const realToplevel = fs.realpathSync(top.stdout);
  const realRoot = fs.realpathSync(rootDir);
  if (realToplevel === realRoot) {
    return {ready: false, problem: 'it has no .git of its own'};
  }
  const realDir = fs.realpathSync(dir);
  const absGit = runGit(['rev-parse', '--absolute-git-dir'], {cwd: dir});
  const foreignGitDir = absGit.ok ? absGit.stdout : undefined;
  if (realToplevel !== realDir) {
    return {
      ready: false,
      problem: `its .git belongs to ${realToplevel}`,
      foreignGitDir,
    };
  }

  if (!absGit.ok) {
    return {ready: false, problem: 'unable to resolve its git directory'};
  }
  const realSubGit = fs.realpathSync(absGit.stdout);
  const realGitDir = fs.realpathSync(gitDir);
  if (realSubGit !== realGitDir && !realSubGit.startsWith(`${realGitDir}${path.sep}`)) {
    return {
      ready: false,
      problem: `its .git points outside this checkout (${realSubGit})`,
      foreignGitDir: realSubGit,
    };
  }

  const sparseTarget = path.join(dir, spec.sparseDir);
  const sparseStats = fs.lstatSync(sparseTarget, {throwIfNoEntry: false});
  if (!sparseStats?.isDirectory() || fs.readdirSync(sparseTarget).length === 0) {
    return {
      ready: false,
      problem: `missing sparse checkout directory ${spec.sparseDir}`,
      foreignGitDir: realSubGit,
    };
  }

  return {ready: true};
}

export function hasUncommittedChanges(dir: string, gitDir: string): boolean {
  const res = runGit([
    '--no-optional-locks',
    `--git-dir=${gitDir}`,
    `--work-tree=${dir}`,
    'status',
    '--porcelain',
  ]);
  return !res.ok || res.stdout !== '';
}

export function clearBrokenCheckout(
  rootDir: string,
  subPath: string,
  foreignGitDir?: string
): string | undefined {
  const dir = path.join(rootDir, subPath);
  const stats = fs.lstatSync(dir, {throwIfNoEntry: false});
  if (!stats) return undefined;
  if (stats.isSymbolicLink()) {
    fs.unlinkSync(dir);
    return undefined;
  }
  if (foreignGitDir !== undefined && !hasUncommittedChanges(dir, foreignGitDir)) {
    fs.rmSync(dir, {recursive: true, force: true});
    return undefined;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const aside = `${subPath}.bak-${stamp}`;
  fs.renameSync(dir, path.join(rootDir, aside));
  return aside;
}

function applySparseCheckout(rootDir: string, spec: SubmoduleSpec) {
  const subDir = path.join(rootDir, spec.path);
  const input = spec.stdinFile
    ? fs.readFileSync(path.join(rootDir, spec.stdinFile))
    : undefined;
  execGit(['-C', subDir, 'sparse-checkout', ...spec.sparseArgs], {input});
}

export function setUpSubmodule(
  rootDir: string,
  spec: SubmoduleSpec,
  log: (msg: string) => void = console.log
) {
  const gitDir = execGit(['rev-parse', '--absolute-git-dir'], {cwd: rootDir});
  const commonDir = execGit(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    {cwd: rootDir}
  );
  const state = checkSubmoduleState(rootDir, gitDir, spec);
  const subDir = path.join(rootDir, spec.path);

  if (state.ready) {
    const pinnedRes = runGit(['rev-parse', `:${spec.path}`], {cwd: rootDir});
    const headRes = runGit(['rev-parse', 'HEAD'], {cwd: subDir});
    if (pinnedRes.ok && headRes.ok && pinnedRes.stdout !== headRes.stdout) {
      log(
        `▸ ${spec.path} is on ${headRes.stdout.slice(0, 12)}, ` +
        `not pinned ${pinnedRes.stdout.slice(0, 12)} (leaving as-is)`
      );
    }
    return;
  }

  if (state.problem !== undefined) {
    log(`▸ Replacing ${spec.path}: ${state.problem}`);
    const aside = clearBrokenCheckout(rootDir, spec.path, state.foreignGitDir);
    if (aside) {
      log(`  Moved existing directory to ${aside} to preserve any local changes.`);
    }
  }

  const ownModule = path.join(gitDir, 'modules', spec.path);
  if (fs.lstatSync(ownModule, {throwIfNoEntry: false})) {
    fs.rmSync(ownModule, {recursive: true, force: true});
  }
  fs.mkdirSync(path.dirname(ownModule), {recursive: true});

  const realGitDir = fs.realpathSync(gitDir);
  const realCommonDir = fs.realpathSync(commonDir);
  const mainModule = path.join(realCommonDir, 'modules', spec.path);
  const pinnedRes = runGit(['rev-parse', `:${spec.path}`], {cwd: rootDir});

  if (realGitDir !== realCommonDir && isGitRepository(mainModule) && pinnedRes.ok) {
    log(`▸ Checking out ${spec.path} from main worktree module cache`);
    fs.cpSync(mainModule, ownModule, {recursive: true});
    runGit(['--git-dir', ownModule, 'config', '--unset-all', 'core.worktree']);
    fs.rmSync(subDir, {recursive: true, force: true});
    fs.mkdirSync(subDir, {recursive: true});
    fs.writeFileSync(path.join(subDir, '.git'), `gitdir: ${ownModule}\n`, 'utf8');
    try {
      applySparseCheckout(rootDir, spec);
      execGit(['-C', subDir, 'checkout', '-f', pinnedRes.stdout]);
      return;
    } catch {
      log(`  Pinned commit not available in local cache; cloning ${spec.path} from remote.`);
      fs.rmSync(subDir, {recursive: true, force: true});
      fs.rmSync(ownModule, {recursive: true, force: true});
    }
  }

  log(`▸ Cloning sparse submodule ${spec.path}`);
  execGit(['submodule', 'init', spec.path], {cwd: rootDir});
  const url = execGit(
    ['config', '-f', '.gitmodules', `submodule.${spec.path}.url`],
    {cwd: rootDir}
  );
  fs.rmSync(subDir, {recursive: true, force: true});
  execGit(
    [
      'clone',
      '--depth',
      '1',
      '--filter=blob:none',
      '--sparse',
      `--separate-git-dir=${ownModule}`,
      url,
      subDir,
    ],
    {cwd: rootDir}
  );
  applySparseCheckout(rootDir, spec);
  execGit(['submodule', 'update', '--depth', '1', spec.path], {cwd: rootDir});
}

export function setUpPrivate(
  rootDir: string,
  log: (msg: string) => void = console.log
) {
  const gitDir = execGit(['rev-parse', '--absolute-git-dir'], {cwd: rootDir});
  const commonDir = execGit(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    {cwd: rootDir}
  );
  const realGitDir = fs.realpathSync(gitDir);
  const realCommonDir = fs.realpathSync(commonDir);
  if (realGitDir === realCommonDir) return;

  const mainRoot = path.dirname(realCommonDir);
  const mainEnv = path.join(mainRoot, '.env');
  const localEnv = path.join(rootDir, '.env');
  if (fs.existsSync(mainEnv) && !fs.existsSync(localEnv)) {
    log('▸ Copying .env from main checkout');
    try {
      fs.copyFileSync(mainEnv, localEnv, fs.constants.COPYFILE_EXCL);
    } catch {
      // Ignore if created concurrently
    }
  }

  const mainPrivate = path.join(mainRoot, 'private');
  const mainPrivateStats = fs.lstatSync(mainPrivate, {throwIfNoEntry: false});
  if (!mainPrivateStats?.isDirectory()) return;

  const localPrivate = path.join(rootDir, 'private');
  const localStats = fs.lstatSync(localPrivate, {throwIfNoEntry: false});
  if (localStats?.isSymbolicLink()) {
    log('▸ Replacing private/ symlink with local directory');
    fs.unlinkSync(localPrivate);
  } else if (localStats) {
    return;
  }

  if (fs.existsSync(path.join(mainPrivate, '.git'))) {
    log('▸ Checking out private/ as a detached worktree');
    execGit(['-C', mainPrivate, 'worktree', 'add', '--detach', localPrivate, 'HEAD']);
    return;
  }

  log('▸ Copying private/ from main checkout');
  fs.cpSync(mainPrivate, localPrivate, {
    recursive: true,
    filter: src => {
      const base = path.basename(src);
      return base !== '.DS_Store' && !base.includes('.sqlite');
    },
  });
}

export function findPrivateTsconfigs(privateDir: string): string[] {
  const stats = fs.lstatSync(privateDir, {throwIfNoEntry: false});
  if (!stats?.isDirectory()) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === 'tsconfig.json') {
        found.push(full);
      }
    }
  };
  walk(privateDir);
  return found.sort();
}

export function typecheckPrivate(
  rootDir: string,
  log: (msg: string) => void = console.log
): number {
  const configs = findPrivateTsconfigs(path.join(rootDir, 'private'));
  if (configs.length === 0) return 0;
  const tscBin = path.join(
    rootDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc'
  );
  for (const cfg of configs) {
    const rel = path.relative(rootDir, cfg);
    log(`▸ Typechecking ${rel}`);
    execFileSync(tscBin, ['--noEmit', '-p', cfg], {cwd: rootDir, stdio: 'inherit'});
  }
  return configs.length;
}

export function verifyCheckout(rootDir: string, requirePublic = true) {
  for (const spec of SUBMODULES) {
    const sparsePath = path.join(rootDir, spec.path, spec.sparseDir);
    const stats = fs.lstatSync(sparsePath, {throwIfNoEntry: false});
    if (!stats?.isDirectory() || fs.readdirSync(sparsePath).length === 0) {
      throw new Error(`Submodule ${spec.path} is missing ${spec.sparseDir}`);
    }
  }
  execGit(['status', '--porcelain'], {cwd: rootDir});
  if (requirePublic && !fs.existsSync(path.join(rootDir, 'public', 'index.html'))) {
    throw new Error('Static site build did not produce public/index.html');
  }
}

export function runSetup(
  rootDir = ROOT,
  options: {submodulesOnly?: boolean; log?: (msg: string) => void} = {}
) {
  const log = options.log ?? console.log;
  const startedAt = performance.now();

  for (const spec of SUBMODULES) {
    setUpSubmodule(rootDir, spec, log);
  }

  if (options.submodulesOnly) {
    verifyCheckout(rootDir, false);
    return;
  }

  setUpPrivate(rootDir, log);
  typecheckPrivate(rootDir, log);

  log('▸ Building static site');
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npmCmd, ['run', 'build'], {cwd: rootDir, stdio: 'inherit'});

  verifyCheckout(rootDir, true);
  const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
  log(`▸ Ready in ${elapsed}s`);
}

if (require.main === module) {
  try {
    const submodulesOnly = process.argv.includes('--submodules-only');
    runSetup(ROOT, {submodulesOnly});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
}
