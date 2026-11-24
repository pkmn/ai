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
  submittedAt: number;
}

export interface AgentTournamentEntryView {
  tournamentId: string;
  tournamentName: string;
  tournamentStatus: 'scheduled' | 'running' | 'completed';
  startsAt: number;
  version: string;
  seed: number;
  points: number;
  gameWins: number;
  gameLosses: number;
  gameTies: number;
  elo: number;
  se: number;
  finalRank?: number;
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
      av.version,
      av.submitted_at
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
    submittedAt: r.submitted_at as number,
  }));
}

export function getTournamentEntrantsByAgent(
  db: DatabaseSync
): Map<number, AgentTournamentEntryView[]> {
  const rows = db.prepare(`
    SELECT
      te.agent_id,
      te.tournament_id,
      t.name AS tournament_name,
      t.status AS tournament_status,
      t.starts_at,
      av.version,
      te.seed,
      te.points,
      te.game_wins,
      te.game_losses,
      te.game_ties,
      te.elo,
      te.se,
      te.final_rank
    FROM tournament_entrants te
    JOIN tournaments t ON t.id = te.tournament_id
    JOIN agent_versions av ON av.id = te.version_id
    ORDER BY t.starts_at DESC, te.tournament_id DESC
  `).all() as Array<{
    agent_id: number;
    tournament_id: string;
    tournament_name: string;
    tournament_status: 'scheduled' | 'running' | 'completed';
    starts_at: number;
    version: string;
    seed: number;
    points: number;
    game_wins: number;
    game_losses: number;
    game_ties: number;
    elo: number;
    se: number;
    final_rank: number | null;
  }>;

  const out = new Map<number, AgentTournamentEntryView[]>();
  for (const r of rows) {
    let list = out.get(r.agent_id);
    if (!list) {
      list = [];
      out.set(r.agent_id, list);
    }
    list.push({
      tournamentId: r.tournament_id,
      tournamentName: r.tournament_name,
      tournamentStatus: r.tournament_status,
      startsAt: r.starts_at,
      version: r.version,
      seed: r.seed,
      points: r.points,
      gameWins: r.game_wins,
      gameLosses: r.game_losses,
      gameTies: r.game_ties,
      elo: r.elo,
      se: r.se,
      finalRank: r.final_rank ?? undefined,
    });
  }
  return out;
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
    SELECT id, stage, matchup_game, p1_version_id, p2_version_id, outcome
    FROM tournament_matches
    WHERE tournament_id = ?
      AND status = 'completed'
      AND outcome IS NOT NULL
    ORDER BY matchup_game ASC, id ASC
  `).all(tournamentId) as Array<{
    id: string;
    stage: 'Round Robin' | 'Superfinal';
    matchup_game: number;
    p1_version_id: number;
    p2_version_id: number;
    outcome: ratings.GameOutcome;
  }>;

  const subGameRows = db.prepare(`
    SELECT tg.match_id, tg.outcome
    FROM tournament_games tg
    JOIN tournament_matches tm ON tm.id = tg.match_id
    WHERE tm.tournament_id = ?
      AND tm.status = 'completed'
    ORDER BY tg.match_id ASC, tg.game_number ASC
  `).all(tournamentId) as Array<{
    match_id: string;
    outcome: ratings.GameOutcome;
  }>;
  const subOutcomesByMatch = new Map<string, ratings.GameOutcome[]>();
  for (const sg of subGameRows) {
    let list = subOutcomesByMatch.get(sg.match_id);
    if (!list) {
      list = [];
      subOutcomesByMatch.set(sg.match_id, list);
    }
    list.push(sg.outcome);
  }

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
    const subOutcomes = subOutcomesByMatch.get(g.id);
    const ratingOutcomes = subOutcomes && subOutcomes.length > 0 ? subOutcomes : [g.outcome];
    for (const out of ratingOutcomes) {
      allGames.push({i, j, outcome: out});
    }

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

    for (const out of ratingOutcomes) {
      rrGames.push({i, j, outcome: out});
    }
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
  const rrRatingRes = ratings.computeTournamentRatings(M, rrGames);
  const allRatingRes = allGames.length === rrGames.length
    ? rrRatingRes
    : ratings.computeTournamentRatings(M, allGames);
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

  // While `final_rank` is still `NULL` (`assignFinalRanks === false`), persist `rrRatingRes` so
  // `getTournamentEntrants` (`ORDER BY points DESC, sonneborn_berger DESC, elo DESC`) preserves
  // exact Stage-1 tiebreak ordering throughout a live Superfinal; once finalized, persist
  // `final_rank` alongside full-event `allRatingRes`.
  const displayRatings = assignFinalRanks ? allRatingRes : rrRatingRes;
  const hasRatedGames = assignFinalRanks ? allGames.length > 0 : rrGames.length > 0;

  for (let i = 0; i < M; i++) {
    const ent = entrants[i];
    upsertTournamentEntrant(db, {
      tournamentId,
      agentId: ent.agentId,
      versionId: ent.versionId,
      seed: ent.seed,
      finalRank: assignFinalRanks ? rankByIdx[i] : ent.finalRank,
      elo: hasRatedGames ? Math.round(displayRatings.elo[i]) : ent.elo,
      se: hasRatedGames ? Math.round(displayRatings.eloStd[i]) : ent.se,
      gameWins: wins[i],
      gameLosses: losses[i],
      gameTies: ties[i],
      points: points[i],
      sonnebornBerger: sb[i],
    });
  }
}
