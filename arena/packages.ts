import {execFileSync} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {root} from '../static/util';

import {AgentMode, LocalAgentRow, StateDatabase} from './db';

export const MAX_IMAGE_BYTES = 500 * 1024 * 1024; // 500 MB hard cap
export const MAX_OCI_LAYERS = 32;
export const HOT_AGENTS_HIGH_WATER_BYTES = 1350 * 1024 * 1024 * 1024; // 1.35 TB
export const HOT_AGENTS_LOW_WATER_BYTES = 1200 * 1024 * 1024 * 1024; // 1.20 TB

export const AGENTS_DIR = process.env.ARENA_AGENTS_DIR ?? '/opt/arena/agents';
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
    if (cleanExpected !== manifestSha256 && cleanExpected !== configSha256) {
      throw new Error(
        `OCI digest mismatch: expected ${cleanExpected}, ` +
        `got manifest=${manifestSha256}${configSha256 ? ` config=${configSha256}` : ''}`
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
  expectedSha256?: string
): OciManifestInspection {
  const args = ['inspect', '--raw'];
  if (creds) args.push('--creds', creds);
  args.push(`docker://${imageRef}`);

  const rawJson = execFileSync('skopeo', args, {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return verifyOciManifestDigest(rawJson, expectedSha256);
}

export function pullAndVerifyOciImage(
  imageRef: string,
  agentTargetId: string,
  creds?: string,
  stagingDir = STAGING_DIR,
  expectedSha256?: string
): number {
  inspectRemoteOciSize(imageRef, creds, expectedSha256);

  fs.mkdirSync(stagingDir, {recursive: true});
  const stagingTar = path.join(stagingDir, `oci-${agentTargetId}.tar`);
  fs.rmSync(stagingTar, {force: true});

  try {
    const copyArgs = ['copy'];
    if (creds) copyArgs.push('--src-creds', creds);
    copyArgs.push(`docker://${imageRef}`, `docker-archive:${stagingTar}:${agentTargetId}:latest`);

    execFileSync('skopeo', copyArgs, {timeout: 180_000});

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
  } finally {
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
}): Promise<number> {
  const stagingDir = opts.stagingDir ?? STAGING_DIR;
  const agentsDir = opts.agentsDir ?? AGENTS_DIR;
  const unpackBin = opts.unpackBin ?? UNPACK_BIN;

  fs.mkdirSync(stagingDir, {recursive: true});
  fs.mkdirSync(agentsDir, {recursive: true});

  const ext = opts.url.endsWith('.tar.zst') || opts.url.endsWith('.tzst')
    ? '.tar.zst'
    : opts.url.endsWith('.tar.xz')
      ? '.tar.xz'
      : '.tar.gz';
  const archivePath = path.join(stagingDir, `bundle-${opts.agentTargetId}${ext}`);
  const destDir = path.join(agentsDir, opts.agentTargetId);

  fs.rmSync(archivePath, {force: true});
  fs.rmSync(destDir, {recursive: true, force: true});

  try {
    if (opts.url.startsWith('file://')) {
      const localPath = opts.url.slice('file://'.length);
      fs.copyFileSync(localPath, archivePath);
    } else {
      const headers: Record<string, string> = {};
      if (opts.authToken) {
        headers.authorization = opts.authToken.includes(' ')
          ? opts.authToken
          : `Bearer ${opts.authToken}`;
      }
      const res = await fetch(opts.url, {headers});
      if (!res.ok) {
        throw new Error(`Bundle download failed (${res.status} ${res.statusText})`);
      }
      const contentLength = Number(res.headers?.get?.('content-length') ?? 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
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
        fs.writeFileSync(archivePath, buf);
      }
    }

    // Verify SHA-256 digest before invoking the unpacker
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(archivePath));
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
  } finally {
    fs.rmSync(archivePath, {force: true});
  }
}

export function unpackLocalTarArchive(opts: {
  archivePath: string;
  destDir: string;
  unpackBin?: string;
  casDir?: string;
}): number {
  const unpackBin = opts.unpackBin ?? UNPACK_BIN;
  const env = {...process.env};
  if (opts.casDir) env.ARENA_CAS_DIR = opts.casDir;

  const stdout = execFileSync('python3', [unpackBin, opts.archivePath, opts.destDir], {
    encoding: 'utf8',
    timeout: 180_000,
    env,
  });
  const m = /UNPACK_OK:\s*(\d+)\s*bytes/.exec(stdout);
  return m ? Number(m[1]) : 0;
}

export function evictColdAgentsIfNeeded(
  stateDb: StateDatabase,
  opts: {
    highWaterBytes?: number;
    lowWaterBytes?: number;
    agentsDir?: string;
    coldDir?: string;
    pinnedVersionIds?: ReadonlySet<number>;
  } = {}
): number[] {
  const highWater = opts.highWaterBytes ?? HOT_AGENTS_HIGH_WATER_BYTES;
  const lowWater = opts.lowWaterBytes ?? HOT_AGENTS_LOW_WATER_BYTES;
  const agentsDir = opts.agentsDir ?? AGENTS_DIR;
  const coldDir = opts.coldDir ?? COLD_AGENTS_DIR;
  const pinned = opts.pinnedVersionIds ?? new Set<number>();

  const hotAgents = stateDb.listLocalAgents().filter(a => a.residency === 'hot');
  let usedBytes = hotAgents.reduce((sum, a) => sum + a.unpackedBytes, 0);
  if (usedBytes <= highWater) return [];

  fs.mkdirSync(coldDir, {recursive: true});

  const victims = hotAgents
    .filter(a => !pinned.has(a.versionId))
    .sort((a, b) => a.lastPlayedAt - b.lastPlayedAt || a.versionId - b.versionId);

  const evicted: number[] = [];
  for (const v of victims) {
    if (usedBytes <= lowWater) break;
    const coldArchive = path.join(coldDir, `${v.target}.tar.zst`);
    if (v.mode === 'native') {
      const hotDir = path.join(agentsDir, v.target);
      if (fs.existsSync(hotDir)) {
        execFileSync('tar', ['--zstd', '-cf', coldArchive, '-C', hotDir, '.'], {
          timeout: 180_000,
        });
        fs.rmSync(hotDir, {recursive: true, force: true});
      }
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
    evicted.push(v.versionId);
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
