import {execFileSync} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {isAllowedBundleHost, isAllowedOciRegistryHost} from '../server/account';

import * as db from './db';
import * as unpack from './unpack';

export const MAX_IMAGE_BYTES = 500 * 1024 * 1024; // 500 MB hard cap
export const MAX_OCI_LAYERS = 32;
const MAX_REDIRECT_HOPS = 5;
const DOWNLOAD_TIMEOUT_MILLIS = 180_000;
const TARGET_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const ALLOWED_OCI_LAYER_MEDIATYPE_RE = new RegExp(
  '^(?:application/vnd\\.(?:oci\\.image\\.layer\\.v1\\.tar|' +
  'docker\\.image\\.rootfs\\.diff\\.tar)(?:\\+(?:gzip|zstd)|\\.gzip|\\.zstd)?|' +
  'application/x-tar)$'
);

// Hot-agent disk-usage watermarks sized for the 256 GB Mac mini internal SSD (cold `.tar.zst`
// archives evict to the external 1 TB `/Volumes/Archive/cold-agents` SSD).
export const HOT_AGENTS_HIGH_WATER_BYTES = 110 * 1000 * 1000 * 1000; // 110 GB internal SSD
export const HOT_AGENTS_LOW_WATER_BYTES = 85 * 1000 * 1000 * 1000; // 85 GB internal SSD
// Separate disk-usage watermarks inside `podman-machine-default`'s 48 GB virtual disk on the Mac
// mini SSD (`setup-arena.sh --disk-size 48`) so cached OCI images never fill the VM rootfs.
export const HOT_CONTAINERS_HIGH_WATER_BYTES = 32 * 1000 * 1000 * 1000; // 32 GB VM disk
export const HOT_CONTAINERS_LOW_WATER_BYTES = 24 * 1000 * 1000 * 1000; // 24 GB VM disk

export interface Dirs {
  agents: string;
  staging: string;
  cold: string;
  cas: string;
  teams: string;
  logs: string;
}

// Production Mac mini directory layout is intentionally hardcoded (no `ARENA_*_DIR` env vars);
// tests pass an isolated single root via `dirsForRoot(rootDir)`.
export const PROD_DIRS: Dirs = {
  agents: '/opt/arena/agents',
  staging: '/Volumes/Staging',
  cold: '/Volumes/Archive/cold-agents',
  cas: '/opt/arena/cas/sha256',
  teams: '/opt/arena/teams',
  logs: '/Volumes/Archive/logs',
};

export function dirsForRoot(rootDir: string): Dirs {
  return {
    agents: path.join(rootDir, 'agents'),
    staging: path.join(rootDir, 'staging'),
    cold: path.join(rootDir, 'cold-agents'),
    cas: path.join(rootDir, 'cas'),
    teams: path.join(rootDir, 'teams'),
    logs: path.join(rootDir, 'logs'),
  };
}

export interface OciManifestInspection {
  compressedBytes: number;
  layerCount: number;
  manifestSha256: string;
  configSha256?: string;
  indexSha256?: string;
}

// Headless macOS holds external USB/Thunderbolt volumes unmounted at the login window until
// `AutomountDisksWithoutUserLogin` is enabled or `root` runs `diskutil mount` (`diskarbitrationd`
// denies non-root `diskutil mount` from `LaunchDaemon`s without an interactive audit session).
export function tryMountArchiveVolume(): void {
  if (process.platform !== 'darwin' || fs.existsSync('/Volumes/Archive')) return;
  try {
    execFileSync('/usr/bin/sudo', ['-n', '/usr/sbin/diskutil', 'mount', 'Archive'], {
      stdio: 'ignore',
      timeout: 15_000,
    });
  } catch {
    try {
      execFileSync('/usr/sbin/diskutil', ['mount', 'Archive'], {
        stdio: 'ignore',
        timeout: 15_000,
      });
    } catch {}
  }
}

// Prevents silent writes onto the 256 GB internal Mac mini SSD (and `/Volumes/Archive 1` mount
// collisions) if the external `/Volumes/Archive` drive is unmounted.
export function assertArchiveVolumeMounted(targetPath: string): void {
  if (process.platform !== 'darwin') return;
  const resolved = path.resolve(targetPath);
  if (resolved !== '/Volumes/Archive' && !resolved.startsWith('/Volumes/Archive/')) return;
  if (!fs.existsSync('/Volumes/Archive')) {
    tryMountArchiveVolume();
  }
  if (!fs.existsSync('/Volumes/Archive')) {
    throw new Error('/Volumes/Archive is not mounted');
  }
  if (fs.statSync('/Volumes/Archive').dev === fs.statSync('/').dev) {
    throw new Error('/Volumes/Archive resolves to the root SSD instead of an external volume');
  }
}

export function validateOciRegistryRef(cleanRef: string): void {
  if (!cleanRef || cleanRef.startsWith('http://') || cleanRef.startsWith('https://')) {
    throw new Error(`Invalid OCI image reference: ${cleanRef}`);
  }
  const slash = cleanRef.indexOf('/');
  if (slash <= 0) return;
  const authority = cleanRef.slice(0, slash);
  const isExplicitRegistry =
    authority.includes('.') ||
    authority.includes(':') ||
    authority.toLowerCase() === 'localhost';
  if (!isExplicitRegistry) return;

  let parsedAuthority: URL;
  try {
    parsedAuthority = new URL(`https://${authority}`);
  } catch {
    throw new Error(`Invalid OCI registry authority: ${authority}`);
  }
  if (parsedAuthority.port !== '' || !isAllowedOciRegistryHost(parsedAuthority.hostname)) {
    throw new Error(`Disallowed OCI registry host: ${parsedAuthority.hostname}`);
  }
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
  const candidates = new Set<string>();
  const trimmed = rawToken.trim();
  if (trimmed.length >= 4) candidates.add(trimmed);
  const bare = trimmed
    .replace(/^authorization:\s*/i, '')
    .replace(/^(?:bearer|basic)\s+/i, '')
    .trim();
  if (bare.length >= 4) {
    candidates.add(bare);
    candidates.add(Buffer.from(bare, 'utf8').toString('base64'));
    if (!bare.includes(':')) {
      candidates.add(Buffer.from(`oauth2:${bare}`, 'utf8').toString('base64'));
    }
  }
  if (bare.includes(':')) {
    const pass = bare.slice(bare.indexOf(':') + 1);
    if (pass.length >= 4) candidates.add(pass);
  }
  for (const secret of candidates) {
    if (secret.length >= 4) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out;
}

export function scrubError(err: unknown, rawToken?: string): Error {
  if (err instanceof Error) {
    err.message = scrubAuthSecret(err.message, rawToken);
    const execErr = err as Error & {stderr?: string | Buffer; stdout?: string | Buffer};
    if (typeof execErr.stderr === 'string') {
      execErr.stderr = scrubAuthSecret(execErr.stderr, rawToken);
    } else if (Buffer.isBuffer(execErr.stderr)) {
      execErr.stderr = Buffer.from(scrubAuthSecret(execErr.stderr.toString('utf8'), rawToken));
    }
    if (typeof execErr.stdout === 'string') {
      execErr.stdout = scrubAuthSecret(execErr.stdout, rawToken);
    } else if (Buffer.isBuffer(execErr.stdout)) {
      execErr.stdout = Buffer.from(scrubAuthSecret(execErr.stdout.toString('utf8'), rawToken));
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
    config?: {digest?: string; urls?: unknown};
    layers?: Array<{size?: unknown; urls?: unknown; mediaType?: unknown}>;
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
  if (manifest.config?.urls !== undefined) {
    throw new Error('OCI config descriptor must not contain external URLs');
  }

  let compressedBytes = 0;
  for (const layer of manifest.layers) {
    if (layer.urls !== undefined) {
      throw new Error('OCI foreign layers with external URLs are disallowed');
    }
    if (
      layer.mediaType !== undefined &&
      (typeof layer.mediaType !== 'string' || !ALLOWED_OCI_LAYER_MEDIATYPE_RE.test(layer.mediaType))
    ) {
      const mediaDesc = typeof layer.mediaType === 'string'
        ? layer.mediaType
        : typeof layer.mediaType;
      throw new Error(`Unsupported OCI layer mediaType: ${mediaDesc}`);
    }
    if (
      typeof layer.size !== 'number' ||
      !Number.isSafeInteger(layer.size) ||
      layer.size < 0
    ) {
      throw new Error('Invalid OCI layer size');
    }
    compressedBytes += layer.size;
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

export interface InspectOciOptions {
  imageRef: string;
  creds?: string;
  expectedSha256?: string;
  platform?: {os: string; arch: string};
  stagingDir?: string;
}

export function inspectRemoteOciSize(opts: InspectOciOptions): OciManifestInspection {
  const {
    imageRef,
    creds,
    expectedSha256,
    platform = {os: 'linux', arch: 'arm64'},
    stagingDir = PROD_DIRS.staging,
  } = opts;
  const cleanRef = imageRef.replace(/^docker:\/\//, '').trim();
  validateOciRegistryRef(cleanRef);
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
    const parsedOuter = JSON.parse(outerRaw) as {
      manifests?: Array<{digest?: string; platform?: {os?: string; architecture?: string}}>;
    };
    if (Array.isArray(parsedOuter.manifests)) {
      const outerSha = crypto.createHash('sha256').update(outerRaw).digest('hex');
      const cleanExpected = expectedSha256?.trim().toLowerCase().replace(/^sha256:/, '');
      if (cleanExpected && cleanExpected !== outerSha) {
        throw new Error(`OCI digest mismatch: expected ${cleanExpected}, got manifest=${outerSha}`);
      }
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

    return verifyOciManifestDigest(outerRaw, expectedSha256);
  } catch (err) {
    throw scrubError(err, creds);
  } finally {
    if (authWorkDir) fs.rmSync(authWorkDir, {recursive: true, force: true});
  }
}

export interface PullOciOptions {
  imageRef: string;
  agentTargetId: string;
  expectedSha256: string;
  creds?: string;
  dirs?: Dirs;
}

export function pullAndVerifyOciImage(opts: PullOciOptions): number {
  const {
    imageRef,
    agentTargetId,
    expectedSha256,
    creds,
    dirs = PROD_DIRS,
  } = opts;
  if (!TARGET_ID_RE.test(agentTargetId) || agentTargetId.includes('..')) {
    throw new Error(`Invalid OCI agent target ID: ${agentTargetId}`);
  }
  if (!expectedSha256 || !/^(?:sha256:)?[0-9a-fA-F]{64}$/.test(expectedSha256.trim())) {
    throw new Error('Expected 64-hex SHA-256 manifest digest for OCI pull');
  }
  const cleanRef = imageRef.replace(/^docker:\/\//, '').trim();
  const repoRef = stripOciTagOrDigest(cleanRef);
  const inspected = inspectRemoteOciSize({
    imageRef: cleanRef,
    creds,
    expectedSha256,
    platform: {os: 'linux', arch: 'arm64'},
    stagingDir: dirs.staging,
  });

  fs.mkdirSync(dirs.staging, {recursive: true});
  const stagingTar = path.join(dirs.staging, `oci-${agentTargetId}.tar`);
  fs.rmSync(stagingTar, {force: true});
  let authWorkDir: string | undefined;
  let imageLoaded = false;

  try {
    const authArgs: string[] = [];
    if (creds) {
      authWorkDir = fs.mkdtempSync(path.join(dirs.staging, 'oci-auth-'));
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
      {env: {...process.env, TMPDIR: dirs.staging}, timeout: 180_000}
    );

    execFileSync('podman', ['load', '-i', stagingTar], {timeout: 120_000});
    imageLoaded = true;

    const uncompressedStr = execFileSync(
      'podman',
      ['image', 'inspect', '--format', '{{.Size}}', agentTargetId],
      {encoding: 'utf8', timeout: 15_000}
    ).trim();
    const uncompressedBytes = Number(uncompressedStr);

    if (!Number.isFinite(uncompressedBytes) || uncompressedBytes > MAX_IMAGE_BYTES) {
      throw new Error(
        `Uncompressed OCI image size (${uncompressedBytes} B) ` +
        `exceeds 500 MB cap (${MAX_IMAGE_BYTES} B)`
      );
    }

    return uncompressedBytes;
  } catch (err) {
    if (imageLoaded) {
      try {
        execFileSync('podman', ['rmi', '-f', agentTargetId], {timeout: 30_000});
      } catch {}
    }
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
  dirs?: Dirs;
  allowPrivateUrls?: boolean;
}): Promise<number> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(opts.agentTargetId) ||
      opts.agentTargetId.includes('..')) {
    throw new Error(`Invalid bundle agent target ID: ${opts.agentTargetId}`);
  }
  const dirs = opts.dirs ?? PROD_DIRS;

  fs.mkdirSync(dirs.staging, {recursive: true});
  fs.mkdirSync(dirs.agents, {recursive: true});

  const cleanUrlPath = opts.url.split(/[?#]/)[0].toLowerCase();
  const ext = cleanUrlPath.endsWith('.tar.zst') || cleanUrlPath.endsWith('.tzst')
    ? '.tar.zst'
    : cleanUrlPath.endsWith('.tar.xz') || cleanUrlPath.endsWith('.txz')
      ? '.tar.xz'
      : '.tar.gz';
  const archivePath = path.join(dirs.staging, `bundle-${opts.agentTargetId}${ext}`);
  const destDir = path.join(dirs.agents, opts.agentTargetId);

  fs.rmSync(archivePath, {force: true});

  try {
    const hash = crypto.createHash('sha256');
    if (opts.url.startsWith('file://')) {
      if (!opts.allowPrivateUrls) {
        throw new Error('Bundle download target must use HTTPS (file:// URLs are disallowed)');
      }
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
      const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MILLIS);
      const initialUrl = new URL(opts.url);
      const initialOrigin = initialUrl.origin;
      const rawAuth = opts.authToken?.trim().replace(/^authorization:\s*/i, '').trim();
      const authHeader = rawAuth
        ? (rawAuth.includes(' ') ? rawAuth : `Bearer ${rawAuth}`)
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

    return unpack.unpackBundle(archivePath, destDir, dirs.cas);
  } catch (err) {
    throw scrubError(err, opts.authToken);
  } finally {
    fs.rmSync(archivePath, {force: true});
  }
}

export function archiveColdAgent(
  agent: Pick<db.LocalAgentRow, 'mode' | 'target'>,
  opts: {
    dirs?: Dirs;
    archiveContainerFn?: (target: string, coldArchive: string) => void;
  } = {}
): string {
  const dirs = opts.dirs ?? PROD_DIRS;
  assertArchiveVolumeMounted(dirs.cold);
  fs.mkdirSync(dirs.cold, {recursive: true});
  const coldArchive = path.join(dirs.cold, `${agent.target}.tar.zst`);
  try {
    if (fs.existsSync(coldArchive) && fs.statSync(coldArchive).size > 0) {
      return coldArchive;
    }
  } catch {}

  if (agent.mode === 'container' && opts.archiveContainerFn) {
    opts.archiveContainerFn(agent.target, coldArchive);
    return coldArchive;
  }

  const tmpArchive = `${coldArchive}.tmp-${process.pid}`;
  fs.rmSync(tmpArchive, {force: true});
  try {
    if (agent.mode === 'native') {
      const hotDir = path.join(dirs.agents, agent.target);
      if (!fs.existsSync(hotDir)) {
        throw new Error(`Hot native bundle directory missing for ${agent.target}`);
      }
      execFileSync('tar', ['--zstd', '-cf', tmpArchive, '-C', hotDir, '.'], {
        timeout: 180_000,
      });
    } else {
      execFileSync(
        'bash',
        [
          '-euo',
          'pipefail',
          '-c',
          'podman save "$1" | zstd -3 -o "$2"',
          '_',
          agent.target,
          tmpArchive,
        ],
        {timeout: 180_000}
      );
    }
    fs.renameSync(tmpArchive, coldArchive);
  } catch (err) {
    fs.rmSync(tmpArchive, {force: true});
    throw err;
  }
  return coldArchive;
}

export function evictColdAgentsIfNeeded(
  stateDb: db.Database,
  opts: {
    highWaterBytes?: number;
    lowWaterBytes?: number;
    containerHighWaterBytes?: number;
    containerLowWaterBytes?: number;
    dirs?: Dirs;
    pinnedVersionIds?: ReadonlySet<number>;
    activeVersionIds?: ReadonlySet<number>;
    evictContainerFn?: (target: string, coldArchive: string) => void;
  } = {}
): number[] {
  const highWater = opts.highWaterBytes ?? HOT_AGENTS_HIGH_WATER_BYTES;
  const lowWater = opts.lowWaterBytes ?? HOT_AGENTS_LOW_WATER_BYTES;
  const containerHighWater = opts.containerHighWaterBytes ?? HOT_CONTAINERS_HIGH_WATER_BYTES;
  const containerLowWater = opts.containerLowWaterBytes ?? HOT_CONTAINERS_LOW_WATER_BYTES;
  const dirs = opts.dirs ?? PROD_DIRS;
  const pinned = opts.pinnedVersionIds ?? new Set<number>();

  const hotAgents = stateDb.listLocalAgents('hot');
  let usedBytes = hotAgents.reduce((sum, a) => sum + a.unpackedBytes, 0);
  let containerUsedBytes = hotAgents
    .filter(a => a.mode === 'container')
    .reduce((sum, a) => sum + a.unpackedBytes, 0);

  const victims = hotAgents
    .filter(a => !pinned.has(a.versionId))
    .sort((a, b) => a.lastPlayedAt - b.lastPlayedAt || a.versionId - b.versionId);

  const hasInactiveVictims = opts.activeVersionIds !== undefined &&
    victims.some(v => !opts.activeVersionIds!.has(v.versionId));
  if (
    !hasInactiveVictims &&
    usedBytes <= highWater &&
    containerUsedBytes <= containerHighWater
  ) {
    return [];
  }

  assertArchiveVolumeMounted(dirs.cold);
  fs.mkdirSync(dirs.cold, {recursive: true});

  let evictedNative = false;
  const evictOne = (v: db.LocalAgentRow) => {
    archiveColdAgent(v, {
      dirs,
      archiveContainerFn: opts.evictContainerFn,
    });
    if (v.mode === 'native') {
      evictedNative = true;
      const hotDir = path.join(dirs.agents, v.target);
      if (fs.existsSync(hotDir)) {
        fs.rmSync(hotDir, {recursive: true, force: true});
      }
      if (fs.existsSync(dirs.cas)) {
        fs.rmSync(unpack.casRefFileForBundle(dirs.cas, hotDir), {force: true});
      }
    } else if (!opts.evictContainerFn) {
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

  // 0. Eagerly evict versions with 0 active ladders (retired or quarantined across all ladders)
  if (opts.activeVersionIds !== undefined) {
    for (const v of victims) {
      if (opts.activeVersionIds.has(v.versionId)) continue;
      evictOne(v);
      evicted.push(v.versionId);
      evictedSet.add(v.versionId);
    }
  }

  // 1. Enforce Podman VM 32 GB virtual-disk cap first
  if (containerUsedBytes > containerHighWater) {
    for (const v of victims) {
      if (containerUsedBytes <= containerLowWater) break;
      if (v.mode !== 'container' || evictedSet.has(v.versionId)) continue;
      evictOne(v);
      evicted.push(v.versionId);
      evictedSet.add(v.versionId);
    }
  }

  // 2. Enforce overall 110 GB internal-SSD cap across remaining hot agents
  if (usedBytes > highWater) {
    for (const v of victims) {
      if (usedBytes <= lowWater) break;
      if (evictedSet.has(v.versionId)) continue;
      evictOne(v);
      evicted.push(v.versionId);
      evictedSet.add(v.versionId);
    }
  }

  // 3. Reclaim CAS blobs in `<casDir>/<shard>/<sha256>` no longer referenced by any hot agent.
  if (evictedNative && fs.existsSync(dirs.cas)) {
    pruneUnreferencedCasBlobs(dirs.cas, dirs.agents);
  }

  return evicted;
}

export function pruneUnreferencedCasBlobs(casDir: string, agentsDir: string) {
  const casBlobs: Array<{blobPath: string; shardPath: string; digest: string}> = [];
  try {
    for (const entry of fs.readdirSync(casDir, {withFileTypes: true})) {
      if (entry.name === 'refs' || !entry.isDirectory()) continue;
      const shardPath = path.join(casDir, entry.name);
      for (const sub of fs.readdirSync(shardPath, {withFileTypes: true})) {
        if (!sub.isFile()) continue;
        casBlobs.push({blobPath: path.join(shardPath, sub.name), shardPath, digest: sub.name});
      }
    }
  } catch {
    return;
  }
  if (casBlobs.length === 0) return;

  const activeDigests = new Set<string>();
  const liveAgentNames = new Set<string>();

  if (fs.existsSync(agentsDir)) {
    for (const top of fs.readdirSync(agentsDir, {withFileTypes: true})) {
      if (top.isSymbolicLink() || !top.isDirectory()) continue;
      liveAgentNames.add(top.name);
      const refFile = unpack.casRefFileForBundle(casDir, path.join(agentsDir, top.name));
      if (!fs.existsSync(refFile)) continue;
      try {
        for (const line of fs.readFileSync(refFile, 'utf8').split(/\r?\n/)) {
          const d = line.trim();
          if (d) activeDigests.add(d);
        }
      } catch {}
    }
  }

  const refsDir = path.join(path.resolve(casDir), 'refs');
  if (fs.existsSync(refsDir)) {
    try {
      for (const ref of fs.readdirSync(refsDir)) {
        if (!ref.endsWith('.txt')) continue;
        if (!liveAgentNames.has(ref.slice(0, -4))) {
          fs.rmSync(path.join(refsDir, ref), {force: true});
        }
      }
    } catch {}
  }

  const touchedShards = new Set<string>();
  for (const blob of casBlobs) {
    if (!activeDigests.has(blob.digest)) {
      try {
        fs.rmSync(blob.blobPath, {force: true});
        touchedShards.add(blob.shardPath);
      } catch {}
    }
  }
  for (const shard of touchedShards) {
    try {
      if (fs.readdirSync(shard).length === 0) fs.rmdirSync(shard);
    } catch {}
  }
}

export function ensureAgentResident(
  stateDb: db.Database,
  versionId: number,
  opts: {dirs?: Dirs; now?: number} = {}
): db.LocalAgentRow | undefined {
  const row = stateDb.getLocalAgent(versionId);
  if (!row) return undefined;

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const dirs = opts.dirs ?? PROD_DIRS;
  if (row.residency === 'hot') {
    if (row.mode === 'native') {
      const hotRun = path.join(dirs.agents, row.target, 'run');
      if (!fs.existsSync(hotRun)) {
        throw new Error(`Hot native bundle missing executable ./run for ${row.target}`);
      }
    }
    stateDb.setAgentResidency(versionId, 'hot', now);
    return stateDb.getLocalAgent(versionId);
  }

  assertArchiveVolumeMounted(dirs.cold);
  const coldArchive = path.join(dirs.cold, `${row.target}.tar.zst`);
  if (!fs.existsSync(coldArchive) || fs.statSync(coldArchive).size === 0) {
    throw new Error(`Cold archive missing or empty for ${row.target}: ${coldArchive}`);
  }

  if (row.mode === 'native') {
    const destDir = path.join(dirs.agents, row.target);
    fs.mkdirSync(dirs.agents, {recursive: true});
    unpack.unpackBundle(coldArchive, destDir, dirs.cas);
  } else {
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
  stateDb: db.Database
): Float64Array {
  const n = versionIds.length;
  const out = new Float64Array(n * n);
  const hotSet = new Set(stateDb.listLocalAgents('hot').map(a => a.versionId));
  const hotFlags = versionIds.map(vid => hotSet.has(vid));

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

function sanitizeOciToken(raw: string, fallback: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/[._-]{2,}/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  return cleaned || fallback;
}

export function formatAgentTargetId(slug: string, version: string, versionId: number): string {
  const safeSlug = sanitizeOciToken(slug, 'agent');
  const safeVer = sanitizeOciToken(version, '0');
  return `${safeSlug}-${safeVer}-v${versionId}`;
}

export function toExecutionMode(pkg: 'bundle' | 'oci'): db.ExecutionMode {
  return pkg === 'oci' ? 'container' : 'native';
}
