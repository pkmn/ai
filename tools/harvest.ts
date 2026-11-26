require('source-map-support').install();

import {spawn} from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import {Worker, isMainThread, parentPort, workerData} from 'worker_threads';

import {Dex, ID, ModdedDex, toID} from '@pkmn/dex';
import {PokemonSet, Team} from '@pkmn/sets';
import * as sim from '@pkmn/sim';
import {
  Display, Parser, Reports, Statistics, Stats, newGenerations,
} from '@pkmn/stats';
import stringify from 'json-stringify-pretty-compact';

import * as serverTeams from '../server/teams';
import {root} from '../static/util';
import * as teams from '../teams';

type ParserLog = Parameters<typeof Parser.parse>[2];

interface WorkerConfig {
  format: ID;
  genNum: number;
  cutoff: number;
  sidecarEloFloor: number;
  sidecarGxeFloor: number;
  keepAllSidecar: boolean;
}

interface PilotSummary {
  games: number;
  wins: number;
  losses: number;
  ties: number;
  peakElo: number;
  peakOldElo: number;
  peakGxe: number;
  peakGxeAny: number;
  peakConservativeR: number;
  minRprd: number;
  lastTs: number;
  endElo: number;
  endGxe: number;
  endRpr: number;
  endRprd: number;
}

interface MonthlySummary {
  battles: number;
  species: {[id: string]: number};
}

interface WorkerResult {
  stats: Statistics;
  stallinessBuckets: Array<[number, number, number]>;
  pilots: Array<[string, PilotSummary]>;
  eloHist: number[];
  gxeHist: number[];
  rprHist: number[];
  monthly: {[month: string]: MonthlySummary};
  processed: number;
  parseErrors: number;
  errorSamples: string[];
  sidecarCount: number;
}

interface RawRating {
  userid?: string;
  elo?: number;
  oldelo?: number;
  gxe?: number;
  r?: number;
  rd?: number;
  rpr?: number;
  rprd?: number;
}

interface RawLog extends Omit<ParserLog, 'p1rating' | 'p2rating'> {
  p1rating: RawRating | null;
  p2rating: RawRating | null;
  roomid?: string;
}

const GENS = newGenerations(Dex);

const FORMAT_DEFAULTS: Record<string, {
  gen: number;
  cutoff: number;
  sidecarEloFloor: number;
  sidecarGxeFloor: number;
  keepAllSidecar: boolean;
}> = {
  gen1ou: {gen: 1, cutoff: 1630, sidecarEloFloor: 0, sidecarGxeFloor: 0, keepAllSidecar: true},
  gen3ou: {gen: 3, cutoff: 1630, sidecarEloFloor: 1350, sidecarGxeFloor: 65, keepAllSidecar: false},
  gen9ou: {gen: 9, cutoff: 1695, sidecarEloFloor: 1450, sidecarGxeFloor: 68, keepAllSidecar: false},
};

const ELO_MIN = 1000;
const ELO_BINS = 2001;
const GXE_BINS = 1001;
const TAR_BLOCK = 512;

interface Percentiles {
  p50: number;
  p75: number;
  p80: number;
  p85: number;
  p90: number;
  p95: number;
  p97: number;
  p99: number;
}

interface Pass1PilotsFile {
  format: ID;
  cutoff: number;
  processedLogs: number;
  parseErrors: number;
  sidecarBattles: number;
  ratedSides: number;
  uniquePilots: number;
  distributions: {
    oldElo: Percentiles;
    gxe: Percentiles;
    rpr: Percentiles;
  };
  monthly: {[month: string]: MonthlySummary};
  pilots: Array<[string, PilotSummary]>;
}

interface SidecarRecord {
  id: string;
  ts: number;
  t: number;
  e: string;
  w: 0 | 1 | 2;
  p1: string;
  p2: string;
  r1: number[]; // [oldelo, elo, r, rd, rpr, rprd, gxe]
  r2: number[];
  t1: Array<Partial<PokemonSet>>;
  t2: Array<Partial<PokemonSet>>;
}

function parseArgs(argv: string[]): {cmd: string; flags: Map<string, string>} {
  const cmd = argv[0] || '';
  const flags = new Map<string, string>();
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags.set(arg.slice(2), argv[++i]);
    } else {
      flags.set(arg.slice(2), 'true');
    }
  }
  return {cmd, flags};
}

function numFlag(flags: Map<string, string>, key: string, fallback: number): number {
  const raw = flags.get(key);
  if (raw === undefined) return fallback;
  const val = Number(raw);
  if (!Number.isFinite(val)) throw new Error(`Invalid numeric flag --${key}=${raw}`);
  return val;
}

function histPercentile(hist: number[], offset: number, scale: number, p: number): number {
  let total = 0;
  for (const v of hist) total += v;
  if (total === 0) return 0;
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return Math.round(((i + offset) / scale) * 100) / 100;
  }
  return Math.round(((hist.length - 1 + offset) / scale) * 100) / 100;
}

function computePercentiles(hist: number[], offset: number, scale: number): Percentiles {
  return {
    p50: histPercentile(hist, offset, scale, 0.50),
    p75: histPercentile(hist, offset, scale, 0.75),
    p80: histPercentile(hist, offset, scale, 0.80),
    p85: histPercentile(hist, offset, scale, 0.85),
    p90: histPercentile(hist, offset, scale, 0.90),
    p95: histPercentile(hist, offset, scale, 0.95),
    p97: histPercentile(hist, offset, scale, 0.97),
    p99: histPercentile(hist, offset, scale, 0.99),
  };
}

function mergePilotSummary(a: PilotSummary, b: PilotSummary): PilotSummary {
  const aLatest = a.lastTs >= b.lastTs;
  return {
    games: a.games + b.games,
    wins: a.wins + b.wins,
    losses: a.losses + b.losses,
    ties: a.ties + b.ties,
    peakElo: Math.max(a.peakElo, b.peakElo),
    peakOldElo: Math.max(a.peakOldElo, b.peakOldElo),
    peakGxe: Math.max(a.peakGxe, b.peakGxe),
    peakGxeAny: Math.max(a.peakGxeAny, b.peakGxeAny),
    peakConservativeR: Math.max(a.peakConservativeR, b.peakConservativeR),
    minRprd: Math.min(a.minRprd, b.minRprd),
    lastTs: aLatest ? a.lastTs : b.lastTs,
    endElo: aLatest ? a.endElo : b.endElo,
    endGxe: aLatest ? a.endGxe : b.endGxe,
    endRpr: aLatest ? a.endRpr : b.endRpr,
    endRprd: aLatest ? a.endRprd : b.endRprd,
  };
}

function fmod(a: number, b: number): number {
  const m = a % b;
  return m < 0 ? m + b : m;
}

// Reproduces `Reports.metagameReport` from quantized stalliness buckets so 4.56M-battle
// `gen9ou` archives do not allocate ~55M `[val, weight]` tuples in V8 heap.
function metagameReportFromBuckets(
  stats: Statistics,
  buckets: Map<number, [number, number]>,
): string {
  const metagame = stats.metagame;
  const W = Math.max(1.0, stats.usage.weighted);

  const tags = Object.entries(metagame.tags).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  let s = '';
  for (const [tag, weight] of tags) {
    const dots = '.'.repeat(Math.max(0, 18 - tag.length));
    s += `${tag}${dots}${((100.0 * weight) / W * 6.0).toFixed(5)}%\n`;
  }
  s += '\n';

  if (buckets.size === 0) return s;

  const sorted = [...buckets.entries()]
    .map(([key, [count, weight]]) => ({val: key / 1000, count, weight}))
    .sort((a, b) => a.val - b.val);

  let totalCount = 0;
  for (const b of sorted) totalCount += b.count;
  if (totalCount === 0) return s;

  const qIdx = Math.floor(totalCount / 1000);
  const valAtRank = (rank: number): number => {
    let seen = 0;
    for (const b of sorted) {
      seen += b.count;
      if (seen > rank) return b.val;
    }
    return sorted[sorted.length - 1].val;
  };

  let low = valAtRank(qIdx);
  let high = valAtRank(totalCount - qIdx - 1);
  if (low > 0) low = 0;
  else if (high < 0) high = 0;

  let nbins = 13;
  const size = (high - low) / (nbins - 1);
  const binSize =
    [10, 5, 2.5, 2, 1.5, 1, 0.5, 0.25, 0.2, 0.1, 0.05].find(bs => size > bs) || 0.05;

  let histogram: Array<[number, number]> = [[0, 0]];
  for (let x = binSize; x + binSize / 2 < high; x += binSize) {
    histogram.push([x, 0]);
  }
  for (let x = -binSize; x - binSize / 2 > low; x -= binSize) {
    histogram.push([x, 0]);
  }
  histogram = histogram.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  nbins = histogram.length;

  let j = 0;
  let weightedSum = 0;
  let totalWeight = 0;
  for (const b of sorted) {
    weightedSum += b.val * b.weight;
    totalWeight += b.weight;
    while (j < nbins && b.val > histogram[0][0] + binSize * (j + 0.5)) j++;
    if (j < nbins) {
      histogram[j][1] += b.weight;
    }
  }

  const mean = totalWeight > 0 ? weightedSum / totalWeight : 0;
  let max = 0;
  for (const h of histogram) {
    if (h[1] > max) max = h[1];
  }

  const MAX_BLOCKS = 30;
  const blockSize = max / MAX_BLOCKS;
  if (blockSize <= 0) return s;

  s += `Stalliness (mean: ${mean.toFixed(3)})\n`;
  for (const h of histogram) {
    let line = '    |';
    if (fmod(h[0], 2 * binSize) < binSize / 2) {
      line = '';
      if (h[0] > 0) line += '+';
      else if (h[0] === 0) line += ' ';
      line += `${h[0].toFixed(1)}|`;
    }
    s += line + '#'.repeat(Math.round(h[1] / blockSize)) + '\n';
  }
  s += 'more negative = more offensive, more positive = more stall\n';
  s += `one # = ${((100.0 * blockSize) / totalWeight).toFixed(2)}%\n`;
  return s;
}

function parseTarInt(field: Buffer): number {
  if (field[0] & 0x80) {
    let val = field[0] & 0x7f;
    for (let i = 1; i < field.length; i++) val = val * 256 + field[i];
    return val;
  }
  const str = field.toString('ascii').split('\0')[0].trim();
  return str ? parseInt(str, 8) : 0;
}

function parsePax(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const len = parseInt(data.subarray(i, sp).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    let rec = data.subarray(sp + 1, i + len).toString('utf8');
    if (rec.endsWith('\n')) rec = rec.slice(0, -1);
    const eq = rec.indexOf('=');
    if (eq !== -1) out.set(rec.slice(0, eq), rec.slice(eq + 1));
    i += len;
  }
  return out;
}

async function runPass1(flags: Map<string, string>) {
  const format = toID(flags.get('format'));
  const archive = flags.get('archive');
  const outDir = flags.get('out');
  const numWorkers = numFlag(flags, 'workers', 5);
  const batchSize = numFlag(flags, 'batch', 1000);

  const defaults = FORMAT_DEFAULTS[format];
  if (!defaults) {
    throw new Error(`Unsupported format '${format}' (expected gen1ou, gen3ou, gen9ou)`);
  }
  if (!archive || !fs.existsSync(archive)) {
    throw new Error(`Archive not found: ${archive}`);
  }
  if (!outDir) {
    throw new Error('Missing required --out <dir> flag');
  }

  fs.mkdirSync(path.join(outDir, 'stats'), {recursive: true});
  fs.mkdirSync(path.join(outDir, 'pilots'), {recursive: true});
  fs.mkdirSync(path.join(outDir, 'sidecar'), {recursive: true});

  const sidecarPath = path.join(outDir, 'sidecar', `${format}.ndjson.zst`);
  const sidecarPart = `${sidecarPath}.part`;
  const zstdWriter = spawn('zstd', ['-3', '-T2', '-q', '-f', '-o', sidecarPart], {
    stdio: ['pipe', 'ignore', 'inherit'],
  });

  const workerConfig: WorkerConfig = {
    format,
    genNum: defaults.gen,
    cutoff: defaults.cutoff,
    sidecarEloFloor: defaults.sidecarEloFloor,
    sidecarGxeFloor: defaults.sidecarGxeFloor,
    keepAllSidecar: defaults.keepAllSidecar,
  };

  interface WorkerSlot {
    worker: Worker;
    inFlight: number;
  }

  const slots: WorkerSlot[] = [];
  let totalInFlight = 0;
  let dispatchedFiles = 0;
  let completedBatches = 0;
  let sidecarWritesPending = 0;
  let batchSeq = 0;
  const maxInFlight = numWorkers * 2;
  const t0 = Date.now();
  let lastLog = t0;

  const zstdReader = spawn('zstdcat', [archive], {stdio: ['ignore', 'pipe', 'inherit']});
  let readerPaused = false;
  let readerDone = false;
  let resolveAllBatches!: () => void;
  let rejectAllBatches!: (err: Error) => void;
  const allBatchesDone = new Promise<void>((res, rej) => {
    resolveAllBatches = res;
    rejectAllBatches = rej;
  });

  function maybeResumeReader() {
    if (readerPaused && !readerDone && totalInFlight < maxInFlight && sidecarWritesPending < 4) {
      readerPaused = false;
      zstdReader.stdout.resume();
    }
  }

  function checkFinished() {
    if (readerDone && totalInFlight === 0 && sidecarWritesPending === 0) {
      resolveAllBatches();
    }
  }

  for (let i = 0; i < numWorkers; i++) {
    const worker = new Worker(__filename, {workerData: workerConfig});
    const slot: WorkerSlot = {worker, inFlight: 0};
    worker.on('message', (msg: {type: string; sidecarChunk?: string}) => {
      if (msg.type !== 'batchDone') return;
      slot.inFlight--;
      totalInFlight--;
      completedBatches++;

      if (msg.sidecarChunk && msg.sidecarChunk.length > 0) {
        const ok = zstdWriter.stdin.write(msg.sidecarChunk);
        if (!ok) {
          sidecarWritesPending++;
          if (!readerPaused && !readerDone) {
            readerPaused = true;
            zstdReader.stdout.pause();
          }
          zstdWriter.stdin.once('drain', () => {
            sidecarWritesPending--;
            maybeResumeReader();
            checkFinished();
          });
        }
      }

      const now = Date.now();
      if (now - lastLog >= 15000) {
        const sec = ((now - t0) / 1000).toFixed(1);
        const rate = Math.round((completedBatches * batchSize) / ((now - t0) / 1000));
        console.log(
          `[pass1:${format}] ${sec}s: ~${(completedBatches * batchSize).toLocaleString()} logs ` +
          `(~${rate.toLocaleString()}/s, inFlight=${totalInFlight})`,
        );
        lastLog = now;
      }

      maybeResumeReader();
      checkFinished();
    });
    worker.on('error', err =>
      rejectAllBatches(err instanceof Error ? err : new Error(String(err))));
    slots.push(slot);
  }

  function dispatchBatch(items: Array<[string, string]>) {
    let best = slots[0];
    for (let i = 1; i < slots.length; i++) {
      if (slots[i].inFlight < best.inFlight) best = slots[i];
    }
    best.inFlight++;
    totalInFlight++;
    best.worker.postMessage({type: 'batch', id: ++batchSeq, items});
    if (totalInFlight >= maxInFlight && !readerPaused) {
      readerPaused = true;
      zstdReader.stdout.pause();
    }
  }

  // Stream-parse POSIX/ustar tar stream from zstdcat
  const chunks: Buffer[] = [];
  let bufferedLen = 0;
  let tarState: 'hdr' | 'data' = 'hdr';
  let entryType = '0';
  let entryName = '';
  let entrySize = 0;
  let entryPadded = 0;
  const pax = new Map<string, string>();
  let gnuLongName: string | undefined;
  let tarEof = false;
  let currentBatch: Array<[string, string]> = [];

  function takeBytes(n: number): Buffer {
    if (chunks.length === 1) {
      const only = chunks[0];
      if (only.length === n) {
        chunks.length = 0;
        bufferedLen = 0;
        return only;
      }
      const slice = only.subarray(0, n);
      chunks[0] = only.subarray(n);
      bufferedLen -= n;
      return slice;
    }
    const merged = Buffer.concat(chunks, bufferedLen);
    chunks.length = 0;
    if (merged.length === n) {
      bufferedLen = 0;
      return merged;
    }
    const slice = merged.subarray(0, n);
    chunks.push(merged.subarray(n));
    bufferedLen = merged.length - n;
    return slice;
  }

  zstdReader.stdout.on('data', (chunk: Buffer) => {
    if (tarEof) return;
    chunks.push(chunk);
    bufferedLen += chunk.length;

    while (!tarEof) {
      if (tarState === 'hdr') {
        if (bufferedLen < TAR_BLOCK) break;
        const hdr = takeBytes(TAR_BLOCK);
        let allZero = true;
        for (let i = 0; i < TAR_BLOCK; i++) {
          if (hdr[i] !== 0) {
            allZero = false;
            break;
          }
        }
        if (allZero) {
          tarEof = true;
          break;
        }
        entryType = String.fromCharCode(hdr[156]);
        entrySize = parseTarInt(hdr.subarray(124, 136));
        const paxSize = pax.get('size');
        if (paxSize !== undefined) entrySize = Number(paxSize);
        entryPadded = Math.ceil(entrySize / TAR_BLOCK) * TAR_BLOCK;

        if (entryType === 'L' || entryType === 'x' || entryType === 'g') {
          tarState = 'data';
          continue;
        }

        const paxPath = pax.get('path');
        if (paxPath !== undefined) {
          entryName = paxPath;
        } else if (gnuLongName !== undefined) {
          entryName = gnuLongName;
        } else {
          const namePart = hdr.subarray(0, 100).toString('utf8').split('\0')[0];
          const prefixPart = hdr.subarray(345, 500).toString('utf8').split('\0')[0];
          entryName = prefixPart ? `${prefixPart}/${namePart}` : namePart;
        }
        pax.clear();
        gnuLongName = undefined;
        tarState = 'data';
      }

      if (tarState === 'data') {
        if (bufferedLen < entryPadded) break;
        const rawData = entryPadded > 0 ? takeBytes(entryPadded) : Buffer.alloc(0);
        const body = rawData.subarray(0, entrySize);
        tarState = 'hdr';

        if (entryType === 'L') {
          gnuLongName = body.toString('utf8').replace(/\0+$/, '');
          continue;
        }
        if (entryType === 'x') {
          for (const [k, v] of parsePax(body)) pax.set(k, v);
          continue;
        }
        if (entryType === 'g') continue;
        if (entryType !== '0' && entryType !== '\0') continue;
        if (!entryName.endsWith('.json')) continue;

        currentBatch.push([path.basename(entryName), body.toString('utf8')]);
        dispatchedFiles++;
        if (currentBatch.length >= batchSize) {
          dispatchBatch(currentBatch);
          currentBatch = [];
        }
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    zstdReader.on('error', reject);
    zstdReader.stdout.on('end', () => {
      if (currentBatch.length > 0) {
        dispatchBatch(currentBatch);
        currentBatch = [];
      }
      readerDone = true;
      checkFinished();
      resolve();
    });
  });

  await allBatchesDone;

  await new Promise<void>((resolve, reject) => {
    zstdWriter.on('error', reject);
    zstdWriter.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`zstd writer exited with code ${code}`));
    });
    zstdWriter.stdin.end();
  });
  fs.renameSync(sidecarPart, sidecarPath);

  console.log(
    `[pass1:${format}] Stream finished (${dispatchedFiles.toLocaleString()} files in ` +
    `${((Date.now() - t0) / 1000).toFixed(1)}s). Merging ${numWorkers} workers sequentially...`,
  );

  let masterStats: Statistics | undefined;
  const masterStalliness = new Map<number, [number, number]>();
  const masterPilots = new Map<string, PilotSummary>();
  const eloHist = new Array<number>(ELO_BINS).fill(0);
  const gxeHist = new Array<number>(GXE_BINS).fill(0);
  const rprHist = new Array<number>(ELO_BINS).fill(0);
  const monthly: {[month: string]: MonthlySummary} = {};
  let totalProcessed = 0;
  let totalErrors = 0;
  let totalSidecar = 0;
  const allErrorSamples: string[] = [];

  for (let i = 0; i < slots.length; i++) {
    const res = await new Promise<WorkerResult>((resolve, reject) => {
      const w = slots[i].worker;
      w.once('message', (msg: {type: string; result?: WorkerResult}) => {
        if (msg.type === 'done' && msg.result) resolve(msg.result);
        else reject(new Error(`Unexpected finish message from worker ${i}`));
      });
      w.postMessage({type: 'finish'});
    });
    await slots[i].worker.terminate();

    masterStats = masterStats ? Stats.combine(masterStats, res.stats) : res.stats;
    for (const [k, c, w] of res.stallinessBuckets) {
      const prev = masterStalliness.get(k);
      if (prev) {
        prev[0] += c;
        prev[1] += w;
      } else {
        masterStalliness.set(k, [c, w]);
      }
    }
    for (const [pid, psum] of res.pilots) {
      const prev = masterPilots.get(pid);
      masterPilots.set(pid, prev ? mergePilotSummary(prev, psum) : psum);
    }
    for (let b = 0; b < ELO_BINS; b++) eloHist[b] += res.eloHist[b];
    for (let b = 0; b < GXE_BINS; b++) gxeHist[b] += res.gxeHist[b];
    for (let b = 0; b < ELO_BINS; b++) rprHist[b] += res.rprHist[b];
    for (const [m, msum] of Object.entries(res.monthly)) {
      let dst = monthly[m];
      if (!dst) {
        dst = {battles: 0, species: {}};
        monthly[m] = dst;
      }
      dst.battles += msum.battles;
      for (const [sp, cnt] of Object.entries(msum.species)) {
        dst.species[sp] = (dst.species[sp] || 0) + cnt;
      }
    }
    totalProcessed += res.processed;
    totalErrors += res.parseErrors;
    totalSidecar += res.sidecarCount;
    for (const sample of res.errorSamples) {
      if (allErrorSamples.length < 20) allErrorSamples.push(sample);
    }
  }

  if (!masterStats) throw new Error('No statistics accumulated');

  const gen = GENS.get(defaults.gen);
  const usageReport = Reports.usageReport(gen, format, masterStats, true);
  const movesetReports = Reports.movesetReports(
    gen, format, masterStats, defaults.cutoff, null, [20, 0.5], true,
  );
  const metagameReport = metagameReportFromBuckets(masterStats, masterStalliness);
  const leadsReport = Reports.leadsReport(gen, masterStats, true);

  const display = Display.fromReports(
    gen,
    usageReport,
    movesetReports.basic,
    movesetReports.detailed,
    metagameReport,
    leadsReport,
  );

  const statsPath = path.join(outDir, 'stats', `${format}.json`);
  fs.writeFileSync(statsPath, stringify(display));

  let ratedSides = 0;
  for (const v of eloHist) ratedSides += v;

  const pilotsData: Pass1PilotsFile = {
    format,
    cutoff: defaults.cutoff,
    processedLogs: totalProcessed,
    parseErrors: totalErrors,
    sidecarBattles: totalSidecar,
    ratedSides,
    uniquePilots: masterPilots.size,
    distributions: {
      oldElo: computePercentiles(eloHist, ELO_MIN, 1),
      gxe: computePercentiles(gxeHist, 0, 10),
      rpr: computePercentiles(rprHist, ELO_MIN, 1),
    },
    monthly,
    pilots: [...masterPilots.entries()],
  };
  const pilotsPath = path.join(outDir, 'pilots', `${format}.json`);
  fs.writeFileSync(pilotsPath, JSON.stringify(pilotsData));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[pass1:${format}] DONE in ${elapsed}s | logs=${totalProcessed.toLocaleString()} ` +
    `errors=${totalErrors} | statsBattles=${display.battles.toLocaleString()} ` +
    `species=${Object.keys(display.pokemon).length} | ` +
    `pilots=${masterPilots.size.toLocaleString()} sidecar=${totalSidecar.toLocaleString()}`,
  );
  console.log(`[pass1:${format}] oldElo percentiles:`, pilotsData.distributions.oldElo);
  console.log(`[pass1:${format}] gxe percentiles:`, pilotsData.distributions.gxe);
  console.log(`[pass1:${format}] rpr percentiles:`, pilotsData.distributions.rpr);
  if (allErrorSamples.length > 0) {
    console.log(`[pass1:${format}] sample parse errors:`, allErrorSamples.slice(0, 5));
  }
}

// --- Pass 2: Team Harvesting, Opponent-Adjusted Scoring, Distinct Selection & Public Analysis ---

function victoryChance(r1: number, d1: number, r2: number, d2: number): number {
  const c = (3.0 * Math.pow(Math.log(10.0), 2.0)) / Math.pow(400.0 * Math.PI, 2);
  const d = d1 * d1 + d2 * d2;
  return 1.0 / (1.0 + Math.pow(10.0, (r2 - r1) / 400.0 / Math.sqrt(1.0 + c * d)));
}

interface Trajectory {
  pilotId: string;
  dedupeKey: string;
  canonicalPacked: string;
  uniquenessSets: Array<Partial<PokemonSet>>;
  speciesSet: Set<string>;
  variantCounts: Map<string, number>;
  wins: number;
  losses: number;
  ties: number;
  expectedWins: number;
  oppRatingSum: number;
  oppEloSum: number;
  netEloDelta: number;
  maxEloWon: number;
  maxOppEloBeaten: number;
  lastTs: number;
}

interface ScoredTeam {
  dedupeKey: string;
  canonicalPacked: string;
  uniquenessSets: Array<Partial<PokemonSet>>;
  speciesSet: Set<string>;
  pilots: string[];
  wins: number;
  losses: number;
  ties: number;
  expectedWins: number;
  surplus: number;
  avgOppR: number;
  avgOppElo: number;
  netEloDelta: number;
  maxEloWon: number;
  maxOppEloBeaten: number;
  tpr: number;
  conservativeTpr: number;
  finalScore: number;
  lastTs: number;
  nearestPublicId?: string;
  nearestPublicDist?: number;
}

interface PublicEntry {
  id: string;
  canonicalPacked: string;
  sets: Array<Partial<PokemonSet>>;
  speciesSet: Set<string>;
}

function makeUniquenessSets(
  dex: ModdedDex,
  canonicalSets: Array<Partial<PokemonSet>>,
  defaultLevel: number,
): {sets: Array<Partial<PokemonSet>>; speciesSet: Set<string>; dedupeKey: string} {
  const uniq = structuredClone(canonicalSets);
  for (const s of uniq) {
    const cid = teams.canonSpecies(dex, s.species);
    s.species = cid;
    s.shiny = undefined;
    s.gender = undefined;
    if (defaultLevel === 50 && (s.level ?? defaultLevel) > defaultLevel) {
      s.level = defaultLevel;
    }
  }
  const speciesSet = new Set(uniq.map(s => String(s.species ?? '')));
  // Build deterministic dedupe key using display species names stripped of cosmetic info
  const keySets = structuredClone(uniq);
  for (const s of keySets) {
    const sp = dex.species.get(String(s.species ?? ''));
    if (sp.exists) s.species = sp.name;
  }
  const dedupeKey = new Team(Team.canonicalize(keySets, dex), dex).pack();
  return {sets: uniq, speciesSet, dedupeKey};
}

function validateAndCanonicalizeRaw(
  dex: ModdedDex,
  validator: sim.TeamValidator,
  rawTeam: Array<Partial<PokemonSet>>,
  defaultLevel: number,
): {
  canonicalPacked: string;
  dedupeKey: string;
  sets: Array<Partial<PokemonSet>>;
  speciesSet: Set<string>;
} | undefined {
  if (!Array.isArray(rawTeam) || rawTeam.length !== 6) return undefined;
  const cloned = structuredClone(rawTeam) as sim.PokemonSet[];
  for (const s of cloned) {
    s.name = '';
  }
  const problems = validator.validateTeam(cloned);
  if (problems?.length) return undefined;
  const canonicalSets = Team.canonicalize(cloned, dex);
  if (canonicalSets.length !== 6) return undefined;
  const canonicalPacked = new Team(canonicalSets, dex).pack();
  const {sets, speciesSet, dedupeKey} = makeUniquenessSets(dex, canonicalSets, defaultLevel);
  return {canonicalPacked, dedupeKey, sets, speciesSet};
}

function minDistanceToPool(
  dex: ModdedDex,
  candSets: Array<Partial<PokemonSet>>,
  candSpecies: Set<string>,
  pool: Array<{id: string; sets: Array<Partial<PokemonSet>>; speciesSet: Set<string>}>,
  defaultLevel: number,
  thresholdHint?: number,
): {minD: number; closestId?: string} {
  let minD = Infinity;
  let closestId: string | undefined;
  for (const entry of pool) {
    let unshared = 0;
    for (const sp of candSpecies) {
      if (!entry.speciesSet.has(sp)) unshared++;
    }
    const lowerBound = Math.max(unshared, entry.speciesSet.size - (candSpecies.size - unshared));
    if (lowerBound >= minD) continue;
    if (thresholdHint !== undefined && lowerBound >= thresholdHint && minD <= thresholdHint) {
      continue;
    }
    const d = teams.teamDistance(dex, candSets, entry.sets, defaultLevel);
    if (d < minD) {
      minD = d;
      closestId = entry.id;
      if (thresholdHint !== undefined && minD < thresholdHint) {
        return {minD, closestId};
      }
    }
  }
  return {minD, closestId};
}

function loadPublicSamplePool(
  format: ID,
  dex: ModdedDex,
  validator: sim.TeamValidator,
  publicDir: string,
  defaultLevel: number,
): {entries: PublicEntry[]; totalFiles: number; legalFiles: number} {
  const dir = path.join(publicDir, format);
  if (!fs.existsSync(dir)) return {entries: [], totalFiles: 0, legalFiles: 0};
  const files = fs
    .readdirSync(dir)
    .filter(f => !f.startsWith('.') && f !== 'README.md')
    .sort();
  const entries: PublicEntry[] = [];
  let legalFiles = 0;
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8').trim();
    if (!raw) continue;
    const imported = Team.import(raw, dex);
    const rawSets = (imported?.team ?? []).filter(s => s && (s.species || s.name));
    if (rawSets.length !== 6) continue;
    const cloned = structuredClone(rawSets) as sim.PokemonSet[];
    for (const s of cloned) s.name = '';
    const probs = validator.validateTeam(cloned);
    if (probs?.length) continue;
    legalFiles++;
    const canon = Team.canonicalize(cloned, dex);
    const canonicalPacked = new Team(canon, dex).pack();
    const {sets, speciesSet} = makeUniquenessSets(dex, canon, defaultLevel);
    entries.push({id: f, canonicalPacked, sets, speciesSet});
  }
  return {entries, totalFiles: files.length, legalFiles};
}

function computeTprAndScore(
  wins: number,
  losses: number,
  ties: number,
  oppRatingSum: number,
  priorR: number,
  priorK: number,
  pilotsCount: number,
): {tpr: number; conservativeTpr: number; finalScore: number} {
  const n = wins + losses + ties;
  const s = wins + 0.5 * ties;
  const avgOppShrunk = (oppRatingSum + priorK * priorR) / (n + priorK);
  const p = (s + 0.5 * priorK) / (n + priorK);
  const tpr = avgOppShrunk + 400 * Math.log10(p / (1 - p));
  // Lower confidence bound penalty scales as 1/sqrt(n) (~50 Elo at n=6, ~27 Elo at n=20).
  const conservativeTpr = tpr - 120 / Math.sqrt(Math.max(1, n));
  const consensusBonus = pilotsCount > 1 ? 25 * Math.log2(pilotsCount) : 0;
  return {tpr, conservativeTpr, finalScore: conservativeTpr + consensusBonus};
}

async function runPass2(flags: Map<string, string>) {
  const format = toID(flags.get('format'));
  const outDir = flags.get('out');
  const publicDir = flags.get('public-dir') || root('teams', 'teams');

  const defaults = FORMAT_DEFAULTS[format];
  if (!defaults) {
    throw new Error(`Unsupported format '${format}' (expected gen1ou, gen3ou, gen9ou)`);
  }
  if (!outDir) {
    throw new Error('Missing required --out <dir> flag');
  }

  const pilotsPath = path.join(outDir, 'pilots', `${format}.json`);
  const sidecarPath = path.join(outDir, 'sidecar', `${format}.ndjson.zst`);
  if (!fs.existsSync(pilotsPath) || !fs.existsSync(sidecarPath)) {
    throw new Error(`Missing pass1 outputs for ${format}. Run pass1 first.`);
  }

  const pass1 = JSON.parse(fs.readFileSync(pilotsPath, 'utf8')) as Pass1PilotsFile;
  const dex = teams.getDex(format);
  const defaultLevel = teams.defaultLevelForFormat(format);
  const validator = new sim.TeamValidator(format);

  // Empirical defaults tuned per format from Pass 1 distributions, all overridable via CLI flags.
  const minPilotGames = numFlag(flags, 'pilot-min-games', 15);
  const maxPilotRprd = numFlag(flags, 'pilot-max-rprd', 55);
  const pilotEloCutoff = numFlag(flags, 'pilot-elo', pass1.distributions.oldElo.p90);
  const pilotGxeCutoff = numFlag(flags, 'pilot-gxe', Math.max(70, pass1.distributions.gxe.p90));
  const gameEloFloor = numFlag(flags, 'game-elo-floor', pass1.distributions.oldElo.p80);
  const oppEloFloor = numFlag(flags, 'opp-elo-floor', pass1.distributions.oldElo.p75);
  const minGames = numFlag(flags, 'min-games', 5);
  const minWins = numFlag(flags, 'min-wins', 4);
  const maxPerPilot = numFlag(flags, 'max-per-pilot', 8);
  const distThreshold = numFlag(flags, 'distance', teams.THRESHOLD);
  const priorK = numFlag(flags, 'prior-k', 6);
  const priorR = pass1.distributions.rpr.p80;
  const minTpr = numFlag(flags, 'min-tpr', pass1.distributions.rpr.p85);
  const minLastTs = numFlag(flags, 'min-last-ts', 0);

  const provenPilots = new Map<string, PilotSummary>();
  let qualifiedPilotCount = 0;
  for (const [pid, p] of pass1.pilots) {
    if (p.games >= minPilotGames && p.minRprd <= maxPilotRprd) {
      qualifiedPilotCount++;
      if (p.peakElo >= pilotEloCutoff && p.peakGxe >= pilotGxeCutoff) {
        provenPilots.set(pid, p);
      }
    }
  }

  console.log(
    `[pass2:${format}] Proven pilots: ${provenPilots.size.toLocaleString()} / ` +
    `${qualifiedPilotCount.toLocaleString()} active qualified ` +
    `(peakElo>=${pilotEloCutoff}, peakGxe>=${pilotGxeCutoff}, games>=${minPilotGames})`,
  );

  const publicPool = loadPublicSamplePool(format, dex, validator, publicDir, defaultLevel);
  console.log(
    `[pass2:${format}] Public sample pool: ${publicPool.entries.length} legal / ` +
    `${publicPool.totalFiles} files from ${path.join(publicDir, format)}`,
  );

  // Fast validation cache keyed by raw team JSON string (identical teams appear many times).
  const validationCache = new Map<
    string,
    Exclude<ReturnType<typeof validateAndCanonicalizeRaw>, undefined> | false
  >();
  const trajectories = new Map<string, Trajectory>();

  let sidecarRead = 0;
  let eligibleSides = 0;
  let validSides = 0;
  let illegalSides = 0;

  const reader = spawn('zstdcat', [sidecarPath], {stdio: ['ignore', 'pipe', 'inherit']});
  const rl = readline.createInterface({input: reader.stdout, crlfDelay: Infinity});

  for await (const line of rl) {
    if (!line) continue;
    sidecarRead++;
    const rec = JSON.parse(line) as SidecarRecord;
    if (rec.t < 5) continue;

    const sides: Array<{
      pilot: string;
      r: number[];
      oppR: number[];
      team: Array<Partial<PokemonSet>>;
      outcome: 'win' | 'loss' | 'tie';
    }> = [
      {
        pilot: rec.p1,
        r: rec.r1,
        oppR: rec.r2,
        team: rec.t1,
        outcome: rec.w === 1 ? 'win' : rec.w === 2 ? 'loss' : 'tie',
      },
      {
        pilot: rec.p2,
        r: rec.r2,
        oppR: rec.r1,
        team: rec.t2,
        outcome: rec.w === 2 ? 'win' : rec.w === 1 ? 'loss' : 'tie',
      },
    ];

    for (const side of sides) {
      if (!provenPilots.has(side.pilot)) continue;
      const [oldElo, elo, preR, preRd] = side.r;
      const [oppOldElo, , oppPreR, oppPreRd] = side.oppR;
      if (oldElo < gameEloFloor || oppOldElo < oppEloFloor) continue;
      if (preR <= 0 || preRd <= 0 || oppPreR <= 0 || oppPreRd <= 0) continue;

      eligibleSides++;
      const rawKey = JSON.stringify(side.team);
      let validated = validationCache.get(rawKey);
      if (validated === undefined) {
        validated = validateAndCanonicalizeRaw(dex, validator, side.team, defaultLevel) ?? false;
        if (validationCache.size < 250_000) validationCache.set(rawKey, validated);
      }
      if (!validated) {
        illegalSides++;
        continue;
      }
      validSides++;

      const trajKey = `${side.pilot}\t${validated.dedupeKey}`;
      let traj = trajectories.get(trajKey);
      if (!traj) {
        traj = {
          pilotId: side.pilot,
          dedupeKey: validated.dedupeKey,
          canonicalPacked: validated.canonicalPacked,
          uniquenessSets: validated.sets,
          speciesSet: validated.speciesSet,
          variantCounts: new Map(),
          wins: 0,
          losses: 0,
          ties: 0,
          expectedWins: 0,
          oppRatingSum: 0,
          oppEloSum: 0,
          netEloDelta: 0,
          maxEloWon: 0,
          maxOppEloBeaten: 0,
          lastTs: 0,
        };
        trajectories.set(trajKey, traj);
      }

      if (side.outcome === 'win') {
        traj.wins++;
        if (oldElo > traj.maxEloWon) traj.maxEloWon = oldElo;
        if (oppOldElo > traj.maxOppEloBeaten) traj.maxOppEloBeaten = oppOldElo;
      } else if (side.outcome === 'loss') {
        traj.losses++;
      } else {
        traj.ties++;
      }

      traj.expectedWins += victoryChance(preR, preRd, oppPreR, oppPreRd);
      traj.oppRatingSum += oppPreR;
      traj.oppEloSum += oppOldElo;
      if (elo > 0 && oldElo > 0) traj.netEloDelta += elo - oldElo;
      if (rec.ts > traj.lastTs) traj.lastTs = rec.ts;
      traj.variantCounts.set(
        validated.canonicalPacked,
        (traj.variantCounts.get(validated.canonicalPacked) || 0) + 1,
      );
    }
  }

  console.log(
    `[pass2:${format}] Sidecar=${sidecarRead.toLocaleString()} | ` +
    `eligibleSides=${eligibleSides.toLocaleString()} | ` +
    `valid=${validSides.toLocaleString()} illegal=${illegalSides.toLocaleString()} | ` +
    `rawTrajectories=${trajectories.size.toLocaleString()}`,
  );

  // Group trajectories by pilot and micro-cluster near-identical tweaks (D < 0.15) per pilot.
  const byPilotRaw = new Map<string, Trajectory[]>();
  for (const t of trajectories.values()) {
    const arr = byPilotRaw.get(t.pilotId) ?? [];
    arr.push(t);
    byPilotRaw.set(t.pilotId, arr);
  }

  const pilotQualified: Trajectory[] = [];
  let totalMergedClusters = 0;

  for (const list of byPilotRaw.values()) {
    list.sort((a, b) => (b.wins + b.losses + b.ties) - (a.wins + a.losses + a.ties));
    const clusters: Trajectory[] = [];
    for (const item of list) {
      let merged = false;
      for (const c of clusters) {
        if (c.speciesSet.size !== item.speciesSet.size) continue;
        let sameAll = true;
        for (const sp of item.speciesSet) {
          if (!c.speciesSet.has(sp)) {
            sameAll = false;
            break;
          }
        }
        if (!sameAll) continue;
        if (teams.teamDistance(dex, c.uniquenessSets, item.uniquenessSets, defaultLevel) < 0.15) {
          c.wins += item.wins;
          c.losses += item.losses;
          c.ties += item.ties;
          c.expectedWins += item.expectedWins;
          c.oppRatingSum += item.oppRatingSum;
          c.oppEloSum += item.oppEloSum;
          c.netEloDelta += item.netEloDelta;
          c.maxEloWon = Math.max(c.maxEloWon, item.maxEloWon);
          c.maxOppEloBeaten = Math.max(c.maxOppEloBeaten, item.maxOppEloBeaten);
          c.lastTs = Math.max(c.lastTs, item.lastTs);
          for (const [packed, cnt] of item.variantCounts) {
            c.variantCounts.set(packed, (c.variantCounts.get(packed) || 0) + cnt);
          }
          merged = true;
          totalMergedClusters++;
          break;
        }
      }
      if (!merged) clusters.push(item);
    }

    // Score and filter this pilot's clusters, keeping top `maxPerPilot`.
    const passing: Array<{traj: Trajectory; score: number}> = [];
    for (const c of clusters) {
      const n = c.wins + c.losses + c.ties;
      if (n < minGames || c.wins < minWins) continue;
      if (minLastTs > 0 && c.lastTs < minLastTs) continue;

      const s = c.wins + 0.5 * c.ties;
      const smoothWr = (s + 1) / (n + 2);
      const surplus = s - c.expectedWins;
      const {tpr, conservativeTpr} = computeTprAndScore(
        c.wins, c.losses, c.ties, c.oppRatingSum, priorR, priorK, 1,
      );

      // Must have at least a 50% smoothed record AND either beat expected score OR post
      // >=55% smoothed win rate with positive Elo gain, AND clear the format TPR floor.
      const strongPerformance = surplus >= 0 || (smoothWr >= 0.55 && c.netEloDelta > 0);
      if (smoothWr < 0.50 || !strongPerformance || tpr < minTpr) continue;

      // Pick the most frequently played exact variant in this cluster.
      let bestPacked = c.canonicalPacked;
      let bestCnt = -1;
      for (const [packed, cnt] of c.variantCounts) {
        if (cnt > bestCnt) {
          bestCnt = cnt;
          bestPacked = packed;
        }
      }
      c.canonicalPacked = bestPacked;
      passing.push({traj: c, score: conservativeTpr});
    }

    passing.sort((a, b) => b.score - a.score);
    for (const item of passing.slice(0, maxPerPilot)) {
      pilotQualified.push(item.traj);
    }
  }

  // Merge qualified trajectories across pilots (exact dedupeKey first, then D < 0.15).
  const byDedupe = new Map<string, {
    dedupeKey: string;
    canonicalPacked: string;
    uniquenessSets: Array<Partial<PokemonSet>>;
    speciesSet: Set<string>;
    pilots: Set<string>;
    variantCounts: Map<string, number>;
    wins: number;
    losses: number;
    ties: number;
    expectedWins: number;
    oppRatingSum: number;
    oppEloSum: number;
    netEloDelta: number;
    maxEloWon: number;
    maxOppEloBeaten: number;
    lastTs: number;
  }>();

  for (const t of pilotQualified) {
    let entry = byDedupe.get(t.dedupeKey);
    if (!entry) {
      entry = {
        dedupeKey: t.dedupeKey,
        canonicalPacked: t.canonicalPacked,
        uniquenessSets: t.uniquenessSets,
        speciesSet: t.speciesSet,
        pilots: new Set([t.pilotId]),
        variantCounts: new Map(t.variantCounts),
        wins: t.wins,
        losses: t.losses,
        ties: t.ties,
        expectedWins: t.expectedWins,
        oppRatingSum: t.oppRatingSum,
        oppEloSum: t.oppEloSum,
        netEloDelta: t.netEloDelta,
        maxEloWon: t.maxEloWon,
        maxOppEloBeaten: t.maxOppEloBeaten,
        lastTs: t.lastTs,
      };
      byDedupe.set(t.dedupeKey, entry);
    } else {
      entry.pilots.add(t.pilotId);
      entry.wins += t.wins;
      entry.losses += t.losses;
      entry.ties += t.ties;
      entry.expectedWins += t.expectedWins;
      entry.oppRatingSum += t.oppRatingSum;
      entry.oppEloSum += t.oppEloSum;
      entry.netEloDelta += t.netEloDelta;
      entry.maxEloWon = Math.max(entry.maxEloWon, t.maxEloWon);
      entry.maxOppEloBeaten = Math.max(entry.maxOppEloBeaten, t.maxOppEloBeaten);
      entry.lastTs = Math.max(entry.lastTs, t.lastTs);
      for (const [packed, cnt] of t.variantCounts) {
        entry.variantCounts.set(packed, (entry.variantCounts.get(packed) || 0) + cnt);
      }
    }
  }

  const scored: ScoredTeam[] = [];
  for (const e of byDedupe.values()) {
    const n = e.wins + e.losses + e.ties;
    const s = e.wins + 0.5 * e.ties;
    let bestPacked = e.canonicalPacked;
    let bestCnt = -1;
    for (const [packed, cnt] of e.variantCounts) {
      if (cnt > bestCnt) {
        bestCnt = cnt;
        bestPacked = packed;
      }
    }
    const {tpr, conservativeTpr, finalScore} = computeTprAndScore(
      e.wins, e.losses, e.ties, e.oppRatingSum, priorR, priorK, e.pilots.size,
    );
    const pubDist = publicPool.entries.length > 0
      ? minDistanceToPool(dex, e.uniquenessSets, e.speciesSet, publicPool.entries, defaultLevel)
      : {minD: Infinity, closestId: undefined};
    scored.push({
      dedupeKey: e.dedupeKey,
      canonicalPacked: bestPacked,
      uniquenessSets: e.uniquenessSets,
      speciesSet: e.speciesSet,
      pilots: [...e.pilots],
      wins: e.wins,
      losses: e.losses,
      ties: e.ties,
      expectedWins: Math.round(e.expectedWins * 100) / 100,
      surplus: Math.round((s - e.expectedWins) * 100) / 100,
      avgOppR: Math.round(e.oppRatingSum / n),
      avgOppElo: Math.round(e.oppEloSum / n),
      netEloDelta: Math.round(e.netEloDelta),
      maxEloWon: Math.round(e.maxEloWon),
      maxOppEloBeaten: Math.round(e.maxOppEloBeaten),
      tpr: Math.round(tpr * 10) / 10,
      conservativeTpr: Math.round(conservativeTpr * 10) / 10,
      finalScore: Math.round(finalScore * 10) / 10,
      lastTs: e.lastTs,
      nearestPublicId: pubDist.closestId,
      nearestPublicDist: Number.isFinite(pubDist.minD)
        ? Math.round(pubDist.minD * 1000) / 1000
        : undefined,
    });
  }

  scored.sort((a, b) => b.finalScore - a.finalScore);

  // Greedy pairwise-distinct selection: BOTH with and without excluding public sample near-clones.
  const selectDistinct = (excludePublic: boolean): ScoredTeam[] => {
    const selected: ScoredTeam[] = [];
    const selectedPool: Array<{
      id: string;
      sets: Array<Partial<PokemonSet>>;
      speciesSet: Set<string>;
    }> = [];
    for (const cand of scored) {
      if (excludePublic && cand.nearestPublicDist !== undefined &&
        cand.nearestPublicDist < distThreshold) {
        continue;
      }
      const {minD} = minDistanceToPool(
        dex, cand.uniquenessSets, cand.speciesSet, selectedPool, defaultLevel, distThreshold,
      );
      if (minD < distThreshold) continue;
      selected.push(cand);
      selectedPool.push({
        id: `sel-${selected.length}`,
        sets: cand.uniquenessSets,
        speciesSet: cand.speciesSet,
      });
    }
    return selected;
  };

  const selectedWithPublic = selectDistinct(false);
  const selectedExcludePublic = selectDistinct(true);

  // Verify 100% of final selected teams pass the exact `upload-ladder-teams` validator!
  const verifyPool = (label: string, list: ScoredTeam[]) => {
    if (list.length < 2) {
      throw new Error(`${format} (${label}) produced fewer than 2 teams (${list.length})`);
    }
    const rawLines = list.map(t => t.canonicalPacked).join('\n');
    const validated = serverTeams.validateHarvestedTeams(rawLines, format);
    if (validated.length !== list.length) {
      throw new Error(
        `${format} (${label}) validation mismatch: ${validated.length} !== ${list.length}`,
      );
    }
  };
  verifyPool('with-public', selectedWithPublic);
  verifyPool('exclude-public', selectedExcludePublic);

  // Public pool overlap report!
  const exactPublicMatches = scored.filter(
    t => t.nearestPublicDist !== undefined && t.nearestPublicDist < 0.001,
  );
  const nearPublicMatches = scored.filter(
    t => t.nearestPublicDist !== undefined && t.nearestPublicDist < distThreshold,
  );
  const top50WithPublic = selectedWithPublic.slice(0, 50);
  const top50PublicOverlap = top50WithPublic.filter(
    t => t.nearestPublicDist !== undefined && t.nearestPublicDist < distThreshold,
  );
  const top100WithPublic = selectedWithPublic.slice(0, 100);
  const top100PublicOverlap = top100WithPublic.filter(
    t => t.nearestPublicDist !== undefined && t.nearestPublicDist < distThreshold,
  );
  const selectedPublicOverlap = selectedWithPublic.filter(
    t => t.nearestPublicDist !== undefined && t.nearestPublicDist < distThreshold,
  );

  // Species coverage in selected pools
  const speciesFreq = (list: ScoredTeam[]) => {
    const counts = new Map<string, number>();
    for (const t of list) {
      for (const sp of t.speciesSet) counts.set(sp, (counts.get(sp) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([sp, c]) => ({
        species: sp,
        count: c,
        pct: Math.round((c / Math.max(1, list.length)) * 1000) / 10,
      }));
  };

  fs.mkdirSync(path.join(outDir, 'teams'), {recursive: true});
  fs.mkdirSync(path.join(outDir, 'diagnostics'), {recursive: true});

  const teamsExcludePath = path.join(outDir, 'teams', `${format}.txt`);
  const teamsWithPublicPath = path.join(outDir, 'teams', `${format}-with-public.txt`);
  fs.writeFileSync(
    teamsExcludePath,
    `${selectedExcludePublic.map(t => t.canonicalPacked).join('\n')}\n`,
  );
  fs.writeFileSync(
    teamsWithPublicPath,
    `${selectedWithPublic.map(t => t.canonicalPacked).join('\n')}\n`,
  );

  const summarizeTeam = (t: ScoredTeam) => ({
    pilots: t.pilots.length,
    record: `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ''}`,
    surplus: t.surplus,
    tpr: t.tpr,
    conservativeTpr: t.conservativeTpr,
    finalScore: t.finalScore,
    avgOppElo: t.avgOppElo,
    maxEloWon: t.maxEloWon,
    nearestPublicId: t.nearestPublicId,
    nearestPublicDist: t.nearestPublicDist,
    species: [...t.speciesSet],
    packed: t.canonicalPacked,
  });

  const diag = {
    format,
    parameters: {
      minPilotGames,
      maxPilotRprd,
      pilotEloCutoff,
      pilotGxeCutoff,
      gameEloFloor,
      oppEloFloor,
      minGames,
      minWins,
      maxPerPilot,
      distThreshold,
      priorK,
      priorR,
      minTpr,
      minLastTs,
    },
    counts: {
      totalPilots: pass1.uniquePilots,
      qualifiedActivePilots: qualifiedPilotCount,
      provenPilots: provenPilots.size,
      sidecarBattles: sidecarRead,
      eligibleSides,
      validSides,
      illegalSides,
      rawTrajectories: trajectories.size,
      intraPilotMerged: totalMergedClusters,
      pilotQualifiedTrajectories: pilotQualified.length,
      mergedUniqueQualifiedTeams: scored.length,
      selectedExcludePublic: selectedExcludePublic.length,
      selectedWithPublic: selectedWithPublic.length,
    },
    scoreProfile: {
      excludePublic: {
        top1: selectedExcludePublic[0]?.finalScore,
        p25: selectedExcludePublic[Math.floor(selectedExcludePublic.length * 0.25)]?.finalScore,
        median: selectedExcludePublic[Math.floor(selectedExcludePublic.length * 0.5)]?.finalScore,
        p75: selectedExcludePublic[Math.floor(selectedExcludePublic.length * 0.75)]?.finalScore,
        bottom: selectedExcludePublic[selectedExcludePublic.length - 1]?.finalScore,
        multiPilotTeams: selectedExcludePublic.filter(t => t.pilots.length > 1).length,
      },
      withPublic: {
        top1: selectedWithPublic[0]?.finalScore,
        median: selectedWithPublic[Math.floor(selectedWithPublic.length * 0.5)]?.finalScore,
        bottom: selectedWithPublic[selectedWithPublic.length - 1]?.finalScore,
        multiPilotTeams: selectedWithPublic.filter(t => t.pilots.length > 1).length,
      },
    },
    publicPoolAnalysis: {
      publicFiles: publicPool.totalFiles,
      publicLegalFiles: publicPool.legalFiles,
      qualifiedExactMatches: exactPublicMatches.length,
      qualifiedNearMatches: nearPublicMatches.length,
      qualifiedNearMatchPct:
        Math.round((nearPublicMatches.length / Math.max(1, scored.length)) * 1000) / 10,
      selectedWithPublicNearMatches: selectedPublicOverlap.length,
      selectedWithPublicNearMatchPct:
        Math.round(
          (selectedPublicOverlap.length / Math.max(1, selectedWithPublic.length)) * 1000,
        ) / 10,
      top50NearMatches: top50PublicOverlap.length,
      top100NearMatches: top100PublicOverlap.length,
      avgScorePublicNearMatches: nearPublicMatches.length
        ? Math.round(
          (nearPublicMatches.reduce((a, b) => a + b.finalScore, 0) / nearPublicMatches.length) * 10,
        ) / 10
        : undefined,
      avgScoreNonPublic: scored.length > nearPublicMatches.length
        ? Math.round(
          (scored
            .filter(t => t.nearestPublicDist === undefined || t.nearestPublicDist >= distThreshold)
            .reduce((a, b) => a + b.finalScore, 0) /
            (scored.length - nearPublicMatches.length)) * 10,
        ) / 10
        : undefined,
      topPublicOverlaps: selectedPublicOverlap.slice(0, 15).map(summarizeTeam),
    },
    topSpeciesExcludePublic: speciesFreq(selectedExcludePublic),
    topSpeciesWithPublic: speciesFreq(selectedWithPublic),
    top10ExcludePublic: selectedExcludePublic.slice(0, 10).map(summarizeTeam),
    bottom5ExcludePublic: selectedExcludePublic.slice(-5).map(summarizeTeam),
    top10WithPublic: selectedWithPublic.slice(0, 10).map(summarizeTeam),
  };

  const diagPath = path.join(outDir, 'diagnostics', `${format}.json`);
  fs.writeFileSync(diagPath, JSON.stringify(diag, undefined, 2));

  console.log(
    `[pass2:${format}] DONE | qualified=${scored.length} | ` +
    `distinct(exclude-public)=${selectedExcludePublic.length} | ` +
    `distinct(with-public)=${selectedWithPublic.length} | ` +
    `publicOverlap(selected)=${selectedPublicOverlap.length}/${selectedWithPublic.length} ` +
    `(top50=${top50PublicOverlap.length}/50, top100=${top100PublicOverlap.length}/100)`,
  );
}

// --- Pass 1 Worker Thread ---

function numOrNaN(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
}

function clampBin(val: number, min: number, len: number): number {
  const idx = Math.round(val - min);
  if (idx < 0) return 0;
  if (idx >= len) return len - 1;
  return idx;
}

function parseTimestampSeconds(ts: unknown): number {
  if (typeof ts === 'number' && Number.isFinite(ts)) return Math.floor(ts);
  if (typeof ts === 'string' && ts.length > 0) {
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return 0;
}

function monthKeyFromSeconds(seconds: number): string {
  if (!seconds) return 'unknown';
  const d = new Date(seconds * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function updatePilot(
  pilots: Map<string, PilotSummary>,
  id: string,
  r: RawRating,
  outcome: 'win' | 'loss' | 'tie',
  ts: number,
  eloHist: number[],
  gxeHist: number[],
  rprHist: number[],
) {
  const oldElo = numOrNaN(r.oldelo);
  const elo = numOrNaN(r.elo);
  const gxe = numOrNaN(r.gxe);
  const rpr = numOrNaN(r.rpr);
  const rprd = numOrNaN(r.rprd);

  if (Number.isFinite(oldElo)) eloHist[clampBin(oldElo, ELO_MIN, ELO_BINS)]++;
  if (Number.isFinite(gxe)) gxeHist[clampBin(gxe * 10, 0, GXE_BINS)]++;
  if (Number.isFinite(rpr)) rprHist[clampBin(rpr, ELO_MIN, ELO_BINS)]++;

  let p = pilots.get(id);
  if (!p) {
    p = {
      games: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      peakElo: 0,
      peakOldElo: 0,
      peakGxe: 0,
      peakGxeAny: 0,
      peakConservativeR: 0,
      minRprd: 999,
      lastTs: 0,
      endElo: 0,
      endGxe: 0,
      endRpr: 0,
      endRprd: 999,
    };
    pilots.set(id, p);
  }

  p.games++;
  if (outcome === 'win') p.wins++;
  else if (outcome === 'loss') p.losses++;
  else p.ties++;

  if (Number.isFinite(elo) && elo > p.peakElo) p.peakElo = elo;
  if (Number.isFinite(oldElo) && oldElo > p.peakOldElo) p.peakOldElo = oldElo;
  if (Number.isFinite(gxe)) {
    if (gxe > p.peakGxeAny) p.peakGxeAny = gxe;
    if (Number.isFinite(rprd) && rprd <= 50 && gxe > p.peakGxe) p.peakGxe = gxe;
  }
  if (Number.isFinite(rpr) && Number.isFinite(rprd)) {
    if (rprd < p.minRprd) p.minRprd = rprd;
    if (rprd <= 60) {
      const cons = rpr - 2 * rprd;
      if (cons > p.peakConservativeR) p.peakConservativeR = cons;
    }
  }
  if (ts >= p.lastTs) {
    p.lastTs = ts;
    if (Number.isFinite(elo)) p.endElo = elo;
    if (Number.isFinite(gxe)) p.endGxe = gxe;
    if (Number.isFinite(rpr)) p.endRpr = rpr;
    if (Number.isFinite(rprd)) p.endRprd = rprd;
  }
}

function packRatingTuple(r: RawRating): number[] {
  return [
    Math.round((numOrNaN(r.oldelo) || 0) * 100) / 100,
    Math.round((numOrNaN(r.elo) || 0) * 100) / 100,
    Math.round((numOrNaN(r.r) || 0) * 100) / 100,
    Math.round((numOrNaN(r.rd) || 0) * 100) / 100,
    Math.round((numOrNaN(r.rpr) || 0) * 100) / 100,
    Math.round((numOrNaN(r.rprd) || 0) * 100) / 100,
    Math.round((numOrNaN(r.gxe) || 0) * 10) / 10,
  ];
}

function runWorker() {
  const port = parentPort;
  if (!port) return;

  const cfg = workerData as WorkerConfig;
  const gen = GENS.get(cfg.genNum);
  const stats: Statistics = Stats.create();
  const stallinessBuckets = new Map<number, [number, number]>();
  const pilots = new Map<string, PilotSummary>();
  const eloHist = new Array<number>(ELO_BINS).fill(0);
  const gxeHist = new Array<number>(GXE_BINS).fill(0);
  const rprHist = new Array<number>(ELO_BINS).fill(0);
  const monthly: {[month: string]: MonthlySummary} = {};

  let processed = 0;
  let parseErrors = 0;
  const errorSamples: string[] = [];
  let sidecarCount = 0;

  function drainStalliness() {
    const arr = stats.metagame.stalliness;
    for (const [val, weight] of arr) {
      const key = Math.round(val * 1000);
      const bucket = stallinessBuckets.get(key);
      if (bucket) {
        bucket[0] += 1;
        bucket[1] += weight;
      } else {
        stallinessBuckets.set(key, [1, weight]);
      }
    }
    arr.length = 0;
  }

  function compactUniqueForLegacy() {
    for (const sp in stats.pokemon) {
      const uniq = stats.pokemon[sp].unique;
      for (const player in uniq) {
        const u = uniq[player];
        if ('g' in u) {
          if ('r' in u || 'w' in u) {
            uniq[player] = {g: u.g};
          }
        } else {
          delete uniq[player];
        }
      }
    }
  }

  let batchesSinceCompact = 0;

  type WorkerMsg =
    {type: 'batch'; id: number; items: Array<[string, string]>} |
    {type: 'finish'};

  port.on('message', (msg: WorkerMsg) => {
    if (msg.type === 'finish') {
      drainStalliness();
      compactUniqueForLegacy();
      const result: WorkerResult = {
        stats,
        stallinessBuckets: [...stallinessBuckets.entries()].map(([k, [c, w]]) => [k, c, w]),
        pilots: [...pilots.entries()],
        eloHist,
        gxeHist,
        rprHist,
        monthly,
        processed,
        parseErrors,
        errorSamples,
        sidecarCount,
      };
      port.postMessage({type: 'done', result});
      return;
    }

    const sidecarLines: string[] = [];
    for (const [name, text] of msg.items) {
      processed++;
      try {
        const raw = JSON.parse(text) as RawLog;
        const turns = typeof raw.turns === 'number' ? raw.turns : 0;
        const ts = parseTimestampSeconds(raw.timestamp);
        const r1 = raw.p1rating;
        const r2 = raw.p2rating;

        // Track monthly species usage (before Parser.parse mutates raw.p1team/p2team).
        const mKey = monthKeyFromSeconds(ts);
        let mEntry = monthly[mKey];
        if (!mEntry) {
          mEntry = {battles: 0, species: {}};
          monthly[mKey] = mEntry;
        }
        mEntry.battles++;
        for (const team of [raw.p1team, raw.p2team]) {
          if (!Array.isArray(team)) continue;
          for (const mon of team) {
            const spId = toID(mon?.species || mon?.name);
            if (spId) mEntry.species[spId] = (mEntry.species[spId] || 0) + 1;
          }
        }

        // Determine winner cleanly from raw.winner (or log fallback).
        const p1Id = toID(raw.p1);
        const p2Id = toID(raw.p2);
        const winId = toID(raw.winner);
        const wCode = winId && winId === p1Id ? 1 : winId && winId === p2Id ? 2 : 0;

        // Update pilot stats & emit sidecar BEFORE Parser.parse mutates raw teams in place.
        if (turns >= 5 && r1 && r2 && p1Id && p2Id && p1Id !== p2Id) {
          const p1Out = wCode === 1 ? 'win' : wCode === 2 ? 'loss' : 'tie';
          const p2Out = wCode === 2 ? 'win' : wCode === 1 ? 'loss' : 'tie';
          updatePilot(pilots, p1Id, r1, p1Out, ts, eloHist, gxeHist, rprHist);
          updatePilot(pilots, p2Id, r2, p2Out, ts, eloHist, gxeHist, rprHist);

          const maxElo = Math.max(
            numOrNaN(r1.oldelo) || 0,
            numOrNaN(r1.elo) || 0,
            numOrNaN(r2.oldelo) || 0,
            numOrNaN(r2.elo) || 0,
          );
          const maxGxe = Math.max(numOrNaN(r1.gxe) || 0, numOrNaN(r2.gxe) || 0);
          if (
            cfg.keepAllSidecar ||
            maxElo >= cfg.sidecarEloFloor ||
            maxGxe >= cfg.sidecarGxeFloor
          ) {
            sidecarLines.push(JSON.stringify({
              id: name.replace(/\.log\.json$/, ''),
              ts,
              t: turns,
              e: raw.endType || 'normal',
              w: wCode,
              p1: p1Id,
              p2: p2Id,
              r1: packRatingTuple(r1),
              r2: packRatingTuple(r2),
              t1: raw.p1team,
              t2: raw.p2team,
            }));
            sidecarCount++;
          }
        }

        const battle = Parser.parse(gen, cfg.format, raw as unknown as ParserLog, true);
        Stats.update(gen, cfg.format, battle, cfg.cutoff, stats, true);
      } catch (err: unknown) {
        parseErrors++;
        if (errorSamples.length < 10) {
          const msgStr = err instanceof Error ? err.message : String(err);
          errorSamples.push(`${name}: ${msgStr}`);
        }
      }
    }

    drainStalliness();
    batchesSinceCompact++;
    if (batchesSinceCompact >= 20) {
      compactUniqueForLegacy();
      batchesSinceCompact = 0;
    }

    port.postMessage({
      type: 'batchDone',
      id: msg.id,
      sidecarChunk: sidecarLines.length ? `${sidecarLines.join('\n')}\n` : '',
    });
  });
}

async function main() {
  const {cmd, flags} = parseArgs(process.argv.slice(2));
  if (cmd === 'pass1') {
    await runPass1(flags);
  } else if (cmd === 'pass2') {
    await runPass2(flags);
  } else {
    console.error(
      'Usage:\n' +
      '  node build/tools/harvest pass1 --format <gen1ou|gen3ou|gen9ou> ' +
      '--archive <path.tar.zst> --out <dir> [--workers 5]\n' +
      '  node build/tools/harvest pass2 --format <gen1ou|gen3ou|gen9ou> ' +
      '--out <dir> [--public-dir <path>]',
    );
    process.exit(1);
  }
}

if (isMainThread) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
} else {
  runWorker();
}
