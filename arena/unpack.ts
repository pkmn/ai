import {execFileSync} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

export const MAX_BYTES = 500 * 1024 * 1024;
export const MAX_FILES = 25_000;
export const CAS_MIN_BYTES = 64 * 1024;

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

function parsePaxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  const text = data.toString('utf8');
  while (offset < text.length) {
    const spaceIdx = text.indexOf(' ', offset);
    if (spaceIdx < 0) break;
    const len = parseInt(text.slice(offset, spaceIdx), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(spaceIdx + 1, offset + len - 1);
    const eqIdx = record.indexOf('=');
    if (eqIdx > 0) {
      out[record.slice(0, eqIdx)] = record.slice(eqIdx + 1);
    }
    offset += len;
  }
  return out;
}

function decompressArchive(archivePath: string): Buffer {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    return zlib.gunzipSync(fs.readFileSync(archivePath), {
      maxOutputLength: MAX_BYTES + 1024 * 1024,
    });
  }
  if (lower.endsWith('.tar.zst') || lower.endsWith('.tzst')) {
    const zstdDecompress = (
      zlib as unknown as {
        zstdDecompressSync?: (buf: Buffer, opts?: {maxOutputLength?: number}) => Buffer;
      }
    ).zstdDecompressSync;
    if (typeof zstdDecompress === 'function') {
      return zstdDecompress(fs.readFileSync(archivePath), {
        maxOutputLength: MAX_BYTES + 1024 * 1024,
      });
    }
    return execFileSync('zstd', ['-dc', archivePath], {
      maxBuffer: MAX_BYTES + 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) {
    return execFileSync('xz', ['-dc', archivePath], {
      maxBuffer: MAX_BYTES + 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

// Resolves a relative archive path step-by-step against all symlinks declared so far in the
// archive so chained-symlink Tar Slip attacks (`a/b -> ..`, `a/b/escape -> ..`, `escape/pwned`)
// are caught before touching the filesystem.
function resolveInTree(
  relPath: string,
  symlinkMap: ReadonlyMap<string, string>,
  maxHops = 40
): string {
  const parts = relPath.split('/').filter(p => p && p !== '.');
  const resolved: string[] = [];
  let hops = 0;

  while (parts.length > 0) {
    const comp = parts.shift()!;
    if (comp === '..') {
      if (resolved.length === 0) {
        throw new Error(`Path traversal escapes destination root: ${relPath}`);
      }
      resolved.pop();
      continue;
    }
    const candidate = [...resolved, comp].join('/');
    const target = symlinkMap.get(candidate);
    if (target !== undefined) {
      hops++;
      if (hops > maxHops) {
        throw new Error(`Symlink loop detected in archive at: ${candidate}`);
      }
      const targetParts = target.split('/').filter(p => p && p !== '.');
      parts.unshift(...targetParts);
    } else {
      resolved.push(comp);
    }
  }

  return resolved.length > 0 ? resolved.join('/') : '.';
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
  if (process.platform === 'darwin') {
    try {
      execFileSync('/bin/cp', ['-c', src, dst], {stdio: 'pipe'});
      return;
    } catch {}
  }
  try {
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE);
  } catch {
    fs.copyFileSync(src, dst);
  }
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

export function unpackBundle(archivePath: string, destDir: string, casDir?: string): number {
  const resolvedDest = path.resolve(destDir);
  const resolvedCas = casDir ? path.resolve(casDir) : undefined;

  try {
    const tarBuf = decompressArchive(archivePath);
    const entries = parseTarBuffer(tarBuf);

    if (entries.length > MAX_FILES) {
      throw new Error(`Archive exceeds 25,000 file cap (${entries.length} entries)`);
    }

    let totalBytes = 0;
    const symlinkMap = new Map<string, string>();
    const regularSizes = new Map<string, number>();

    for (const m of entries) {
      if (m.type === 'special') {
        throw new Error(`Disallowed special file in archive: ${m.name}`);
      }
      if (m.name.startsWith('/') || m.name.startsWith('\\')) {
        throw new Error(`Illegal path in archive: ${m.name}`);
      }
      const norm = path.posix.normalize(m.name).replace(/^(\.\/)+/, '');
      const parts = norm.split('/');
      if (parts.includes('..')) {
        throw new Error(`Illegal path in archive: ${m.name}`);
      }

      if (norm && norm !== '.') {
        const parentNorm = path.posix.dirname(norm);
        if (parentNorm && parentNorm !== '.') {
          const resolvedParent = resolveInTree(parentNorm, symlinkMap);
          if (resolvedParent !== parentNorm) {
            throw new Error(
              `Archive entry traverses symlinked directory: ${norm} ` +
              `(resolves via ${resolvedParent})`
            );
          }
        }
      }

      if (m.type === 'symlink' || m.type === 'hardlink') {
        if (m.linkname.startsWith('/') || m.linkname.startsWith('\\')) {
          throw new Error(`Illegal link target in archive: ${m.name} -> ${m.linkname}`);
        }
        const linkBase = m.type === 'symlink' ? path.posix.dirname(norm) : '';
        const targetNorm = path.posix.normalize(
          linkBase && linkBase !== '.' ? `${linkBase}/${m.linkname}` : m.linkname
        );
        if (targetNorm.split('/').includes('..')) {
          throw new Error(`Illegal link target in archive: ${m.name} -> ${m.linkname}`);
        }
        const resolvedLinkTarget = resolveInTree(targetNorm, symlinkMap);
        if (m.type === 'symlink' && norm && norm !== '.') {
          symlinkMap.set(norm, m.linkname);
        } else if (m.type === 'hardlink') {
          const targetSize = regularSizes.get(resolvedLinkTarget);
          if (targetSize === undefined) {
            throw new Error(
              `Hardlink target '${resolvedLinkTarget}' for '${norm}' ` +
              'does not reference an earlier regular file'
            );
          }
          totalBytes += targetSize;
        }
      } else if (m.type === 'file') {
        totalBytes += m.size;
        if (norm && norm !== '.') {
          regularSizes.set(norm, m.size);
        }
      }

      if (totalBytes > MAX_BYTES) {
        throw new Error(`Unpacked size exceeds 500 MB cap (${totalBytes} bytes)`);
      }
    }

    fs.rmSync(resolvedDest, {recursive: true, force: true});
    fs.mkdirSync(resolvedDest, {recursive: true, mode: 0o755});

    for (const m of entries) {
      const rel = path.posix.normalize(m.name).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
      if (!rel || rel === '.') continue;
      const targetPath = path.resolve(resolvedDest, rel);
      if (targetPath !== resolvedDest && !targetPath.startsWith(`${resolvedDest}${path.sep}`)) {
        throw new Error(`Path escapes destination directory: ${m.name}`);
      }

      if (m.type === 'dir') {
        fs.mkdirSync(targetPath, {recursive: true, mode: 0o755});
      } else if (m.type === 'symlink') {
        fs.mkdirSync(path.dirname(targetPath), {recursive: true, mode: 0o755});
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
        fs.symlinkSync(m.linkname, targetPath);
      } else if (m.type === 'hardlink') {
        const linkRel = path.posix.normalize(m.linkname).replace(/^(\.\/)+/, '');
        const linkSrc = path.resolve(resolvedDest, linkRel);
        if (!linkSrc.startsWith(`${resolvedDest}${path.sep}`)) {
          throw new Error(`Hardlink escapes destination directory: ${m.linkname}`);
        }
        fs.mkdirSync(path.dirname(targetPath), {recursive: true, mode: 0o755});
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
        fs.linkSync(linkSrc, targetPath);
      } else if (m.type === 'file') {
        fs.mkdirSync(path.dirname(targetPath), {recursive: true, mode: 0o755});
        const mode = (m.mode & 0o111) !== 0 ? 0o755 : 0o644;
        fs.writeFileSync(targetPath, m.data, {mode});
        fs.chmodSync(targetPath, mode);
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
        execFileSync('/usr/bin/xattr', ['-cr', resolvedDest], {stdio: 'pipe'});
      } catch {}
      if (fs.existsSync('/usr/bin/codesign')) {
        for (const fpath of walkFiles(resolvedDest)) {
          const st = fs.lstatSync(fpath);
          if ((st.mode & 0o111) !== 0 || isMachOBinary(fpath)) {
            try {
              execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', fpath], {
                stdio: 'pipe',
              });
            } catch {}
          }
        }
      }
    }

    if (resolvedCas) {
      for (const fpath of walkFiles(resolvedDest)) {
        const st = fs.lstatSync(fpath);
        if (st.size < CAS_MIN_BYTES || st.nlink > 1) continue;

        const fileBytes = fs.readFileSync(fpath);
        const digest = crypto.createHash('sha256').update(fileBytes).digest('hex');
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
    }

    return totalBytes;
  } catch (err) {
    fs.rmSync(resolvedDest, {recursive: true, force: true});
    throw formatUnpackError(err);
  }
}

if (require.main === module) {
  const [, , archiveArg, destArg, casArg] = process.argv;
  if (!archiveArg || !destArg) {
    process.stderr.write('Usage: unpack <archive_path> <dest_dir> [cas_dir]\n');
    process.exit(2);
  }
  try {
    const casDir = casArg || process.env.ARENA_CAS_DIR || undefined;
    const unpackedBytes = unpackBundle(archiveArg, destArg, casDir);
    process.stdout.write(`UNPACK_OK: ${unpackedBytes} bytes\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : `UNPACK_ERROR: ${String(err)}`;
    process.stderr.write(`${msg}\n`);
    process.exit(1);
  }
}
