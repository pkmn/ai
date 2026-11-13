import {DatabaseSync} from 'node:sqlite';

import * as ratings from '../server/ratings';

export interface TournamentEntrantRow {
  tournamentId: string;
  agentId: number;
  versionId: number;
  seed: number;
  points: number;
  sonnebornBerger: number;
  gameWins: number;
  gameLosses: number;
  gameTies: number;
  elo: number;
  se: number;
  finalRank?: number;
}

export interface TournamentEntrantView extends TournamentEntrantRow {
  agentSlug: string;
  agentName: string;
  version: string;
}

export interface UpsertTournamentEntrantInput {
  tournamentId: string;
  agentId: number;
  versionId: number;
  seed: number;
  points?: number;
  sonnebornBerger?: number;
  gameWins?: number;
  gameLosses?: number;
  gameTies?: number;
  elo?: number;
  se?: number;
  finalRank?: number;
}

export function upsertTournamentEntrant(db: DatabaseSync, input: UpsertTournamentEntrantInput) {
  db.prepare(`
    INSERT INTO tournament_entrants (
      tournament_id, agent_id, version_id, seed, points, sonneborn_berger,
      game_wins, game_losses, game_ties, elo, se, final_rank
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tournament_id, version_id) DO UPDATE SET
      seed = excluded.seed,
      points = excluded.points,
      sonneborn_berger = excluded.sonneborn_berger,
      game_wins = excluded.game_wins,
      game_losses = excluded.game_losses,
      game_ties = excluded.game_ties,
      elo = excluded.elo,
      se = excluded.se,
      final_rank = excluded.final_rank
  `).run(
    input.tournamentId,
    input.agentId,
    input.versionId,
    input.seed,
    input.points ?? 0,
    input.sonnebornBerger ?? 0,
    input.gameWins ?? 0,
    input.gameLosses ?? 0,
    input.gameTies ?? 0,
    input.elo ?? 1500,
    input.se ?? 350,
    input.finalRank ?? null
  );
}

// Orders entrants by official final rank (once completed), then tournament points,
// Sonneborn-Berger opponent-weighted score, event Elo, and initial seed.
export function getTournamentEntrants(
  db: DatabaseSync,
  tournamentId: string
): TournamentEntrantView[] {
  const rows = db.prepare(`
    SELECT
      te.*,
      a.slug AS agent_slug,
      a.name AS agent_name,
      av.version
    FROM tournament_entrants te
    JOIN agents a ON a.id = te.agent_id
    JOIN agent_versions av ON av.id = te.version_id
    WHERE te.tournament_id = ?
    ORDER BY
      CASE WHEN te.final_rank IS NOT NULL THEN 0 ELSE 1 END ASC,
      te.final_rank ASC,
      te.points DESC,
      te.sonneborn_berger DESC,
      te.elo DESC,
      te.seed ASC
  `).all(tournamentId) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    tournamentId: r.tournament_id as string,
    agentId: r.agent_id as number,
    versionId: r.version_id as number,
    seed: r.seed as number,
    points: r.points as number,
    sonnebornBerger: r.sonneborn_berger as number,
    gameWins: r.game_wins as number,
    gameLosses: r.game_losses as number,
    gameTies: r.game_ties as number,
    elo: r.elo as number,
    se: r.se as number,
    finalRank: (r.final_rank as number | null) ?? undefined,
    agentSlug: r.agent_slug as string,
    agentName: r.agent_name as string,
    version: r.version as string,
  }));
}

// Recomputes Round-Robin points, Sonneborn-Berger opponent-weighted tiebreakers, event-scoped
// Davidson MAP Elo ± SE, and optional final 1..M placements (including any 100-game #1 vs #2
// Superfinal swap) over all completed games for `tournamentId`.
export function recomputeTournamentStandings(
  db: DatabaseSync,
  tournamentId: string,
  assignFinalRanks = false
) {
  const entrants = getTournamentEntrants(db, tournamentId)
    .slice()
    .sort((a, b) => a.seed - b.seed || a.versionId - b.versionId);
  if (!entrants.length) return;

  const gameRows = db.prepare(`
    SELECT stage, p1_version_id, p2_version_id, outcome
    FROM tournament_games
    WHERE tournament_id = ?
      AND status = 'completed'
      AND outcome IS NOT NULL
    ORDER BY id ASC
  `).all(tournamentId) as Array<{
    stage: 'Round Robin' | 'Superfinal';
    p1_version_id: number;
    p2_version_id: number;
    outcome: ratings.GameOutcome;
  }>;

  const M = entrants.length;
  const idxByVer = new Map<number, number>();
  entrants.forEach((e, idx) => idxByVer.set(e.versionId, idx));

  const wins = new Int32Array(M);
  const losses = new Int32Array(M);
  const ties = new Int32Array(M);
  const pairScore = new Float64Array(M * M);
  const sfScore = new Float64Array(M);
  const rrGames: ratings.TournamentGameInput[] = [];
  const allGames: ratings.TournamentGameInput[] = [];

  for (const g of gameRows) {
    const i = idxByVer.get(g.p1_version_id);
    const j = idxByVer.get(g.p2_version_id);
    if (i === undefined || j === undefined) continue;
    allGames.push({i, j, outcome: g.outcome});

    if (g.stage === 'Superfinal') {
      if (g.outcome === 'W') {
        sfScore[i] += 1;
      } else if (g.outcome === 'L') {
        sfScore[j] += 1;
      } else {
        sfScore[i] += 0.5;
        sfScore[j] += 0.5;
      }
      continue;
    }

    rrGames.push({i, j, outcome: g.outcome});
    if (g.outcome === 'W') {
      wins[i]++;
      losses[j]++;
      pairScore[i * M + j] += 1;
    } else if (g.outcome === 'L') {
      losses[i]++;
      wins[j]++;
      pairScore[j * M + i] += 1;
    } else {
      ties[i]++;
      ties[j]++;
      pairScore[i * M + j] += 0.5;
      pairScore[j * M + i] += 0.5;
    }
  }

  const points = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    points[i] = wins[i] + 0.5 * ties[i];
  }
  const sb = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    let total = 0;
    for (let j = 0; j < M; j++) {
      if (i !== j) total += pairScore[i * M + j] * points[j];
    }
    sb[i] = Math.round(total * 100) / 100;
  }

  // Compute Stage 1 tiebreak Elo strictly from Round-Robin games so a #2 finisher losing the
  // 100-game Superfinal against #1 can never drop below a tied #3 in Stage 1 ordering.
  const rrRatingRes = ratings.computeTournamentRatings(M, rrGames, -1, 1500);
  const allRatingRes = allGames.length === rrGames.length
    ? rrRatingRes
    : ratings.computeTournamentRatings(M, allGames, -1, 1500);
  const order = entrants.map((_, idx) => idx).sort((a, b) => (
    points[b] - points[a] ||
    sb[b] - sb[a] ||
    rrRatingRes.elo[b] - rrRatingRes.elo[a] ||
    entrants[a].seed - entrants[b].seed
  ));

  if (order.length >= 2 && (sfScore[order[0]] > 0 || sfScore[order[1]] > 0)) {
    if (sfScore[order[1]] > sfScore[order[0]]) {
      const tmp = order[0];
      order[0] = order[1];
      order[1] = tmp;
    }
  }

  const rankByIdx = new Int32Array(M);
  order.forEach((entIdx, rankZero) => {
    rankByIdx[entIdx] = rankZero + 1;
  });

  for (let i = 0; i < M; i++) {
    const ent = entrants[i];
    upsertTournamentEntrant(db, {
      tournamentId,
      agentId: ent.agentId,
      versionId: ent.versionId,
      seed: ent.seed,
      finalRank: assignFinalRanks ? rankByIdx[i] : ent.finalRank,
      elo: allGames.length > 0 ? Math.round(allRatingRes.elo[i]) : ent.elo,
      se: allGames.length > 0 ? Math.round(allRatingRes.eloStd[i]) : ent.se,
      gameWins: wins[i],
      gameLosses: losses[i],
      gameTies: ties[i],
      points: points[i],
      sonnebornBerger: sb[i],
    });
  }
}
