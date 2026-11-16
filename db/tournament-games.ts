import {DatabaseSync} from 'node:sqlite';

import * as ratings from '../server/ratings';

export interface TournamentGamePlayerStats {
  bankSeconds?: number;
  meanTurnMillis?: number;
  peakRam?: number;
}

export interface TournamentGameRow {
  matchId: string;
  gameNumber: number;
  seed: string;
  outcome?: ratings.GameOutcome;
  turns?: number;
  endReason?: string;
  p1: TournamentGamePlayerStats;
  p2: TournamentGamePlayerStats;
}

export interface TournamentGameInput {
  gameNumber?: number;
  seed: string;
  outcome?: ratings.GameOutcome;
  turns?: number;
  endReason?: string;
  p1?: TournamentGamePlayerStats;
  p2?: TournamentGamePlayerStats;
}

function mapTournamentGameRow(r: Record<string, unknown>): TournamentGameRow {
  return {
    matchId: r.match_id as string,
    gameNumber: r.game_number as number,
    seed: r.seed as string,
    outcome: (r.outcome as ratings.GameOutcome | null) ?? undefined,
    turns: (r.turns as number | null) ?? undefined,
    endReason: (r.end_reason as string | null) ?? undefined,
    p1: {
      bankSeconds: (r.p1_bank_seconds as number | null) ?? undefined,
      meanTurnMillis: (r.p1_mean_turn_millis as number | null) ?? undefined,
      peakRam: (r.p1_peak_ram as number | null) ?? undefined,
    },
    p2: {
      bankSeconds: (r.p2_bank_seconds as number | null) ?? undefined,
      meanTurnMillis: (r.p2_mean_turn_millis as number | null) ?? undefined,
      peakRam: (r.p2_peak_ram as number | null) ?? undefined,
    },
  };
}

export function replaceTournamentMatchGames(
  db: DatabaseSync,
  matchId: string,
  games: readonly TournamentGameInput[]
) {
  db.prepare('DELETE FROM tournament_games WHERE match_id = ?').run(matchId);
  if (games.length === 0) return;

  const insert = db.prepare(`
    INSERT INTO tournament_games (
      match_id, game_number, seed, outcome, turns, end_reason,
      p1_bank_seconds, p2_bank_seconds, p1_mean_turn_millis, p2_mean_turn_millis,
      p1_peak_ram, p2_peak_ram
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    const gameNumber = g.gameNumber ?? i + 1;
    insert.run(
      matchId,
      gameNumber,
      g.seed,
      g.outcome ?? null,
      g.turns ?? null,
      g.endReason ?? null,
      g.p1?.bankSeconds ?? null,
      g.p2?.bankSeconds ?? null,
      g.p1?.meanTurnMillis ?? null,
      g.p2?.meanTurnMillis ?? null,
      g.p1?.peakRam ?? null,
      g.p2?.peakRam ?? null
    );
  }
}

export function getTournamentMatchGames(
  db: DatabaseSync,
  matchId: string
): TournamentGameRow[] {
  const rows = db
    .prepare(
      `
      SELECT *
      FROM tournament_games
      WHERE match_id = ?
      ORDER BY game_number ASC
      `
    )
    .all(matchId) as Array<Record<string, unknown>>;
  return rows.map(mapTournamentGameRow);
}

export function getTournamentMatchGamesByTournament(
  db: DatabaseSync,
  tournamentId: string
): Map<string, TournamentGameRow[]> {
  const rows = db
    .prepare(
      `
      SELECT g.*
      FROM tournament_games g
      JOIN tournament_matches m ON m.id = g.match_id
      WHERE m.tournament_id = ?
      ORDER BY g.match_id ASC, g.game_number ASC
      `
    )
    .all(tournamentId) as Array<Record<string, unknown>>;

  const byMatch = new Map<string, TournamentGameRow[]>();
  for (const row of rows) {
    const mapped = mapTournamentGameRow(row);
    const list = byMatch.get(mapped.matchId);
    if (list) {
      list.push(mapped);
    } else {
      byMatch.set(mapped.matchId, [mapped]);
    }
  }
  return byMatch;
}
