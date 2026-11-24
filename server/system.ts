import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';

import * as util from '../static/util';

export interface LoadMetrics {
  load1: number;
  load5: number;
  load15: number;
  cpus: number;
  uptimeSeconds: number;
  processUptimeSeconds: number;
}

export interface MemoryMetrics {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  processRssBytes: number;
  pressure?: 'normal' | 'warning' | 'critical';
}

export interface DiskMetrics {
  mount: string;
  label: string;
  mounted: boolean;
  totalBytes?: number;
  usedBytes?: number;
  availableBytes?: number;
  readBytesPerSecond?: number;
  writeBytesPerSecond?: number;
  ioBytesPerSecond?: number;
  iops?: number;
  busyPct?: number;
}

export interface NetworkProbe {
  target: string;
  ok: boolean;
  rttMillis?: number;
  checkedAt: number;
  error?: string;
}

export interface NetworkMetrics {
  iface?: string;
  rxBytesPerSecond?: number;
  txBytesPerSecond?: number;
  rxErrors?: number;
  txErrors?: number;
  internal?: NetworkProbe;
  external?: NetworkProbe;
}

export interface UpdateStatus {
  pending: number;
  security?: number;
  rebootRequired?: boolean;
  checkedAt: number;
  summary?: string;
}

export interface BackupStatus {
  lastBackupAt?: number;
  lastBackupBytes?: number;
  backupCount?: number;
  lastArchiveUploadAt?: number;
  archiveError?: string;
  checkedAt?: number;
}

export interface DatabaseStorageMetrics {
  dbBytes: number;
  walBytes: number;
}

export interface SseViewerCounts {
  battles: number;
  tournaments: number;
  admin: number;
}

export interface TrafficMetrics {
  sse: SseViewerCounts;
  activeVisitors5m: number;
  requests1m: number;
  requests1h: number;
  errors4xx1h: number;
  rateLimited4291h: number;
  errors5xx1h: number;
  meanLatencyMillis?: number;
  p95LatencyMillis?: number;
  last5xx?: {
    at: number;
    path: string;
    status: number;
  };
}

export interface TlsCertStatus {
  expiresAt: number;
  daysRemaining: number;
  checkedAt?: number;
}

export interface ArenaFaultsSummary {
  matches: number;
  faults: number;
}

export interface VpsSystemInfo {
  collectedAt: number;
  hostname: string;
  platform: string;
  nodeVersion: string;
  gitCommit?: string;
  load: LoadMetrics;
  memory: MemoryMetrics;
  disks: DiskMetrics[];
  network: NetworkMetrics;
  updates?: UpdateStatus;
  backups: BackupStatus;
  database: DatabaseStorageMetrics;
  traffic: TrafficMetrics;
  tlsCert?: TlsCertStatus;
  arenaFaults24h: ArenaFaultsSummary;
}

export interface ArenaSystemInfo {
  collectedAt: number;
  hostname: string;
  platform: string;
  nodeVersion: string;
  gitCommit?: string;
  load: LoadMetrics;
  memory: MemoryMetrics;
  disks: DiskMetrics[];
  network: NetworkMetrics;
  updates?: UpdateStatus;
  backups: BackupStatus;
  database?: DatabaseStorageMetrics;
  outboxPending: number;
  daemonErrors: number;
  podmanState?: string;
  podmanCheckedAt?: number;
}

export interface ProcDiskSample {
  name: string;
  readsCompleted: number;
  sectorsRead: number;
  writesCompleted: number;
  sectorsWritten: number;
  ioTicksMillis: number;
}

export interface NetCounterSample {
  iface: string;
  rxBytes: number;
  txBytes: number;
  rxErrors: number;
  txErrors: number;
}

export interface MacIostatSample {
  disk: string;
  transfers: number;
  megabytes: number;
}

const ARCHIVE_MOUNT = '/Volumes/Archive';
const ARCHIVE_STATUS_FILE = '/opt/arena/state/archive-status.json';
const UPDATES_STATUS_FILE = '/opt/arena/state/updates-status.json';
const VPS_BACKUP_DIR = '/var/lib/pkmn/backups';
const VPS_TLS_CERT_PATH = '/etc/letsencrypt/live/pkmn.ai/fullchain.pem';
const VPS_UPDATES_PATH = '/var/lib/update-notifier/updates-available';
const VPS_REBOOT_PATH = '/var/run/reboot-required';
const VPS_PROBE_URL = 'https://api.github.com/zen';
const ARENA_PROBE_URL = 'https://ghcr.io/v2/';

const PROBE_TIMEOUT_MILLIS = 5000;
const FAST_SAMPLE_SECONDS = 60;
const SLOW_PROBE_SECONDS = 15 * 60;
const SLOW_PROBE_MILLIS = SLOW_PROBE_SECONDS * 1000;
const BACKUP_RETRY_SECONDS = 5 * 60;
const TLS_REFRESH_MILLIS = 6 * 60 * 60_000;
const VPS_BACKUP_HOUR_UTC = 10;
const VPS_BACKUP_MINUTE_UTC = 0;
const ARENA_MAINTENANCE_HOUR_UTC = 10;
const ARENA_MAINTENANCE_MINUTE_UTC = 0;
const VISITOR_WINDOW_SECONDS = 5 * 60;
const MAX_TRACKED_VISITORS = 5000;
const MAX_LATENCY_SAMPLES = 200;

export function latestScheduledWindowStart(
  nowSeconds: number,
  hour: number,
  minute: number,
  useUtc: boolean
): number {
  const d = new Date(nowSeconds * 1000);
  const candidate = useUtc
    ? Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute) / 1000)
    : Math.floor(
      new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0).getTime() / 1000
    );
  return candidate <= nowSeconds ? candidate : candidate - 86400;
}

export function parseProcMeminfo(text: string): {
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
} | undefined {
  const fields = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z0-9_()]+):\s+(\d+)\s*kB/i.exec(line.trim());
    if (m) fields.set(m[1], Number(m[2]) * 1024);
  }
  const totalBytes = fields.get('MemTotal');
  if (!totalBytes || totalBytes <= 0) return undefined;
  const availableBytes = fields.get('MemAvailable') ?? (
    (fields.get('MemFree') ?? 0) +
    (fields.get('Buffers') ?? 0) +
    (fields.get('Cached') ?? 0)
  );
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const swapTotalBytes = fields.get('SwapTotal') ?? 0;
  const swapFreeBytes = fields.get('SwapFree') ?? swapTotalBytes;
  const swapUsedBytes = Math.max(0, swapTotalBytes - swapFreeBytes);
  return {totalBytes, availableBytes, usedBytes, swapTotalBytes, swapUsedBytes};
}

export function parseProcDiskstats(text: string): Map<string, ProcDiskSample> {
  const out = new Map<string, ProcDiskSample>();
  for (const rawLine of text.split('\n')) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts.length < 13) continue;
    const name = parts[2];
    if (!name || /^(?:loop|ram|dm-)\d+/.test(name)) continue;
    out.set(name, {
      name,
      readsCompleted: Number(parts[3]) || 0,
      sectorsRead: Number(parts[5]) || 0,
      writesCompleted: Number(parts[7]) || 0,
      sectorsWritten: Number(parts[9]) || 0,
      ioTicksMillis: Number(parts[12]) || 0,
    });
  }
  return out;
}

export function pickRootLinuxDisk(
  stats: ReadonlyMap<string, ProcDiskSample>,
  mountsText?: string
): string | undefined {
  if (mountsText) {
    for (const line of mountsText.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2 || parts[1] !== '/') continue;
      const dev = parts[0].replace(/^\/dev\//, '');
      if (stats.has(dev)) return dev;
      const base = dev.replace(/p?\d+$/, '');
      if (stats.has(base)) return base;
    }
  }
  for (const candidate of ['vda', 'sda', 'nvme0n1', 'xvda', 'vda1', 'sda1']) {
    if (stats.has(candidate)) return candidate;
  }
  for (const name of stats.keys()) {
    if (/^(?:vd|sd|xvd)[a-z]$|^nvme\d+n\d+$/.test(name)) return name;
  }
  return stats.keys().next().value;
}

export function parseProcNetDev(text: string): NetCounterSample | undefined {
  let best: NetCounterSample | undefined;
  for (const rawLine of text.split('\n')) {
    const colon = rawLine.indexOf(':');
    if (colon === -1) continue;
    const iface = rawLine.slice(0, colon).trim();
    if (!iface || iface === 'lo' || /^(?:docker|veth|br-|virbr|wg)/.test(iface)) continue;
    const nums = rawLine.slice(colon + 1).trim().split(/\s+/);
    if (nums.length < 11) continue;
    const sample: NetCounterSample = {
      iface,
      rxBytes: Number(nums[0]) || 0,
      rxErrors: (Number(nums[2]) || 0) + (Number(nums[3]) || 0),
      txBytes: Number(nums[8]) || 0,
      txErrors: (Number(nums[10]) || 0) + (Number(nums[11]) || 0),
    };
    if (!best || (sample.rxBytes + sample.txBytes) > (best.rxBytes + best.txBytes)) {
      best = sample;
    }
  }
  return best;
}

export function parseProcNetTcpListening(text: string, port: number): boolean {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  for (const rawLine of text.split('\n').slice(1)) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const localAddr = parts[1];
    const state = parts[3];
    // `0A` = TCP_LISTEN in Linux /proc/net/tcp
    if (state === '0A' && localAddr.toUpperCase().endsWith(`:${hexPort}`)) {
      return true;
    }
  }
  return false;
}

export function parseUbuntuUpdates(
  text: string | undefined,
  rebootRequired: boolean,
  checkedAt: number
): UpdateStatus | undefined {
  if (text === undefined && !rebootRequired) return undefined;
  const pendingMatch = text ? /(\d+)\s+updates?\s+can\s+be\s+applied/i.exec(text) : undefined;
  const secMatch = text
    ? /(\d+)\s+of\s+these\s+updates?\s+are\s+(?:standard\s+)?security\s+updates?/i.exec(text)
    : undefined;
  const pending = pendingMatch ? Number(pendingMatch[1]) : 0;
  const security = secMatch ? Number(secMatch[1]) : 0;
  return {
    pending,
    security,
    rebootRequired,
    checkedAt,
  };
}

export function parseMacVmStat(text: string): {
  pageSize: number;
  usedBytes: number;
} | undefined {
  const pageMatch = /page size of (\d+) bytes/i.exec(text);
  const pageSize = pageMatch ? Number(pageMatch[1]) : 16384;
  const readPages = (label: string): number => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`^${escaped}:\\s+(\\d+)\\.?$`, 'm').exec(text);
    return m ? Number(m[1]) : 0;
  };
  const anonymous = readPages('Anonymous pages');
  const purgeable = readPages('Pages purgeable');
  const wired = readPages('Pages wired down');
  const compressor = readPages('Pages occupied by compressor');
  if (wired === 0 && anonymous === 0) return undefined;
  const usedPages = Math.max(0, anonymous - purgeable) + wired + compressor;
  return {pageSize, usedBytes: usedPages * pageSize};
}

export function parseMacSwapUsage(text: string): {
  swapTotalBytes: number;
  swapUsedBytes: number;
} | undefined {
  const parseUnit = (val: string, unit: string): number => {
    const n = Number(val);
    const u = unit.toUpperCase();
    if (u === 'G') return Math.round(n * 1024 * 1024 * 1024);
    if (u === 'M') return Math.round(n * 1024 * 1024);
    if (u === 'K') return Math.round(n * 1024);
    return Math.round(n);
  };
  const totalMatch = /total\s*=\s*([\d.]+)([KMG]?)/i.exec(text);
  const usedMatch = /used\s*=\s*([\d.]+)([KMG]?)/i.exec(text);
  if (!totalMatch || !usedMatch) return undefined;
  return {
    swapTotalBytes: parseUnit(totalMatch[1], totalMatch[2]),
    swapUsedBytes: parseUnit(usedMatch[1], usedMatch[2]),
  };
}

export function parseMacSysctlMemory(text: string): {
  swapTotalBytes?: number;
  swapUsedBytes?: number;
  pressure?: 'normal' | 'warning' | 'critical';
} {
  const swap = parseMacSwapUsage(text);
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const lastNum = lines.length > 0 ? Number(lines[lines.length - 1]) : NaN;
  const pressure: MemoryMetrics['pressure'] = lastNum === 4
    ? 'critical'
    : lastNum === 2
      ? 'warning'
      : lastNum === 1
        ? 'normal'
        : undefined;
  return {
    ...(swap ? {swapTotalBytes: swap.swapTotalBytes, swapUsedBytes: swap.swapUsedBytes} : {}),
    ...(pressure ? {pressure} : {}),
  };
}

export function parseMacIostat(text: string): Map<string, MacIostatSample> {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const out = new Map<string, MacIostatSample>();
  if (lines.length < 3) return out;
  const disks = lines[0].split(/\s+/);
  const values = lines[lines.length - 1].split(/\s+/).map(Number);
  for (let i = 0; i < disks.length; i++) {
    const base = i * 3;
    if (base + 2 >= values.length) break;
    const transfers = values[base + 1];
    const megabytes = values[base + 2];
    if (Number.isFinite(transfers) && Number.isFinite(megabytes)) {
      out.set(disks[i], {disk: disks[i], transfers, megabytes});
    }
  }
  return out;
}

export function parseMacNetstat(
  text: string,
  preferredIface?: string
): NetCounterSample | undefined {
  let preferred: NetCounterSample | undefined;
  let fallback: NetCounterSample | undefined;
  for (const line of text.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;
    const iface = parts[0];
    const network = parts[2];
    if (!network.startsWith('<Link#')) continue;
    if (iface === 'lo0' || /^(?:gif|stf|anpi|bridge|ap|awdl|llw|utun|pktap)/.test(iface)) {
      continue;
    }
    // Format varies by whether MAC address column is present (10 vs 11 columns).
    const hasMac = parts.length >= 11 && parts[3].includes(':');
    const offset = hasMac ? 1 : 0;
    const rxErrors = Number(parts[4 + offset]);
    const rxBytes = Number(parts[5 + offset]);
    const txErrors = Number(parts[7 + offset]);
    const txBytes = Number(parts[8 + offset]);
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;
    const sample: NetCounterSample = {
      iface,
      rxBytes,
      txBytes,
      rxErrors: Number.isFinite(rxErrors) ? rxErrors : 0,
      txErrors: Number.isFinite(txErrors) ? txErrors : 0,
    };
    if (preferredIface && iface === preferredIface) {
      preferred = sample;
    }
    if (!fallback || (sample.rxBytes + sample.txBytes) > (fallback.rxBytes + fallback.txBytes)) {
      fallback = sample;
    }
  }
  return preferred ?? fallback;
}

export function parseMacSoftwareUpdate(text: string, checkedAt: number): UpdateStatus {
  const labels: string[] = [];
  let rebootRequired = false;
  for (const line of text.split('\n')) {
    const m = /^\s*\*\s*Label:\s*(.+)$/.exec(line);
    if (m) labels.push(m[1].trim());
    if (/Action:\s*restart/i.test(line)) rebootRequired = true;
  }
  return {
    pending: labels.length,
    rebootRequired,
    checkedAt,
    ...(labels.length > 0 ? {summary: labels.slice(0, 3).join(', ')} : {}),
  };
}

export function parseDiskutilPhysicalDisk(text: string): string | undefined {
  const storeMatch = /APFS Physical Store:\s+(disk\d+)/i.exec(text);
  if (storeMatch) return storeMatch[1];
  const wholeMatch = /Part of Whole:\s+(disk\d+)/i.exec(text);
  if (wholeMatch) return wholeMatch[1];
  return undefined;
}

function statFileBytes(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function statDatabaseFiles(dbPath: string): DatabaseStorageMetrics {
  if (!dbPath || dbPath === ':memory:') return {dbBytes: 0, walBytes: 0};
  return {
    dbBytes: statFileBytes(dbPath),
    walBytes: statFileBytes(`${dbPath}-wal`),
  };
}

function statMountSpace(mount: string, label: string, mounted: boolean): DiskMetrics {
  if (!mounted) return {mount, label, mounted: false};
  try {
    const st = fs.statfsSync(mount);
    const totalBytes = st.blocks * st.bsize;
    const availableBytes = st.bavail * st.bsize;
    const usedBytes = Math.max(0, totalBytes - st.bfree * st.bsize);
    return {mount, label, mounted: true, totalBytes, usedBytes, availableBytes};
  } catch {
    return {mount, label, mounted: false};
  }
}

function scanLatestBackup(
  dir: string,
  pattern: RegExp
): {lastBackupAt?: number; lastBackupBytes?: number; backupCount: number} {
  try {
    if (!fs.existsSync(dir)) return {backupCount: 0};
    let lastBackupAt: number | undefined;
    let lastBackupBytes: number | undefined;
    let backupCount = 0;
    for (const name of fs.readdirSync(dir)) {
      if (!pattern.test(name)) continue;
      backupCount++;
      try {
        const st = fs.statSync(path.join(dir, name));
        const mtimeSeconds = Math.floor(st.mtimeMs / 1000);
        if (lastBackupAt === undefined || mtimeSeconds > lastBackupAt) {
          lastBackupAt = mtimeSeconds;
          lastBackupBytes = st.size;
        }
      } catch {}
    }
    return {lastBackupAt, lastBackupBytes, backupCount};
  } catch {
    return {backupCount: 0};
  }
}

const GIT_COMMIT: string | undefined = (() => {
  try {
    const out = childProcess.execFileSync(
      'git',
      ['rev-parse', '--short=8', 'HEAD'],
      {cwd: util.ROOT, encoding: 'utf8', timeout: 1000}
    ).trim();
    return /^[0-9a-f]{7,12}$/i.test(out) ? out.slice(0, 8) : undefined;
  } catch {
    return undefined;
  }
})();

function execTextAsync(
  cmd: string,
  args: string[],
  timeoutMillis = 5000
): Promise<string | undefined> {
  return new Promise(resolve => {
    childProcess.execFile(
      cmd,
      args,
      {encoding: 'utf8', timeout: timeoutMillis, maxBuffer: 512 * 1024},
      (err, stdout) => {
        if (err) {
          resolve(undefined);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

async function probeHttpsUrl(url: string, label: string): Promise<NetworkProbe> {
  const start = Date.now();
  const checkedAt = Math.floor(start / 1000);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: {'user-agent': 'pkmn.ai-health/1.0'},
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MILLIS),
    });
    const rttMillis = Math.max(1, Date.now() - start);
    // Any HTTP response (even 401 on ghcr.io/v2/ without token) proves DNS + TLS + HTTP work.
    return {
      target: label,
      ok: res.status < 500,
      rttMillis,
      checkedAt,
      ...(res.status >= 500 ? {error: `HTTP ${res.status}`} : {}),
    };
  } catch (err) {
    return {
      target: label,
      ok: false,
      checkedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function readTlsCertStatus(certPath: string, nowSeconds: number): TlsCertStatus | undefined {
  try {
    if (!fs.existsSync(certPath)) return undefined;
    const pem = fs.readFileSync(certPath, 'utf8');
    const cert = new crypto.X509Certificate(pem);
    const expiresAt = Math.floor(Date.parse(cert.validTo) / 1000);
    if (!Number.isFinite(expiresAt)) return undefined;
    const daysRemaining = Math.floor((expiresAt - nowSeconds) / 86400);
    return {expiresAt, daysRemaining, checkedAt: nowSeconds};
  } catch {
    return undefined;
  }
}

export function probeTlsCertEndpoint(
  host: string,
  port: number,
  servername: string,
  nowSeconds: number,
  timeoutMillis = PROBE_TIMEOUT_MILLIS
): Promise<TlsCertStatus | undefined> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (val: TlsCertStatus | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(val);
    };
    const socket = tls.connect({
      host,
      port,
      servername,
      rejectUnauthorized: false,
    }, () => {
      try {
        const peer = socket.getPeerCertificate(false);
        const validTo = peer?.raw
          ? new crypto.X509Certificate(peer.raw).validTo
          : peer?.valid_to;
        const expiresAt = validTo ? Math.floor(Date.parse(validTo) / 1000) : NaN;
        if (!Number.isFinite(expiresAt)) {
          finish(undefined);
          return;
        }
        const daysRemaining = Math.floor((expiresAt - nowSeconds) / 86400);
        finish({expiresAt, daysRemaining, checkedAt: nowSeconds});
      } catch {
        finish(undefined);
      }
    });
    const timer = setTimeout(() => finish(undefined), timeoutMillis);
    timer.unref?.();
    socket.on('error', () => finish(undefined));
  });
}

interface MinuteBucket {
  minute: number;
  requests: number;
  errors4xx: number;
  rateLimited429: number;
  errors5xx: number;
}

export class TrafficTracker {
  private readonly buckets: MinuteBucket[];
  private readonly visitors: Map<string, number>;
  private readonly latencies: number[];
  private latencyIdx: number;
  private last5xx: {at: number; path: string; status: number} | undefined;
  private readonly now: () => number;

  constructor(now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.now = now;
    this.buckets = Array.from({length: 60}, () => ({
      minute: -1,
      requests: 0,
      errors4xx: 0,
      rateLimited429: 0,
      errors5xx: 0,
    }));
    this.visitors = new Map();
    this.latencies = [];
    this.latencyIdx = 0;
    this.last5xx = undefined;
  }

  middleware(): (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    next: (err?: unknown) => void
  ) => void {
    return (req, res, next) => {
      const startMillis = Date.now();
      const rawUrl = req.url ?? '/';
      const pathname = rawUrl.split('?')[0];
      const realIp = typeof req.headers['x-real-ip'] === 'string'
        ? req.headers['x-real-ip'].trim()
        : undefined;
      const ip = realIp || req.socket?.remoteAddress || '';
      const isStream =
        /^\/api\/(?:battles|admin|account\/diagnostic|tournaments\/[^/]+)\/stream\/?$/
          .test(pathname);
      const isInternalArena = pathname.startsWith('/api/arena/') ||
        pathname === '/auth/discord/validate' ||
        pathname === '/admin' ||
        pathname === '/admin.json' ||
        pathname.startsWith('/admin/') ||
        pathname.startsWith('/api/admin/');

      res.once('finish', () => {
        this.record({
          status: res.statusCode,
          durationMillis: Math.max(0, Date.now() - startMillis),
          ip,
          pathname,
          isStream,
          isInternalArena,
        });
      });
      next();
    };
  }

  record(input: {
    status: number;
    durationMillis: number;
    ip?: string;
    pathname: string;
    isStream?: boolean;
    isInternalArena?: boolean;
  }): void {
    const nowSeconds = this.now();
    const minute = Math.floor(nowSeconds / 60);
    const slot = ((minute % 60) + 60) % 60;
    const bucket = this.buckets[slot];
    if (bucket.minute !== minute) {
      bucket.minute = minute;
      bucket.requests = 0;
      bucket.errors4xx = 0;
      bucket.rateLimited429 = 0;
      bucket.errors5xx = 0;
    }
    if (!input.isInternalArena) {
      bucket.requests++;
      if (input.status === 429) {
        bucket.rateLimited429++;
        bucket.errors4xx++;
      } else if (input.status >= 400 && input.status < 500) {
        bucket.errors4xx++;
      } else if (input.status >= 500) {
        bucket.errors5xx++;
        this.last5xx = {at: nowSeconds, path: input.pathname, status: input.status};
      }
      if (!input.isStream) {
        if (this.latencies.length < MAX_LATENCY_SAMPLES) {
          this.latencies.push(input.durationMillis);
        } else {
          this.latencies[this.latencyIdx] = input.durationMillis;
          this.latencyIdx = (this.latencyIdx + 1) % MAX_LATENCY_SAMPLES;
        }
      }
      if (input.ip && !input.isStream) {
        if (this.visitors.size >= MAX_TRACKED_VISITORS && !this.visitors.has(input.ip)) {
          this.pruneVisitors(nowSeconds);
        }
        if (this.visitors.size < MAX_TRACKED_VISITORS || this.visitors.has(input.ip)) {
          this.visitors.set(input.ip, nowSeconds);
        }
      }
    }
  }

  private pruneVisitors(nowSeconds: number): void {
    const cutoff = nowSeconds - VISITOR_WINDOW_SECONDS;
    for (const [ip, seen] of this.visitors) {
      if (seen < cutoff) this.visitors.delete(ip);
    }
  }

  snapshot(sse: SseViewerCounts, nowSeconds = this.now()): TrafficMetrics {
    this.pruneVisitors(nowSeconds);
    const currentMinute = Math.floor(nowSeconds / 60);
    const cutoffMinute = currentMinute - 59;
    let requests1m = 0;
    let requests1h = 0;
    let errors4xx1h = 0;
    let rateLimited4291h = 0;
    let errors5xx1h = 0;
    for (const b of this.buckets) {
      if (b.minute < cutoffMinute || b.minute > currentMinute) continue;
      requests1h += b.requests;
      errors4xx1h += b.errors4xx;
      rateLimited4291h += b.rateLimited429;
      errors5xx1h += b.errors5xx;
      if (b.minute === currentMinute) {
        requests1m += b.requests;
      }
    }

    let meanLatencyMillis: number | undefined;
    let p95LatencyMillis: number | undefined;
    if (this.latencies.length > 0) {
      const sorted = [...this.latencies].sort((a, b) => a - b);
      const sum = sorted.reduce((acc, v) => acc + v, 0);
      meanLatencyMillis = Math.round(sum / sorted.length);
      const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
      p95LatencyMillis = Math.round(sorted[p95Index]);
    }

    const last5xx = this.last5xx && nowSeconds - this.last5xx.at <= 3600 ? this.last5xx : undefined;
    return {
      sse,
      activeVisitors5m: this.visitors.size,
      requests1m,
      requests1h,
      errors4xx1h,
      rateLimited4291h,
      errors5xx1h,
      ...(meanLatencyMillis !== undefined ? {meanLatencyMillis} : {}),
      ...(p95LatencyMillis !== undefined ? {p95LatencyMillis} : {}),
      ...(last5xx ? {last5xx} : {}),
    };
  }
}

export interface VpsMonitorOptions {
  dbPath: string;
  traffic?: TrafficTracker;
  backupDir?: string;
  tlsCertPath?: string;
  tlsProbe?: {host: string; port: number; servername: string};
  now?: () => number;
}

export interface LinuxDiskRateState {
  prev?: {atMillis: number; sample: ProcDiskSample};
  rates?: {readBytesPerSecond: number; writeBytesPerSecond: number; iops: number; busyPct: number};
}

export function advanceLinuxDiskRates(
  state: LinuxDiskRateState,
  cur: ProcDiskSample,
  nowMillis: number
): LinuxDiskRateState['rates'] {
  if (state.prev?.sample.name !== cur.name) {
    state.prev = {atMillis: nowMillis, sample: cur};
    state.rates = undefined;
    return undefined;
  }
  const dtSeconds = (nowMillis - state.prev.atMillis) / 1000;
  if (dtSeconds < 0.5) {
    // Keep the previous baseline and most recent rates during sub-500ms bursts (e.g. /admin load
    // immediately followed by /api/admin/stream connect) so rates are never erased.
    return state.rates;
  }
  const dReadSec = Math.max(0, cur.sectorsRead - state.prev.sample.sectorsRead);
  const dWriteSec = Math.max(0, cur.sectorsWritten - state.prev.sample.sectorsWritten);
  const dOps = Math.max(0, cur.readsCompleted - state.prev.sample.readsCompleted) +
    Math.max(0, cur.writesCompleted - state.prev.sample.writesCompleted);
  const dTicks = Math.max(0, cur.ioTicksMillis - state.prev.sample.ioTicksMillis);
  state.rates = {
    readBytesPerSecond: Math.round((dReadSec * 512) / dtSeconds),
    writeBytesPerSecond: Math.round((dWriteSec * 512) / dtSeconds),
    iops: Math.round(dOps / dtSeconds),
    busyPct: Math.min(100, Math.round((dTicks / (dtSeconds * 1000)) * 100)),
  };
  state.prev = {atMillis: nowMillis, sample: cur};
  return state.rates;
}

export interface NetRateState {
  prev?: {atMillis: number; sample: NetCounterSample};
  rates?: {rxBytesPerSecond: number; txBytesPerSecond: number};
}

export function advanceNetRates(
  state: NetRateState,
  cur: NetCounterSample,
  nowMillis: number
): NetRateState['rates'] {
  if (state.prev?.sample.iface !== cur.iface) {
    state.prev = {atMillis: nowMillis, sample: cur};
    state.rates = undefined;
    return undefined;
  }
  const dtSeconds = (nowMillis - state.prev.atMillis) / 1000;
  if (dtSeconds < 0.5) {
    return state.rates;
  }
  state.rates = {
    rxBytesPerSecond: Math.round(Math.max(0, cur.rxBytes - state.prev.sample.rxBytes) / dtSeconds),
    txBytesPerSecond: Math.round(Math.max(0, cur.txBytes - state.prev.sample.txBytes) / dtSeconds),
  };
  state.prev = {atMillis: nowMillis, sample: cur};
  return state.rates;
}

export class VpsHostMonitor {
  private readonly dbPath: string;
  private readonly traffic: TrafficTracker | undefined;
  private readonly backupDir: string;
  private readonly tlsCertPath: string;
  private readonly tlsProbe: {host: string; port: number; servername: string} | undefined;
  private readonly now: () => number;
  private readonly diskRateState: LinuxDiskRateState;
  private readonly netRateState: NetRateState;
  private cachedExternalProbe: NetworkProbe | undefined;
  private cachedTlsCert: TlsCertStatus | undefined;
  private tlsChecked: boolean;
  private cachedBackups: BackupStatus | undefined;
  private lastBackupScanAt: number | undefined;
  private cachedMacMem: {usedBytes: number; swapTotalBytes: number; swapUsedBytes: number} |
    undefined;
  private probeTimer: ReturnType<typeof setInterval> | undefined;
  private tlsTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: VpsMonitorOptions) {
    this.dbPath = opts.dbPath;
    this.traffic = opts.traffic;
    this.backupDir = opts.backupDir ?? VPS_BACKUP_DIR;
    this.tlsCertPath = opts.tlsCertPath ?? VPS_TLS_CERT_PATH;
    // `/etc/letsencrypt/{live,archive}` are `0700 root:root` under `User=pkmn`, so Linux prod
    // falls back to probing local Nginx on loopback `:443` when the PEM file is unreadable.
    this.tlsProbe = opts.tlsProbe ?? (
      !opts.tlsCertPath && process.platform === 'linux'
        ? {host: '127.0.0.1', port: 443, servername: 'pkmn.ai'}
        : undefined
    );
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.diskRateState = {};
    this.netRateState = {};
    this.cachedExternalProbe = undefined;
    this.cachedTlsCert = undefined;
    this.tlsChecked = false;
    this.cachedBackups = undefined;
    this.lastBackupScanAt = undefined;
    this.cachedMacMem = undefined;
    this.probeTimer = undefined;
    this.tlsTimer = undefined;
  }

  start(): void {
    if (this.probeTimer) return;
    this.refreshSlowProbes().catch(() => {});
    this.refreshTlsCert().catch(() => {});
    this.probeTimer = setInterval(() => {
      this.refreshSlowProbes().catch(() => {});
    }, SLOW_PROBE_MILLIS);
    this.probeTimer.unref?.();
    this.tlsTimer = setInterval(() => {
      this.refreshTlsCert().catch(() => {});
    }, TLS_REFRESH_MILLIS);
    this.tlsTimer.unref?.();
  }

  stop(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = undefined;
    }
    if (this.tlsTimer) {
      clearInterval(this.tlsTimer);
      this.tlsTimer = undefined;
    }
  }

  async refreshTlsCert(): Promise<TlsCertStatus | undefined> {
    const nowSeconds = this.now();
    let cert = readTlsCertStatus(this.tlsCertPath, nowSeconds);
    if (!cert && this.tlsProbe) {
      cert = await probeTlsCertEndpoint(
        this.tlsProbe.host,
        this.tlsProbe.port,
        this.tlsProbe.servername,
        nowSeconds
      );
    }
    this.cachedTlsCert = cert;
    this.tlsChecked = true;
    return cert;
  }

  private async refreshSlowProbes(): Promise<void> {
    this.cachedExternalProbe = await probeHttpsUrl(VPS_PROBE_URL, 'api.github.com');
    if (process.platform === 'darwin') {
      const [vmOut, swapOut] = await Promise.all([
        execTextAsync('vm_stat', []),
        execTextAsync('sysctl', ['-n', 'vm.swapusage']),
      ]);
      const vm = vmOut ? parseMacVmStat(vmOut) : undefined;
      const swap = swapOut ? parseMacSwapUsage(swapOut) : undefined;
      if (vm || swap) {
        this.cachedMacMem = {
          usedBytes: vm?.usedBytes ?? Math.max(0, os.totalmem() - os.freemem()),
          swapTotalBytes: swap?.swapTotalBytes ?? 0,
          swapUsedBytes: swap?.swapUsedBytes ?? 0,
        };
      }
    }
  }

  sampleNow(input: {
    sse: SseViewerCounts;
    arenaFaults24h: ArenaFaultsSummary;
    lastHeartbeatAt?: number;
  }): VpsSystemInfo {
    const nowSeconds = this.now();
    const nowMillis = Date.now();
    const [load1, load5, load15] = os.loadavg();
    const load: LoadMetrics = {
      load1: Number(load1.toFixed(2)),
      load5: Number(load5.toFixed(2)),
      load15: Number(load15.toFixed(2)),
      cpus: os.cpus().length,
      uptimeSeconds: Math.floor(os.uptime()),
      processUptimeSeconds: Math.floor(process.uptime()),
    };

    const memory = this.sampleMemory();
    const disks = this.sampleDisks(nowMillis);
    const network = this.sampleNetwork(nowSeconds, nowMillis, input.lastHeartbeatAt);
    const updates = this.sampleUpdates(nowSeconds);
    const backups = this.sampleBackups(nowSeconds);
    const database = statDatabaseFiles(this.dbPath);
    const traffic = this.traffic
      ? this.traffic.snapshot(input.sse, nowSeconds)
      : {
        sse: input.sse,
        activeVisitors5m: 0,
        requests1m: 0,
        requests1h: 0,
        errors4xx1h: 0,
        rateLimited4291h: 0,
        errors5xx1h: 0,
      };
    if (!this.tlsChecked) {
      this.cachedTlsCert = readTlsCertStatus(this.tlsCertPath, nowSeconds);
      this.tlsChecked = true;
    }
    const tlsCert = this.cachedTlsCert
      ? {
        ...this.cachedTlsCert,
        daysRemaining: Math.floor((this.cachedTlsCert.expiresAt - nowSeconds) / 86400),
      }
      : undefined;

    return {
      collectedAt: nowSeconds,
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      nodeVersion: process.version,
      ...(GIT_COMMIT ? {gitCommit: GIT_COMMIT} : {}),
      load,
      memory,
      disks,
      network,
      ...(updates ? {updates} : {}),
      backups,
      database,
      traffic,
      ...(tlsCert ? {tlsCert} : {}),
      arenaFaults24h: input.arenaFaults24h,
    };
  }

  private sampleMemory(): MemoryMetrics {
    const rss = process.memoryUsage().rss;
    if (process.platform === 'linux') {
      try {
        const parsed = parseProcMeminfo(fs.readFileSync('/proc/meminfo', 'utf8'));
        if (parsed) {
          return {...parsed, processRssBytes: rss};
        }
      } catch {}
    }
    const totalBytes = os.totalmem();
    if (this.cachedMacMem) {
      const usedBytes = Math.min(totalBytes, this.cachedMacMem.usedBytes);
      return {
        totalBytes,
        usedBytes,
        availableBytes: Math.max(0, totalBytes - usedBytes),
        swapTotalBytes: this.cachedMacMem.swapTotalBytes,
        swapUsedBytes: this.cachedMacMem.swapUsedBytes,
        processRssBytes: rss,
      };
    }
    const availableBytes = os.freemem();
    return {
      totalBytes,
      usedBytes: Math.max(0, totalBytes - availableBytes),
      availableBytes,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
      processRssBytes: rss,
    };
  }

  private sampleDisks(nowMillis: number): DiskMetrics[] {
    const rootDisk = statMountSpace('/', 'Root', true);
    if (process.platform === 'linux') {
      try {
        const stats = parseProcDiskstats(fs.readFileSync('/proc/diskstats', 'utf8'));
        const mounts = fs.existsSync('/proc/mounts')
          ? fs.readFileSync('/proc/mounts', 'utf8')
          : undefined;
        const dev = pickRootLinuxDisk(stats, mounts);
        const cur = dev ? stats.get(dev) : undefined;
        if (cur) {
          const rates = advanceLinuxDiskRates(this.diskRateState, cur, nowMillis);
          if (rates) {
            rootDisk.readBytesPerSecond = rates.readBytesPerSecond;
            rootDisk.writeBytesPerSecond = rates.writeBytesPerSecond;
            rootDisk.iops = rates.iops;
            rootDisk.busyPct = rates.busyPct;
          }
        }
      } catch {}
    }
    return [rootDisk];
  }

  private sampleNetwork(
    nowSeconds: number,
    nowMillis: number,
    lastHeartbeatAt?: number
  ): NetworkMetrics {
    const out: NetworkMetrics = {};
    if (process.platform === 'linux') {
      try {
        const cur = parseProcNetDev(fs.readFileSync('/proc/net/dev', 'utf8'));
        if (cur) {
          out.iface = cur.iface;
          out.rxErrors = cur.rxErrors;
          out.txErrors = cur.txErrors;
          const rates = advanceNetRates(this.netRateState, cur, nowMillis);
          if (rates) {
            out.rxBytesPerSecond = rates.rxBytesPerSecond;
            out.txBytesPerSecond = rates.txBytesPerSecond;
          }
        }
      } catch {}

      try {
        const tcp = fs.readFileSync('/proc/net/tcp', 'utf8');
        const tunnelOpen = parseProcNetTcpListening(tcp, 2222);
        out.internal = {
          target: 'SSH tunnel :2222',
          ok: tunnelOpen,
          checkedAt: nowSeconds,
          ...(!tunnelOpen ? {error: 'not listening'} : {}),
        };
      } catch {}
    } else if (lastHeartbeatAt !== undefined) {
      const age = Math.max(0, nowSeconds - lastHeartbeatAt);
      out.internal = {
        target: 'Arena heartbeat',
        ok: age < 15 * 60,
        checkedAt: nowSeconds,
        ...(age >= 15 * 60 ? {error: `stale (${Math.floor(age / 60)}m)`} : {}),
      };
    }

    if (this.cachedExternalProbe) {
      out.external = this.cachedExternalProbe;
    }
    return out;
  }

  private sampleUpdates(nowSeconds: number): UpdateStatus | undefined {
    if (process.platform !== 'linux') return undefined;
    let text: string | undefined;
    try {
      if (fs.existsSync(VPS_UPDATES_PATH)) {
        text = fs.readFileSync(VPS_UPDATES_PATH, 'utf8');
      }
    } catch {}
    let rebootRequired = false;
    try {
      rebootRequired = fs.existsSync(VPS_REBOOT_PATH);
    } catch {}
    return parseUbuntuUpdates(text, rebootRequired, nowSeconds);
  }

  private sampleBackups(nowSeconds: number): BackupStatus {
    const windowStart = latestScheduledWindowStart(
      nowSeconds,
      VPS_BACKUP_HOUR_UTC,
      VPS_BACKUP_MINUTE_UTC,
      true
    );
    if (
      this.cachedBackups?.lastBackupAt !== undefined &&
      this.cachedBackups.lastBackupAt >= windowStart
    ) {
      return this.cachedBackups;
    }
    if (
      this.cachedBackups &&
      this.lastBackupScanAt !== undefined &&
      nowSeconds - this.lastBackupScanAt < BACKUP_RETRY_SECONDS
    ) {
      return this.cachedBackups;
    }
    const scanned = scanLatestBackup(this.backupDir, /^arena-.*\.sqlite\.zst$/);
    this.cachedBackups = {...scanned, checkedAt: nowSeconds};
    this.lastBackupScanAt = nowSeconds;
    return this.cachedBackups;
  }
}

export interface ArenaMonitorOptions {
  stateDbPath: string;
  getOutboxCount: () => number;
  isArchiveMounted: () => boolean;
  archiveMount?: string;
  archiveStatusPath?: string;
  updatesStatusPath?: string;
  requireGcsSync?: boolean;
  now?: () => number;
}

interface ArchiveStatusFile {
  completedAt?: number;
  backupAt?: number;
  backupBytes?: number;
  gcsSyncedAt?: number;
  error?: string;
  errorAt?: number;
}

export class ArenaHostMonitor {
  private readonly stateDbPath: string;
  private readonly getOutboxCount: () => number;
  private readonly isArchiveMounted: () => boolean;
  private readonly archiveMount: string;
  private readonly archiveStatusPath: string;
  private readonly updatesStatusPath: string;
  private readonly requireGcsSync: boolean;
  private readonly now: () => number;

  private latest: ArenaSystemInfo | undefined;
  private internalProbe: NetworkProbe | undefined;
  private externalProbe: NetworkProbe | undefined;
  private cachedUpdates: UpdateStatus | undefined;
  private cachedBackups: BackupStatus | undefined;
  private cachedPodmanState: string | undefined;
  private cachedPodmanCheckedAt: number | undefined;
  private daemonErrors: number;
  private defaultIface: string | undefined;
  private rootDiskName: string | undefined;
  private archiveDiskName: string | undefined;
  private prevIostat: {atMillis: number; disks: Map<string, MacIostatSample>} | undefined;
  private lastIostatRates: Map<string, {ioBytesPerSecond: number; iops: number}>;
  private readonly netRateState: NetRateState;
  private lastFastAt: number | undefined;
  private lastSlowAt: number | undefined;
  private lastBackupScanAt: number | undefined;
  private revision: number;
  private sentRevision: number;
  private lastSentOutbox: number;
  private pendingSendRevision: number;

  constructor(opts: ArenaMonitorOptions) {
    this.stateDbPath = opts.stateDbPath;
    this.getOutboxCount = opts.getOutboxCount;
    this.isArchiveMounted = opts.isArchiveMounted;
    this.archiveMount = opts.archiveMount ?? ARCHIVE_MOUNT;
    this.archiveStatusPath = opts.archiveStatusPath ?? ARCHIVE_STATUS_FILE;
    this.updatesStatusPath = opts.updatesStatusPath ?? UPDATES_STATUS_FILE;
    this.requireGcsSync = opts.requireGcsSync ?? Boolean(process.env.ARENA_GCS_SYNC);
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.latest = undefined;
    this.internalProbe = undefined;
    this.externalProbe = undefined;
    this.cachedUpdates = undefined;
    this.cachedBackups = undefined;
    this.cachedPodmanState = undefined;
    this.cachedPodmanCheckedAt = undefined;
    this.daemonErrors = 0;
    this.defaultIface = undefined;
    this.rootDiskName = undefined;
    this.archiveDiskName = undefined;
    this.prevIostat = undefined;
    this.lastIostatRates = new Map();
    this.netRateState = {};
    this.lastFastAt = undefined;
    this.lastSlowAt = undefined;
    this.lastBackupScanAt = undefined;
    this.revision = 0;
    this.sentRevision = 0;
    this.lastSentOutbox = -1;
    this.pendingSendRevision = 0;
  }

  // Called explicitly between matches and during idle loops so telemetry subprocesses never
  // execute mid-battle.
  async maybeRefresh(): Promise<void> {
    const nowSeconds = this.now();
    const tasks: Array<Promise<unknown>> = [];
    const needBackup = this.shouldScanBackups(nowSeconds);
    if (needBackup) {
      this.refreshBackups(nowSeconds);
    }
    const needFast = this.lastFastAt === undefined ||
      nowSeconds - this.lastFastAt >= FAST_SAMPLE_SECONDS;
    const needSlow = this.lastSlowAt === undefined ||
      nowSeconds - this.lastSlowAt >= SLOW_PROBE_SECONDS;
    if (needSlow) {
      this.lastSlowAt = nowSeconds;
      tasks.push(this.refreshSlow().catch(() => {}));
    }
    if (needFast) {
      this.lastFastAt = nowSeconds;
      tasks.push(this.refreshFast(true).catch(() => {}));
    }
    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  }

  recordHeartbeatRtt(rttMillis: number, ok: boolean, error?: string): void {
    const checkedAt = this.now();
    const prev = this.internalProbe;
    this.internalProbe = {
      target: 'VPS tunnel',
      ok,
      ...(ok ? {rttMillis: Math.max(1, Math.round(rttMillis))} : {}),
      checkedAt,
      ...(error ? {error} : {}),
    };
    if (ok && this.pendingSendRevision > this.sentRevision) {
      this.sentRevision = this.pendingSendRevision;
    }
    if (this.latest) {
      this.latest = {
        ...this.latest,
        network: {
          ...this.latest.network,
          internal: this.internalProbe,
        },
      };
      if (prev?.ok !== ok) {
        this.revision++;
      }
    }
  }

  recordDaemonErrors(count: number): void {
    if (this.daemonErrors === count) return;
    this.daemonErrors = count;
    if (this.latest) {
      this.latest = {...this.latest, daemonErrors: count};
      this.revision++;
    }
  }

  getSnapshot(): ArenaSystemInfo | undefined {
    if (!this.latest) return undefined;
    return {
      ...this.latest,
      outboxPending: this.safeOutboxCount(),
      daemonErrors: this.daemonErrors,
    };
  }

  // Returns the snapshot only when telemetry changed since the last acknowledged heartbeat so
  // per-turn heartbeats stay lean while guaranteeing delivery after dropped requests. When called
  // between paused turns during long matches, refreshes all fast host probes (`~11ms` warm on
  // macOS, skipping one-time `diskutil`/`route` discovery) at most once per `FAST_SAMPLE_SECONDS`.
  async takePendingSnapshot(): Promise<ArenaSystemInfo | undefined> {
    const nowSeconds = this.now();
    if (
      this.latest &&
      (this.lastFastAt === undefined || nowSeconds - this.lastFastAt >= FAST_SAMPLE_SECONDS)
    ) {
      this.lastFastAt = nowSeconds;
      await this.refreshFast(false).catch(() => {});
    }
    const snap = this.getSnapshot();
    if (!snap) return undefined;
    if (this.revision === this.sentRevision && snap.outboxPending === this.lastSentOutbox) {
      return undefined;
    }
    this.pendingSendRevision = this.revision;
    this.lastSentOutbox = snap.outboxPending;
    return snap;
  }

  private safeOutboxCount(): number {
    try {
      return this.getOutboxCount();
    } catch {
      return 0;
    }
  }

  private readArchiveStatus(): ArchiveStatusFile | undefined {
    try {
      if (!fs.existsSync(this.archiveStatusPath)) return undefined;
      return JSON.parse(fs.readFileSync(this.archiveStatusPath, 'utf8')) as ArchiveStatusFile;
    } catch {
      return undefined;
    }
  }

  private readUpdatesStatus(): UpdateStatus | undefined {
    try {
      if (!fs.existsSync(this.updatesStatusPath)) return undefined;
      return JSON.parse(fs.readFileSync(this.updatesStatusPath, 'utf8')) as UpdateStatus;
    } catch {
      return undefined;
    }
  }

  private shouldScanBackups(nowSeconds: number): boolean {
    const windowStart = latestScheduledWindowStart(
      nowSeconds,
      ARENA_MAINTENANCE_HOUR_UTC,
      ARENA_MAINTENANCE_MINUTE_UTC,
      true
    );
    const cur = this.cachedBackups;
    const backupGood = cur?.lastBackupAt !== undefined && cur.lastBackupAt >= windowStart;
    const gcsGood = !this.requireGcsSync ||
      (cur?.lastArchiveUploadAt !== undefined && cur.lastArchiveUploadAt >= windowStart);
    const updatesGood =
      this.cachedUpdates !== undefined && this.cachedUpdates.checkedAt >= windowStart;
    if (cur && !cur.archiveError && backupGood && gcsGood && updatesGood) {
      return false;
    }
    if (
      this.lastBackupScanAt !== undefined &&
      nowSeconds - this.lastBackupScanAt < BACKUP_RETRY_SECONDS
    ) {
      return false;
    }
    return true;
  }

  refreshBackups(nowSeconds = this.now()): BackupStatus {
    const archiveMounted = this.isArchiveMounted();
    const scannedBackup = archiveMounted
      ? scanLatestBackup(
        path.join(this.archiveMount, 'db-backups'),
        /^arena-state-.*\.sqlite\.zst$/
      )
      : {backupCount: 0};
    const archiveStatus = this.readArchiveStatus();
    const updatesStatus = this.readUpdatesStatus();
    if (updatesStatus) {
      this.cachedUpdates = updatesStatus;
    }
    const backups: BackupStatus = {
      lastBackupAt: scannedBackup.lastBackupAt ?? archiveStatus?.backupAt,
      lastBackupBytes: scannedBackup.lastBackupBytes ?? archiveStatus?.backupBytes,
      backupCount: scannedBackup.backupCount,
      ...(archiveStatus?.gcsSyncedAt ? {lastArchiveUploadAt: archiveStatus.gcsSyncedAt} : {}),
      ...(archiveStatus?.error ? {archiveError: archiveStatus.error} : {}),
      checkedAt: nowSeconds,
    };
    this.cachedBackups = backups;
    this.lastBackupScanAt = nowSeconds;
    if (this.latest) {
      this.latest = {
        ...this.latest,
        backups,
        ...(this.cachedUpdates ? {updates: this.cachedUpdates} : {}),
      };
      this.revision++;
    }
    return backups;
  }

  async refreshFast(allowDiscovery = true): Promise<ArenaSystemInfo> {
    const nowSeconds = this.now();
    this.lastFastAt = nowSeconds;
    const nowMillis = Date.now();
    const [load1, load5, load15] = os.loadavg();
    const load: LoadMetrics = {
      load1: Number(load1.toFixed(2)),
      load5: Number(load5.toFixed(2)),
      load15: Number(load15.toFixed(2)),
      cpus: os.cpus().length,
      uptimeSeconds: Math.floor(os.uptime()),
      processUptimeSeconds: Math.floor(process.uptime()),
    };

    const archiveMounted = this.isArchiveMounted();
    const rootDisk = statMountSpace('/', 'Internal', true);
    const archiveDisk = statMountSpace(this.archiveMount, 'Archive', archiveMounted);
    const disks: DiskMetrics[] = [rootDisk, archiveDisk];

    let memory: MemoryMetrics = {
      totalBytes: os.totalmem(),
      usedBytes: Math.max(0, os.totalmem() - os.freemem()),
      availableBytes: os.freemem(),
      swapTotalBytes: 0,
      swapUsedBytes: 0,
      processRssBytes: process.memoryUsage().rss,
    };
    const network: NetworkMetrics = {
      ...(this.internalProbe ? {internal: this.internalProbe} : {}),
      ...(this.externalProbe ? {external: this.externalProbe} : {}),
    };

    if (process.platform === 'darwin') {
      if (!archiveMounted) {
        this.archiveDiskName = undefined;
      }
      if (allowDiscovery) {
        if (!this.rootDiskName) {
          const info = await execTextAsync('diskutil', ['info', '/']);
          if (info) this.rootDiskName = parseDiskutilPhysicalDisk(info);
        }
        if (archiveMounted && !this.archiveDiskName) {
          const info = await execTextAsync('diskutil', ['info', this.archiveMount]);
          if (info) this.archiveDiskName = parseDiskutilPhysicalDisk(info);
        }
        if (!this.defaultIface) {
          const routeOut = await execTextAsync('route', ['-n', 'get', 'default']);
          const m = routeOut ? /interface:\s*(\S+)/.exec(routeOut) : undefined;
          if (m) this.defaultIface = m[1];
        }
      }

      const [vmOut, sysctlOut, iostatOut, netOut] = await Promise.all([
        execTextAsync('vm_stat', []),
        execTextAsync('sysctl', ['-n', 'vm.swapusage', 'kern.memorystatus_vm_pressure_level']),
        execTextAsync('iostat', ['-Id', '-n', '16']),
        execTextAsync('netstat', ['-ibn']),
      ]);

      const vm = vmOut ? parseMacVmStat(vmOut) : undefined;
      const sysctlMem = sysctlOut ? parseMacSysctlMemory(sysctlOut) : undefined;
      if (vm || sysctlMem?.swapTotalBytes !== undefined || sysctlMem?.pressure) {
        const usedBytes = vm ? Math.min(memory.totalBytes, vm.usedBytes) : memory.usedBytes;
        memory = {
          totalBytes: memory.totalBytes,
          usedBytes,
          availableBytes: Math.max(0, memory.totalBytes - usedBytes),
          swapTotalBytes: sysctlMem?.swapTotalBytes ?? 0,
          swapUsedBytes: sysctlMem?.swapUsedBytes ?? 0,
          processRssBytes: memory.processRssBytes,
          ...(sysctlMem?.pressure ? {pressure: sysctlMem.pressure} : {}),
        };
      }

      if (iostatOut) {
        const curDisks = parseMacIostat(iostatOut);
        if (!this.prevIostat) {
          this.prevIostat = {atMillis: nowMillis, disks: curDisks};
        } else {
          const dtSeconds = (nowMillis - this.prevIostat.atMillis) / 1000;
          if (dtSeconds >= 0.5) {
            const updateIo = (target: DiskMetrics, diskName?: string) => {
              if (!diskName) return;
              const cur = curDisks.get(diskName);
              const prev = this.prevIostat!.disks.get(diskName);
              if (!cur || !prev) return;
              const dMb = Math.max(0, cur.megabytes - prev.megabytes);
              const dXfrs = Math.max(0, cur.transfers - prev.transfers);
              const rates = {
                ioBytesPerSecond: Math.round((dMb * 1024 * 1024) / dtSeconds),
                iops: Math.round(dXfrs / dtSeconds),
              };
              this.lastIostatRates.set(diskName, rates);
              target.ioBytesPerSecond = rates.ioBytesPerSecond;
              target.iops = rates.iops;
            };
            updateIo(rootDisk, this.rootDiskName);
            if (archiveMounted) updateIo(archiveDisk, this.archiveDiskName);
            this.prevIostat = {atMillis: nowMillis, disks: curDisks};
          } else {
            const reuseIo = (target: DiskMetrics, diskName?: string) => {
              const cached = diskName ? this.lastIostatRates.get(diskName) : undefined;
              if (!cached) return;
              target.ioBytesPerSecond = cached.ioBytesPerSecond;
              target.iops = cached.iops;
            };
            reuseIo(rootDisk, this.rootDiskName);
            if (archiveMounted) reuseIo(archiveDisk, this.archiveDiskName);
          }
        }
      }

      if (netOut) {
        const curNet = parseMacNetstat(netOut, this.defaultIface);
        if (curNet) {
          network.iface = curNet.iface;
          network.rxErrors = curNet.rxErrors;
          network.txErrors = curNet.txErrors;
          const rates = advanceNetRates(this.netRateState, curNet, nowMillis);
          if (rates) {
            network.rxBytesPerSecond = rates.rxBytesPerSecond;
            network.txBytesPerSecond = rates.txBytesPerSecond;
          }
        }
      }
    }

    const backups = this.cachedBackups ?? this.refreshBackups(nowSeconds);
    this.latest = {
      collectedAt: nowSeconds,
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      nodeVersion: process.version,
      ...(GIT_COMMIT ? {gitCommit: GIT_COMMIT} : {}),
      load,
      memory,
      disks,
      network,
      ...(this.cachedUpdates ? {updates: this.cachedUpdates} : {}),
      backups,
      database: statDatabaseFiles(this.stateDbPath),
      outboxPending: this.safeOutboxCount(),
      daemonErrors: this.daemonErrors,
      ...(this.cachedPodmanState ? {podmanState: this.cachedPodmanState} : {}),
      ...(this.cachedPodmanCheckedAt !== undefined
        ? {podmanCheckedAt: this.cachedPodmanCheckedAt}
        : {}),
    };
    this.revision++;
    return this.latest;
  }

  private async refreshSlow(): Promise<void> {
    const [extProbe, podmanOut] = await Promise.all([
      probeHttpsUrl(ARENA_PROBE_URL, 'ghcr.io'),
      process.platform === 'darwin'
        ? execTextAsync('podman', [
          'machine', 'inspect', '--format', '{{.State}}', 'podman-machine-default',
        ])
        : Promise.resolve(undefined),
    ]);
    const checkedAt = this.now();
    this.externalProbe = extProbe;
    if (process.platform === 'darwin') {
      this.cachedPodmanState = podmanOut ? podmanOut.trim().toLowerCase() : 'error';
      this.cachedPodmanCheckedAt = checkedAt;
    }
    if (this.latest) {
      this.latest = {
        ...this.latest,
        network: {
          ...this.latest.network,
          external: extProbe,
        },
        ...(this.cachedPodmanState ? {podmanState: this.cachedPodmanState} : {}),
        ...(this.cachedPodmanCheckedAt !== undefined
          ? {podmanCheckedAt: this.cachedPodmanCheckedAt}
          : {}),
      };
      this.revision++;
    }
  }
}
