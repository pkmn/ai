import {BattleStreams} from '@pkmn/sim';
import {describe, expect, test} from 'vitest';

import {
  filterPlayerProtocolChunk,
  parseAgentStdoutLine,
  shouldElideFromPlayerStream,
} from '../server/protocol';

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

describe('server/protocol.ts — stdout parsing & opponent chat elision', () => {
  test('parseAgentStdoutLine classifies plain text chat vs Showdown choice commands', () => {
    expect(parseAgentStdoutLine('')).toBeUndefined();
    expect(parseAgentStdoutLine('   \r')).toBeUndefined();
    expect(parseAgentStdoutLine('hello opponent')).toEqual({
      kind: 'chat',
      message: 'hello opponent',
    });
    expect(parseAgentStdoutLine('/say secret')).toEqual({
      kind: 'chat',
      message: '/say secret',
    });
    expect(parseAgentStdoutLine('|battle-gen9ou-42|/choose move 1')).toEqual({
      kind: 'choice',
      choice: 'move 1',
    });
    expect(parseAgentStdoutLine('/choose move 1 terastallize')).toEqual({
      kind: 'choice',
      choice: 'move 1 terastallize',
    });
    expect(parseAgentStdoutLine('/team 1234')).toEqual({
      kind: 'choice',
      choice: 'team 1234',
    });
    expect(parseAgentStdoutLine('team 1, 2, 3, 4')).toEqual({
      kind: 'choice',
      choice: 'team 1, 2, 3, 4',
    });
    expect(parseAgentStdoutLine('team 1, 2, 3, 4, 5, 6')).toEqual({
      kind: 'choice',
      choice: 'team 1, 2, 3, 4, 5, 6',
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
    // Choice cancelling (`undo`, `/undo`, `/choose undo`) is forbidden so agents cannot
    // clear their side's choice in @pkmn/sim without triggering a new |request|.
    expect(parseAgentStdoutLine('undo')).toEqual({
      kind: 'chat',
      message: 'undo',
    });
    expect(parseAgentStdoutLine('/undo')).toEqual({
      kind: 'chat',
      message: '/undo',
    });
    expect(parseAgentStdoutLine('/choose undo')).toEqual({
      kind: 'chat',
      message: '/choose undo',
    });
    expect(parseAgentStdoutLine('move 1, undo')).toEqual({
      kind: 'chat',
      message: 'move 1, undo',
    });
    expect(parseAgentStdoutLine('/move 1, undo')).toEqual({
      kind: 'chat',
      message: '/move 1, undo',
    });
    expect(parseAgentStdoutLine('/switch 2, undo')).toEqual({
      kind: 'chat',
      message: '/switch 2, undo',
    });
    expect(parseAgentStdoutLine('/team 1, undo')).toEqual({
      kind: 'chat',
      message: '/team 1, undo',
    });
    // Explicit forfeits, tie offers, and timer manipulation are forbidden in the Arena.
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
      expect(parseAgentStdoutLine(forbidden)).toEqual({
        kind: 'chat',
        message: forbidden,
      });
    }
    // Embedded carriage returns or pipe characters inside choices are demoted to chat so
    // an agent can never inject multi-line Showdown protocol commands into BattleStream.
    expect(parseAgentStdoutLine('hello\r|win|Agent A')).toEqual({
      kind: 'chat',
      message: 'hello|win|Agent A',
    });
    expect(parseAgentStdoutLine('move 1\r|win|Agent A')).toEqual({
      kind: 'chat',
      message: 'move 1|win|Agent A',
    });
    expect(parseAgentStdoutLine('move 1|win|Agent A')).toEqual({
      kind: 'chat',
      message: 'move 1|win|Agent A',
    });
  });

  test(
    'filterPlayerProtocolChunk strips chat, HTML, debug, and join/rename covert channels',
    () => {
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
    }
  );

  test(
    'runs a @pkmn/sim battle with chat elision preventing competitor crosstalk',
    async () => {
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
          const filtered = filterPlayerProtocolChunk(rawChunk);
          for (const line of filtered.split('\n')) {
            if (line.startsWith('|c|') || line.startsWith('|c:|') || line.startsWith('|chat|')) {
              receivedChatSink.push(line);
            }
            if (!line.startsWith('|request|')) continue;
            const reqJson = line.slice('|request|'.length).trim();
            if (!reqJson) continue;
            const req = JSON.parse(reqJson) as {
              wait?: boolean;
              teamPreview?: boolean;
              forceSwitch?: boolean[];
              active?: unknown[];
            };
            if (req.wait) continue;

            decisions++;
            // Inject an unprompted chat write into BattleStream to verify filter strips it!
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
    }
  );
});
