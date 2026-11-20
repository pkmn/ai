import {execFileSync} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

export const MAX_BYTES = 500 * 1024 * 1024;
export const MAX_FILES = 25_000;
export const CAS_MIN_BYTES = 64 * 1024;
// Allow up to 64 MiB of 512-byte tar/PAX headers and block padding above the 500 MiB payload cap.
const MAX_TAR_STREAM_BYTES = MAX_BYTES + 64 * 1024 * 1024;
const CODESIGN_BATCH_SIZE = 64;

// Mach-O 32-bit, 64-bit, and fat universal binary magic headers.
const MACHO_MAGICS = new Set([
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
]);

interface TarEntry {
  name: string;
  mode: number;
  size: number;
  type: 'file' | 'dir' | 'symlink' | 'hardlink' | 'special';
  linkname: string;
  data: Buffer;
}

function readCString(buf: Buffer, start: number, end: number): string {
  let i = start;
  while (i < end && buf[i] !== 0) i++;
  return buf.subarray(start, i).toString('utf8');
}

function parseOctalOrBase256(buf: Buffer, offset: number, length: number): number {
  const first = buf[offset];
  if ((first & 0x80) !== 0) {
    let val = 0;
    for (let i = 1; i < length; i++) {
      val = val * 256 + buf[offset + i];
    }
    return val;
  }
  const str = readCString(buf, offset, offset + length).trim();
  if (!str) return 0;
  const parsed = parseInt(str, 8);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Corrupt tar numeric field "${str}"`);
  }
  return parsed;
}

function verifyHeaderChecksum(block: Buffer): void {
  const expected = parseOctalOrBase256(block, 148, 8);
  let unsignedSum = 0;
  let signedSum = 0;
  for (let i = 0; i < 512; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : block[i];
    unsignedSum += byte;
    signedSum += byte > 127 ? byte - 256 : byte;
  }
  if (unsignedSum !== expected && signedSum !== expected) {
    throw new Error('Corrupt tar header checksum');
  }
}

// PAX record lengths (`<len> <key>=<value>\n`) count UTF-8 bytes rather than UTF-16 code units,
// so slice on the raw Buffer before decoding multi-byte paths/linkpaths.
function parsePaxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const spaceIdx = data.indexOf(0x20, offset);
    if (spaceIdx < 0) break;
    const len = parseInt(data.subarray(offset, spaceIdx).toString('utf8'), 10);
    if (!Number.isFinite(len) || len <= spaceIdx - offset + 1 || offset + len > data.length) {
      throw new Error('Corrupt PAX extended header record');
    }
    const endIdx = data[offset + len - 1] === 0x0a ? offset + len - 1 : offset + len;
    const body = data.subarray(spaceIdx + 1, endIdx);
    const eqIdx = body.indexOf(0x3d);
    if (eqIdx > 0) {
      out[body.subarray(0, eqIdx).toString('utf8')] = body.subarray(eqIdx + 1).toString('utf8');
    }
    offset += len;
  }
  return out;
}

function decompressArchive(archivePath: string): Buffer {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    return zlib.gunzipSync(fs.readFileSync(archivePath), {
      maxOutputLength: MAX_TAR_STREAM_BYTES,
    });
  }
  if (lower.endsWith('.tar.zst') || lower.endsWith('.tzst')) {
    return zlib.zstdDecompressSync(fs.readFileSync(archivePath), {
      maxOutputLength: MAX_TAR_STREAM_BYTES,
    });
  }
  if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) {
    return execFileSync('xz', ['-dc', archivePath], {
      maxBuffer: MAX_TAR_STREAM_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  }
  const st = fs.statSync(archivePath);
  if (st.size > MAX_TAR_STREAM_BYTES) {
    throw new Error(`Archive stream exceeds size cap (${st.size} bytes)`);
  }
  return fs.readFileSync(archivePath);
}

function parseTarBuffer(tarBuf: Buffer): TarEntry[] {
  if (tarBuf.length === 0 || tarBuf.length % 512 !== 0) {
    throw new Error('Corrupt or truncated tar stream');
  }

  const entries: TarEntry[] = [];
  let offset = 0;
  let nextLongName: string | undefined;
  let nextLongLink: string | undefined;
  let nextPax: Record<string, string> = {};

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    offset += 512;

    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    verifyHeaderChecksum(header);

    const rawName = readCString(header, 0, 100);
    const mode = parseOctalOrBase256(header, 100, 8);
    let size = parseOctalOrBase256(header, 124, 12);
    const typeFlag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const rawLink = readCString(header, 157, 257);
    const magic = readCString(header, 257, 263);
    const prefix = magic.startsWith('ustar') ? readCString(header, 345, 500) : '';

    if (nextPax.size !== undefined) {
      const paxSize = parseInt(nextPax.size, 10);
      if (Number.isFinite(paxSize) && paxSize >= 0) size = paxSize;
    }

    const paddedSize = Math.ceil(size / 512) * 512;
    if (offset + paddedSize > tarBuf.length) {
      throw new Error('Truncated tar entry payload');
    }
    const payload = tarBuf.subarray(offset, offset + size);
    offset += paddedSize;

    if (typeFlag === 'L') {
      nextLongName = readCString(payload, 0, payload.length);
      continue;
    }
    if (typeFlag === 'K') {
      nextLongLink = readCString(payload, 0, payload.length);
      continue;
    }
    if (typeFlag === 'x') {
      nextPax = {...nextPax, ...parsePaxRecords(payload)};
      continue;
    }
    if (typeFlag === 'g') {
      continue;
    }

    const combinedName = prefix ? `${prefix}/${rawName}` : rawName;
    const name = nextPax.path ?? nextLongName ?? combinedName;
    const linkname = nextPax.linkpath ?? nextLongLink ?? rawLink;
    nextLongName = undefined;
    nextLongLink = undefined;
    nextPax = {};

    let type: TarEntry['type'];
    if (typeFlag === '0') {
      type = 'file';
    } else if (typeFlag === '5') {
      type = 'dir';
    } else if (typeFlag === '2') {
      type = 'symlink';
    } else if (typeFlag === '1') {
      type = 'hardlink';
    } else {
      type = 'special';
    }

    entries.push({name, mode, size, type, linkname, data: payload});
  }

  return entries;
}

// Normalizes an archive entry path without collapsing `..`, rejecting absolute paths, backslashes,
// NUL bytes, and `..` traversal components. Returns `''` for the archive root (`.` / `./`).
function canonicalEntryRel(rawPath: string): string {
  if (!rawPath || rawPath.startsWith('/') || rawPath.includes('\\') || rawPath.includes('\0')) {
    throw new Error(`Illegal path in archive: ${rawPath}`);
  }
  const parts: string[] = [];
  for (const seg of rawPath.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      throw new Error(`Illegal path in archive: ${rawPath}`);
    }
    parts.push(seg);
  }
  return parts.join('/');
}

// Case-insensitive, NFD-normalized key matching macOS APFS lookup semantics so archives cannot
// smuggle colliding paths (`Link` vs `link`, NFC vs NFD) past symlink/hardlink checks.
function apfsKey(relPath: string): string {
  return relPath
    .split('/')
    .map(c => c.normalize('NFD').toLowerCase())
    .join('/');
}

// Resolves a relative symlink step-by-step against the complete archive symlink map WITHOUT calling
// `path.posix.normalize` beforehand, catching lexical `<symlink>/..` collapses (`a -> ..`,
// `s -> a/../../outside`) as well as forward-referenced symlink chains (`s -> t/../outside`
// followed later in the archive by `t -> .`).
function verifySymlinkTargetInTree(
  symRel: string,
  linkname: string,
  symlinkMap: ReadonlyMap<string, string>,
  maxHops = 40
): void {
  const symParts = symRel.split('/');
  const resolved = symParts.slice(0, -1);
  const pending = linkname.split('/');
  let hops = 0;

  while (pending.length > 0) {
    const comp = pending.shift()!;
    if (!comp || comp === '.') continue;
    if (comp === '..') {
      if (resolved.length === 0) {
        throw new Error(`Illegal link target in archive: ${symRel} -> ${linkname}`);
      }
      resolved.pop();
      continue;
    }
    const candRel = [...resolved, comp].join('/');
    const target = symlinkMap.get(apfsKey(candRel));
    if (target !== undefined) {
      hops++;
      if (hops > maxHops) {
        throw new Error(`Symlink loop detected in archive at: ${candRel}`);
      }
      pending.unshift(...target.split('/'));
    } else {
      resolved.push(comp);
    }
  }
}

function isMachOBinary(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const hdr = Buffer.alloc(4);
    const read = fs.readSync(fd, hdr, 0, 4, 0);
    if (read < 4) return false;
    return MACHO_MAGICS.has(hdr.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const d of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, d.name);
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (d.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function cloneOrCopyFile(src: string, dst: string) {
  try {
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE);
  } catch {
    fs.copyFileSync(src, dst);
  }
}

function sha256FileSync(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(65_536);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(n === buf.length ? buf : buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function formatUnpackError(err: unknown): Error {
  if (err instanceof Error) {
    if (!err.message.startsWith('UNPACK_ERROR:')) {
      err.message = `UNPACK_ERROR: ${err.message}`;
    }
    return err;
  }
  return new Error(`UNPACK_ERROR: ${String(err)}`);
}

export function casRefFileForBundle(casDir: string, destDir: string): string {
  const safeName = path.basename(path.resolve(destDir)).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(path.resolve(casDir), 'refs', `${safeName}.txt`);
}

export function bundle(archivePath: string, destDir: string, casDir?: string): number {
  const resolvedDest = path.resolve(destDir);
  const resolvedCas = casDir ? path.resolve(casDir) : undefined;

  try {
    const tarBuf = decompressArchive(archivePath);
    const entries = parseTarBuffer(tarBuf);

    if (entries.length > MAX_FILES) {
      throw new Error(`Archive exceeds 25,000 file cap (${entries.length} entries)`);
    }

    interface ValidatedEntry {
      rel: string;
      mode: number;
      type: 'file' | 'dir' | 'symlink' | 'hardlink';
      linkname: string;
      hardlinkSrcRel?: string;
      data: Buffer;
    }

    let totalBytes = 0;
    const entryKinds = new Map<string, 'file' | 'dir' | 'symlink' | 'hardlink'>();
    const symlinkMap = new Map<string, string>();
    const symlinkEntries: Array<{rel: string; linkname: string}> = [];
    const regularFiles = new Map<string, {rel: string; size: number}>();
    const validated: ValidatedEntry[] = [];

    for (const m of entries) {
      if (m.type === 'special') {
        throw new Error(`Disallowed special file in archive: ${m.name}`);
      }
      const rel = canonicalEntryRel(m.name);
      if (!rel) {
        if (m.type === 'dir') continue;
        throw new Error(`Illegal root entry in archive: ${m.name}`);
      }

      const segs = rel.split('/');
      for (let i = 1; i < segs.length; i++) {
        const ancRel = segs.slice(0, i).join('/');
        const ancKey = apfsKey(ancRel);
        const prevKind = entryKinds.get(ancKey);
        if (prevKind !== undefined && prevKind !== 'dir') {
          if (prevKind === 'symlink') {
            verifySymlinkTargetInTree(ancRel, symlinkMap.get(ancKey)!, symlinkMap);
          }
          throw new Error(`Archive entry traverses symlinked directory: ${rel}`);
        }
        entryKinds.set(ancKey, 'dir');
      }

      const key = apfsKey(rel);
      const existingKind = entryKinds.get(key);
      if (m.type === 'dir') {
        if (existingKind !== undefined && existingKind !== 'dir') {
          throw new Error(`Archive directory collides with existing entry: ${rel}`);
        }
        entryKinds.set(key, 'dir');
        validated.push({rel, mode: m.mode, type: 'dir', linkname: '', data: m.data});
      } else {
        if (existingKind !== undefined) {
          throw new Error(`Duplicate or colliding archive entry path: ${rel}`);
        }
        entryKinds.set(key, m.type);

        if (m.type === 'symlink') {
          if (
            !m.linkname ||
            m.linkname.startsWith('/') ||
            m.linkname.includes('\\') ||
            m.linkname.includes('\0')
          ) {
            throw new Error(`Illegal link target in archive: ${m.name} -> ${m.linkname}`);
          }
          symlinkMap.set(key, m.linkname);
          symlinkEntries.push({rel, linkname: m.linkname});
          validated.push({rel, mode: m.mode, type: 'symlink', linkname: m.linkname, data: m.data});
        } else if (m.type === 'hardlink') {
          if (
            !m.linkname ||
            m.linkname.startsWith('/') ||
            m.linkname.includes('\\') ||
            m.linkname.includes('\0')
          ) {
            throw new Error(`Illegal link target in archive: ${m.name} -> ${m.linkname}`);
          }
          const targetRel = canonicalEntryRel(m.linkname);
          const targetInfo = targetRel ? regularFiles.get(apfsKey(targetRel)) : undefined;
          if (!targetInfo) {
            throw new Error(
              `Hardlink target '${m.linkname}' for '${rel}' ` +
              'does not reference an earlier regular file'
            );
          }
          totalBytes += targetInfo.size;
          validated.push({
            rel,
            mode: m.mode,
            type: 'hardlink',
            linkname: m.linkname,
            hardlinkSrcRel: targetInfo.rel,
            data: m.data,
          });
        } else {
          totalBytes += m.size;
          regularFiles.set(key, {rel, size: m.size});
          validated.push({rel, mode: m.mode, type: 'file', linkname: '', data: m.data});
        }
      }

      if (totalBytes > MAX_BYTES) {
        throw new Error(`Unpacked size exceeds 500 MiB cap (${totalBytes} bytes)`);
      }
    }

    // Validate all symlinks against the complete symlink map so forward-referenced symlink chains
    // (`s -> t/../outside` declared before `t -> .`) are caught before touching disk.
    for (const sym of symlinkEntries) {
      verifySymlinkTargetInTree(sym.rel, sym.linkname, symlinkMap);
    }

    fs.rmSync(resolvedDest, {recursive: true, force: true});
    fs.mkdirSync(resolvedDest, {recursive: true, mode: 0o755});

    const assertInsideDest = (p: string, label: string) => {
      if (p !== resolvedDest && !p.startsWith(`${resolvedDest}${path.sep}`)) {
        throw new Error(`Path escapes destination directory: ${label}`);
      }
    };

    // Phase 1: Extract directories and regular files exclusively (zero symlinks exist on disk yet,
    // and regular files are opened with O_CREAT | O_EXCL | O_NOFOLLOW).
    for (const m of validated) {
      if (m.type !== 'dir' && m.type !== 'file') continue;
      const targetPath = path.resolve(resolvedDest, m.rel);
      assertInsideDest(targetPath, m.rel);
      if (m.type === 'dir') {
        fs.mkdirSync(targetPath, {recursive: true, mode: 0o755});
      } else {
        fs.mkdirSync(path.dirname(targetPath), {recursive: true, mode: 0o755});
        const mode = (m.mode & 0o111) !== 0 ? 0o755 : 0o644;
        const fd = fs.openSync(
          targetPath,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          mode
        );
        try {
          if (m.data.length > 0) fs.writeSync(fd, m.data, 0, m.data.length, 0);
          fs.fchmodSync(fd, mode);
        } finally {
          fs.closeSync(fd);
        }
      }
    }

    // Phase 2: Materialize hardlinks strictly against verified regular files inside `resolvedDest`.
    for (const m of validated) {
      if (m.type !== 'hardlink') continue;
      const targetPath = path.resolve(resolvedDest, m.rel);
      const linkSrc = path.resolve(resolvedDest, m.hardlinkSrcRel!);
      assertInsideDest(targetPath, m.rel);
      assertInsideDest(linkSrc, m.linkname);
      const srcStat = fs.lstatSync(linkSrc);
      if (srcStat.isSymbolicLink() || !srcStat.isFile()) {
        throw new Error(`Hardlink source is not a regular file: ${m.linkname}`);
      }
      fs.mkdirSync(path.dirname(targetPath), {recursive: true, mode: 0o755});
      fs.linkSync(linkSrc, targetPath);
    }

    // Phase 3: Materialize symlinks last so no directory/file/hardlink creation ever traverses one.
    const realDest = fs.realpathSync(resolvedDest);
    for (const m of validated) {
      if (m.type !== 'symlink') continue;
      const targetPath = path.resolve(resolvedDest, m.rel);
      assertInsideDest(targetPath, m.rel);
      fs.mkdirSync(path.dirname(targetPath), {recursive: true, mode: 0o755});
      fs.symlinkSync(m.linkname, targetPath);
    }

    // Post-extraction belt-and-suspenders realpath check on every materialized symlink whose target
    // exists on disk.
    for (const m of validated) {
      if (m.type !== 'symlink') continue;
      const targetPath = path.resolve(resolvedDest, m.rel);
      let realTarget: string | undefined;
      try {
        realTarget = fs.realpathSync(targetPath);
      } catch {
        realTarget = undefined;
      }
      if (
        realTarget !== undefined &&
        realTarget !== realDest &&
        !realTarget.startsWith(`${realDest}${path.sep}`)
      ) {
        throw new Error(`Materialized symlink escapes destination directory: ${m.rel}`);
      }
    }

    const runEntry = path.join(resolvedDest, 'run');
    let runStat: fs.Stats | undefined;
    try {
      runStat = fs.lstatSync(runEntry);
    } catch {}
    if (
      !runStat ||
      runStat.isSymbolicLink() ||
      !runStat.isFile() ||
      (runStat.mode & 0o111) === 0
    ) {
      throw new Error('Bundle is missing required executable ./run at archive root');
    }

    if (process.platform === 'darwin') {
      try {
        execFileSync('/usr/bin/xattr', ['-crs', resolvedDest], {
          stdio: 'pipe',
          timeout: 30_000,
        });
      } catch {}
      if (fs.existsSync('/usr/bin/codesign')) {
        const machoFiles = walkFiles(resolvedDest).filter(isMachOBinary);
        for (let i = 0; i < machoFiles.length; i += CODESIGN_BATCH_SIZE) {
          const batch = machoFiles.slice(i, i + CODESIGN_BATCH_SIZE);
          try {
            execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', ...batch], {
              stdio: 'pipe',
              timeout: 30_000,
            });
          } catch {
            for (const fpath of batch) {
              try {
                execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', fpath], {
                  stdio: 'pipe',
                  timeout: 10_000,
                });
              } catch {}
            }
          }
        }
      }
    }

    if (resolvedCas) {
      const referencedDigests = new Set<string>();
      for (const fpath of walkFiles(resolvedDest)) {
        const st = fs.lstatSync(fpath);
        if (st.size < CAS_MIN_BYTES || st.nlink > 1) continue;

        const digest = sha256FileSync(fpath);
        referencedDigests.add(digest);
        const casShardDir = path.join(resolvedCas, digest.slice(0, 2));
        fs.mkdirSync(casShardDir, {recursive: true, mode: 0o755});
        const casBlob = path.join(casShardDir, digest);

        if (!fs.existsSync(casBlob)) {
          const tmpBlob = `${casBlob}.tmp-${process.pid}`;
          cloneOrCopyFile(fpath, tmpBlob);
          fs.chmodSync(tmpBlob, 0o444);
          fs.renameSync(tmpBlob, casBlob);
        }

        const origMode = st.mode & 0o777;
        const tmpTarget = `${fpath}.cas-tmp-${process.pid}`;
        cloneOrCopyFile(casBlob, tmpTarget);
        fs.chmodSync(tmpTarget, origMode);
        fs.renameSync(tmpTarget, fpath);
      }

      if (referencedDigests.size > 0) {
        const refFile = casRefFileForBundle(resolvedCas, resolvedDest);
        fs.mkdirSync(path.dirname(refFile), {recursive: true, mode: 0o700});
        const tmpRef = `${refFile}.tmp-${process.pid}`;
        fs.writeFileSync(tmpRef, `${[...referencedDigests].sort().join('\n')}\n`, {mode: 0o600});
        fs.renameSync(tmpRef, refFile);
      }
    }

    return totalBytes;
  } catch (err) {
    fs.rmSync(resolvedDest, {recursive: true, force: true});
    throw formatUnpackError(err);
  }
}
