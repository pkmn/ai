import {execFileSync, spawn} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as tournament from '../arena/tournament';
import * as sim from '../server/sim';
import {root} from '../static/util';

import {
  TEAM_ONE,
  TEAM_TWO,
  getArenaTestBins,
  linkOrCopyExecutable,
} from './arena-helpers';

describe('arena sandbox & tourney-relay', () => {
  let tmpDir: string;
  let relayBin: string;
  let limitBin: string;
  let sandboxProbeBin: string;
  let defaultAgentScript: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-sb-'));
    ({relayBin, limitBin, sandboxProbeBin, defaultAgentScript} = getArenaTestBins({
      darwinBins: true,
    }));
  }, 30_000);

  afterAll(async () => {
    await sim.closeAllWorkers();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  describe('tourney-relay binary', () => {
    test('emits local CLOCK_MONOTONIC turn duration on stderr', async () => {
      const proc = spawn(relayBin, [defaultAgentScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', chunk => stdoutLines.push(String(chunk)));
      proc.stderr.on('data', chunk => stderrLines.push(String(chunk)));

      proc.stdin.write('|request|{"wait":true}\n');
      proc.stdin.write('|request|{"active":[{"moves":[{"id":"tackle"}]}]}\n');

      await new Promise<void>(resolve => {
        const check = () => {
          if (stdoutLines.join('').includes('default')) resolve();
          else setTimeout(check, 5);
        };
        check();
      });

      proc.kill('SIGTERM');
      expect(stderrLines.join('')).toMatch(/ARENA_TURN_MS=[1-9]\d*\t1/);
      expect(stdoutLines.join('')).toContain('default');
    });

    test('terminates hung child process groups promptly on stdin EOF', async () => {
      const hungScript = path.join(tmpDir, 'hung-gpu-agent.js');
      fs.writeFileSync(
        hungScript,
        '#!/usr/bin/env node\nsetInterval(() => {}, 10000);\n',
        {mode: 0o755}
      );
      const hungRelay = spawn(relayBin, [process.execPath, hungScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const exitedPromise = new Promise<number | null>(resolve => {
        hungRelay.on('exit', code => resolve(code));
      });
      hungRelay.stdin.end();
      const exitStart = Date.now();
      await exitedPromise;
      expect(Date.now() - exitStart).toBeLessThan(1500);
    });

    test('exits promptly on stdin EOF when child never reads flooded stdin', async () => {
      const noReadScript = path.join(tmpDir, 'noread-agent.js');
      fs.writeFileSync(
        noReadScript,
        '#!/usr/bin/env node\nconst b = Buffer.alloc(16 * 1024 * 1024, 3);' +
          'setInterval(() => b[0], 10000);\n',
        {mode: 0o755}
      );
      const relay = spawn(relayBin, [process.execPath, noReadScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      relay.stdin.on('error', () => undefined);
      let stderrOut = '';
      relay.stderr.setEncoding('utf8');
      relay.stderr.on('data', chunk => {
        stderrOut += String(chunk);
      });
      const exitedPromise = new Promise<number | null>(resolve => {
        relay.on('close', code => resolve(code));
      });
      const line = `|c|~|${'x'.repeat(4000)}\n`;
      for (let i = 0; i < 80; i++) {
        relay.stdin.write(line);
      }
      relay.stdin.end();
      const start = Date.now();
      await exitedPromise;
      expect(Date.now() - start).toBeLessThan(1500);
      const ramMatch = /ARENA_PEAK_RAM=(\d+)/.exec(stderrOut);
      expect(ramMatch).toBeTruthy();
      const peakMib = Number(ramMatch![1]);
      expect(peakMib).toBeGreaterThanOrEqual(16);
      expect(peakMib).toBeLessThan(4096);
    });

    test('closes inherited file descriptors above stderr before exec', async () => {
      const relay = spawn(
        relayBin,
        ['/bin/sh', '-c', 'if echo leaked >&3 2>/dev/null; then echo OPEN; else echo CLOSED; fi'],
        {stdio: ['pipe', 'pipe', 'pipe', 'pipe']}
      );
      let out = '';
      relay.stdout.setEncoding('utf8');
      relay.stdout.on('data', chunk => {
        out += String(chunk);
      });
      await new Promise<void>(resolve => {
        relay.on('close', () => resolve());
      });
      expect(out.trim()).toBe('CLOSED');
    });

    test('emits ARENA_TURN_MS on empty stdout lines to keep turn clocks aligned', async () => {
      const emptyLineScript = path.join(tmpDir, 'empty-line-agent.js');
      fs.writeFileSync(
        emptyLineScript,
        '#!/usr/bin/env node\nconst readline = require("readline");' +
          'process.stdout.write("/ready\\n");' +
          'const rl = readline.createInterface({input: process.stdin});' +
          'rl.on("line", line => {' +
          '  if (!line.startsWith("|request|")) return;' +
          '  process.stdout.write("\\n");' +
          '  setTimeout(() => process.stdout.write("default\\n"), 25);' +
          '});\n',
        {mode: 0o755}
      );
      const res = await new tournament.ConcurrentGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        smokeStopAfterTurn: 1,
        p1: {
          spec: {
            agentId: 'empty-p1',
            displayName: 'Empty P1',
            vmHost: 'localhost',
            controlSocket: '/tmp/unused',
            localCommand: relayBin,
            localArgs: [process.execPath, emptyLineScript],
          },
          teamPacked: TEAM_ONE,
        },
        p2: {
          spec: {
            agentId: 'default-p2',
            displayName: 'Default P2',
            vmHost: 'localhost',
            controlSocket: '/tmp/unused',
            localCommand: relayBin,
            localArgs: [defaultAgentScript],
          },
          teamPacked: TEAM_TWO,
        },
      }).run();
      expect(res.p1.meanTurnMillis).toBeGreaterThanOrEqual(20);
      expect(res.p1.peakRam).toBeGreaterThan(1);
    });

    test('bake-image smoke_test_agent keeps stdin open past tourney-relay 100ms EOF kill', () => {
      const slowAgent = path.join(tmpDir, 'slow-bake-agent.js');
      fs.writeFileSync(
        slowAgent,
        [
          '#!/usr/bin/env node',
          'const readline = require("readline");',
          'const rl = readline.createInterface({input: process.stdin});',
          'rl.on("line", line => {',
          '  if (line.startsWith("|request|")) process.stdout.write("/choose move 1\\n");',
          '});',
          'setTimeout(() => process.stdout.write("/ready\\n"), 140);',
        ].join('\n'),
        {mode: 0o755}
      );
      const wrapperBin = path.join(tmpDir, 'mock-tourney-agent.sh');
      fs.writeFileSync(
        wrapperBin,
        `#!/usr/bin/env bash\nexec ${JSON.stringify(relayBin)} ` +
          `${JSON.stringify(process.execPath)} ${JSON.stringify(slowAgent)}\n`,
        {mode: 0o755}
      );
      const bakeScript = fs.readFileSync(root('arena', 'scripts', 'bake-image.sh'), 'utf8');
      const fnMatch = /smoke_test_agent\(\) \{[\s\S]*?\n\}/.exec(bakeScript);
      expect(fnMatch).not.toBeNull();
      const adaptedFn = fnMatch![0].replace('/usr/local/bin/tourney-agent', wrapperBin);
      const driver = [
        'set -euo pipefail',
        'timeout() { shift; "$@"; }',
        adaptedFn,
        'SMOKE_OUT=""',
        'smoke_test_agent slow-agent \'|request|{"rqid":1}\'',
        'printf "%s" "$SMOKE_OUT"',
      ].join('\n');
      const output = execFileSync('bash', ['-c', driver], {encoding: 'utf8', timeout: 10_000});
      expect(output).toBe('/ready -> /choose move 1');
    });
  });

  describe('Darwin sandbox enforcement', () => {
    test('validates LaunchDaemon plists plus PF anchor ruleset syntax', () => {
      if (process.platform !== 'darwin') return;
      expect(() => {
        execFileSync('plutil', [
          '-lint',
          root('arena/config/ai.pkmn.arena.plist'),
          root('arena/config/ai.pkmn.archive.plist'),
          root('arena/config/ai.pkmn.pf.plist'),
          root('arena/config/ai.pkmn.podman.plist'),
          root('arena/config/ai.pkmn.tunnel.plist'),
        ]);
        execFileSync('/sbin/pfctl', ['-nf', root('arena/config/pf.anchor')]);
      }).not.toThrow();
    });

    test('sandbox.sb permits bundle reads, scratch writes, or /dev/fd substitution', () => {
      if (process.platform !== 'darwin') return;
      const realTmp = fs.realpathSync(tmpDir);
      const sbRo = path.join(realTmp, 'sb-allow-ro');
      const sbScratch = path.join(realTmp, 'sb-allow-scratch');
      fs.mkdirSync(sbRo, {recursive: true});
      fs.mkdirSync(sbScratch, {recursive: true});
      const probe = path.join(sbRo, 'probe');
      linkOrCopyExecutable(sandboxProbeBin, probe);
      fs.writeFileSync(path.join(sbRo, 'weights.txt'), 'ok-weights');

      const sandboxEnv = {
        HOME: sbScratch,
        TMPDIR: sbScratch,
        PATH: '/opt/homebrew/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        PYTHONHASHSEED: '0',
      };
      const out = execFileSync(
        '/usr/bin/sandbox-exec',
        [
          '-f', root('arena/config/sandbox.sb'),
          '-D', `AGENT_RO_DIR=${sbRo}`,
          '-D', `AGENT_SCRATCH_DIR=${sbScratch}`,
          probe,
          'allow',
          path.join(sbRo, 'weights.txt'),
          path.join(sbScratch, 'out.txt'),
        ],
        {cwd: sbScratch, env: sandboxEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}
      ).trim();
      expect(out).toBe('ok-weights-scratch-fd');
    });

    test('sandbox.sb blocks sibling agent reads, network sockets, kern.proc, or uchg', () => {
      if (process.platform !== 'darwin') return;
      const realTmp = fs.realpathSync(tmpDir);
      const sbRo = path.join(realTmp, 'sb-deny-ro');
      const sbSibling = path.join(realTmp, 'sb-deny-sibling');
      const sbScratch = path.join(realTmp, 'sb-deny-scratch');
      fs.mkdirSync(sbRo, {recursive: true});
      fs.mkdirSync(sbSibling, {recursive: true});
      fs.mkdirSync(sbScratch, {recursive: true});
      const probe = path.join(sbRo, 'probe');
      linkOrCopyExecutable(sandboxProbeBin, probe);
      fs.writeFileSync(path.join(sbSibling, 'secret.txt'), 'rival-secret');
      fs.writeFileSync(path.join(sbScratch, 'out.txt'), 'scratch-file');

      const sandboxEnv = {
        HOME: sbScratch,
        TMPDIR: sbScratch,
        PATH: '/opt/homebrew/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        PYTHONHASHSEED: '0',
      };
      const res = execFileSync(
        '/usr/bin/sandbox-exec',
        [
          '-f', root('arena/config/sandbox.sb'),
          '-D', `AGENT_RO_DIR=${sbRo}`,
          '-D', `AGENT_SCRATCH_DIR=${sbScratch}`,
          probe,
          'deny-all',
          path.join(sbSibling, 'secret.txt'),
          sbScratch,
          path.join(sbScratch, 'out.txt'),
        ],
        {cwd: sbScratch, env: sandboxEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}
      );
      expect(res).toBe('');
    });

    test('limit binary fails closed when slot privilege drop is unavailable', () => {
      if (process.platform !== 'darwin') return;
      let status: number | undefined;
      try {
        execFileSync(limitBin, ['p1', '/usr/bin/true'], {stdio: 'pipe'});
      } catch (err) {
        status = (err as {status?: number}).status;
      }
      expect(status).toBe(126);
    });
  });
});
