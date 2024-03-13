import {Generations} from '@pkmn/data';
import {Battle, Dex, ID, PokemonSet} from '@pkmn/sim';

import {Choice, Player} from './player';

const TEAM = [
  {species: 'Starmie', moves: ['Blizzard', 'Psychic', 'Recover', 'Thunder Wave']},
  {species: 'Alakazam', moves: ['Psychic', 'Recover', 'Seismic Toss', 'Thunder Wave']},
  {species: 'Chansey', moves: ['Ice Beam', 'Soft-Boiled', 'Thunderbolt', 'Thunder Wave']},
  {species: 'Exeggutor', moves: ['Double-Edge', 'Explosion', 'Psychic', 'Sleep Powder']},
  {species: 'Snorlax', moves: ['Body Slam', 'Hyper Beam', 'Reflect', 'Rest']},
  {species: 'Tauros', moves: ['Blizzard', 'Body Slam', 'Earthquake', 'Hyper Beam']},
] as unknown as PokemonSet[];
const ZOROAK = {
  species: 'Zoroark',
  ability: 'Illusion',
  moves: ['Dark Pulse', 'Flamethrower', 'Focus Blast', 'Trick'],
} as unknown as PokemonSet;

class TestPlayer extends Player {
  choices: Choice[] = [];

  choose<C extends Choice>(choices: C[]): C {
    this.choices = choices;
    return choices[0];
  }
}

const gens = new Generations(Dex as any);

const battle = (gen: number, gameType: 'singles' | 'doubles' = 'singles') =>
  new Battle({
    formatid: (gameType === 'doubles'
      ? `gen${gen}doublescustomgame@@@Flat Rules`
      : `gen${gen}customgame`) as ID,
    seed: [1, 2, 3, 4],
    strictChoices: false,
  });

describe('Player', () => {
  describe('singles', () => {
    describe('choices', () => {
      test.todo('wait');
      describe('team', () => {
        // Partial Team
        test('partial', () => {
          const b = battle(5);
          b.setPlayer('p1', {team: TEAM.slice(0, 5)});
          b.setPlayer('p2', {team: TEAM});
          const p = new TestPlayer(gens);
          // FIXME
          p.accept(b.log.join('\n'));
          p.accept(`|request|${JSON.stringify(b.p1.activeRequest)}`);
          expectTeamChoices(p.choices, 120);
        });
        test('non-Illusion', () => {
          const b = battle(5);
          b.setPlayer('p1', {team: TEAM});
          b.setPlayer('p2', {team: TEAM});
          const p = new TestPlayer(gens);
          // FIXME
          p.accept(b.log.join('\n'));
          p.accept(`|request|${JSON.stringify(b.p1.activeRequest)}`);
          expectTeamChoices(p.choices, 6);
        });
        test('Illusion', () => {
          const b = battle(5);
          const team = TEAM.slice();
          team[5] = ZOROAK;
          b.setPlayer('p1', {team});
          b.setPlayer('p2', {team});
          const p = new TestPlayer(gens);
          // FIXME
          p.accept(b.log.join('\n'));
          p.accept(`|request|${JSON.stringify(b.p1.activeRequest)}`);
          expectTeamChoices(p.choices, 720);
        });
      });

      // Revival Blessing
      // - something to revive
      // - no one to revive!
      // fainted
      test.todo('switch');

      // mega
      // ultra burst
      // dynamax
      // - already dynamaxed
      // terastallize
      test.todo('move');
    });
  });

  describe('doubles', () => {
    describe('choices', () => {
      test.todo('wait');
      describe('team', () => {
        // Partial Team
        test('partial', () => {
          const b = battle(5, 'doubles');
          b.setPlayer('p1', {team: TEAM.slice(0, 3)});
          b.setPlayer('p2', {team: TEAM});
          const p = new TestPlayer(gens);
          // FIXME
          p.accept(b.log.join('\n'));
          p.accept(`|request|${JSON.stringify(b.p1.activeRequest)}`);
          expectTeamChoices(p.choices, 6);
        });
        test('non-Illusion', () => {
          const b = battle(5, 'doubles');
          b.setPlayer('p1', {team: TEAM});
          b.setPlayer('p2', {team: TEAM});
          const p = new TestPlayer(gens);
          // FIXME
          p.accept(b.log.join('\n'));
          p.accept(`|request|${JSON.stringify(b.p1.activeRequest)}`);
          expectTeamChoices(p.choices, 360);
        });
        test('Illusion', () => {
          const b = battle(5, 'doubles');
          const team = TEAM.slice();
          team[5] = ZOROAK;
          b.setPlayer('p1', {team});
          b.setPlayer('p2', {team});
          const p = new TestPlayer(gens);
          // FIXME
          p.accept(b.log.join('\n'));
          p.accept(`|request|${JSON.stringify(b.p1.activeRequest)}`);
          expectTeamChoices(p.choices, 720);
        });
      });

      // Revival Blessing
      // - something to revive
      // - no one to revive!
      // fainted
      test.todo('switch');

      // mega
      // ultra burst
      // dynamax
      // - already dynamaxed
      // terastallize
      test.todo('move');
    });
  });
});

function expectTeamChoices(choices: Choice[], n: number) {
  expect(choices).toHaveLength(n);
  expect(new Set(choices.map(c => c.type === 'team' && c.slots.join())).size).toBe(n);
}
