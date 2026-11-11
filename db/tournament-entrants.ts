import type {DatabaseSync} from 'node:sqlite';

export interface TournamentEntrantRow {
  tournament_id: string;
  bot_id: number;
  version_id: number;
  seed_number: number;
  points: number;
  sb_score: number;
  game_wins: number;
  game_losses: number;
  game_ties: number;
  tourney_elo: number;
  tourney_se: number;
  final_rank: number | null;
}

export interface TournamentEntrantView extends TournamentEntrantRow {
  bot_slug: string;
  bot_name: string;
  version_str: string;
}

export interface UpsertTournamentEntrantInput {
  tournament_id: string;
  bot_id: number;
  version_id: number;
  seed_number: number;
  points?: number;
  sb_score?: number;
  game_wins?: number;
  game_losses?: number;
  game_ties?: number;
  tourney_elo?: number;
  tourney_se?: number;
  final_rank?: number | null;
}

export function upsertTournamentEntrant(db: DatabaseSync, input: UpsertTournamentEntrantInput) {
  db.prepare(`
    INSERT INTO tournament_entrants (
      tournament_id, bot_id, version_id, seed_number, points, sb_score,
      game_wins, game_losses, game_ties, tourney_elo, tourney_se, final_rank
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tournament_id, version_id) DO UPDATE SET
      seed_number = excluded.seed_number,
      points = excluded.points,
      sb_score = excluded.sb_score,
      game_wins = excluded.game_wins,
      game_losses = excluded.game_losses,
      game_ties = excluded.game_ties,
      tourney_elo = excluded.tourney_elo,
      tourney_se = excluded.tourney_se,
      final_rank = excluded.final_rank
  `).run(
    input.tournament_id,
    input.bot_id,
    input.version_id,
    input.seed_number,
    input.points ?? 0,
    input.sb_score ?? 0,
    input.game_wins ?? 0,
    input.game_losses ?? 0,
    input.game_ties ?? 0,
    input.tourney_elo ?? 1500,
    input.tourney_se ?? 350,
    input.final_rank ?? null
  );
}

export function getTournamentEntrants(
  db: DatabaseSync,
  tournamentId: string
): TournamentEntrantView[] {
  return db.prepare(`
    SELECT
      te.*,
      b.slug AS bot_slug,
      b.name AS bot_name,
      bv.version_str
    FROM tournament_entrants te
    JOIN bots b ON b.id = te.bot_id
    JOIN bot_versions bv ON bv.id = te.version_id
    WHERE te.tournament_id = ?
    ORDER BY
      CASE WHEN te.final_rank IS NOT NULL THEN 0 ELSE 1 END ASC,
      te.final_rank ASC,
      te.points DESC,
      te.sb_score DESC,
      te.tourney_elo DESC,
      te.seed_number ASC
  `).all(tournamentId) as unknown as TournamentEntrantView[];
}
