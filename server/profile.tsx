import * as fs from 'fs';
import * as path from 'path';

import {AVATARS_DIR} from '../db';
import type * as db from '../db';
import {Renderer, header, injectLiveBanner} from '../static/build';
import * as util from '../static/util';

import * as arena from './arena';
import * as ratings from './ratings';
import * as render from './render';

const PROFILE_STYLE = fs.readFileSync(util.root('static', 'style', 'profile.css'), 'utf8');

interface VersionDynamicStats {
  rank: string;
  elo: string;
  gxe: string;
  peak: string;
  record: string;
  streak: string;
  telemetry: string;
}

interface LadderProfileClientData {
  ladderId: string;
  multiVersion: boolean;
  optionsHtml: string;
  oppOptionsHtml: string;
  oppCounts: Record<string, Record<string, number>>;
  vstats: Record<string, VersionDynamicStats>;
  reign: Record<string, string>;
}

function formatIsoDateTimeUtc(sec: number): string {
  return `${new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

function formatDurationCell(seconds: number, boldDays = false): util.Html {
  if (seconds <= 0) {
    return <span className='muted'>—</span>;
  }
  const days = `${(seconds / 86400).toFixed(1)}d`;
  const hours = `${Math.round(seconds / 3600).toLocaleString('en-US')}h`;
  return (
    <>
      {boldDays ? <strong>{days}</strong> : days} <span className='muted'>({hours})</span>
    </>
  );
}

// Computes live, longest, and cumulative Top 1 / Top 10 / Top 100 reign durations.
// If the entrant currently occupies a tier (`top*_entered_at` is set), the ongoing reign since the
// last match (`nowSec - enteredAt`) is compared against `maxStreakSeconds`; `totalSeconds` already
// accumulates elapsed intervals on every `recomputeLadderRatings` pass.
function buildReignRowsHtml(
  stats: {
    top1EnteredAt?: number;
    top1MaxStreakSeconds: number;
    top1TotalSeconds: number;
    top10EnteredAt?: number;
    top10MaxStreakSeconds: number;
    top10TotalSeconds: number;
    top100EnteredAt?: number;
    top100MaxStreakSeconds: number;
    top100TotalSeconds: number;
  },
  nowSec: number
): string {
  const cur1 = stats.top1EnteredAt !== undefined
    ? Math.max(0, nowSec - stats.top1EnteredAt)
    : 0;
  const max1 = Math.max(stats.top1MaxStreakSeconds, cur1);
  const tot1 = stats.top1TotalSeconds;
  const has1 = cur1 > 0 || max1 > 0 || tot1 > 0;

  const cur10 = stats.top10EnteredAt !== undefined
    ? Math.max(0, nowSec - stats.top10EnteredAt)
    : 0;
  const max10 = Math.max(stats.top10MaxStreakSeconds, cur10);
  const tot10 = stats.top10TotalSeconds;
  const has10 = cur10 > 0 || max10 > 0 || tot10 > 0;

  const cur100 = stats.top100EnteredAt !== undefined
    ? Math.max(0, nowSec - stats.top100EnteredAt)
    : 0;
  const max100 = Math.max(stats.top100MaxStreakSeconds, cur100);
  const tot100 = stats.top100TotalSeconds;
  const has100 = cur100 > 0 || max100 > 0 || tot100 > 0;

  if (!has1 && !has10 && !has100) return '';

  const t1Tip = 'Guaranteed #1 (rank = 1 & settled)';
  const t10Tip = 'Guaranteed Top 10 at 95% confidence';
  const t100Tip = 'Guaranteed Top 100 at 95% confidence';

  return String(
    <>
      {has1 && (
        <tr>
          <td title={t1Tip}><strong>Top 1</strong></td>
          <td className='num'>{formatDurationCell(cur1, cur1 > 0)}</td>
          <td className='num'>{formatDurationCell(max1)}</td>
          <td className='num'>{formatDurationCell(tot1)}</td>
        </tr>
      )}
      {has10 && (
        <tr>
          <td title={t10Tip}><strong>Top 10</strong></td>
          <td className='num'>{formatDurationCell(cur10, cur10 > 0)}</td>
          <td className='num'>{formatDurationCell(max10)}</td>
          <td className='num'>{formatDurationCell(tot10)}</td>
        </tr>
      )}
      {has100 && (
        <tr>
          <td title={t100Tip}><strong>Top 100</strong></td>
          <td className='num'>{formatDurationCell(cur100, cur100 > 0)}</td>
          <td className='num'>{formatDurationCell(max100)}</td>
          <td className='num'>{formatDurationCell(tot100)}</td>
        </tr>
      )}
    </>
  );
}

function formatCurStreakNode(winStreak: number, lossStreak: number, played: number): util.Child {
  if (winStreak >= 3) return <span className='yes'>W{winStreak}</span>;
  if (winStreak >= 1) return `W${winStreak}`;
  if (lossStreak >= 3) return <span className='no'>L{lossStreak}</span>;
  if (lossStreak >= 1) return `L${lossStreak}`;
  if (played > 0) return 'T1';
  return <span className='muted'>—</span>;
}

function buildVersionDynamicStats(
  entry: db.AgentLadderProfileEntry,
  adjacentLos: ReadonlyMap<number, number>
): VersionDynamicStats {
  const isProvisional =
    entry.role !== 'retired' && (entry.matches < 10 || entry.se > 60);
  let rank: string;
  if (entry.role === 'retired') {
    const retDate = entry.retiredAt ? ` ${util.formatUtcDate(entry.retiredAt)}` : '';
    rank = String(<span className='muted'>— (retired{retDate})</span>);
  } else if (entry.rankCurrent !== undefined && !isProvisional) {
    const nextRank = entry.rankCurrent + 1;
    const los = adjacentLos.get(entry.versionId);
    const rangeNote = (
      entry.rankMin !== undefined &&
      entry.rankMax !== undefined &&
      entry.rankMin < entry.rankMax
    )
      ? ` [${entry.rankMin}–${entry.rankMax}]`
      : '';
    const losNote = los !== undefined
      ? ` · LOS ${(los * 100).toFixed(1)}% vs. #${nextRank}`
      : '';
    rank = String(
      <>
        <strong>#{entry.rankCurrent}</strong>
        {Boolean(rangeNote || losNote) && (
          <> <span className='muted'>{rangeNote}{losNote}</span></>
        )}
      </>
    );
  } else if (isProvisional) {
    rank = String(<span className='muted'>Provisional</span>);
  } else {
    rank = String(<span className='muted'>— (active)</span>);
  }

  const eloRounded = Math.round(entry.elo);
  const ci = entry.isAnchor ? 0 : Math.round(1.96 * entry.se);
  const elo = entry.isAnchor
    ? String(<strong>{eloRounded}</strong>)
    : String(<><strong>{eloRounded}</strong> <span className='muted'>±{ci}</span></>);
  const gxe = `${entry.gxe.toFixed(1)}%`;

  let peak: string;
  if (entry.settledAt !== undefined && entry.maxElo !== undefined) {
    const pCi = entry.isAnchor
      ? 0
      : Math.round(1.96 * (entry.maxEloSe ?? entry.se));
    const pGxe = (entry.maxGxe ?? entry.gxe).toFixed(1);
    const peakSuffix = entry.isAnchor ? `(${pGxe}% GXE)` : `±${pCi} (${pGxe}% GXE)`;
    peak = String(
      <>
        {entry.bestRank !== undefined && <><strong>#{entry.bestRank}</strong> · </>}
        {Math.round(entry.maxElo)} <span className='muted'>{peakSuffix}</span>
      </>
    );
  } else {
    peak = String(<span className='muted'>Unsettled</span>);
  }

  const wins = entry.ww + entry.wt;
  const losses = entry.ll + entry.tl;
  const ties = entry.split;
  const record = `${wins}–${losses}–${ties}`;

  const curNode = formatCurStreakNode(
    entry.currentWinStreak,
    entry.currentLossStreak,
    entry.matches
  );
  const streak = String(
    <>
      {curNode} <span className='muted'>(max {entry.maxWinStreak}W / {entry.maxLossStreak}L)</span>
    </>
  );

  const initMillis = Math.round(entry.meanInitMillis);
  const turnMillis = Math.round(entry.meanTurnMillis);
  const meanRamText = Math.round(entry.meanRam).toLocaleString('en-US');
  const hasTp = entry.meanTeamPreviewMillis !== undefined;
  const telemetry = String(
    <>
      {turnMillis} ms/turn{' '}
      <span className='muted'>
        ({initMillis} ms init{hasTp && ` · ${Math.round(entry.meanTeamPreviewMillis!)} ms preview`})
      </span>
      {' · '}RAM {meanRamText} MiB
    </>
  );

  return {rank, elo, gxe, peak, record, streak, telemetry};
}

function buildAllVersionsDynamicStats(
  entries: db.AgentLadderProfileEntry[],
  familyStats: db.AgentLadderStatsRow | undefined,
  adjacentLos: ReadonlyMap<number, number>
): VersionDynamicStats {
  const activeEntries = entries
    .filter(e => e.role === 'champion' || e.role === 'challenger')
    .sort((a, b) => b.lcb - a.lcb || b.elo - a.elo);
  const rep = activeEntries[0] ?? entries[0];
  const base = buildVersionDynamicStats(rep, adjacentLos);

  let totalW = 0;
  let totalL = 0;
  let totalT = 0;
  let totalPlayed = 0;
  for (const e of entries) {
    totalW += e.ww + e.wt;
    totalL += e.ll + e.tl;
    totalT += e.split;
    totalPlayed += e.matches;
  }

  let peak = base.peak;
  if (familyStats?.maxElo !== undefined) {
    const isPeakAnchor = Boolean(
      familyStats.maxEloVersionId !== undefined &&
      entries.find(e => e.versionId === familyStats.maxEloVersionId)?.isAnchor
    );
    const pCi = Math.round(1.96 * (familyStats.maxEloSe ?? rep.se));
    const pGxe = (familyStats.maxGxe ?? rep.gxe).toFixed(1);
    const peakSuffix = isPeakAnchor ? `(${pGxe}% GXE)` : `±${pCi} (${pGxe}% GXE)`;
    peak = String(
      <>
        {familyStats.bestRank !== undefined && <><strong>#{familyStats.bestRank}</strong> · </>}
        {Math.round(familyStats.maxElo)} <span className='muted'>{peakSuffix}</span>
      </>
    );
  }

  let streak = base.streak;
  if (familyStats) {
    const curNode = formatCurStreakNode(
      familyStats.currentWinStreak,
      familyStats.currentLossStreak,
      totalPlayed
    );
    streak = String(
      <>
        {curNode}{' '}
        <span className='muted'>
          (max {familyStats.maxWinStreak}W / {familyStats.maxLossStreak}L)
        </span>
      </>
    );
  }

  return {
    rank: base.rank,
    elo: base.elo,
    gxe: base.gxe,
    peak,
    record: `${totalW}–${totalL}–${totalT}`,
    streak,
    telemetry: base.telemetry,
  };
}

function renderVersionsLineageSvg(
  agentName: string,
  entriesDesc: db.AgentLadderProfileEntry[],
  snapshots: db.LadderSnapshotHistoryRow[],
  nowSec: number
): util.Html {
  const entriesChron = [...entriesDesc].reverse();
  const todayUtc = util.formatUtcDate(nowSec);
  const snapsByVer = new Map<number, db.LadderSnapshotHistoryRow[]>();
  for (const s of snapshots) {
    const list = snapsByVer.get(s.versionId) ?? [];
    list.push(s);
    snapsByVer.set(s.versionId, list);
  }

  const allDaysSet = new Set<string>();
  const ptsByVer = new Map<number, Array<{day: string; elo: number; se: number}>>();

  for (const e of entriesChron) {
    const rawSnaps = (snapsByVer.get(e.versionId) ?? []).filter(r => r.matches > 0);
    const pts = rawSnaps.map(r => ({day: r.dayUtc, elo: r.elo, se: r.se}));
    const startDay = util.formatUtcDate(e.submittedAt);
    if (pts.length === 0) {
      pts.push({day: startDay, elo: e.elo, se: e.se});
      if (e.role !== 'retired' && todayUtc > startDay) {
        pts.push({day: todayUtc, elo: e.elo, se: e.se});
      }
    } else if (e.role !== 'retired' && pts[pts.length - 1].day < todayUtc) {
      pts.push({day: todayUtc, elo: e.elo, se: e.se});
    }
    for (const pt of pts) allDaysSet.add(pt.day);
    ptsByVer.set(e.versionId, pts);
  }

  const allDays = [...allDaysSet].sort((a, b) => a.localeCompare(b));
  const minDayMillis = allDays.length > 0 ? util.parseUtcDayMillis(allDays[0]) : 0;
  const maxDayMillis = allDays.length > 0 ? util.parseUtcDayMillis(allDays[allDays.length - 1]) : 0;

  let minElo = 1500;
  let maxElo = 1750;
  for (const pts of ptsByVer.values()) {
    for (const pt of pts) {
      if (pt.elo - 40 < minElo) minElo = pt.elo - 40;
      if (pt.elo + 40 > maxElo) maxElo = pt.elo + 40;
    }
  }
  const axisMin = Math.min(1400, Math.floor(minElo / 100) * 100);
  const axisMax = Math.max(1800, Math.ceil(maxElo / 100) * 100);
  const xLeft = 45;
  const xRight = 720;
  const yTop = 25;
  const yBottom = 185;

  // Map YYYY-MM-DD dates proportionally by UTC timestamp rather than array index so irregular
  // release cadence (e.g. rapid patch followed by weeks of steady play) is true to calendar time.
  const mapX = (day: string): number => {
    if (maxDayMillis <= minDayMillis) return xRight;
    const frac = (util.parseUtcDayMillis(day) - minDayMillis) / (maxDayMillis - minDayMillis);
    return Math.round((xLeft + frac * (xRight - xLeft)) * 10) / 10;
  };
  const mapY = (elo: number): number => {
    const clamped = Math.max(axisMin, Math.min(axisMax, elo));
    const frac = (axisMax - clamped) / Math.max(1, axisMax - axisMin);
    return Math.round((yTop + frac * (yBottom - yTop)) * 10) / 10;
  };

  const gridLines: util.Html[] = [];
  const yLabels: util.Html[] = [];
  const step = axisMax - axisMin > 500 ? 150 : 100;
  for (let tick = axisMax; tick >= axisMin; tick -= step) {
    const y = mapY(tick);
    gridLines.push(
      <line
        x1={xLeft}
        y1={y}
        x2={xRight}
        y2={y}
        stroke-opacity={tick === 1500 ? '0.3' : undefined}
        stroke-dasharray={tick === 1500 ? '3,3' : undefined}
      />
    );
    yLabels.push(<text x='38' y={y + 4}>{tick}</text>);
  }

  const activeEntries = entriesChron
    .filter(e => e.role === 'champion' || e.role === 'challenger')
    .sort((a, b) => b.lcb - a.lcb);
  const primaryVerId = (activeEntries[0] ?? entriesChron[entriesChron.length - 1])?.versionId;

  const releaseDividers: util.Html[] = [];
  const xLabels: util.Html[] = [];
  const seenLabelX = new Set<number>();

  for (let i = 0; i < entriesChron.length; i++) {
    const e = entriesChron[i];
    const pts = ptsByVer.get(e.versionId) ?? [];
    if (pts.length === 0) continue;
    const x0 = pts.length === 1 && entriesChron.length === 1 ? xLeft : mapX(pts[0].day);
    if (i > 0 && x0 > xLeft + 25 && x0 < xRight - 25) {
      releaseDividers.push(<line x1={x0} y1='18' x2={x0} y2='195' />);
    }
    const nearExisting = [...seenLabelX].some(prevX => Math.abs(prevX - x0) < 75);
    if (!nearExisting && x0 < xRight - 55) {
      seenLabelX.add(x0);
      const dayLabel = `${render.formatShortDay(pts[0].day)} (${e.version})`;
      xLabels.push(<text x={x0} y='212'>{dayLabel}</text>);
    }
  }
  xLabels.push(<text x={xRight} y='212'>Today</text>);

  const seriesEls: util.Html[] = [];
  const pendingLabels: Array<{
    x: number;
    y: number;
    text: string;
    isPrimary: boolean;
  }> = [];

  for (const e of entriesChron) {
    const pts = ptsByVer.get(e.versionId) ?? [];
    if (pts.length === 0) continue;
    const coords = pts.length === 1
      ? [
        {x: xLeft, y: mapY(pts[0].elo), pt: pts[0]},
        {x: xRight, y: mapY(pts[0].elo), pt: pts[0]},
      ]
      : pts.map(pt => ({x: mapX(pt.day), y: mapY(pt.elo), pt}));

    const isPrimary = e.versionId === primaryVerId;
    const ci = e.isAnchor ? 0 : Math.round(1.96 * e.se);
    const upper = coords.map(c => `${c.x},${mapY(c.pt.elo + (e.isAnchor ? 0 : 1.96 * c.pt.se))}`);
    const lower = [...coords]
      .reverse()
      .map(c => `${c.x},${mapY(c.pt.elo - (e.isAnchor ? 0 : 1.96 * c.pt.se))}`);
    const polyPts = [...upper, ...lower].join(' ');
    const linePts = coords.map(c => `${c.x},${c.y}`).join(' ');
    const last = coords[coords.length - 1];
    const labelText = e.isAnchor
      ? `${e.version} (${Math.round(e.elo)})`
      : `${e.version} (${Math.round(e.elo)} ±${ci})`;
    const labelX = Math.min(xRight - 115, Math.max(xLeft + 10, last.x - 110));
    const labelY = Math.max(22, last.y - 10);

    if (isPrimary) {
      const lcbPts = coords
        .map(c => `${c.x},${mapY(c.pt.elo - (e.isAnchor ? 0 : 1.96 * c.pt.se))}`)
        .join(' ');
      seriesEls.push(
        <polygon points={polyPts} fill='var(--hl-symbol)' fill-opacity='0.1' />,
        <polyline
          fill='none'
          stroke='var(--hl-symbol)'
          stroke-opacity='0.75'
          stroke-width='1.25'
          stroke-dasharray='3,2'
          points={lcbPts}
        />,
        <polyline
          fill='none'
          stroke='var(--hl-symbol)'
          stroke-width='2.25'
          points={linePts}
        />,
        <circle cx={last.x} cy={last.y} r='3' fill='var(--hl-symbol)' />
      );
    } else {
      const op = e.role === 'retired' ? '0.45' : '0.65';
      seriesEls.push(
        <polygon points={polyPts} fill='currentColor' fill-opacity='0.06' />,
        <polyline
          fill='none'
          stroke='currentColor'
          stroke-opacity={op}
          stroke-width='1.6'
          points={linePts}
        />,
        <circle cx={last.x} cy={last.y} r='2.5' fill='currentColor' fill-opacity={op} />
      );
    }
    pendingLabels.push({x: labelX, y: labelY, text: labelText, isPrimary});
  }

  pendingLabels.sort((a, b) => a.y - b.y || Number(b.isPrimary) - Number(a.isPrimary));
  for (let i = 1; i < pendingLabels.length; i++) {
    const cur = pendingLabels[i];
    for (let j = 0; j < i; j++) {
      const prev = pendingLabels[j];
      if (Math.abs(cur.x - prev.x) < 115 && cur.y - prev.y < 14) {
        cur.y = Math.min(yBottom + 4, prev.y + 14);
      }
    }
  }
  for (const lbl of pendingLabels) {
    if (lbl.isPrimary) {
      seriesEls.push(
        <text
          x={lbl.x}
          y={lbl.y}
          fill='var(--hl-symbol)'
          font-size='11'
          font-weight='bold'
        >
          {lbl.text}
        </text>
      );
    } else {
      seriesEls.push(
        <text x={lbl.x} y={lbl.y} fill='currentColor' fill-opacity='0.6' font-size='11'>
          {lbl.text}
        </text>
      );
    }
  }

  return (
    <figure className='chart'>
      <svg
        viewBox='0 0 760 220'
        role='img'
        aria-label={`${agentName} Version Lineage and Rating Convergence`}
      >
        <g stroke='currentColor' stroke-opacity='0.12' stroke-width='1'>
          {gridLines}
        </g>
        {releaseDividers.length > 0 && (
          <g stroke='currentColor' stroke-opacity='0.2' stroke-width='1' stroke-dasharray='2,3'>
            {releaseDividers}
          </g>
        )}
        <g fill='currentColor' fill-opacity='0.5' font-size='11' text-anchor='end'>
          {yLabels}
        </g>
        <g fill='currentColor' fill-opacity='0.5' font-size='11' text-anchor='middle'>
          {xLabels}
        </g>
        {seriesEls}
      </svg>
    </figure>
  );
}

function renderVersionsPane(opts: {
  agentName: string;
  ladderKey: string;
  isDefault: boolean;
  entriesDesc: db.AgentLadderProfileEntry[];
  snapshots: db.LadderSnapshotHistoryRow[];
  nowSec: number;
}): util.Html {
  const {agentName, ladderKey, isDefault, entriesDesc, snapshots, nowSec} = opts;
  const entriesChron = [...entriesDesc].reverse();
  const prevEloByVer = new Map<number, number>();
  for (let i = 1; i < entriesChron.length; i++) {
    prevEloByVer.set(entriesChron[i].versionId, entriesChron[i - 1].elo);
  }

  const activePrimary = entriesDesc
    .filter(e => e.role === 'champion' || e.role === 'challenger')
    .sort((a, b) => b.lcb - a.lcb)[0];
  const hasTeamPreview = entriesDesc.some(e => e.meanTeamPreviewMillis !== undefined);

  return (
    <div className={isDefault ? 'profile-pane' : 'profile-pane hide'} data-ladder={ladderKey}>
      {renderVersionsLineageSvg(agentName, entriesDesc, snapshots, nowSec)}
      <div className='table-wrap'>
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th className='num'>Elo</th>
              <th className='num' title='Elo improvement over previous version'>
                {'\u0394'} Elo
              </th>
              <th className='num'>GXE</th>
              <th className='num'>W–L–T</th>
              <th className='num' title='Mean /ready initialization time'>Init</th>
              {hasTeamPreview && (
                <th className='num' title='Mean team preview selection time'>Preview</th>
              )}
              <th className='num' title='Mean regular turn decision time'>Turn</th>
              <th className='num' title='Mean / Peak XNU physical memory footprint'>RAM</th>
              <th className='num'>Submitted</th>
            </tr>
          </thead>
          <tbody>
            {entriesDesc.map((e, idx) => {
              const isPrimary = activePrimary?.versionId === e.versionId;
              const isRetired = e.role === 'retired';
              const eloRounded = Math.round(e.elo);
              const ci = e.isAnchor ? 0 : Math.round(1.96 * e.se);
              const prevElo = prevEloByVer.get(e.versionId);

              let deltaCell: util.Html;
              if (prevElo === undefined) {
                deltaCell = <td className='num muted'>—</td>;
              } else {
                const diff = Math.round(e.elo) - Math.round(prevElo);
                if (diff > 0) {
                  deltaCell = <td className='num'><span className='yes'>+{diff}</span></td>;
                } else if (diff < 0) {
                  deltaCell = <td className='num'><span className='no'>{diff}</span></td>;
                } else {
                  deltaCell = <td className='num muted'>0</td>;
                }
              }

              const wins = e.ww + e.wt;
              const losses = e.ll + e.tl;
              const ties = e.split;
              const initText = `${Math.round(e.meanInitMillis)} ms`;
              const tpText = e.meanTeamPreviewMillis !== undefined
                ? `${Math.round(e.meanTeamPreviewMillis)} ms`
                : '—';
              const turnText = `${Math.round(e.meanTurnMillis)} ms`;
              const meanRamText = `${Math.round(e.meanRam).toLocaleString('en-US')} MiB`;
              const peakRamTip = `Peak: ${Math.round(e.peakRam).toLocaleString('en-US')} MiB`;
              const classes: string[] = [];
              if (isRetired) classes.push('secondary');
              if (idx >= util.TABLE_PAGE_SIZE) classes.push('hide');

              return (
                <tr
                  className={classes.length > 0 ? classes.join(' ') : undefined}
                  data-vrow={e.version}
                >
                  <td>
                    {isPrimary
                      ? <code><strong>{e.version}</strong></code>
                      : <code>{e.version}</code>}
                    {isRetired && <> <span className='muted'>(retired)</span></>}
                  </td>
                  <td className='num'>
                    {isPrimary ? <strong>{eloRounded}</strong> : eloRounded}
                    {!e.isAnchor && <> <span className='muted'>±{ci}</span></>}
                  </td>
                  {deltaCell}
                  <td className='num'>{e.gxe.toFixed(1)}%</td>
                  <td className='num'>{wins}–{losses}–{ties}</td>
                  <td className='num'>{initText}</td>
                  {hasTeamPreview && <td className='num'>{tpText}</td>}
                  <td className='num'>{turnText}</td>
                  <td className='num' title={peakRamTip}>{meanRamText}</td>
                  <td className='num muted'>{util.formatUtcDate(e.submittedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <util.TablePager
        label='Versions pagination'
        total={entriesDesc.length}
        singular='version'
        plural='versions'
      />
    </div>
  );
}

function renderHeadToHeadPane(opts: {
  agentId: number;
  ladderKey: string;
  isDefault: boolean;
  agentEntries: db.AgentLadderProfileEntry[];
  allEntries: db.LeaderboardEntryView[];
  pairs: db.PairAggregateRow[];
  links: render.AgentLinkContext;
}): {pane: util.Html; empty: boolean} {
  const {
    agentId,
    ladderKey,
    isDefault,
    agentEntries,
    allEntries,
    pairs,
    links,
  } = opts;
  const emptyPane = (
    <div
      className={isDefault ? 'table-wrap profile-pane' : 'table-wrap profile-pane hide'}
      data-ladder={ladderKey}
      data-empty='true'
    >
      <p className='empty-state muted'>No head-to-head matches yet.</p>
    </div>
  );

  const activeEntries = agentEntries
    .filter(e => e.role === 'champion' || e.role === 'challenger')
    .sort((a, b) => b.lcb - a.lcb);
  const rep = activeEntries[0] ?? agentEntries[0];
  if (!rep) return {pane: emptyPane, empty: true};

  const pairMap = new Map<string, db.PairAggregateRow>();
  for (const p of pairs) {
    pairMap.set(`${p.lowVersionId}:${p.highVersionId}`, p);
  }

  // Pick each opponent agent's primary active (or top) version that has played against `rep`.
  const oppCandidates = allEntries.filter(e => e.agentId !== agentId);
  const seenOppAgents = new Set<number>();
  const h2hRows: util.Html[] = [];

  let fallbackSolve: ReturnType<typeof ratings.solveIndexedDavidson> | undefined;

  for (const opp of oppCandidates) {
    if (seenOppAgents.has(opp.agentId)) continue;
    const lowId = Math.min(rep.versionId, opp.versionId);
    const highId = Math.max(rep.versionId, opp.versionId);
    const pair = pairMap.get(`${lowId}:${highId}`);
    if (!pair) continue;

    const isLow = rep.versionId === lowId;
    const wins = isLow ? pair.ww + pair.wt : pair.ll + pair.tl;
    const losses = isLow ? pair.ll + pair.tl : pair.ww + pair.wt;
    const ties = pair.split;
    const total = wins + losses + ties;
    if (total === 0) continue;

    seenOppAgents.add(opp.agentId);

    const oppHref = render.resolveAgentHref(links, opp.agentSlug, opp.agentName);
    const oppLink = render.formatAgentLink(opp.agentName, oppHref, true);
    const oppElo = Math.round(opp.elo);
    const oppCi = opp.isAnchor ? 0 : Math.round(1.96 * opp.se);

    const scorePct = ((wins + 0.5 * ties) / total) * 100;
    const deltaTheta = (rep.elo - opp.elo) / ratings.ELO_SCALE;
    const expPct = ratings.expectedMatchScore(deltaTheta) * 100;
    const resid = scorePct - expPct;
    const residSign = resid > 0 ? '+' : '';
    const residText = `${residSign}${resid.toFixed(1)}%`;
    let residNode: util.Child = residText;
    let residTip: string | undefined;
    // Gate stylistic Best Matchup / Nemesis highlighting on >= 10 paired matches so tiny early
    // samples (e.g. 1-0 = +50% over expectation) don't masquerade as non-transitive counterpicks.
    if (total >= 10 && resid >= 4.5) {
      residNode = <span className='yes'>{residText}</span>;
      residTip = `Best Matchup (${residText} over expectation)`;
    } else if (total >= 10 && resid <= -4.5) {
      residNode = <span className='no'>{residText}</span>;
      residTip = `Relative underperformance vs. expectation (${residText})`;
    }

    const signedCur = isLow ? pair.currentStreak : -pair.currentStreak;
    const maxW = isLow ? pair.lowMaxWinStreak : pair.highMaxWinStreak;
    const maxL = isLow ? pair.highMaxWinStreak : pair.lowMaxWinStreak;
    let curStrNode: util.Child;
    if (signedCur >= 3) curStrNode = <span className='yes'>W{signedCur}</span>;
    else if (signedCur >= 1) curStrNode = `W${signedCur}`;
    else if (signedCur <= -3) curStrNode = <span className='no'>L{-signedCur}</span>;
    else if (signedCur <= -1) curStrNode = `L${-signedCur}`;
    else curStrNode = 'T1';

    let losVal = pair.lowLos !== undefined
      ? (isLow ? pair.lowLos : 1 - pair.lowLos)
      : undefined;
    if (losVal === undefined) {
      fallbackSolve ??= ratings.solveIndexedDavidson(allEntries, pairs);
      const idxUs = fallbackSolve.indexByVer.get(rep.versionId);
      const idxOpp = fallbackSolve.indexByVer.get(opp.versionId);
      if (idxUs !== undefined && idxOpp !== undefined) {
        losVal = ratings.computeLOS(
          fallbackSolve.theta,
          fallbackSolve.covariance,
          fallbackSolve.indexByVer.size,
          idxUs,
          idxOpp
        );
      }
    }
    const losPct = losVal !== undefined ? losVal * 100 : 50;

    const wltTip = `${wins} W, ${ties} (WL/LW/TT), ${losses} L`;
    const rowCls = h2hRows.length >= util.TABLE_PAGE_SIZE ? 'opp-row hide' : 'opp-row';

    h2hRows.push(
      <tr
        className={rowCls}
        data-opp={opp.agentSlug}
        title={`Click to filter Matches vs. ${opp.agentName}`}
      >
        <td data-val={opp.agentName}>
          {util.raw(oppLink)} <code>{opp.version}</code>
        </td>
        <td className='num' data-val={oppElo}>
          {oppElo}
          {!opp.isAnchor && <> <span className='muted'>±{oppCi}</span></>}
        </td>
        <td className='num' data-val={wins} title={wltTip}>
          {wins}–{losses}–{ties}
        </td>
        <td className='num' data-val={scorePct.toFixed(1)}>
          {scorePct >= 50
            ? <strong>{scorePct.toFixed(1)}%</strong>
            : `${scorePct.toFixed(1)}%`}
        </td>
        <td className='num muted' data-val={expPct.toFixed(1)}>
          {expPct.toFixed(1)}%
        </td>
        <td className='num' data-val={resid.toFixed(1)} title={residTip}>
          {residNode}
        </td>
        <td className='center' data-val={signedCur}>
          {curStrNode} <span className='muted'>({maxW}W/{maxL}L)</span>
        </td>
        <td className='num' data-val={losPct.toFixed(1)}>
          {losPct.toFixed(1)}%
        </td>
      </tr>
    );
  }

  if (h2hRows.length === 0) {
    return {pane: emptyPane, empty: true};
  }

  const thWlt = 'Match Wins – Losses – Ties';
  const thExp = 'Expected Score %';
  const thDelta = 'Actual Score % - Expected Score %';
  const thStr = 'Current streak (Longest Win / Loss streak vs. Opponent)';
  const thLos = 'Pairwise Likelihood of Superiority';

  return {
    empty: false,
    pane: (
      <div className={isDefault ? 'profile-pane' : 'profile-pane hide'} data-ladder={ladderKey}>
        <div className='table-wrap'>
          <table className='h2h-table'>
            <thead>
              <tr>
                <th className='sortable' data-col='0' data-type='str'>Opponent</th>
                <th className='num sortable' data-col='1' data-type='num'>Elo</th>
                <th className='num sortable' data-col='2' data-type='num' title={thWlt}>
                  W–L–T
                </th>
                <th className='num sortable' data-col='3' data-type='num'>Score</th>
                <th className='num sortable' data-col='4' data-type='num' title={thExp}>
                  Expected
                </th>
                <th className='num sortable' data-col='5' data-type='num' title={thDelta}>
                  {'\u0394'}
                </th>
                <th className='center sortable' data-col='6' data-type='num' title={thStr}>
                  Streak
                </th>
                <th className='num sortable' data-col='7' data-type='num' title={thLos}>
                  LOS
                </th>
              </tr>
            </thead>
            <tbody>{h2hRows}</tbody>
          </table>
        </div>
        <util.TablePager
          label='Head-to-head pagination'
          total={h2hRows.length}
          singular='opponent'
          plural='opponents'
        />
      </div>
    ),
  };
}

function invertCategory(cat: db.RecentMatchView['category']): string {
  const flip = (c: string) => (c === 'W' ? 'L' : c === 'L' ? 'W' : 'T');
  return `${flip(cat[0])}${flip(cat[1])}`;
}

function renderRecentMatchesPane(opts: {
  agentSlug: string;
  ladderKey: string;
  isDefault: boolean;
  matches: db.RecentMatchView[];
  totalMatches: number;
  agentLinks: Readonly<Record<string, string>>;
  publicDir: string;
  nowSec: number;
}): util.Html {
  const {
    agentSlug,
    ladderKey,
    isDefault,
    matches,
    totalMatches,
    agentLinks,
    publicDir,
    nowSec,
  } = opts;

  return (
    <div className={isDefault ? 'profile-pane' : 'profile-pane hide'} data-ladder={ladderKey}>
      <div className='table-wrap'>
        <table className='matches-table'>
          <thead>
            <tr>
              <th>Match</th>
              <th>Version</th>
              <th>Opponent</th>
              <th className='center' title='Match Outcome (Game 1 / Game 2 Outcomes)'>Result</th>
              <th className='num'>Completed</th>
            </tr>
          </thead>
          <tbody>
            {matches.length === 0 ? (
              <tr><td colSpan={5} className='center muted'>No completed matches yet.</td></tr>
            ) : (
              matches.map((m, idx) => {
                const weAreP1 = m.p1.slug === agentSlug;
                const ourSide = weAreP1 ? m.p1 : m.p2;
                const oppSide = weAreP1 ? m.p2 : m.p1;
                const ternary = ratings.toTernaryMatchOutcome(m.category);
                const ourOutcome = weAreP1 ? ternary.p1 : ternary.p2;
                const ourCat = weAreP1 ? m.category : invertCategory(m.category);

                let resNode: util.Html;
                if (ourOutcome === 'W') {
                  resNode = (
                    <><span className='yes'>W</span> <span className='muted'>({ourCat})</span></>
                  );
                } else if (ourOutcome === 'L') {
                  resNode = (
                    <><span className='no'>L</span> <span className='muted'>({ourCat})</span></>
                  );
                } else {
                  resNode = <>T <span className='muted'>({ourCat})</span></>;
                }

                const oppHref = agentLinks[oppSide.slug];
                const tsTitle = formatIsoDateTimeUtc(m.completedAt);
                const rel = render.formatRelativeTime(nowSec, m.completedAt);
                const detailHtml = render.renderBattleInlineDetailHtml(
                  arena.enrichMatchView(publicDir, m),
                  agentSlug
                );
                const rowCls = idx >= util.TABLE_PAGE_SIZE ? 'battle-row hide' : 'battle-row';

                return (
                  <>
                    <tr
                      className={rowCls}
                      data-ver={ourSide.version}
                      data-opp={oppSide.slug}
                      tabIndex={0}
                      aria-expanded='false'
                    >
                      <td>
                        <span className='battle-toggle' aria-hidden='true'>{'\u25b8'}</span>
                        <code>{m.id}</code>
                      </td>
                      <td><code>{ourSide.version}</code></td>
                      <td>
                        {util.raw(render.formatAgentLink(oppSide.name, oppHref, false))}{' '}
                        <code>{oppSide.version}</code>
                      </td>
                      <td className='center'>{resNode}</td>
                      <td className='num muted' title={tsTitle} data-ts={m.completedAt}>
                        {rel}
                      </td>
                    </tr>
                    <tr className='battle-detail-row hide' data-detail-for={m.id}>
                      <td colSpan={5}>{util.raw(detailHtml)}</td>
                    </tr>
                  </>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <util.TablePager
        label='Matches pagination'
        total={totalMatches}
        singular='match'
        plural='matches'
        prevLabel={'\u2190 Newer'}
        nextLabel={'Older \u2192'}
      />
    </div>
  );
}

function buildProjectMetaRows(
  db: db.Database,
  agent: db.AgentRow,
  meta: render.ProjectMeta | undefined,
  latestEntry: db.AgentLadderProfileEntry | undefined
): util.Html[] {
  const rows: util.Html[] = [];
  const devs = db.getDevelopersForAgent(agent.id);
  if (devs.length > 0) {
    rows.push(
      <tr>
        <td><strong>Author</strong></td>
        <td>
          {devs.map((d, i) => [
            i > 0 && ', ',
            <a href={`https://github.com/${encodeURIComponent(d.githubLogin)}`} className='subtle'>
              {d.githubLogin}
            </a>,
          ])}
        </td>
      </tr>
    );
  }

  if (meta?.active !== undefined) {
    const activeNode = Array.isArray(meta.active)
      ? (meta.active[0] === meta.active[1]
        ? `${meta.active[0]}`
        : `${meta.active[0]} – ${meta.active[1]}`)
      : <>{meta.active} – <em>present</em></>;
    rows.push(<tr><td><strong>Active</strong></td><td>{activeNode}</td></tr>);
  }

  if (meta?.license) {
    rows.push(<tr><td><strong>License</strong></td><td><tt>{meta.license}</tt></td></tr>);
  } else if (meta?.source) {
    rows.push(<tr><td><strong>License</strong></td><td>None</td></tr>);
  }

  if (meta?.source) {
    const identifier = /^https:\/\/git(hub|lab)\.com\//.test(meta.source)
      ? meta.source.slice(19)
      : meta.source;
    rows.push(
      <tr>
        <td><strong>Source</strong></td>
        <td><a href={meta.source}>{identifier}</a></td>
      </tr>
    );
  }

  if (meta?.engine) {
    const engNode = Array.isArray(meta.engine)
      ? meta.engine.map((e, i) => [
        i > 0 && ', ',
        <a href={e.url} className='subtle'>{e.name}</a>,
      ])
      : meta.engine;
    rows.push(<tr><td><strong>Engine</strong></td><td>{engNode}</td></tr>);
  }

  if (meta?.language) {
    const langText = Array.isArray(meta.language)
      ? meta.language.join(', ')
      : meta.language;
    rows.push(<tr><td><strong>Language</strong></td><td>{langText}</td></tr>);
  }

  if (latestEntry) {
    const pkgNode = latestEntry.package === 'bundle'
      ? <><tt>darwin/arm64</tt> bundle</>
      : <><tt>linux/arm64</tt> OCI</>;
    rows.push(
      <tr>
        <td><strong>Artifact</strong></td>
        <td>
          {pkgNode}
          {latestEntry.unpackedBytes !== undefined && (
            <>
              {' '}
              <span className='muted'>
                ({Math.round(latestEntry.unpackedBytes / (1024 * 1024))} MiB)
              </span>
            </>
          )}
        </td>
      </tr>
    );
  }

  return rows;
}

function buildProfileScript(
  profileDataMap: Record<string, LadderProfileClientData>,
  defaultLadderKey: string,
  agentSlug: string,
  agentLinks: Readonly<Record<string, string>>
): string {
  return `
  document.addEventListener('DOMContentLoaded', () => {
    const profileData = ${render.safeInlineJson(profileDataMap)};
    const agentSlug = ${render.safeInlineJson(agentSlug)};
    const agentLinks = ${render.safeInlineJson(agentLinks)};
    const formatTitles = ${render.safeInlineJson(render.FORMAT_TITLES)};
    const ladderRadios = document.querySelectorAll('input[name="ladder"]');
    const verSelect = document.getElementById('ver-select');
    const verPicker = document.getElementById('ver-picker');
    const verSep = document.getElementById('ver-sep');
    const oppSelect = document.getElementById('opp-select');
    const reignWrap = document.querySelector('.table-wrap.reign');
    let reignTbody = document.getElementById('reign-tbody');
    const ensureReignTbody = () => {
      if (reignTbody) return reignTbody;
      const tbl = reignWrap ? reignWrap.querySelector('table') : null;
      if (!tbl) return null;
      const tb = document.createElement('tbody');
      tb.id = 'reign-tbody';
      tbl.appendChild(tb);
      reignTbody = tb;
      return tb;
    };
    const hasOwn = Object.prototype.hasOwnProperty;
    const matchupsSec = document.getElementById('matchups');
    const matchesSec = document.getElementById('matches');
    const panes = document.querySelectorAll('.profile-pane');
    let curLad = ${render.safeInlineJson(defaultLadderKey)};
    let curVer = 'all';
    let curOpp = 'all';
    let matchPage = 1;
    let matchFetchSeq = 0;
    const pageSize = 25;
    const panePagers = new WeakMap();
    const initialMatchHtml = Object.create(null);

    document.querySelectorAll('#matches .profile-pane').forEach(pane => {
      const lad = pane.dataset.ladder;
      const tbody = pane.querySelector('tbody');
      if (lad && tbody) {
        initialMatchHtml[lad] = tbody.innerHTML;
      }
    });

    ${render.buildBattleDetailClientJs()}

    const invertCat = cat => {
      if (cat === 'WW') return 'LL';
      if (cat === 'LL') return 'WW';
      if (cat === 'WT') return 'TL';
      if (cat === 'TW') return 'LT';
      if (cat === 'TL') return 'WT';
      if (cat === 'LT') return 'TW';
      if (cat === 'WL') return 'LW';
      if (cat === 'LW') return 'WL';
      return 'TT';
    };

    const renderProfileMatchPair = (m, nowSec, expanded) => {
      const bothOurs = m.p1.slug === agentSlug && m.p2.slug === agentSlug;
      const weAreP1 = (bothOurs && curVer !== 'all')
        ? m.p1.version === curVer
        : m.p1.slug === agentSlug;
      const ourSide = weAreP1 ? m.p1 : m.p2;
      const oppSide = weAreP1 ? m.p2 : m.p1;
      const ourCat = weAreP1 ? m.category : invertCat(m.category);
      let resHtml;
      if (ourCat === 'WW' || ourCat === 'WT' || ourCat === 'TW') {
        resHtml = '<span class="yes">W</span> <span class="muted">(' + esc(ourCat) + ')</span>';
      } else if (ourCat === 'LL' || ourCat === 'LT' || ourCat === 'TL') {
        resHtml = '<span class="no">L</span> <span class="muted">(' + esc(ourCat) + ')</span>';
      } else {
        resHtml = 'T <span class="muted">(' + esc(ourCat) + ')</span>';
      }

      const tsTitle = utcStr(m.completedAt);
      const rel = relTime(nowSec, m.completedAt);

      const tr = document.createElement('tr');
      tr.className = 'battle-row' + (expanded ? ' expanded' : '');
      tr.dataset.ver = ourSide.version;
      tr.dataset.opp = oppSide.slug;
      tr.tabIndex = 0;
      tr.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      tr.innerHTML =
        '<td><span class="battle-toggle" aria-hidden="true">&#9656;</span><code>' +
        esc(m.id) + '</code></td>' +
        '<td><code>' + esc(ourSide.version) + '</code></td>' +
        '<td>' + renderAgent(oppSide, false) + '</td>' +
        '<td class="center">' + resHtml + '</td>' +
        '<td class="num muted" title="' + esc(tsTitle) +
        '" data-ts="' + m.completedAt + '">' + esc(rel) + '</td>';

      const detailTr = document.createElement('tr');
      detailTr.className = 'battle-detail-row' + (expanded ? '' : ' hide');
      detailTr.dataset.detailFor = m.id;
      detailTr.innerHTML = '<td colspan="5">' + renderMatchDetailHtml(m, agentSlug) + '</td>';
      if (expanded) {
        const slot = detailTr.querySelector('.battle-detail[data-match-id]');
        if (slot) void loadRowReplay(slot, 1);
      }
      return [tr, detailTr];
    };

    const renderMatchesList = (tbody, matches, nowSec) => {
      if (!tbody) return;
      if (!matches || matches.length === 0) {
        if (curVer !== 'all' || curOpp !== 'all') {
          tbody.innerHTML =
            '<tr class="empty-filter-row"><td colspan="5" class="center muted">' +
            'No matching battles.</td></tr>';
        } else {
          tbody.innerHTML =
            '<tr><td colspan="5" class="center muted">No completed matches yet.</td></tr>';
        }
        return;
      }
      const frag = document.createDocumentFragment();
      for (const m of matches) {
        const pair = renderProfileMatchPair(m, nowSec, false);
        frag.appendChild(pair[0]);
        frag.appendChild(pair[1]);
      }
      tbody.innerHTML = '';
      tbody.appendChild(frag);
    };

    const updatePagerControls = (pager, page, total) => {
      if (!pager) return;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const prevBtn = pager.querySelector('[data-pager-prev]');
      const nextBtn = pager.querySelector('[data-pager-next]');
      const infoEl = pager.querySelector('[data-pager-info]');
      const singular = pager.dataset.singular || 'row';
      const plural = pager.dataset.plural || 'rows';
      const word = total === 1 ? singular : plural;
      pager.classList.toggle('hide', totalPages <= 1);
      if (prevBtn) prevBtn.disabled = page <= 1;
      if (nextBtn) nextBtn.disabled = page >= totalPages;
      if (infoEl) {
        infoEl.textContent =
          'Page ' + page + ' of ' + totalPages +
          ' (' + total.toLocaleString('en-US') + ' ' + word + ')';
      }
    };

    document.querySelectorAll('#versions .profile-pane, #matchups .profile-pane').forEach(pane => {
      const tbody = pane.querySelector('tbody');
      const pager = pane.querySelector('.pager[data-table-pager]');
      if (!tbody || !pager) return;
      let page = 1;
      const apply = () => {
        const rows = Array.from(tbody.querySelectorAll('tr'));
        const total = rows.length;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        if (page > totalPages) page = totalPages;
        if (page < 1) page = 1;
        const start = (page - 1) * pageSize;
        rows.forEach((row, idx) => {
          row.classList.toggle('hide', idx < start || idx >= start + pageSize);
        });
        updatePagerControls(pager, page, total);
      };
      const prevBtn = pager.querySelector('[data-pager-prev]');
      const nextBtn = pager.querySelector('[data-pager-next]');
      if (prevBtn) {
        prevBtn.addEventListener('click', () => {
          if (page > 1) {
            page--;
            apply();
          }
        });
      }
      if (nextBtn) {
        nextBtn.addEventListener('click', () => {
          page++;
          apply();
        });
      }
      panePagers.set(pane, {
        reset: () => {
          page = 1;
          apply();
        },
      });
    });

    const applyMatchesPager = async scrollMatches => {
      const ladData = profileData[curLad];
      const activeMatchPane = document.querySelector(
        '#matches .profile-pane[data-ladder="' + curLad + '"]'
      );
      if (!ladData || !activeMatchPane) return;
      const tbody = activeMatchPane.querySelector('tbody');
      const pager = activeMatchPane.querySelector('.pager[data-table-pager]');
      const vCounts = (ladData.oppCounts && ladData.oppCounts[curVer]) ||
        (ladData.oppCounts && ladData.oppCounts.all) ||
        Object.create(null);

      if (oppSelect) {
        Array.from(oppSelect.options).forEach(opt => {
          const count = opt.value === 'all' ? (vCounts.all || 0) : (vCounts[opt.value] || 0);
          const idx = opt.textContent.lastIndexOf(' (');
          if (idx >= 0) {
            opt.textContent = opt.textContent.slice(0, idx) + ' (' + count + ')';
          }
        });
      }

      const expectedTotal = curOpp === 'all' ? (vCounts.all || 0) : (vCounts[curOpp] || 0);
      const totalPages = Math.max(1, Math.ceil(expectedTotal / pageSize));
      if (matchPage > totalPages) matchPage = totalPages;
      if (matchPage < 1) matchPage = 1;

      const seq = ++matchFetchSeq;

      if (curVer === 'all' && curOpp === 'all' && matchPage === 1 && initialMatchHtml[curLad]) {
        if (tbody) tbody.innerHTML = initialMatchHtml[curLad];
        updatePagerControls(pager, 1, expectedTotal);
        if (scrollMatches && matchesSec) matchesSec.scrollIntoView();
        return;
      }

      if (expectedTotal === 0) {
        renderMatchesList(tbody, [], Math.floor(Date.now() / 1000));
        updatePagerControls(pager, 1, 0);
        if (scrollMatches && matchesSec) matchesSec.scrollIntoView();
        return;
      }

      updatePagerControls(pager, matchPage, expectedTotal);

      try {
        let qs = '?ladder=' + encodeURIComponent(ladData.ladderId) +
          '&agent=' + encodeURIComponent(agentSlug) +
          '&page=' + matchPage +
          '&limit=' + pageSize;
        if (curVer !== 'all') qs += '&version=' + encodeURIComponent(curVer);
        if (curOpp !== 'all') qs += '&vs=' + encodeURIComponent(curOpp);
        const res = await fetch('/api/battles.json' + qs, {
          cache: 'no-cache',
          headers: {Accept: 'application/json'},
        });
        if (!res.ok) return;
        const data = await res.json();
        if (seq !== matchFetchSeq) return;
        renderMatchesList(tbody, data.matches || [], Math.floor(Date.now() / 1000));
        const total = data.total !== undefined ? data.total : expectedTotal;
        updatePagerControls(pager, data.page || matchPage, total);
        if (scrollMatches && matchesSec) matchesSec.scrollIntoView();
      } catch {}
    };

    document.querySelectorAll('#matches .profile-pane').forEach(pane => {
      const pager = pane.querySelector('.pager[data-table-pager]');
      if (!pager) return;
      const prevBtn = pager.querySelector('[data-pager-prev]');
      const nextBtn = pager.querySelector('[data-pager-next]');
      if (prevBtn) {
        prevBtn.addEventListener('click', () => {
          if (matchPage > 1) {
            matchPage--;
            void applyMatchesPager(true);
          }
        });
      }
      if (nextBtn) {
        nextBtn.addEventListener('click', () => {
          matchPage++;
          void applyMatchesPager(true);
        });
      }
    });

    const syncUrl = hashOverride => {
      if (!history.replaceState) return;
      const url = new URL(location.href);
      if (curOpp && curOpp !== 'all') {
        url.searchParams.set('vs', curOpp);
      } else {
        url.searchParams.delete('vs');
      }
      const nextHash = hashOverride !== undefined ? hashOverride : location.hash;
      history.replaceState(null, '', url.pathname + url.search + nextHash);
    };

    const applyStats = ver => {
      curVer = ver || 'all';
      matchPage = 1;
      const ladData = profileData[curLad];
      if (!ladData) return;
      const s = ladData.vstats[curVer] || ladData.vstats.all;
      if (s) {
        document.getElementById('stat-rank').innerHTML = s.rank;
        document.getElementById('stat-elo').innerHTML = s.elo;
        document.getElementById('stat-gxe').innerHTML = s.gxe;
        document.getElementById('stat-peak').innerHTML = s.peak;
        document.getElementById('stat-record').innerHTML = s.record;
        document.getElementById('stat-streak').innerHTML = s.streak;
        document.getElementById('stat-telemetry').innerHTML = s.telemetry;
      }
      const reignHtml = ladData.reign
        ? (ladData.reign[curVer] !== undefined ? ladData.reign[curVer] : (ladData.reign.all || ''))
        : '';
      const tbody = reignHtml ? ensureReignTbody() : reignTbody;
      if (tbody) {
        tbody.innerHTML = reignHtml;
      }
      if (reignWrap) {
        reignWrap.classList.toggle('hide', !reignHtml);
      }
      void applyMatchesPager(false);
      if (matchupsSec) {
        matchupsSec.querySelectorAll('tr.opp-row').forEach(row => {
          row.classList.toggle('active-opp', curOpp !== 'all' && row.dataset.opp === curOpp);
        });
      }
    };

    const applyLadder = ladKey => {
      if (!hasOwn.call(profileData, ladKey)) return;
      const ladData = profileData[ladKey];
      if (!ladData) return;
      curLad = ladKey;
      curVer = 'all';
      curOpp = 'all';
      ladderRadios.forEach(r => {
        if (r.value === ladKey) r.checked = true;
      });
      panes.forEach(p => {
        const isCurrent = p.dataset.ladder === ladKey;
        p.classList.toggle('hide', !isCurrent);
        if (isCurrent) {
          const ctrl = panePagers.get(p);
          if (ctrl) ctrl.reset();
        }
      });
      if (matchupsSec) {
        const mp = matchupsSec.querySelector('.profile-pane[data-ladder="' + ladKey + '"]');
        matchupsSec.classList.toggle('hide', !mp || mp.dataset.empty === 'true');
      }
      if (verSelect) {
        verSelect.innerHTML = ladData.optionsHtml;
        verSelect.value = 'all';
      }
      if (verPicker) verPicker.classList.toggle('hide', !ladData.multiVersion);
      if (verSep) verSep.classList.toggle('hide', !ladData.multiVersion);
      if (oppSelect && ladData.oppOptionsHtml) {
        oppSelect.innerHTML = ladData.oppOptionsHtml;
        oppSelect.value = 'all';
      }
      applyStats('all');
    };

    if (verSelect) {
      verSelect.addEventListener('change', () => applyStats(verSelect.value));
    }

    if (oppSelect) {
      oppSelect.addEventListener('change', () => {
        curOpp = oppSelect.value || 'all';
        applyStats(curVer);
        syncUrl();
      });
    }

    ladderRadios.forEach(r => r.addEventListener('change', () => {
      applyLadder(r.value);
      syncUrl('#' + r.value);
    }));

    const applyHash = () => {
      if (!location.hash) return;
      let hashKey = '';
      try {
        hashKey = decodeURIComponent(location.hash.slice(1)).toLowerCase();
      } catch {
        return;
      }
      if (hasOwn.call(profileData, hashKey)) {
        applyLadder(hashKey);
      }
    };
    window.addEventListener('hashchange', applyHash);
    applyHash();

    const initVs = new URLSearchParams(location.search).get('vs');
    if (initVs && oppSelect) {
      const matchOpt = Array.from(oppSelect.options).find(o => o.value === initVs);
      if (matchOpt) {
        curOpp = initVs;
        oppSelect.value = initVs;
        applyStats(curVer);
      }
    }

    if (matchupsSec) {
      matchupsSec.addEventListener('click', e => {
        if (e.target.closest('a') || e.target.closest('th')) return;
        const row = e.target.closest('tr.opp-row');
        if (!row || !row.dataset.opp) return;
        const nextOpp = curOpp === row.dataset.opp ? 'all' : row.dataset.opp;
        curOpp = nextOpp;
        if (oppSelect) oppSelect.value = nextOpp;
        applyStats(curVer);
        syncUrl();
        if (nextOpp !== 'all' && matchesSec) {
          matchesSec.scrollIntoView({behavior: 'smooth'});
        }
      });
    }

    document.querySelectorAll('.h2h-table').forEach(table => {
      const headers = table.querySelectorAll('th.sortable');
      let sortCol = -1;
      let sortAsc = false;
      headers.forEach(th => th.addEventListener('click', () => {
        const col = Number(th.dataset.col);
        const isNum = th.dataset.type === 'num';
        sortAsc = sortCol === col ? !sortAsc : !isNum;
        sortCol = col;
        const tbody = table.querySelector('tbody');
        const rows = Array.from(tbody.querySelectorAll('tr'));
        rows.sort((a, b) => {
          const av = a.children[col].dataset.val || '';
          const bv = b.children[col].dataset.val || '';
          const cmp = isNum ? Number(av) - Number(bv) : av.localeCompare(bv);
          return sortAsc ? cmp : -cmp;
        });
        rows.forEach(row => tbody.appendChild(row));
        const pane = table.closest('.profile-pane');
        const ctrl = pane ? panePagers.get(pane) : undefined;
        if (ctrl) ctrl.reset();
      }));
    });

    if (matchesSec) {
      const toggleMatchRow = row => {
        const detail = row.nextElementSibling;
        if (!detail || !detail.classList.contains('battle-detail-row')) return;
        const open = !detail.classList.toggle('hide');
        row.classList.toggle('expanded', open);
        row.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
          const slot = detail.querySelector('.battle-detail[data-match-id]');
          if (slot && !slot._loadedLogUrl) {
            void loadRowReplay(slot, 1);
          }
        }
      };
      matchesSec.addEventListener('click', e => {
        const replayLink = e.target.closest('a[data-replay-log]');
        if (replayLink) {
          const detailRow = replayLink.closest('tr.battle-detail-row');
          const slot = detailRow
            ? detailRow.querySelector('.battle-detail[data-match-id]')
            : undefined;
          if (slot) {
            e.preventDefault();
            const gNum = Number(replayLink.getAttribute('data-replay-game')) || 1;
            void loadRowReplay(slot, gNum);
            return;
          }
        }
        if (e.target.closest('a')) return;
        const row = e.target.closest('tr.battle-row');
        if (row) toggleMatchRow(row);
      });
      matchesSec.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('tr.battle-row');
        if (row && e.target === row) {
          e.preventDefault();
          toggleMatchRow(row);
        }
      });
    }

    setInterval(() => {
      const nowSec = Math.floor(Date.now() / 1000);
      document.querySelectorAll('td[data-ts]').forEach(el => {
        const ts = Number(el.getAttribute('data-ts'));
        if (ts > 0) el.textContent = relTime(nowSec, ts);
      });
    }, 30000);
  });
`;
}

export interface AgentProfileDocument {
  slug: string;
  name: string;
  status: db.AgentRow['status'];
  logoHref?: string;
  owners: Array<{github: string; smogon?: string; smogonId?: number}>;
  metadata?: render.ProjectMeta;
  ladders: unknown[];
}

const LOGO_CONTENT_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export function resolveAgentLogo(
  agent: Pick<db.AgentRow, 'slug' | 'logo'>,
  avatarsDir = AVATARS_DIR
): {filePath: string; fileName: string; href: string; contentType: string} | undefined {
  if (!agent.logo) return undefined;
  const filePath = path.join(avatarsDir, agent.logo);
  if (!fs.existsSync(filePath)) return undefined;
  const ext = (path.extname(agent.logo) || '.png').toLowerCase();
  const fileName = `${agent.slug}${ext}`;
  return {
    filePath,
    fileName,
    href: `/projects/${encodeURIComponent(fileName)}`,
    contentType: LOGO_CONTENT_TYPES[ext] ?? 'application/octet-stream',
  };
}

export function renderAgentProfile(opts: {
  db: db.Database;
  renderer: Renderer;
  agent: db.AgentRow;
  links: render.AgentLinkContext;
  avatarsDir?: string;
  liveTournament?: {id: string; name: string};
  nowSec: number;
}): {html: string; json: AgentProfileDocument} {
  const {
    db,
    renderer,
    agent,
    links,
    avatarsDir = AVATARS_DIR,
    liveTournament,
    nowSec,
  } = opts;
  const {publicDir, projectMeta} = links;

  const ladders = db.getAgentParticipatedLadders(agent.id);
  const resolvedLogo = resolveAgentLogo(agent, avatarsDir);
  const logoHref = resolvedLogo?.href;
  const logoNode = logoHref
    ? <img className='project-logo' src={logoHref} alt={agent.name} />
    : undefined;

  const owners = db.getDevelopersForAgent(agent.id).map(d => ({
    github: d.githubLogin,
    smogon: d.smogonUsername,
    smogonId: d.smogonId,
  }));
  const meta = projectMeta.get(agent.name);
  const siteLink = meta?.site ? (
    <a href={meta.site} className='subtle' title='Project Homepage'>
      {util.raw(util.EXT_ICON)}
    </a>
  ) : undefined;
  const profileHeader = injectLiveBanner(
    header(<>{agent.name}{siteLink}</>),
    liveTournament
  );

  if (ladders.length === 0) {
    const statusNote = agent.status === 'pending' ? 'Pending qualification' : 'No active entries';
    const emptyReign = buildReignRowsHtml(
      {
        top1MaxStreakSeconds: 0,
        top1TotalSeconds: 0,
        top10MaxStreakSeconds: 0,
        top10TotalSeconds: 0,
        top100MaxStreakSeconds: 0,
        top100TotalSeconds: 0,
      },
      nowSec
    );
    const content = (
      <>
        {logoNode}
        <div className='controls-bar hide'>
          <nav aria-label='Format'>
            <ul>
              <li><span className='muted'>—</span></li>
            </ul>
          </nav>
          <span className='muted'>·</span>
          <div className='ver-picker'>
            <label htmlFor='ver-select' className='muted'>Version</label>
            <select id='ver-select' className='min-select' aria-label='Version'>
              <option value='all'>All (0)</option>
            </select>
          </div>
        </div>

        <section id='overview'>
          <div className='grid-2'>
            <table className='kv'>
              {buildProjectMetaRows(db, agent, meta, undefined)}
            </table>

            <table className='kv'>
              <tr>
                <td><strong>Rank</strong></td>
                <td id='stat-rank'><span className='muted'>— ({statusNote})</span></td>
              </tr>
              <tr>
                <td><strong>Elo</strong></td>
                <td id='stat-elo'><span className='muted'>—</span></td>
              </tr>
              <tr>
                <td><strong>GXE</strong></td>
                <td id='stat-gxe'><span className='muted'>—</span></td>
              </tr>
              <tr>
                <td><strong>Peak</strong></td>
                <td id='stat-peak'><span className='muted'>—</span></td>
              </tr>
              <tr>
                <td><strong>Matches</strong></td>
                <td id='stat-record'><span className='muted'>0–0–0</span></td>
              </tr>
              <tr>
                <td><strong>Streak</strong></td>
                <td id='stat-streak'><span className='muted'>—</span></td>
              </tr>
              <tr>
                <td><strong>Telemetry</strong></td>
                <td id='stat-telemetry'><span className='muted'>—</span></td>
              </tr>
            </table>
          </div>

          <div className='table-wrap reign hide'>
            <table>
              <thead>
                <tr>
                  <th>Reign</th>
                  <th className='num'>Current Streak</th>
                  <th className='num'>Longest Streak</th>
                  <th className='num'>Total Duration</th>
                </tr>
              </thead>
              <tbody id='reign-tbody'>
                {util.raw(emptyReign)}
              </tbody>
            </table>
          </div>
        </section>

        <p className='empty-state muted'>No Arena ladder entries yet.</p>

        <section id='versions' className='hide'>
          <h3><a href='#versions' className='subtle'>Versions</a></h3>
          <p className='empty-state muted'>No versions yet.</p>
        </section>

        <section id='matchups' className='hide'>
          <h3><a href='#matchups' className='subtle'>Head-to-Head</a></h3>
          <p className='empty-state muted'>No head-to-head matches yet.</p>
        </section>

        <section id='matches' className='hide'>
          <div className='matches-header'>
            <h3><a href='#matches' className='subtle'>Matches</a></h3>
            <div className='ver-picker'>
              <label htmlFor='opp-select' className='muted'>Opponent</label>
              <select id='opp-select' className='min-select' aria-label='Opponent'>
                <option value='all'>All (0)</option>
              </select>
            </div>
          </div>
          <p className='empty-state muted'>No completed matches yet.</p>
        </section>

        <script>{buildProfileScript({}, '', agent.slug, {})}</script>
      </>
    );
    const html = renderer.render({
      id: 'agent-profile',
      title: `${agent.name} | pkmn.ai`,
      header: profileHeader,
      path: `/projects/${agent.slug}/`,
      style: `${render.ARENA_STYLE}\n${PROFILE_STYLE}`,
      content,
    });
    return {
      html,
      json: {
        slug: agent.slug,
        name: agent.name,
        status: agent.status,
        logoHref,
        owners,
        metadata: meta,
        ladders: [],
      },
    };
  }

  const profileDataMap: Record<string, LadderProfileClientData> = {};
  const ladderJsonList: unknown[] = [];
  const formatNavParts: util.Child[] = [];
  const versionsPanes: util.Html[] = [];
  const matchupsPanes: util.Html[] = [];
  const matchesPanes: util.Html[] = [];
  const agentLinks: Record<string, string> = {};
  const registerAgentLink = (slug: string, name: string) => {
    if (Object.prototype.hasOwnProperty.call(agentLinks, slug)) return;
    agentLinks[slug] = render.resolveAgentHref(links, slug, name) ?? '';
  };
  registerAgentLink(agent.slug, agent.name);

  const usedKeys = new Set<string>();
  const ladderKeys = ladders.map(l => {
    const base = l.status !== 'archived' ? l.slot : l.id.toLowerCase();
    const key = usedKeys.has(base) ? l.id.toLowerCase() : base;
    usedKeys.add(key);
    return key;
  });

  const defaultLadderKey = ladderKeys[0];
  let latestOverallEntry: db.AgentLadderProfileEntry | undefined;
  let defaultMatchupsEmpty = true;

  for (let i = 0; i < ladders.length; i++) {
    const l = ladders[i];
    const lKey = ladderKeys[i];
    const isDefault = i === 0;

    const agentEntries = db.getAgentLadderProfileEntries(agent.id, l.id);
    if (!latestOverallEntry || (
      agentEntries[0] && agentEntries[0].submittedAt > latestOverallEntry.submittedAt
    )) {
      latestOverallEntry = agentEntries[0];
    }

    const allEntries = db.getLeaderboardEntries(l.id);
    const pairs = db.getPairAggregatesForLadder(l.id);
    const snapshots = db.getRatingSnapshotsForLadder(l.id, agent.id);
    const familyStats = db.getAgentLadderStats(l.id, agent.id);
    const recentMatches = db.getRecentMatchesForAgentOnLadder(agent.id, l.id);
    const adjacentLos = render.computeAdjacentLosMap(allEntries, pairs, l.status);

    for (const e of allEntries) {
      registerAgentLink(e.agentSlug, e.agentName);
    }
    for (const m of recentMatches) {
      registerAgentLink(m.p1.slug, m.p1.name);
      registerAgentLink(m.p2.slug, m.p2.name);
    }

    const statsJson = familyStats
      ? {
        bestRank: familyStats.bestRank,
        bestRankAt: familyStats.bestRankAt,
        maxLcb: familyStats.maxLcb !== undefined ? Math.round(familyStats.maxLcb) : undefined,
        maxElo: familyStats.maxElo !== undefined ? Math.round(familyStats.maxElo) : undefined,
        maxEloSe: familyStats.maxEloSe !== undefined
          ? Math.round(familyStats.maxEloSe * 10) / 10
          : undefined,
        maxEloAt: familyStats.maxEloAt,
        maxGxe: familyStats.maxGxe !== undefined
          ? Math.round(familyStats.maxGxe * 10) / 10
          : undefined,
        maxGxeAt: familyStats.maxGxeAt,
        currentWinStreak: familyStats.currentWinStreak,
        currentLossStreak: familyStats.currentLossStreak,
        maxWinStreak: familyStats.maxWinStreak,
        maxLossStreak: familyStats.maxLossStreak,
        reign: {
          top1: {
            enteredAt: familyStats.top1EnteredAt,
            maxStreakSeconds: familyStats.top1MaxStreakSeconds,
            totalSeconds: familyStats.top1TotalSeconds,
          },
          top10: {
            enteredAt: familyStats.top10EnteredAt,
            maxStreakSeconds: familyStats.top10MaxStreakSeconds,
            totalSeconds: familyStats.top10TotalSeconds,
          },
          top100: {
            enteredAt: familyStats.top100EnteredAt,
            maxStreakSeconds: familyStats.top100MaxStreakSeconds,
            totalSeconds: familyStats.top100TotalSeconds,
          },
        },
      }
      : undefined;

    ladderJsonList.push({
      key: lKey,
      id: l.id,
      slot: l.slot,
      name: l.name,
      format: l.format,
      team: l.team,
      status: l.status,
      ...(statsJson ? {stats: statsJson} : {}),
      versions: agentEntries.map(e => ({
        version: e.version,
        package: e.package,
        role: e.role,
        isAnchor: e.isAnchor,
        elo: Math.round(e.elo),
        se: Math.round(e.se * 10) / 10,
        lcb: Math.round(e.lcb),
        gxe: Math.round(e.gxe * 10) / 10,
        rankCurrent: e.rankCurrent,
        bestRank: e.bestRank,
        maxElo: e.maxElo !== undefined ? Math.round(e.maxElo) : undefined,
        matches: e.matches,
        wins: e.ww + e.wt,
        losses: e.ll + e.tl,
        ties: e.split,
        meanInitMillis: Math.round(e.meanInitMillis),
        ...(e.meanTeamPreviewMillis !== undefined
          ? {meanTeamPreviewMillis: Math.round(e.meanTeamPreviewMillis)}
          : {}),
        meanTurnMillis: Math.round(e.meanTurnMillis),
        meanRam: Math.round(e.meanRam),
        peakRam: Math.round(e.peakRam),
        maxWinStreak: e.maxWinStreak,
        maxLossStreak: e.maxLossStreak,
        submittedAt: e.submittedAt,
        settledAt: e.settledAt,
        retiredAt: e.retiredAt,
      })),
      recentMatches: recentMatches.map(m => arena.enrichMatchView(publicDir, m)),
    });

    if (i > 0) formatNavParts.push(' — ');
    formatNavParts.push(
      <li id={lKey}>
        <input
          type='radio'
          name='ladder'
          id={`lad-${lKey}`}
          value={lKey}
          checked={isDefault}
        />
        <label htmlFor={`lad-${lKey}`}>{l.name}</label>
      </li>
    );

    const optNodes = (
      <>
        <option value='all' selected={true}>All ({agentEntries.length})</option>
        {agentEntries.map(e => {
          const stateTag = e.role === 'retired' ? 'retired' : 'active';
          return <option value={e.version}>{e.version} ({stateTag})</option>;
        })}
      </>
    );

    const verById = new Map<number, db.LadderVersionIdentity>();
    const oppMap = new Map<string, {slug: string; name: string; count: number}>();
    for (const e of allEntries) {
      if (e.agentId !== agent.id && !oppMap.has(e.agentSlug)) {
        oppMap.set(e.agentSlug, {slug: e.agentSlug, name: e.agentName, count: 0});
      }
    }
    for (const v of db.getLadderVersionIdentities(l.id)) {
      verById.set(v.versionId, v);
    }

    const oppCounts: Record<string, Record<string, number>> = {
      all: {all: 0},
    };
    for (const e of agentEntries) {
      oppCounts[e.version] = {all: 0};
    }

    for (const p of pairs) {
      const count = p.ww + p.wt + p.split + p.tl + p.ll;
      if (count <= 0) continue;
      const low = verById.get(p.lowVersionId);
      const high = verById.get(p.highVersionId);
      if (!low || !high) continue;
      if (low.agentId === agent.id && high.agentId === agent.id) {
        oppCounts.all.all += count;
        const lowBucket = oppCounts[low.version] ?? (oppCounts[low.version] = {all: 0});
        lowBucket.all += count;
        if (high.version !== low.version) {
          const highBucket = oppCounts[high.version] ?? (oppCounts[high.version] = {all: 0});
          highBucket.all += count;
        }
        continue;
      }
      const ourEntry = low.agentId === agent.id
        ? low
        : (high.agentId === agent.id ? high : undefined);
      const oppEntry = low.agentId === agent.id
        ? high
        : (high.agentId === agent.id ? low : undefined);
      if (!ourEntry || !oppEntry) continue;

      oppCounts.all.all += count;
      oppCounts.all[oppEntry.agentSlug] = (oppCounts.all[oppEntry.agentSlug] ?? 0) + count;

      const verBucket = oppCounts[ourEntry.version] ?? (oppCounts[ourEntry.version] = {all: 0});
      verBucket.all += count;
      verBucket[oppEntry.agentSlug] = (verBucket[oppEntry.agentSlug] ?? 0) + count;

      const oppRec = oppMap.get(oppEntry.agentSlug);
      if (oppRec) {
        oppRec.count += count;
      } else {
        oppMap.set(oppEntry.agentSlug, {
          slug: oppEntry.agentSlug,
          name: oppEntry.agentName,
          count,
        });
      }
    }

    const sortedOpps = [...oppMap.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name)
    );
    const oppOptNodes = (
      <>
        <option value='all' selected={true}>All ({oppCounts.all.all})</option>
        {sortedOpps.map(o => (
          <option value={o.slug}>{o.name} ({o.count})</option>
        ))}
      </>
    );

    const vstats: Record<string, VersionDynamicStats> = {
      all: buildAllVersionsDynamicStats(agentEntries, familyStats, adjacentLos),
    };
    const reign: Record<string, string> = {
      all: buildReignRowsHtml(
        familyStats ?? {
          top1MaxStreakSeconds: 0,
          top1TotalSeconds: 0,
          top10MaxStreakSeconds: 0,
          top10TotalSeconds: 0,
          top100MaxStreakSeconds: 0,
          top100TotalSeconds: 0,
        },
        nowSec
      ),
    };

    for (const e of agentEntries) {
      vstats[e.version] = buildVersionDynamicStats(e, adjacentLos);
      reign[e.version] = buildReignRowsHtml(
        {
          top1EnteredAt: e.top1EnteredAt,
          top1MaxStreakSeconds: e.top1MaxStreakSeconds,
          top1TotalSeconds: e.top1TotalSeconds,
          top10EnteredAt: e.top10EnteredAt,
          top10MaxStreakSeconds: e.top10MaxStreakSeconds,
          top10TotalSeconds: e.top10TotalSeconds,
          top100EnteredAt: e.top100EnteredAt,
          top100MaxStreakSeconds: e.top100MaxStreakSeconds,
          top100TotalSeconds: e.top100TotalSeconds,
        },
        nowSec
      );
    }

    profileDataMap[lKey] = {
      ladderId: l.id,
      multiVersion: agentEntries.length > 1,
      optionsHtml: String(optNodes),
      oppOptionsHtml: String(oppOptNodes),
      oppCounts,
      vstats,
      reign,
    };

    versionsPanes.push(
      renderVersionsPane({
        agentName: agent.name,
        ladderKey: lKey,
        isDefault,
        entriesDesc: agentEntries,
        snapshots,
        nowSec,
      })
    );
    const h2hRes = renderHeadToHeadPane({
      agentId: agent.id,
      ladderKey: lKey,
      isDefault,
      agentEntries,
      allEntries,
      pairs,
      links,
    });
    matchupsPanes.push(h2hRes.pane);
    if (isDefault) {
      defaultMatchupsEmpty = h2hRes.empty;
    }

    matchesPanes.push(
      renderRecentMatchesPane({
        agentSlug: agent.slug,
        ladderKey: lKey,
        isDefault,
        matches: recentMatches,
        totalMatches: oppCounts.all.all,
        agentLinks,
        publicDir,
        nowSec,
      })
    );
  }

  const initialData = profileDataMap[defaultLadderKey];
  const initStats = initialData.vstats.all;
  const content = (
    <>
      {logoNode}
      <div className='controls-bar'>
        <nav aria-label='Format'>
          <ul>{formatNavParts}</ul>
        </nav>
        <span id='ver-sep' className={initialData.multiVersion ? 'muted' : 'muted hide'}>·</span>
        <div
          id='ver-picker'
          className={initialData.multiVersion ? 'ver-picker' : 'ver-picker hide'}
        >
          <label htmlFor='ver-select' className='muted'>Version</label>
          <select id='ver-select' className='min-select' aria-label='Version'>
            {util.raw(initialData.optionsHtml)}
          </select>
        </div>
      </div>

      <section id='overview'>
        <div className='grid-2'>
          <table className='kv'>
            {buildProjectMetaRows(db, agent, meta, latestOverallEntry)}
          </table>

          <table className='kv'>
            <tr>
              <td><strong>Rank</strong></td>
              <td id='stat-rank'>{util.raw(initStats.rank)}</td>
            </tr>
            <tr><td><strong>Elo</strong></td><td id='stat-elo'>{util.raw(initStats.elo)}</td></tr>
            <tr><td><strong>GXE</strong></td><td id='stat-gxe'>{util.raw(initStats.gxe)}</td></tr>
            <tr>
              <td><strong>Peak</strong></td>
              <td id='stat-peak'>{util.raw(initStats.peak)}</td>
            </tr>
            <tr>
              <td><strong>Matches</strong></td>
              <td id='stat-record'>{util.raw(initStats.record)}</td>
            </tr>
            <tr>
              <td><strong>Streak</strong></td>
              <td id='stat-streak'>{util.raw(initStats.streak)}</td>
            </tr>
            <tr>
              <td><strong>Telemetry</strong></td>
              <td id='stat-telemetry'>{util.raw(initStats.telemetry)}</td>
            </tr>
          </table>
        </div>

        <div className={initialData.reign.all ? 'table-wrap reign' : 'table-wrap reign hide'}>
          <table>
            <thead>
              <tr>
                <th>Reign</th>
                <th className='num'>Current Streak</th>
                <th className='num'>Longest Streak</th>
                <th className='num'>Total Duration</th>
              </tr>
            </thead>
            <tbody id='reign-tbody'>
              {util.raw(initialData.reign.all)}
            </tbody>
          </table>
        </div>
      </section>

      <section id='versions'>
        <h3><a href='#versions' className='subtle'>Versions</a></h3>
        {versionsPanes}
      </section>

      <section id='matchups' className={defaultMatchupsEmpty ? 'hide' : undefined}>
        <h3><a href='#matchups' className='subtle'>Head-to-Head</a></h3>
        {matchupsPanes}
      </section>

      <section id='matches'>
        <div className='matches-header'>
          <h3><a href='#matches' className='subtle'>Matches</a></h3>
          <div className='ver-picker'>
            <label htmlFor='opp-select' className='muted'>Opponent</label>
            <select id='opp-select' className='min-select' aria-label='Opponent'>
              {util.raw(initialData.oppOptionsHtml)}
            </select>
          </div>
        </div>
        {matchesPanes}
      </section>

      <script>
        {buildProfileScript(profileDataMap, defaultLadderKey, agent.slug, agentLinks)}
      </script>
    </>
  );

  const html = renderer.render({
    id: 'agent-profile',
    title: `${agent.name} | pkmn.ai`,
    header: profileHeader,
    path: `/projects/${agent.slug}/`,
    style: `${render.ARENA_STYLE}\n${PROFILE_STYLE}`,
    content,
  });

  return {
    html,
    json: {
      slug: agent.slug,
      name: agent.name,
      status: agent.status,
      logoHref,
      owners,
      metadata: meta,
      ladders: ladderJsonList,
    },
  };
}
