import {execFileSync} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {isAllowedBundleHost} from '../server/account';
import {root} from '../static/util';

import {AgentMode, LocalAgentRow, StateDatabase} from './db';

export const MAX_IMAGE_BYTES = 500 * 1024 * 1024; // 500 MB hard cap
export const MAX_OCI_LAYERS = 32;
const MAX_REDIRECT_HOPS = 5;
const DOWNLOAD_TIMEOUT_MILLIS = 180_000;
export const HOT_AGENTS_HIGH_WATER_BYTES = 1350 * 1024 * 1024 * 1024; // 1.35 TB host SSD
export const HOT_AGENTS_LOW_WATER_BYTES = 1200 * 1024 * 1024 * 1024; // 1.20 TB host SSD
// Separate disk-usage watermarks inside `podman-machine-default`'s 64 GB virtual disk on the Mac
// mini SSD (`setup-arena.sh --disk-size 64`) so cached OCI images never fill the VM rootfs.
export const HOT_CONTAINERS_HIGH_WATER_BYTES = 40 * 1000 * 1000 * 1000; // 40 GB disk
export const HOT_CONTAINERS_LOW_WATER_BYTES = 32 * 1000 * 1000 * 1000; // 32 GB disk

export const AGENTS_DIR = process.env.ARENA_AGENTS_DIR ?? '/opt/arena/agents';
export const CAS_DIR = process.env.ARENA_CAS_DIR ?? '/opt/arena/cas/sha256';
export const STAGING_DIR = process.env.ARENA_STAGING_DIR ?? '/Volumes/Staging';
export const COLD_AGENTS_DIR =
  process.env.ARENA_COLD_AGENTS_DIR ?? '/Volumes/Archive/cold-agents';
export const UNPACK_BIN =
  process.env.ARENA_UNPACK_BIN ??
  (fs.existsSync('/opt/arena/bin/unpack')
    ? '/opt/arena/bin/unpack'
    : root('arena', 'bin', 'unpack'));

export interface OciManifestInspection {
  compressedBytes: number;
  layerCount: number;
  manifestSha256: string;
  configSha256?: string;
  indexSha256?: string;
}

export function stripOciTagOrDigest(imageRef: string): string {
  const withoutDigest = imageRef.split('@')[0];
  const slashIdx = withoutDigest.lastIndexOf('/');
  const tail = slashIdx >= 0 ? withoutDigest.slice(slashIdx + 1) : withoutDigest;
  const colonIdx = tail.indexOf(':');
  if (colonIdx < 0) return withoutDigest;
  const repoTail = tail.slice(0, colonIdx);
  return slashIdx >= 0 ? `${withoutDigest.slice(0, slashIdx)}/${repoTail}` : repoTail;
}

export function scrubAuthSecret(message: string, rawToken?: string): string {
  if (!rawToken) return message;
  let out = message;
  const trimmed = rawToken.trim();
  if (trimmed.length >= 4) out = out.split(trimmed).join('[REDACTED]');
  const bare = trimmed
    .replace(/^authorization:\s*/i, '')
    .replace(/^(?:bearer|basic)\s+/i, '')
    .trim();
  if (bare.length >= 4) out = out.split(bare).join('[REDACTED]');
  if (bare.includes(':')) {
    const pass = bare.slice(bare.indexOf(':') + 1);
    if (pass.length >= 4) out = out.split(pass).join('[REDACTED]');
  }
  return out;
}

export function scrubError(err: unknown, rawToken?: string): Error {
  if (err instanceof Error) {
    err.message = scrubAuthSecret(err.message, rawToken);
    const execErr = err as Error & {stderr?: string | Buffer; stdout?: string | Buffer};
    if (typeof execErr.stderr === 'string') {
      execErr.stderr = scrubAuthSecret(execErr.stderr, rawToken);
    }
    if (typeof execErr.stdout === 'string') {
      execErr.stdout = scrubAuthSecret(execErr.stdout, rawToken);
    }
    return err;
  }
  return new Error(scrubAuthSecret(String(err), rawToken));
}

export function writePrivateSkopeoAuthfile(
  workDir: string,
  imageRef: string,
  rawToken: string
): string {
  const noHeader = rawToken.replace(/^authorization:\s*/i, '').trim();
  let authBase64: string;
  if (/^basic\s+/i.test(noHeader)) {
    const rest = noHeader.replace(/^basic\s+/i, '').trim();
    authBase64 = rest.includes(':') ? Buffer.from(rest, 'utf8').toString('base64') : rest;
  } else {
    const clean = noHeader.replace(/^bearer\s+/i, '').trim();
    const creds = clean.includes(':') ? clean : `oauth2:${clean}`;
    authBase64 = Buffer.from(creds, 'utf8').toString('base64');
  }

  const firstSeg = imageRef.split('/')[0];
  const host =
    firstSeg.includes('.') || firstSeg.includes(':') || firstSeg === 'localhost'
      ? firstSeg
      : 'docker.io';
  const auths: Record<string, {auth: string}> = {[host]: {auth: authBase64}};
  if (host === 'docker.io') {
    auths['https://index.docker.io/v1/'] = {auth: authBase64};
  }
  const authPath = path.join(workDir, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({auths}), {mode: 0o600});
  return authPath;
}

export function verifyOciManifestDigest(
  rawManifestJson: string,
  expectedSha256?: string
): OciManifestInspection {
  const manifest = JSON.parse(rawManifestJson) as {
    config?: {digest?: string};
    layers?: Array<{size?: number}>;
    manifests?: unknown[];
  };

  if (!Array.isArray(manifest.layers)) {
    throw new Error(
      'Manifest is not a single-arch OCI/Docker image (multi-arch index must be resolved first)'
    );
  }
  if (manifest.layers.length === 0 || manifest.layers.length > MAX_OCI_LAYERS) {
    throw new Error(
      `Invalid OCI layer count: ${manifest.layers.length} (max ${MAX_OCI_LAYERS})`
    );
  }

  let compressedBytes = 0;
  for (const layer of manifest.layers) {
    compressedBytes += Number(layer.size ?? 0);
  }
  if (compressedBytes > MAX_IMAGE_BYTES) {
    throw new Error(
      `Compressed OCI layers (${compressedBytes} B) exceed 500 MB limit (${MAX_IMAGE_BYTES} B)`
    );
  }

  const manifestSha256 = crypto.createHash('sha256').update(rawManifestJson).digest('hex');
  const rawConfigDigest = manifest.config?.digest ?? '';
  const configSha256 = rawConfigDigest.startsWith('sha256:')
    ? rawConfigDigest.slice(7).toLowerCase()
    : undefined;

  if (expectedSha256) {
    const cleanExpected = expectedSha256.trim().toLowerCase().replace(/^sha256:/, '');
    if (cleanExpected !== manifestSha256) {
      throw new Error(
        `OCI digest mismatch: expected ${cleanExpected}, got manifest=${manifestSha256}`
      );
    }
  }

  return {
    compressedBytes,
    layerCount: manifest.layers.length,
    manifestSha256,
    configSha256,
  };
}

export function inspectRemoteOciSize(
  imageRef: string,
  creds?: string,
  expectedSha256?: string,
  platform: {os: string; arch: string} = {os: 'linux', arch: 'arm64'},
  stagingDir = STAGING_DIR
): OciManifestInspection {
  const cleanRef = imageRef.replace(/^docker:\/\//, '').trim();
  const repoRef = stripOciTagOrDigest(cleanRef);
  let authWorkDir: string | undefined;
  try {
    const authArgs: string[] = [];
    if (creds) {
      fs.mkdirSync(stagingDir, {recursive: true});
      authWorkDir = fs.mkdtempSync(path.join(stagingDir, 'oci-auth-'));
      fs.chmodSync(authWorkDir, 0o700);
      authArgs.push('--authfile', writePrivateSkopeoAuthfile(authWorkDir, cleanRef, creds));
    }

    const outerRaw = execFileSync(
      'skopeo',
      ['inspect', '--raw', ...authArgs, `docker://${cleanRef}`],
      {encoding: 'utf8', timeout: 30_000}
    );
    const outerSha = crypto.createHash('sha256').update(outerRaw).digest('hex');
    const cleanExpected = expectedSha256?.trim().toLowerCase().replace(/^sha256:/, '');
    if (cleanExpected && cleanExpected !== outerSha) {
      throw new Error(`OCI digest mismatch: expected ${cleanExpected}, got manifest=${outerSha}`);
    }

    const parsedOuter = JSON.parse(outerRaw) as {
      manifests?: Array<{digest?: string; platform?: {os?: string; architecture?: string}}>;
    };
    if (Array.isArray(parsedOuter.manifests)) {
      const target = parsedOuter.manifests.find(
        m => m.platform?.os === platform.os && m.platform?.architecture === platform.arch
      );
      if (!target?.digest) {
        throw new Error(
          `Multi-arch OCI index has no ${platform.os}/${platform.arch} manifest`
        );
      }
      const targetSha = target.digest.toLowerCase().replace(/^sha256:/, '');
      if (!/^[0-9a-f]{64}$/.test(targetSha)) {
        throw new Error(`Invalid platform manifest digest in OCI index: ${target.digest}`);
      }
      const innerRaw = execFileSync(
        'skopeo',
        ['inspect', '--raw', ...authArgs, `docker://${repoRef}@sha256:${targetSha}`],
        {encoding: 'utf8', timeout: 30_000}
      );
      return {
        ...verifyOciManifestDigest(innerRaw, targetSha),
        indexSha256: outerSha,
      };
    }

    return verifyOciManifestDigest(outerRaw, cleanExpected);
  } catch (err) {
    throw scrubError(err, creds);
  } finally {
    if (authWorkDir) fs.rmSync(authWorkDir, {recursive: true, force: true});
  }
}

export function pullAndVerifyOciImage(
  imageRef: string,
  agentTargetId: string,
  creds?: string,
  stagingDir = STAGING_DIR,
  expectedSha256?: string
): number {
  const cleanRef = imageRef.replace(/^docker:\/\//, '').trim();
  const repoRef = stripOciTagOrDigest(cleanRef);
  const inspected = inspectRemoteOciSize(
    cleanRef,
    creds,
    expectedSha256,
    {os: 'linux', arch: 'arm64'},
    stagingDir
  );

  fs.mkdirSync(stagingDir, {recursive: true});
  const stagingTar = path.join(stagingDir, `oci-${agentTargetId}.tar`);
  fs.rmSync(stagingTar, {force: true});
  let authWorkDir: string | undefined;

  try {
    const authArgs: string[] = [];
    if (creds) {
      authWorkDir = fs.mkdtempSync(path.join(stagingDir, 'oci-auth-'));
      fs.chmodSync(authWorkDir, 0o700);
      authArgs.push('--authfile', writePrivateSkopeoAuthfile(authWorkDir, cleanRef, creds));
    }

    execFileSync(
      'skopeo',
      [
        'copy',
        '--override-os', 'linux',
        '--override-arch', 'arm64',
        ...authArgs,
        `docker://${repoRef}@sha256:${inspected.manifestSha256}`,
        `docker-archive:${stagingTar}:${agentTargetId}:latest`,
      ],
      {timeout: 180_000}
    );

    execFileSync('podman', ['load', '-i', stagingTar], {timeout: 120_000});

    const uncompressedStr = execFileSync(
      'podman',
      ['image', 'inspect', '--format', '{{.Size}}', agentTargetId],
      {encoding: 'utf8', timeout: 15_000}
    ).trim();
    const uncompressedBytes = Number(uncompressedStr);

    if (!Number.isFinite(uncompressedBytes) || uncompressedBytes > MAX_IMAGE_BYTES) {
      execFileSync('podman', ['rmi', '-f', agentTargetId], {timeout: 30_000});
      throw new Error(
        `Uncompressed OCI image size (${uncompressedBytes} B) ` +
        `exceeds 500 MB cap (${MAX_IMAGE_BYTES} B)`
      );
    }

    return uncompressedBytes;
  } catch (err) {
    throw scrubError(err, creds);
  } finally {
    if (authWorkDir) fs.rmSync(authWorkDir, {recursive: true, force: true});
    fs.rmSync(stagingTar, {force: true});
  }
}

export async function downloadAndUnpackBundle(opts: {
  url: string;
  expectedSha256: string;
  agentTargetId: string;
  authToken?: string;
  stagingDir?: string;
  agentsDir?: string;
  unpackBin?: string;
  casDir?: string;
  allowPrivateUrls?: boolean;
  timeoutMillis?: number;
}): Promise<number> {
  const stagingDir = opts.stagingDir ?? STAGING_DIR;
  const agentsDir = opts.agentsDir ?? AGENTS_DIR;
  const unpackBin = opts.unpackBin ?? UNPACK_BIN;

  fs.mkdirSync(stagingDir, {recursive: true});
  fs.mkdirSync(agentsDir, {recursive: true});

  const cleanUrlPath = opts.url.split(/[?#]/)[0].toLowerCase();
  const ext = cleanUrlPath.endsWith('.tar.zst') || cleanUrlPath.endsWith('.tzst')
    ? '.tar.zst'
    : cleanUrlPath.endsWith('.tar.xz') || cleanUrlPath.endsWith('.txz')
      ? '.tar.xz'
      : '.tar.gz';
  const archivePath = path.join(stagingDir, `bundle-${opts.agentTargetId}${ext}`);
  const destDir = path.join(agentsDir, opts.agentTargetId);

  fs.rmSync(archivePath, {force: true});
  fs.rmSync(destDir, {recursive: true, force: true});

  try {
    const hash = crypto.createHash('sha256');
    if (opts.url.startsWith('file://')) {
      const localPath = opts.url.slice('file://'.length);
      const srcFd = fs.openSync(localPath, 'r');
      const dstFd = fs.openSync(archivePath, 'w', 0o600);
      const chunk = Buffer.allocUnsafe(65_536);
      let total = 0;
      try {
        while (true) {
          const bytesRead = fs.readSync(srcFd, chunk, 0, chunk.length, null);
          if (bytesRead <= 0) break;
          total += bytesRead;
          if (total > MAX_IMAGE_BYTES) {
            throw new Error(
              `Compressed bundle (${total} B) exceeds 500 MB cap (${MAX_IMAGE_BYTES} B)`
            );
          }
          const slice = chunk.subarray(0, bytesRead);
          hash.update(slice);
          fs.writeSync(dstFd, slice);
        }
      } finally {
        fs.closeSync(srcFd);
        fs.closeSync(dstFd);
      }
    } else {
      const signal = AbortSignal.timeout(opts.timeoutMillis ?? DOWNLOAD_TIMEOUT_MILLIS);
      const initialUrl = new URL(opts.url);
      const initialOrigin = initialUrl.origin;
      const authHeader = opts.authToken
        ? (opts.authToken.includes(' ') ? opts.authToken : `Bearer ${opts.authToken}`)
        : undefined;

      let currentUrl = initialUrl;
      let res: Response | undefined;
      for (let hop = 0; ; hop++) {
        if (!opts.allowPrivateUrls) {
          if (currentUrl.protocol !== 'https:') {
            throw new Error(
              `Bundle redirect/download target must use HTTPS (got ${currentUrl.protocol})`
            );
          }
          if (currentUrl.port !== '' || !isAllowedBundleHost(currentUrl.hostname)) {
            throw new Error('Bundle download target must use a supported artifact host');
          }
        }

        const headers: Record<string, string> = {};
        if (authHeader && currentUrl.origin === initialOrigin) {
          headers.authorization = authHeader;
        }
        res = await fetch(currentUrl.toString(), {headers, redirect: 'manual', signal});
        if (
          res.status === 301 ||
          res.status === 302 ||
          res.status === 303 ||
          res.status === 307 ||
          res.status === 308
        ) {
          await res.body?.cancel().catch(() => {});
          if (hop >= MAX_REDIRECT_HOPS) {
            throw new Error(`Bundle download exceeded ${MAX_REDIRECT_HOPS} redirects`);
          }
          const loc = res.headers.get('location');
          if (!loc) {
            throw new Error(`Bundle redirect (${res.status}) missing Location header`);
          }
          currentUrl = new URL(loc, currentUrl);
          continue;
        }
        break;
      }

      if (!res.ok) {
        throw new Error(`Bundle download failed (${res.status} ${res.statusText})`);
      }
      const contentLength = Number(res.headers?.get?.('content-length') ?? 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
        await res.body?.cancel().catch(() => {});
        throw new Error(
          `Compressed bundle (${contentLength} B) exceeds 500 MB cap (${MAX_IMAGE_BYTES} B)`
        );
      }
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const fd = fs.openSync(archivePath, 'w', 0o600);
        let total = 0;
        try {
          while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > MAX_IMAGE_BYTES) {
              await reader.cancel().catch(() => {});
              throw new Error(
                `Compressed bundle (${total} B) exceeds 500 MB cap (${MAX_IMAGE_BYTES} B)`
              );
            }
            hash.update(value);
            fs.writeSync(fd, value);
          }
        } finally {
          fs.closeSync(fd);
        }
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > MAX_IMAGE_BYTES) {
          throw new Error(
            `Compressed bundle (${buf.byteLength} B) exceeds 500 MB cap (${MAX_IMAGE_BYTES} B)`
          );
        }
        hash.update(buf);
        fs.writeFileSync(archivePath, buf, {mode: 0o600});
      }
    }

    // Verify streamed SHA-256 digest before invoking the unpacker
    const actualSha256 = hash.digest('hex').toLowerCase();
    if (actualSha256 !== opts.expectedSha256.toLowerCase()) {
      throw new Error(
        `SHA-256 mismatch: expected ${opts.expectedSha256}, got ${actualSha256}`
      );
    }

    const env = {...process.env};
    if (opts.casDir) env.ARENA_CAS_DIR = opts.casDir;

    const stdout = execFileSync('python3', [unpackBin, archivePath, destDir], {
      encoding: 'utf8',
      timeout: 180_000,
      env,
    });
    const m = /UNPACK_OK:\s*(\d+)\s*bytes/.exec(stdout);
    return m ? Number(m[1]) : 0;
  } catch (err) {
    throw scrubError(err, opts.authToken);
  } finally {
    fs.rmSync(archivePath, {force: true});
  }
}

export function evictColdAgentsIfNeeded(
  stateDb: StateDatabase,
  opts: {
    highWaterBytes?: number;
    lowWaterBytes?: number;
    containerHighWaterBytes?: number;
    containerLowWaterBytes?: number;
    agentsDir?: string;
    coldDir?: string;
    casDir?: string;
    pinnedVersionIds?: ReadonlySet<number>;
    evictContainerFn?: (target: string, coldArchive: string) => void;
  } = {}
): number[] {
  const highWater = opts.highWaterBytes ?? HOT_AGENTS_HIGH_WATER_BYTES;
  const lowWater = opts.lowWaterBytes ?? HOT_AGENTS_LOW_WATER_BYTES;
  const containerHighWater = opts.containerHighWaterBytes ?? HOT_CONTAINERS_HIGH_WATER_BYTES;
  const containerLowWater = opts.containerLowWaterBytes ?? HOT_CONTAINERS_LOW_WATER_BYTES;
  const agentsDir = opts.agentsDir ?? AGENTS_DIR;
  const coldDir = opts.coldDir ?? COLD_AGENTS_DIR;
  const casDir = opts.casDir ?? CAS_DIR;
  const pinned = opts.pinnedVersionIds ?? new Set<number>();

  const hotAgents = stateDb.listLocalAgents().filter(a => a.residency === 'hot');
  let usedBytes = hotAgents.reduce((sum, a) => sum + a.unpackedBytes, 0);
  let containerUsedBytes = hotAgents
    .filter(a => a.mode === 'container')
    .reduce((sum, a) => sum + a.unpackedBytes, 0);
  if (usedBytes <= highWater && containerUsedBytes <= containerHighWater) return [];

  fs.mkdirSync(coldDir, {recursive: true});

  const victims = hotAgents
    .filter(a => !pinned.has(a.versionId))
    .sort((a, b) => a.lastPlayedAt - b.lastPlayedAt || a.versionId - b.versionId);

  let evictedNative = false;
  const evictOne = (v: LocalAgentRow) => {
    const coldArchive = path.join(coldDir, `${v.target}.tar.zst`);
    if (v.mode === 'native') {
      evictedNative = true;
      const hotDir = path.join(agentsDir, v.target);
      if (fs.existsSync(hotDir)) {
        execFileSync('tar', ['--zstd', '-cf', coldArchive, '-C', hotDir, '.'], {
          timeout: 180_000,
        });
        fs.rmSync(hotDir, {recursive: true, force: true});
      }
    } else if (opts.evictContainerFn) {
      opts.evictContainerFn(v.target, coldArchive);
    } else {
      execFileSync(
        'bash',
        [
          '-euo',
          'pipefail',
          '-c',
          'podman save "$1" | zstd -3 -o "$2"',
          '_',
          v.target,
          coldArchive,
        ],
        {timeout: 180_000}
      );
      execFileSync('podman', ['rmi', v.target], {timeout: 30_000});
    }

    stateDb.setAgentResidency(v.versionId, 'cold');
    usedBytes -= v.unpackedBytes;
    if (v.mode === 'container') {
      containerUsedBytes -= v.unpackedBytes;
    }
  };

  const evicted: number[] = [];
  const evictedSet = new Set<number>();

  // 1. Enforce Podman VM 40 GB virtual-disk cap first
  if (containerUsedBytes > containerHighWater) {
    for (const v of victims) {
      if (containerUsedBytes <= containerLowWater) break;
      if (v.mode !== 'container') continue;
      evictOne(v);
      evicted.push(v.versionId);
      evictedSet.add(v.versionId);
    }
  }

  // 2. Enforce overall 1.35 TB host-SSD cap across remaining hot agents
  if (usedBytes > highWater) {
    for (const v of victims) {
      if (usedBytes <= lowWater) break;
      if (evictedSet.has(v.versionId)) continue;
      evictOne(v);
      evicted.push(v.versionId);
      evictedSet.add(v.versionId);
    }
  }

  // 3. Reclaim CAS blobs whose hardlink count dropped to 1 (no remaining hot agent links to them)
  if (evictedNative && fs.existsSync(casDir)) {
    try {
      for (const entry of fs.readdirSync(casDir)) {
        const blobPath = path.join(casDir, entry);
        try {
          const st = fs.statSync(blobPath);
          if (st.isFile() && st.nlink === 1) {
            fs.rmSync(blobPath, {force: true});
          }
        } catch {}
      }
    } catch {}
  }

  return evicted;
}

export function ensureAgentResident(
  stateDb: StateDatabase,
  versionId: number,
  opts: {
    agentsDir?: string;
    coldDir?: string;
    now?: number;
  } = {}
): LocalAgentRow | undefined {
  const row = stateDb.getLocalAgent(versionId);
  if (!row) return undefined;

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (row.residency === 'hot') {
    stateDb.setAgentResidency(versionId, 'hot', now);
    return stateDb.getLocalAgent(versionId);
  }

  const agentsDir = opts.agentsDir ?? AGENTS_DIR;
  const coldDir = opts.coldDir ?? COLD_AGENTS_DIR;
  const coldArchive = path.join(coldDir, `${row.target}.tar.zst`);

  if (row.mode === 'native') {
    const destDir = path.join(agentsDir, row.target);
    fs.mkdirSync(destDir, {recursive: true});
    if (fs.existsSync(coldArchive)) {
      execFileSync(
        'tar',
        ['--zstd', '--no-same-owner', '--no-same-permissions', '-xf', coldArchive, '-C', destDir],
        {timeout: 180_000}
      );
    }
  } else if (fs.existsSync(coldArchive)) {
    execFileSync(
      'bash',
      ['-euo', 'pipefail', '-c', 'zstd -dc "$1" | podman load', '_', coldArchive],
      {timeout: 180_000}
    );
  }

  stateDb.setAgentResidency(versionId, 'hot', now);
  return stateDb.getLocalAgent(versionId);
}

// Computes the flat N*N pair residency bonus matrix rho_ij in {1.00, 1.05, 1.15}:
//   - 1.15 when both versions i and j are hot on the internal NVMe
//   - 1.05 when exactly one of i or j is hot
//   - 1.00 when both are in cold storage
export function computeResidencyMultipliers(
  versionIds: readonly number[],
  stateDb: StateDatabase
): Float64Array {
  const n = versionIds.length;
  const out = new Float64Array(n * n);
  const hotFlags = versionIds.map(vid => {
    const row = stateDb.getLocalAgent(vid);
    return !row || row.residency === 'hot';
  });

  for (let i = 0; i < n; i++) {
    out[i * n + i] = 1.0;
    for (let j = i + 1; j < n; j++) {
      const bonus = hotFlags[i] && hotFlags[j]
        ? 1.15
        : (hotFlags[i] || hotFlags[j])
          ? 1.05
          : 1.00;
      out[i * n + j] = bonus;
      out[j * n + i] = bonus;
    }
  }
  return out;
}

export function formatAgentTargetId(slug: string, version: string, versionId: number): string {
  const safeVer = version.replace(/[^a-zA-Z0-9._-]/g, '-');
  return `${slug}-${safeVer}-v${versionId}`;
}

export function toExecutionMode(pkg: 'bundle' | 'oci'): AgentMode {
  return pkg === 'oci' ? 'container' : 'native';
}
