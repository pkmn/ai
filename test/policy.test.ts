import * as fs from 'fs';
import * as vm from 'vm';

import {BattleStreams, Teams} from '@pkmn/sim';
import * as ts from 'typescript';

import {
  BattleRequest,
  POLICY_SUM_TOLERANCE,
  canonicalizeChoice,
  enumerateRequestChoices,
  filterPlayerProtocolChunk,
  formatOmniscientPolicyChat,
  isDecisionRequest,
  parseAgentStdoutLine,
  shouldElideFromPlayerStream,
  validatePolicyLog,
} from '../server/policy';
import {root} from '../static/util';
import {generateValidVgcTeams} from '../tools/mock';

function uniformPolicy(choices: string[], favoredIdx = 0): Record<string, number> {
  const out: Record<string, number> = {};
  if (choices.length === 0) return out;
  if (choices.length === 1) {
    out[choices[0]] = 1;
    return out;
  }
  const base = Number((1 / choices.length).toFixed(6));
  let rem = 1;
  for (let i = 0; i < choices.length; i++) {
    if (i === favoredIdx) continue;
    out[choices[i]] = base;
    rem -= base;
  }
  out[choices[favoredIdx]] = Number(rem.toFixed(6));
  return out;
}

function loadProtocolDocEmptyPolicy(): (req: BattleRequest) => Record<string, number> | undefined {
  const md = fs.readFileSync(root('PROTOCOL.md'), 'utf8');
  const match = /```ts\n([\s\S]*?)```/.exec(md);
  if (!match) {
    throw new Error('Could not find TypeScript sample block in PROTOCOL.md');
  }
  const transpiled = ts.transpileModule(match[1], {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
  });
  const mod = {exports: {} as {emptyPolicy?: (r: BattleRequest) => Record<string, number>}};
  vm.runInNewContext(transpiled.outputText, {exports: mod.exports, module: mod});
  if (typeof mod.exports.emptyPolicy !== 'function') {
    throw new Error('PROTOCOL.md sample did not export emptyPolicy');
  }
  return mod.exports.emptyPolicy;
}

describe('server/policy.ts — stdout parsing & opponent chat elision', () => {
  test('parseAgentStdoutLine classifies plain JSON chat vs Showdown choice commands', () => {
    expect(parseAgentStdoutLine('')).toBeUndefined();
    expect(parseAgentStdoutLine('   \r')).toBeUndefined();
    expect(parseAgentStdoutLine('{"move 1":1}')).toEqual({
      kind: 'chat',
      message: '{"move 1":1}',
    });
    expect(parseAgentStdoutLine('|battle-gen9ou-42|{"switch 2":1}')).toEqual({
      kind: 'chat',
      message: '{"switch 2":1}',
    });
    expect(parseAgentStdoutLine('/say {"move 1":1}')).toEqual({
      kind: 'chat',
      message: '/say {"move 1":1}',
    });
    expect(parseAgentStdoutLine('/choose move 1 terastallize')).toEqual({
      kind: 'choice',
      choice: 'move 1 terastallize',
    });
    expect(parseAgentStdoutLine('/team 1234')).toEqual({
      kind: 'choice',
      choice: 'team 1234',
    });
    expect(parseAgentStdoutLine('1234')).toEqual({
      kind: 'choice',
      choice: '1234',
    });
    expect(parseAgentStdoutLine('move 1 +2, switch 3')).toEqual({
      kind: 'choice',
      choice: 'move 1 +2, switch 3',
    });
    expect(parseAgentStdoutLine('pass, switch 4')).toEqual({
      kind: 'choice',
      choice: 'pass, switch 4',
    });
  });

  test(
    'filterPlayerProtocolChunk strips chat, HTML, debug, and join/rename covert channels',
    () => {
      const raw = [
        '|turn|3',
        '|t:|1760000123',
        '|c|☆0 ERROR|{"move 1":0.625,"move 2":0.375}',
        '|c:|1760000123|☆Foul Play|{"move 1":1}',
        '|chat|secret signal',
        '|html|<b>injected</b>',
        '|uhtml|box|<div>hi</div>',
        '|raw|<span>raw</span>',
        '|debug|internal rng detail',
        '|j|☆Spectator',
        '|n|☆Renamed|old',
        '|move|p1a: Tauros|Body Slam|p2a: Snorlax',
        '|-damage|p2a: Snorlax|64/100',
      ].join('\n');

      expect(shouldElideFromPlayerStream('|c|☆0 ERROR|hello')).toBe(true);
      expect(shouldElideFromPlayerStream('|c:|1760000123|☆0 ERROR|hello')).toBe(true);
      expect(shouldElideFromPlayerStream('|move|p1a: Tauros|Body Slam|p2a: Snorlax')).toBe(false);

      const filtered = filterPlayerProtocolChunk(raw);
      expect(filtered).toBe([
        '|turn|3',
        '|t:|1760000123',
        '|move|p1a: Tauros|Body Slam|p2a: Snorlax',
        '|-damage|p2a: Snorlax|64/100',
      ].join('\n'));

      expect(formatOmniscientPolicyChat('0 ERROR', '{"move 1":1}')).toBe(
        '|c|☆0 ERROR|{"move 1":1}'
      );
      expect(formatOmniscientPolicyChat('0 ERROR', '{"move 1":1}', 1_760_000_123)).toBe(
        '|c:|1760000123|☆0 ERROR|{"move 1":1}'
      );
    }
  );
});

describe('server/policy.ts — legal choice enumeration, canonicalization & validation', () => {
  test(
    'validates Singles & VGC Pick-4 teamPreview requests (180 configs & 360 permutations)',
    () => {
      const party = Array.from({length: 6}, (_, i) => ({
        ident: `p1: Mon${i + 1}`,
        details: `Mon${i + 1}, L50`,
        condition: '150/150',
        active: i < 2,
      }));

      const singlesPreview: BattleRequest = {
        teamPreview: true,
        side: {name: '0 ERROR', id: 'p1', pokemon: party},
      };
      const singlesLegal = enumerateRequestChoices(singlesPreview);
      expect(singlesLegal.core).toEqual([
        'team 1', 'team 2', 'team 3', 'team 4', 'team 5', 'team 6',
      ]);
      // Full 6-digit team order canonicalizes to the chosen lead in 6v6 Singles
      expect(canonicalizeChoice(singlesPreview, 'team 312456')).toBe('team 3');
      const singlesPolicy = uniformPolicy(singlesLegal.core, 2);
      expect(validatePolicyLog(singlesPreview, JSON.stringify(singlesPolicy), 'team 312456').ok)
        .toBe(true);

      const vgcPreview: BattleRequest = {
        teamPreview: true,
        maxChosenTeamSize: 4,
        side: {name: '0 ERROR', id: 'p1', pokemon: party},
      };
      const vgcLegal = enumerateRequestChoices(vgcPreview);
      // 6 * 5 ordered leads * C(4, 2) unordered back-2 = 30 * 6 = 180
      expect(vgcLegal.core).toHaveLength(180);
      expect(canonicalizeChoice(vgcPreview, 'team 2, 1, 6, 4')).toBe('team 2146');
      expect(canonicalizeChoice(vgcPreview, 'team 1123')).toBeUndefined();

      // 180 canonical configs pass directly
      const vgcPolicy180 = uniformPolicy(vgcLegal.core, 0);
      expect(validatePolicyLog(vgcPreview, JSON.stringify(vgcPolicy180), vgcLegal.core[0]).ok)
        .toBe(true);

      // Full 360 ordered 4-tuples also collapse cleanly onto the 180 canonical configs
      const perms360: string[] = [];
      for (let a = 1; a <= 6; a++) {
        for (let b = 1; b <= 6; b++) {
          if (b === a) continue;
          for (let c = 1; c <= 6; c++) {
            if (c === a || c === b) continue;
            for (let d = 1; d <= 6; d++) {
              if (d === a || d === b || d === c) continue;
              perms360.push(`team ${a}${b}${c}${d}`);
            }
          }
        }
      }
      expect(perms360).toHaveLength(360);
      const vgcPolicy360 = uniformPolicy(perms360, 0);
      const res360 = validatePolicyLog(vgcPreview, JSON.stringify(vgcPolicy360), 'team 1243');
      expect(res360.ok).toBe(true);
      expect(Object.keys(res360.normalized!)).toHaveLength(180);
    }
  );

  test('validates Singles active moves, gimmicks, disabled/Z-Move/Struggle, and trapped', () => {
    const baseReq: BattleRequest = {
      active: [{
        moves: [
          {move: 'Earthquake', id: 'earthquake', pp: 16, maxpp: 16, target: 'allAdjacent'},
          {move: 'Icicle Crash', id: 'iciclecrash', pp: 0, maxpp: 16, target: 'normal'},
          {move: 'Ice Shard', id: 'iceshard', pp: 30, maxpp: 30, target: 'normal', disabled: true},
          {move: 'Knock Off', id: 'knockoff', pp: 20, maxpp: 20, target: 'normal'},
        ],
        canTerastallize: 'Ground',
        canZMove: [null, null, {move: 'Subzero Slammer', target: 'normal'}, null],
        maybeTrapped: true,
      }],
      side: {
        name: '0 ERROR',
        id: 'p1',
        pokemon: [
          {ident: 'p1: Mamoswine', details: 'Mamoswine', condition: '100/100', active: true},
          {ident: 'p1: Zapdos', details: 'Zapdos', condition: '88/100'},
          {ident: 'p1: Chansey', details: 'Chansey', condition: '0 fnt'},
        ],
      },
    };

    // Slot 2 has 0 PP, Slot 3 is Choice/Taunt disabled for base/Tera BUT usable as Z-Move!
    // `maybeTrapped: true` still permits `switch 2` (until Showdown reveals `trapped: true`).
    const legal = enumerateRequestChoices(baseReq);
    expect(legal.core).toEqual([
      'move 1',
      'move 1 terastallize',
      'move 3 zmove',
      'move 4',
      'move 4 terastallize',
      'switch 2',
    ]);
    expect(canonicalizeChoice(baseReq, 'move earthquake terastal')).toBe('move 1 terastallize');
    expect(canonicalizeChoice(baseReq, 'switch Zapdos')).toBe('switch 2');

    const okRes = validatePolicyLog(
      baseReq,
      JSON.stringify({
        'move earthquake': 0.3,
        'move 1 terastal': 0.25,
        'move 3 zmove': 0.1,
        'move knockoff': 0.15,
        'move 4 terastallize': 0.19999,
        'switch zapdos': 0.00001,
      }),
      'switch zapdos'
    );
    expect(okRes.ok).toBe(true);
    expect(okRes.normalized?.['switch 2']).toBe(0.00001);

    // Once `trapped: true`, switches become illegal
    const trappedReq: BattleRequest = {
      ...baseReq,
      active: [{...baseReq.active![0]!, trapped: true, maybeTrapped: undefined}],
    };
    expect(enumerateRequestChoices(trappedReq).core).not.toContain('switch 2');

    // All moves disabled in place -> Struggle (`move 1`) fallback
    const struggleReq: BattleRequest = {
      active: [{
        moves: [
          {move: 'Protect', id: 'protect', pp: 10, maxpp: 10, disabled: true},
        ],
        trapped: true,
      }],
      side: baseReq.side,
    };
    expect(enumerateRequestChoices(struggleReq).core).toEqual(['move 1']);
  });

  test(
    'validates Doubles targets, single gimmick per turn, distinct switches, and forceSwitch',
    () => {
      const doublesReq: BattleRequest = {
        active: [
          {
            moves: [
              {move: 'Moonblast', id: 'moonblast', pp: 15, maxpp: 15, target: 'normal'},
              {
                move: 'Dazzling Gleam',
                id: 'dazzlinggleam',
                pp: 10,
                maxpp: 10,
                target: 'allAdjacentFoes',
              },
              {move: 'Helping Hand', id: 'helpinghand', pp: 20, maxpp: 20, target: 'adjacentAlly'},
            ],
            canTerastallize: 'Fairy',
          },
          {
            moves: [
              {move: 'Protect', id: 'protect', pp: 10, maxpp: 10, target: 'self'},
              {move: 'Pollen Puff', id: 'pollenpuff', pp: 15, maxpp: 15, target: 'normal'},
            ],
            canTerastallize: 'Water',
          },
        ],
        side: {
          name: 'Foul Play',
          id: 'p1',
          pokemon: [
            {
              ident: 'p1: Flutter Mane',
              details: 'Flutter Mane, L50',
              condition: '130/130',
              active: true,
            },
            {ident: 'p1: Amoonguss', details: 'Amoonguss, L50', condition: '220/220', active: true},
            {ident: 'p1: Incineroar', details: 'Incineroar, L50', condition: '200/200'},
            {ident: 'p1: Urshifu', details: 'Urshifu, L50', condition: '0 fnt'},
          ],
        },
      };

      const legal = enumerateRequestChoices(doublesReq);
      // Neither simultaneous Terastallize nor simultaneous `switch 3, switch 3` is legal
      expect(legal.all.some(c => (c.match(/terastallize/g) ?? []).length > 1)).toBe(false);
      expect(legal.all).not.toContain('switch 3, switch 3');
      // Ally-targeted Moonblast (`move 1 -2`) is accepted in `all` (`core` only requires foes)
      expect(legal.all).toContain('move 1 -2, move 1');
      expect(legal.core).not.toContain('move 1 -2, move 1');
      // Helping Hand (`adjacentAlly` from slot 0) targets `-2`
      expect(legal.core).toContain('move 3 -2, move 2 +1');

      const policyCore = uniformPolicy(legal.core, 0);
      expect(validatePolicyLog(doublesReq, JSON.stringify(policyCore), legal.core[0]).ok)
        .toBe(true);

      // Double KO with only 1 healthy bench Pokémon (`Incineroar` in slot 3) requires `pass`
      const doubleKoOneBench: BattleRequest = {
        forceSwitch: [true, true],
        side: {
          name: 'Foul Play',
          id: 'p1',
          pokemon: [
            {
              ident: 'p1: Flutter Mane',
              details: 'Flutter Mane, L50',
              condition: '0 fnt',
              active: true,
            },
            {ident: 'p1: Amoonguss', details: 'Amoonguss, L50', condition: '0 fnt', active: true},
            {ident: 'p1: Incineroar', details: 'Incineroar, L50', condition: '200/200'},
            {ident: 'p1: Urshifu', details: 'Urshifu, L50', condition: '0 fnt'},
          ],
        },
      };
      expect(enumerateRequestChoices(doubleKoOneBench).core).toEqual([
        'switch 3, pass',
        'pass, switch 3',
      ]);
    }
  );

  test(
    'rejects /say prefixes, 0..100 percentages, bad sums, missing/illegal choices, and 0 chosen',
    () => {
      const req: BattleRequest = {
        active: [{
          moves: [
            {move: 'Surf', id: 'surf', pp: 15, maxpp: 15, target: 'normal'},
            {move: 'Recover', id: 'recover', pp: 10, maxpp: 10, target: 'self'},
          ],
          trapped: true,
        }],
        side: {
          name: '0 ERROR',
          id: 'p1',
          pokemon: [{ident: 'p1: Starmie', details: 'Starmie', condition: '100/100', active: true}],
        },
      };

      expect(validatePolicyLog({wait: true, side: req.side}, undefined).ok).toBe(true);
      expect(validatePolicyLog(req, undefined, 'move 1').error).toMatch(/Missing required/);
      expect(validatePolicyLog(req, '/say {"move 1":1,"move 2":0}', 'move 1').error)
        .toMatch(/Do not prefix policy JSON with `\/say`/);
      expect(validatePolicyLog(req, '{bad', 'move 1').error).toMatch(/Invalid policy JSON/);
      expect(validatePolicyLog(req, '[0.5,0.5]', 'move 1').error).toMatch(/flat JSON object/);

      // Tolerance check: within 1 ± 1e-3 passes, outside 1 ± 1e-3 fails
      expect(POLICY_SUM_TOLERANCE).toBe(1e-3);
      expect(validatePolicyLog(req, '{"move 1":0.6664,"move 2":0.333}', 'move 1').ok).toBe(true);
      expect(validatePolicyLog(req, '{"move 1":0.6,"move 2":0.39}', 'move 1').error)
        .toMatch(/sum to 1\.0/);

      // 0..100 percentage scale detection
      const pctScale = validatePolicyLog(req, '{"move 1":70,"move 2":30}', 'move 1');
      expect(pctScale.ok).toBe(false);
      expect(pctScale.error).toMatch(/not 0\.\.100 percentages/);

      // Illegal choice
      expect(validatePolicyLog(req, '{"move 1":0.5,"move 2":0.3,"switch 2":0.2}', 'move 1').error)
        .toMatch(/illegal or unrecognized/);

      // Missing legal choice
      expect(validatePolicyLog(req, '{"move 1":1}', 'move 1').error)
        .toMatch(/missing 1 legal choice/);

      // Chosen action has 0 probability
      expect(validatePolicyLog(req, '{"move 1":1,"move 2":0}', 'move 2').error)
        .toMatch(/must be > 0/);

      // `default` / `auto` forbidden
      expect(validatePolicyLog(req, '{"move 1":0.6,"move 2":0.4}', 'default').error)
        .toMatch(/explicit choice/);
    }
  );

  test('PROTOCOL.md emptyPolicy TypeScript snippet compiles and matches validatePolicyLog', () => {
    const emptyPolicy = loadProtocolDocEmptyPolicy();

    expect(emptyPolicy({wait: true, side: {name: 'Bot A', id: 'p1', pokemon: []}}))
      .toBeUndefined();

    const cases: BattleRequest[] = [
      // 1. VGC Bring-6-Pick-4 Team Preview
      {
        teamPreview: true,
        maxChosenTeamSize: 4,
        side: {
          name: 'Bot A',
          id: 'p1',
          pokemon: Array.from({length: 6}, (_, i) => ({
            ident: `p1: Mon${i + 1}`,
            details: `Mon${i + 1}, L50`,
            condition: '150/150',
            active: i < 2,
          })),
        },
      },
      // 2. Singles active with Tera + Choice-disabled Z-Move + bench
      {
        active: [{
          moves: [
            {move: 'Earthquake', id: 'earthquake', pp: 16, target: 'allAdjacent'},
            {move: 'Ice Shard', id: 'iceshard', pp: 30, target: 'normal', disabled: true},
          ],
          canTerastallize: 'Ground',
          canZMove: [null, {move: 'Subzero Slammer', target: 'normal'}],
        }],
        side: {
          name: 'Bot A',
          id: 'p1',
          pokemon: [
            {ident: 'p1: Mamoswine', details: 'Mamoswine', condition: '100/100', active: true},
            {ident: 'p1: Zapdos', details: 'Zapdos', condition: '80/100'},
          ],
        },
      },
      // 3. Struggle fallback
      {
        active: [{
          moves: [{move: 'Protect', id: 'protect', pp: 10, disabled: true}],
          trapped: true,
        }],
        side: {
          name: 'Bot A',
          id: 'p1',
          pokemon: [{ident: 'p1: Mon1', details: 'Mon1', condition: '50/100', active: true}],
        },
      },
      // 4. VGC Doubles active with Tera + bench
      {
        active: [
          {
            moves: [
              {move: 'Moonblast', id: 'moonblast', pp: 15, target: 'normal'},
              {move: 'Helping Hand', id: 'helpinghand', pp: 20, target: 'adjacentAlly'},
            ],
            canTerastallize: 'Fairy',
          },
          {
            moves: [{move: 'Protect', id: 'protect', pp: 10, target: 'self'}],
            canTerastallize: 'Water',
          },
        ],
        side: {
          name: 'Agent A',
          id: 'p1',
          pokemon: [
            {
              ident: 'p1: Flutter Mane',
              details: 'Flutter Mane',
              condition: '100/100',
              active: true,
            },
            {ident: 'p1: Amoonguss', details: 'Amoonguss', condition: '100/100', active: true},
            {ident: 'p1: Incineroar', details: 'Incineroar', condition: '100/100'},
          ],
        },
      },
    ];

    for (const req of cases) {
      const zeroMap = emptyPolicy(req)!;
      expect(zeroMap).toBeDefined();
      expect(Object.values(zeroMap).every(v => v === 0)).toBe(true);
      const keys = Object.keys(zeroMap);
      expect(keys).toEqual(enumerateRequestChoices(req).core);

      // Setting probability 1 on the first legal key passes validatePolicyLog
      const chosen = keys[0];
      zeroMap[chosen] = 1;
      const check = validatePolicyLog(req, JSON.stringify(zeroMap), chosen);
      expect(check.ok).toBe(true);
    }
  });

  test(
    'runs a full @pkmn/sim Doubles battle with unprefixed [0, 1] policy logging & chat elision',
    async () => {
      const vgcPastes = generateValidVgcTeams(2);
      const p1Packed = Teams.pack(Teams.import(vgcPastes[0]));
      const p2Packed = Teams.pack(Teams.import(vgcPastes[1]));

      const battleStream = new BattleStreams.BattleStream();
      const streams = BattleStreams.getPlayerStreams(battleStream);

      const omniscientLog: string[] = [];
      const p1ReceivedChat: string[] = [];
      const p2ReceivedChat: string[] = [];
      const validationFailures: string[] = [];
      let validatedDecisions = 0;

      const omniTask = (async () => {
        for await (const chunk of streams.omniscient) {
          omniscientLog.push(chunk);
        }
      })();

      const drivePlayer = async (
        side: 'p1' | 'p2',
        playerName: string,
        playerStream: typeof streams.p1,
        receivedChatSink: string[]
      ) => {
        for await (const rawChunk of playerStream) {
          const filtered = filterPlayerProtocolChunk(rawChunk);
          for (const line of filtered.split('\n')) {
            if (line.startsWith('|c|') || line.startsWith('|c:|') || line.startsWith('|chat|')) {
              receivedChatSink.push(line);
            }
            if (!line.startsWith('|request|')) continue;
            const reqJson = line.slice('|request|'.length).trim();
            if (!reqJson) continue;
            const req = JSON.parse(reqJson) as BattleRequest;
            if (!isDecisionRequest(req)) continue;

            const legal = enumerateRequestChoices(req);
            const chosen = legal.core[0];
            const policyObj = uniformPolicy(legal.core, 0);

            const stdoutChat = parseAgentStdoutLine(JSON.stringify(policyObj));
            const stdoutChoice = parseAgentStdoutLine(chosen);
            if (stdoutChat?.kind !== 'chat' || stdoutChoice?.kind !== 'choice') {
              validationFailures.push('Failed to parse simulated stdout lines');
              continue;
            }

            const check = validatePolicyLog(req, stdoutChat.message, stdoutChoice.choice);
            if (!check.ok || !check.compactJson) {
              validationFailures.push(check.error ?? 'Unknown policy validation failure');
              continue;
            }
            omniscientLog.push(
              formatOmniscientPolicyChat(playerName, check.compactJson, 1_760_000_500)
            );
            validatedDecisions++;
            // Inject an unprompted chat write into BattleStream to verify filter strips it!
            await battleStream.write(`>chat ${playerName}|attempted opponent crosstalk`);
            await battleStream.write(`>${side} ${stdoutChoice.choice}`);
          }
        }
      };

      const p1Task = drivePlayer('p1', '0 ERROR', streams.p1, p1ReceivedChat);
      const p2Task = drivePlayer('p2', 'Foul Play', streams.p2, p2ReceivedChat);

      const startSpec = JSON.stringify({formatid: 'gen9vgc2026regi', seed: [1, 2, 3, 4]});
      await battleStream.write(`>start ${startSpec}`);
      await battleStream.write(`>player p1 ${JSON.stringify({name: '0 ERROR', team: p1Packed})}`);
      await battleStream.write(`>player p2 ${JSON.stringify({name: 'Foul Play', team: p2Packed})}`);

      await Promise.all([omniTask, p1Task, p2Task]);

      expect(validationFailures).toEqual([]);
      expect(validatedDecisions).toBeGreaterThanOrEqual(4);
      expect(p1ReceivedChat).toEqual([]);
      expect(p2ReceivedChat).toEqual([]);
      expect(omniscientLog.some(l => l.startsWith('|c:|1760000500|☆0 ERROR|{'))).toBe(true);
      expect(omniscientLog.some(l => l.startsWith('|c:|1760000500|☆Foul Play|{'))).toBe(true);
    }
  );
});
