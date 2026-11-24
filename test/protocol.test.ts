import * as fs from 'fs';

import {BattleStreams, extractChannelMessages} from '@pkmn/sim';

import * as protocol from '../server/protocol';
import {root} from '../static/util';

const TEAM_ONE =
  'Pikachu||lightball|static|thunderbolt,quickattack,irontail,volttackle|' +
  'Jolly|,252,,,4,252|||||' +
  ']Charizard||heavydutyboots|blaze|flamethrower,airslash,roost,willowisp|' +
  'Timid|,4,,,252,252|||||' +
  ']Blastoise||leftovers|torrent|scald,icebeam,rapidspin,toxic|Bold|252,252,,,,4|||||' +
  ']Venusaur||blacksludge|overgrow|gigadrain,sludgebomb,synthesis,sleeppowder|' +
  'Calm|252,,,4,252,|||||';

const TEAM_TWO =
  'Gengar||focussash|cursedbody|shadowball,sludgewave,focusblast,destinybond|' +
  'Timid|,,,252,4,252|||||' +
  ']Dragonite||lumberry|multiscale|outrage,extremespeed,earthquake,dragondance|' +
  'Adamant|,252,4,,,252|||||' +
  ']Tyranitar||smoothrock|sandstream|stoneedge,crunch,stealthrock,earthquake|' +
  'Careful|252,4,252,,,|||||' +
  ']Snorlax||leftovers|thickfat|bodyslam,curse,rest,crunch|Careful|252,4,252,,,|||||';

describe('parseAgentStdoutLine', () => {
  test('ignores blank stdout lines', () => {
    expect(protocol.parseAgentStdoutLine('')).toBeUndefined();
    expect(protocol.parseAgentStdoutLine('   \r')).toBeUndefined();
  });

  test('parses /ready handshake command', () => {
    expect(protocol.parseAgentStdoutLine('/ready')).toEqual({kind: 'ready'});
    expect(protocol.parseAgentStdoutLine('  /READY\r')).toEqual({kind: 'ready'});
  });

  test('classifies plain text lines as chat', () => {
    expect(protocol.parseAgentStdoutLine('hello opponent')).toEqual({
      kind: 'chat',
      message: 'hello opponent',
    });
    expect(protocol.parseAgentStdoutLine('/say secret')).toEqual({
      kind: 'chat',
      message: '/say secret',
    });
  });

  test('parses Showdown battle choice commands', () => {
    expect(protocol.parseAgentStdoutLine('|battle-gen9ou-42|/choose move 1')).toEqual({
      kind: 'choice',
      choice: 'move 1',
    });
    expect(protocol.parseAgentStdoutLine('/choose move 1 terastallize')).toEqual({
      kind: 'choice',
      choice: 'move 1 terastallize',
    });
    expect(protocol.parseAgentStdoutLine('/team 1234')).toEqual({
      kind: 'choice',
      choice: 'team 1234',
    });
    expect(protocol.parseAgentStdoutLine('team 1, 2, 3, 4')).toEqual({
      kind: 'choice',
      choice: 'team 1, 2, 3, 4',
    });
    expect(protocol.parseAgentStdoutLine('team 1, 2, 3, 4, 5, 6')).toEqual({
      kind: 'choice',
      choice: 'team 1, 2, 3, 4, 5, 6',
    });
    expect(protocol.parseAgentStdoutLine('1234')).toEqual({
      kind: 'choice',
      choice: '1234',
    });
    expect(protocol.parseAgentStdoutLine('move 1 +2, switch 3')).toEqual({
      kind: 'choice',
      choice: 'move 1 +2, switch 3',
    });
    expect(protocol.parseAgentStdoutLine('pass, switch 4')).toEqual({
      kind: 'choice',
      choice: 'pass, switch 4',
    });
  });

  test('normalizes uppercase slash or team choice keywords', () => {
    expect(protocol.parseAgentStdoutLine('/CHOOSE move 1')).toEqual({
      kind: 'choice',
      choice: 'move 1',
    });
    expect(protocol.parseAgentStdoutLine('/TEAM 1234')).toEqual({
      kind: 'choice',
      choice: 'team 1234',
    });
    expect(protocol.parseAgentStdoutLine('TEAM 1234')).toEqual({
      kind: 'choice',
      choice: 'team 1234',
    });
    expect(protocol.parseAgentStdoutLine('/DEFAULT')).toEqual({
      kind: 'choice',
      choice: 'default',
    });
  });

  test('demotes undo choice cancellation attempts to chat', () => {
    for (const undoLine of [
      'undo',
      '/undo',
      '/choose undo',
      'move 1, undo',
      '/move 1, undo',
      '/switch 2, undo',
      '/team 1, undo',
    ]) {
      expect(protocol.parseAgentStdoutLine(undoLine)).toEqual({
        kind: 'chat',
        message: undoLine,
      });
    }
  });

  test('demotes forbidden forfeit, tie, or timer commands to chat', () => {
    for (const forbidden of [
      'forfeit',
      '/forfeit',
      '/choose forfeit',
      'offertie',
      '/offertie',
      '/choose offertie',
      '/accepttie',
      '/rejecttie',
      '/tie',
      '/timer on',
    ]) {
      expect(protocol.parseAgentStdoutLine(forbidden)).toEqual({
        kind: 'chat',
        message: forbidden,
      });
    }
  });

  test('strips embedded carriage returns or pipes from protocol injection attempts', () => {
    expect(protocol.parseAgentStdoutLine('hello\r|win|Agent A')).toEqual({
      kind: 'chat',
      message: 'hello|win|Agent A',
    });
    expect(protocol.parseAgentStdoutLine('move 1\r|win|Agent A')).toEqual({
      kind: 'chat',
      message: 'move 1|win|Agent A',
    });
    expect(protocol.parseAgentStdoutLine('move 1|win|Agent A')).toEqual({
      kind: 'chat',
      message: 'move 1|win|Agent A',
    });
  });

  test('parses valid /info JSON payloads including optional policy', () => {
    const line =
      '/info {"win":0.6342,"depth":6,"seldepth":14,"nodes":142000,"nps":95000,' +
      '"policy":{"move 1":0.72,"switch 3":0.28},"futureField":"ignored"}';
    expect(protocol.parseAgentStdoutLine(line)).toEqual({
      kind: 'info',
      info: {
        win: 0.6342,
        depth: 6,
        seldepth: 14,
        nodes: 142000,
        nps: 95000,
        policy: {'move 1': 0.72, 'switch 3': 0.28},
      },
    });
    expect(protocol.parseAgentStdoutLine('/INFO {"win":0.5}')).toEqual({
      kind: 'info',
      info: {win: 0.5},
    });
    expect(protocol.parseAgentStdoutLine('/info {"policy":{"TEAM 1234":1}}')).toEqual({
      kind: 'info',
      info: {policy: {'team 1234': 1}},
    });
    expect(protocol.isAgentInfoLine('|battle-gen9ou-1|/info {"win":0.5}')).toBe(true);
    expect(protocol.isAgentInfoLine('/info bad')).toBe(true);
    expect(protocol.isAgentInfoLine('move 1')).toBe(false);
    expect(protocol.parseAgentInfoLine('|battle-gen9ou-1|/info {"win":0.5}')).toEqual({win: 0.5});
    expect(protocol.parseAgentInfoLine('/info bad')).toBeUndefined();
    const oversized = `/info {"win":0.5,"pad":"${'x'.repeat(protocol.MAX_INFO_LINE_CHARS)}"}`;
    expect(protocol.parseAgentInfoLine(oversized)).toBeUndefined();
  });

  test('silently ignores malformed, out-of-bounds, or oversized /info lines', () => {
    const ninePolicy: Record<string, number> = {};
    for (let i = 1; i <= 9; i++) ninePolicy[`move ${i}`] = 0.1;

    for (const bad of [
      '/info',
      '/info {}',
      '/info not-json',
      '/info []',
      '/info {"unknown":1}',
      '/info {"win":-0.01}',
      '/info {"win":1.01}',
      '/info {"win":"0.5"}',
      '/info {"depth":-1}',
      '/info {"depth":3.5}',
      '/info {"seldepth":-2}',
      '/info {"nodes":1.2}',
      '/info {"nps":"fast"}',
      '/info {"policy":{}}',
      `/info ${JSON.stringify({policy: ninePolicy})}`,
      '/info {"policy":{"forfeit":1}}',
      '/info {"policy":{"undo":0.5}}',
      '/info {"policy":{"move 1|win|p1":0.5}}',
      '/info {"policy":{"move 1":1.5}}',
      `/info {"win":0.5,"pad":"${'x'.repeat(protocol.MAX_INFO_LINE_CHARS)}"}`,
    ]) {
      expect(protocol.parseAgentStdoutLine(bad)).toBeUndefined();
    }
  });
});

describe('agent info public formatting and |ai| log helpers', () => {
  test('toPublicAgentInfo strips policy and rounds win to 4 decimal places', () => {
    expect(
      protocol.toPublicAgentInfo({
        win: 0.63426,
        depth: 6,
        seldepth: 14,
        nodes: 142000,
        nps: 95000,
        policy: {'move 1': 0.8, 'switch 2': 0.2},
      })
    ).toEqual({
      win: 0.6343,
      depth: 6,
      seldepth: 14,
      nodes: 142000,
      nps: 95000,
    });
    expect(protocol.toPublicAgentInfo({policy: {'move 1': 1}})).toBeUndefined();
  });

  test('formatAiLogLine and parseAiLogLine roundtrip without leaking policy', () => {
    const line = protocol.formatAiLogLine('p1', {
      win: 0.75,
      nodes: 50000,
      nps: 40000,
    });
    expect(line).toBe('|ai|p1|{"win":0.75,"nodes":50000,"nps":40000}');
    expect(protocol.parseAiLogLine(line!)).toEqual({
      slot: 'p1',
      info: {win: 0.75, nodes: 50000, nps: 40000},
    });
    expect(
      protocol.parseAiLogLine('|ai|p2|{"win":0.25,"policy":{"move 1":1}}')
    ).toEqual({
      slot: 'p2',
      info: {win: 0.25},
    });
    expect(protocol.parseAiLogLine('|ai|p3|{"win":0.5}')).toBeUndefined();
    expect(protocol.parseAiLogLine('|turn|1')).toBeUndefined();
  });

  test('injectAiLogLines and extractAiTelemetry align per-turn snapshots', () => {
    const rawLog = [
      '|player|p1|Hydra|',
      '|player|p2|Vertex|',
      '|teampreview',
      '|turn|1',
      '|move|p1a: Pikachu|Thunderbolt|p2a: Gengar',
      '|turn|2',
      '|win|Hydra',
    ].join('\n');

    const byTurn = new Map<number, {p1?: protocol.PublicAgentInfo; p2?: protocol.PublicAgentInfo}>([
      [0, {p1: {win: 0.51, nodes: 1000}}],
      [1, {p1: {win: 0.64, depth: 6, seldepth: 14, nodes: 142000, nps: 95000}, p2: {win: 0.41}}],
      [2, {p1: {win: 0.92, depth: 8, nodes: 200000}}],
    ]);

    const injected = protocol.injectAiLogLines(rawLog, byTurn);
    const lines = injected.split('\n');
    expect(lines.indexOf('|ai|p1|{"win":0.51,"nodes":1000}')).toBeLessThan(
      lines.indexOf('|turn|1')
    );
    expect(lines.indexOf('|ai|p2|{"win":0.41}')).toBeGreaterThan(lines.indexOf('|turn|1'));
    expect(lines.indexOf('|ai|p2|{"win":0.41}')).toBeLessThan(lines.indexOf('|turn|2'));

    expect(protocol.extractAiTelemetry(lines)).toEqual([
      {turn: 0, p1: {win: 0.51, nodes: 1000}},
      {
        turn: 1,
        p1: {win: 0.64, depth: 6, seldepth: 14, nodes: 142000, nps: 95000},
        p2: {win: 0.41},
      },
      {turn: 2, p1: {win: 0.92, depth: 8, nodes: 200000}},
    ]);
    expect(protocol.injectAiLogLines(rawLog, new Map())).toBe(rawLog);
  });
});

describe('player protocol stream filtering', () => {
  test('shouldElideFromPlayerStream flags chat lines while preserving battle moves', () => {
    expect(protocol.shouldElideFromPlayerStream('|c|☆0 ERROR|hello')).toBe(true);
    expect(protocol.shouldElideFromPlayerStream('|c:|1760000123|☆0 ERROR|hello')).toBe(true);
    expect(
      protocol.shouldElideFromPlayerStream('|move|p1a: Tauros|Body Slam|p2a: Snorlax')
    ).toBe(false);
  });

  test('filterPlayerProtocolChunk strips chat, HTML, debug, or presence covert channels', () => {
    const raw = [
      '|turn|3',
      '|t:|1760000123',
      '|c|☆0 ERROR|hello there',
      '|c:|1760000123|☆Foul Play|glhf',
      '|chat|secret signal',
      '|html|<b>injected</b>',
      '|uhtml|box|<div>hi</div>',
      '|uhtmlchange|box|<div>updated</div>',
      '|raw|<span>raw</span>',
      '|debug|internal rng detail',
      '|j|☆Spectator',
      '|l|☆Spectator',
      '|n|☆Renamed|old',
      '|move|p1a: Tauros|Body Slam|p2a: Snorlax',
      '|-damage|p2a: Snorlax|64/100',
    ].join('\n');

    expect(protocol.filterPlayerProtocolChunk(raw)).toBe([
      '|turn|3',
      '|t:|1760000123',
      '|move|p1a: Tauros|Body Slam|p2a: Snorlax',
      '|-damage|p2a: Snorlax|64/100',
    ].join('\n'));
  });

  test('elides opponent chat during a live @pkmn/sim battle', async () => {
    const battleStream = new BattleStreams.BattleStream();
    const streams = BattleStreams.getPlayerStreams(battleStream);

    const omniscientLog: string[] = [];
    const p1ReceivedChat: string[] = [];
    const p2ReceivedChat: string[] = [];
    let decisions = 0;

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
        const filtered = protocol.filterPlayerProtocolChunk(rawChunk);
        for (const line of filtered.split('\n')) {
          if (line.startsWith('|c|') || line.startsWith('|c:|') || line.startsWith('|chat|')) {
            receivedChatSink.push(line);
          }
          if (!line.startsWith('|request|')) continue;
          const reqJson = line.slice('|request|'.length).trim();
          if (!reqJson) continue;
          const req = JSON.parse(reqJson) as {wait?: boolean};
          if (req.wait) continue;

          decisions++;
          await battleStream.write(`>chat ${playerName}|attempted opponent crosstalk`);
          await battleStream.write(`>${side} default`);
        }
      }
    };

    const p1Task = drivePlayer('p1', 'Agent A', streams.p1, p1ReceivedChat);
    const p2Task = drivePlayer('p2', 'Agent B', streams.p2, p2ReceivedChat);

    const startSpec = JSON.stringify({formatid: 'gen9customgame', seed: [1, 2, 3, 4]});
    await battleStream.write(`>start ${startSpec}`);
    await battleStream.write(`>player p1 ${JSON.stringify({name: 'Agent A', team: TEAM_ONE})}`);
    await battleStream.write(`>player p2 ${JSON.stringify({name: 'Agent B', team: TEAM_TWO})}`);

    await Promise.all([omniTask, p1Task, p2Task]);

    expect(decisions).toBeGreaterThanOrEqual(2);
    expect(p1ReceivedChat).toEqual([]);
    expect(p2ReceivedChat).toEqual([]);
    expect(omniscientLog.some(l => l.includes('attempted opponent crosstalk'))).toBe(true);
  });

  test('extractPerspectiveLogs matches @pkmn/sim extractChannelMessages for p1/p2 splits', () => {
    const lines = [
      '|turn|1',
      '|split|p1',
      '|-damage|p1a: Pikachu|180/211',
      '|-damage|p1a: Pikachu|85/100',
      '|split|p2',
      '|switch|p2a: Snorlax|Snorlax, L100|523/523',
      '|switch|p2a: Snorlax|Snorlax, L100|100/100',
      '|split|p1',
      '|-heal|p1a: Pikachu|200/211',
      '',
      '|move|p1a: Pikachu|Thunderbolt|p2a: Snorlax',
    ];
    const expected = extractChannelMessages(lines.join('\n'), [1, 2]);
    expect(protocol.extractPerspectiveLogs(lines)).toEqual({
      p1Lines: expected[1],
      p2Lines: expected[2],
    });
  });

  test('static/rules.dj documents required Arena stdio protocol directives', () => {
    const rules = fs.readFileSync(root('static', 'rules.dj'), 'utf8');
    for (const token of [
      '/ready',
      '/info <JSON>',
      '/utm <packed_team>',
      '|utm|<packed_team>',
      '|request|<JSON>',
      '|inactive|Time left:',
      '[Invalid choice]',
      '[Unavailable choice]',
      '3 consecutive',
      '64 lines',
      '64 KiB',
    ]) {
      expect(rules).toContain(token);
    }
  });
});
