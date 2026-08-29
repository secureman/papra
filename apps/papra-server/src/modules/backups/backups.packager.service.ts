import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import {
  createGunzip,
  createBrotliCompress,
  createBrotliDecompress,
  constants as zlibConstants,
} from 'node:zlib';
import { isNil } from '../shared/utils';

// Brotli quality for backup archives. Brotli beats gzip's ratio noticeably on
// text-heavy content (exported/text PDFs, JSON manifests, OCR text) at a
// comparable quality-to-speed tradeoff, and ships in Node core so it costs no
// extra dependency. Quality 5 stays roughly gzip-default speed (important on
// constrained self-hosted hardware like Termux/udocker boxes) while still
// improving the ratio — bump toward 9-11 later if CPU headroom allows and
// backup duration isn't a concern.
const BROTLI_QUALITY = 5;
export const BROTLI_OPTIONS = {
  params: {
    [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
  },
};

// Gzip's magic number (0x1f 0x8b) lets unpack() tell old gzip-compressed
// backups apart from newer brotli ones with no format version field needed —
// same "detect by trying" spirit as decryptPayload's legacy-layout fallback.
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

// Minimal hand-rolled tar packer/unpacker. Why no `tar` npm package?
//   - Most tar libs are 50KB+ with full pax/ustar support
//   - We only need to (de)serialize flat archives of files, no symlinks/permissions
//   - Reduces the dependency audit surface
//
// Format: classic ustar (POSIX.1-1988). Each entry is a 512-byte header followed
// by the file content padded to 512 bytes. End-of-archive is two zero blocks.
//
// We use a small subset of ustar:
//   - File names up to 100 chars (split into name + prefix if needed, but we
//     restrict to 100 to keep the simple header layout)
//   - Regular files only (no directories, symlinks, etc.)
//   - No extended attributes (pax)
//   - 8-byte size field (max 8GB files, plenty for backups)
//
// Restore (extraction) returns an array of {name, content} pairs.

const BLOCK_SIZE = 512;
const FILE_MODE_REGULAR = 0o644;
// Classic ustar splits long paths across two header fields: the final path
// segment lives in `name` (100 bytes at offset 0) and everything before it in
// `prefix` (155 bytes at offset 345). A path is representable when its last
// segment fits in 100 bytes and some '/' boundary leaves a ≤155-byte prefix.
const MAX_NAME_FIELD_LENGTH = 100;
const MAX_PREFIX_FIELD_LENGTH = 155;
const MAX_ENTRY_SIZE_BYTES = 8 * 1024 * 1024 * 1024 - 1;

type TarEntry = { name: string; content: Buffer };

function padToBlock(buffer: Buffer): Buffer {
  const remainder = buffer.length % BLOCK_SIZE;
  if (remainder === 0) {
    return buffer;
  }
  const padding = BLOCK_SIZE - remainder;
  return Buffer.concat([buffer, Buffer.alloc(padding)]);
}

function writeOctal(buffer: Buffer, offset: number, value: number, length: number): void {
  // ustar octal fields are right-padded with NULs, NOT spaces.
  const str = value.toString(8).padStart(length - 1, '0') + '\0';
  buffer.write(str, offset, length, 'utf8');
}

function writeString(buffer: Buffer, offset: number, value: string, length: number): void {
  const truncated = value.slice(0, length);
  buffer.write(truncated, offset, length, 'utf8');
}

function checksum(header: Buffer): number {
  // ustar checksum: sum of all bytes, with the checksum field treated as 8 spaces.
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    const inChecksumField = i >= 148 && i < 156;
    sum += inChecksumField ? 0x20 : header[i]!;
  }
  return sum;
}

// Split an entry path into ustar's name/prefix fields. Short paths fit the
// name field alone; longer ones are split on a '/' boundary. Throws when the
// path can't be represented at all (final segment >100 bytes, or no '/' in
// range to keep the prefix ≤155 bytes).
function splitUstarPath(name: string): { nameField: string; prefixField: string } {
  if (Buffer.byteLength(name, 'utf8') <= MAX_NAME_FIELD_LENGTH) {
    return { nameField: name, prefixField: '' };
  }

  // Try every '/' boundary from the end backwards and take the first one
  // where both fields fit their limits — i.e. the shortest possible suffix,
  // which maximizes headroom on the prefix side.
  for (let index = name.length - 2; index >= 1; index -= 1) {
    if (name[index] !== '/') {
      continue;
    }
    const nameField = name.slice(index + 1);
    const prefixField = name.slice(0, index);
    if (
      Buffer.byteLength(nameField, 'utf8') <= MAX_NAME_FIELD_LENGTH &&
      Buffer.byteLength(prefixField, 'utf8') <= MAX_PREFIX_FIELD_LENGTH
    ) {
      return { nameField, prefixField };
    }
  }

  throw new Error(
    `Backup entry path cannot be stored in the archive format (final path segment must be ≤ ${MAX_NAME_FIELD_LENGTH} bytes and the leading directories ≤ ${MAX_PREFIX_FIELD_LENGTH} bytes)`,
  );
}

function buildEntryHeader({ name, size }: { name: string; size: number }): Buffer {
  const { nameField, prefixField } = splitUstarPath(name);
  const header = Buffer.alloc(BLOCK_SIZE);
  // name (100 bytes at offset 0)
  writeString(header, 0, nameField, MAX_NAME_FIELD_LENGTH);
  // mode (8 bytes at offset 100): "0000644\0"
  writeOctal(header, 100, FILE_MODE_REGULAR, 8);
  // uid (8 bytes at offset 108): "0000000\0"
  writeOctal(header, 108, 0, 8);
  // gid (8 bytes at offset 116): "0000000\0"
  writeOctal(header, 116, 0, 8);
  // size (12 bytes at offset 124)
  writeOctal(header, 124, size, 12);
  // mtime (12 bytes at offset 136)
  writeOctal(header, 136, Math.floor(Date.now() / 1000), 12);
  // checksum placeholder (8 bytes at offset 148) — set after computing it
  // typeflag (1 byte at offset 156): '0' for regular file
  header.write('0', 156, 'utf8');
  // ustar magic at offset 257
  writeString(header, 257, 'ustar', 6);
  // ustar version at offset 263: "00"
  writeString(header, 263, '00', 2);
  // prefix (155 bytes at offset 345): leading directories for long paths.
  // Written before the checksum is computed over the whole block.
  writeString(header, 345, prefixField, MAX_PREFIX_FIELD_LENGTH);

  const sum = checksum(header);
  // Checksum field is 6 octal digits + NUL + space, per ustar spec.
  writeOctal(header, 148, sum, 7);
  header.write(' ', 155, 'utf8');

  return header;
}

// Pack an array of entries into a single Buffer (the tarball bytes).
function packTar(entries: TarEntry[]): Buffer {
  for (const entry of entries) {
    // Validate up front with a clear message rather than letting a malformed
    // header slip through: names that don't fit would previously be silently
    // truncated, which could collide or break the id-prefix matching that the
    // restore and verify flows rely on.
    try {
      splitUstarPath(entry.name);
    } catch (error) {
      throw new Error(`${(error as Error).message} [entry: "${entry.name}"]`);
    }
    if (entry.content.length > MAX_ENTRY_SIZE_BYTES) {
      throw new Error(
        `Backup entry exceeds the ${MAX_ENTRY_SIZE_BYTES}-byte archive size limit: "${entry.name}"`,
      );
    }
  }

  const blocks: Buffer[] = [];
  for (const entry of entries) {
    blocks.push(buildEntryHeader({ name: entry.name, size: entry.content.length }));
    blocks.push(padToBlock(entry.content));
  }
  // End-of-archive marker: two 512-byte zero blocks.
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(blocks);
}

function readOctal(buffer: Buffer, offset: number, length: number): number {
  // Trim trailing NULs and spaces.
  const raw = buffer
    .subarray(offset, offset + length)
    .toString('utf8')
    .replace(/\u0000+$/g, '')
    .trimEnd();
  if (raw.length === 0) {
    return 0;
  }
  return Number.parseInt(raw, 8);
}

function readString(buffer: Buffer, offset: number, length: number): string {
  // Tar header strings are NUL-terminated, NOT NUL-padded everywhere. Trim NULs.
  return buffer
    .subarray(offset, offset + length)
    .toString('utf8')
    .replace(/\u0000+$/g, '')
    .trimEnd();
}

// Unpack a tarball Buffer into its entries. Stops at the first all-zero block.
function unpackTar(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((b) => b === 0)) {
      break; // end-of-archive
    }
    const nameField = readString(header, 0, MAX_NAME_FIELD_LENGTH);
    const prefixField = readString(header, 345, MAX_PREFIX_FIELD_LENGTH);
    // ustar long paths: the leading directories ride in the prefix field.
    const name = prefixField ? `${prefixField}/${nameField}` : nameField;
    const size = readOctal(header, 124, 12);
    offset += BLOCK_SIZE;
    const content = Buffer.from(buffer.subarray(offset, offset + size));
    entries.push({ name, content });
    offset += padToBlock(content).length;
  }
  return entries;
}

// Streaming twin of unpackTar(): parses the same ustar byte stream but writes
// each entry straight to a file under extractDir instead of collecting every
// entry as an in-memory Buffer. This is what makes restoring a large org
// possible on memory-constrained hosts (Termux/udocker) — unpackTar() holds
// every document in RAM simultaneously (~500 docs * 1-2MB = a full org's worth
// of RSS on top of the tarball itself), which is exactly what OOM-killed
// restores of large backups. Emits {name, path} objects on the readable side
// as each entry finishes writing.
export function createTarExtractTransform({ extractDir }: { extractDir: string }): Transform {
  let buffered = Buffer.alloc(0);
  // Current entry being written, if any.
  let currentName: string | null = null;
  let currentRemaining = 0; // content bytes still to come
  let currentPadding = 0; // zero-padding bytes still to come, after content
  let currentStream: ReturnType<typeof createWriteStream> | null = null;
  let endOfArchive = false;
  const pendingEntries: { name: string; path: string }[] = [];

  // Closes the current entry's write stream and only marks it "done" once the
  // OS has actually confirmed every byte was written (the 'finish' event) —
  // not merely once .end() was called. Marking an entry done too early (the
  // original bug here) let restore read a file back before its last buffered
  // writes had actually landed on disk, silently truncating documents under
  // real I/O load — invisible in small/fast tests, real at hundreds of files.
  function closeCurrentEntry(): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      if (!currentStream) {
        resolvePromise();
        return;
      }
      const streamToClose = currentStream;
      const name = currentName!;
      const onFinish = () => {
        streamToClose.off('error', onError);
        pendingEntries.push({ name, path: resolveEntryPath({ extractDir, name }) });
        resolvePromise();
      };
      const onError = (error: Error) => {
        streamToClose.off('finish', onFinish);
        reject(error);
      };
      streamToClose.once('finish', onFinish);
      streamToClose.once('error', onError);
      streamToClose.end();
    });
  }

  return new Transform({
    readableObjectMode: true,
    async transform(chunk: Buffer, _encoding, callback) {
      try {
        buffered = Buffer.concat([buffered, chunk]);

        for (;;) {
          if (endOfArchive) {
            break; // ignore any trailing bytes after the end-of-archive marker
          }

          if (currentStream) {
            // Draining the current entry's content + padding.
            const toWriteAsContent = Math.min(currentRemaining, buffered.length);
            if (toWriteAsContent > 0) {
              await writeChunk(currentStream, buffered.subarray(0, toWriteAsContent));
              buffered = buffered.subarray(toWriteAsContent);
              currentRemaining -= toWriteAsContent;
            }
            if (currentRemaining > 0) {
              break; // need more data
            }
            const toSkipAsPadding = Math.min(currentPadding, buffered.length);
            buffered = buffered.subarray(toSkipAsPadding);
            currentPadding -= toSkipAsPadding;
            if (currentPadding > 0) {
              break; // need more data
            }
            await closeCurrentEntry();
            currentName = null;
            currentStream = null;
            currentRemaining = 0;
            currentPadding = 0;
            continue;
          }

          if (buffered.length < BLOCK_SIZE) {
            break; // need a full header block
          }
          const header = buffered.subarray(0, BLOCK_SIZE);
          if (header.every((b) => b === 0)) {
            endOfArchive = true;
            buffered = Buffer.alloc(0);
            break;
          }
          buffered = buffered.subarray(BLOCK_SIZE);

          const nameField = readString(header, 0, MAX_NAME_FIELD_LENGTH);
          const prefixField = readString(header, 345, MAX_PREFIX_FIELD_LENGTH);
          const name = prefixField ? `${prefixField}/${nameField}` : nameField;
          const size = readOctal(header, 124, 12);
          const padded = padToBlock(Buffer.alloc(size)).length;

          const path = resolveEntryPath({ extractDir, name });
          await mkdir(join(path, '..'), { recursive: true });
          currentName = name;
          currentStream = createWriteStream(path);
          currentRemaining = size;
          currentPadding = padded - size;
        }

        for (const entry of pendingEntries.splice(0)) {
          this.push(entry);
        }
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    flush(callback) {
      if (currentStream) {
        // Ended mid-entry — the archive was truncated.
        callback(new Error('Backup archive ended unexpectedly mid-entry'));
        return;
      }
      for (const entry of pendingEntries.splice(0)) {
        this.push(entry);
      }
      callback();
    },
  });
}

function writeChunk(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (stream.write(chunk)) {
      resolvePromise();
      return;
    }
    // Whichever of drain/error fires first must remove the other listener —
    // otherwise, on a large file needing many backpressured writes, every
    // resolved-via-drain call leaves its paired 'error' listener attached
    // forever, piling up hundreds of dangling listeners on one stream over
    // the life of a big file (surfaces as Node's MaxListenersExceededWarning
    // under real load, invisible on small test fixtures).
    const onDrain = () => {
      stream.off('error', onError);
      resolvePromise();
    };
    const onError = (error: Error) => {
      stream.off('drain', onDrain);
      reject(error);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

// Guards against a corrupted or crafted archive writing outside extractDir
// (tar-slip / zip-slip): resolve the entry path and verify it's still nested
// under extractDir before ever touching the filesystem.
function resolveEntryPath({ extractDir, name }: { extractDir: string; name: string }): string {
  const resolved = resolve(extractDir, name);
  if (resolved !== extractDir && !resolved.startsWith(extractDir + sep)) {
    throw new Error(`Backup archive entry path escapes the extraction directory: "${name}"`);
  }
  return resolved;
}

const GZIP_MAGIC_BYTES = Buffer.from([0x1f, 0x8b]);

// Sniffs the first 2 bytes of a stream to pick gzip vs brotli decompression
// without buffering the whole thing — same gzip magic number used by
// decompressArchive() above, just streaming. The sniffed bytes are re-emitted
// as the first chunk of the returned stream, so nothing is lost.
async function createAutoDetectDecompressStream(source: Readable): Promise<Readable> {
  const sniffed = await new Promise<Buffer>((resolvePromise, reject) => {
    let collected = Buffer.alloc(0);
    function onData(chunk: Buffer) {
      collected = Buffer.concat([collected, chunk]);
      if (collected.length >= 2) {
        source.pause();
        source.off('data', onData);
        source.off('end', onEnd);
        source.off('error', onError);
        resolvePromise(collected);
      }
    }
    function onEnd() {
      source.off('data', onData);
      source.off('error', onError);
      resolvePromise(collected);
    }
    function onError(error: Error) {
      source.off('data', onData);
      source.off('end', onEnd);
      reject(error);
    }
    source.on('data', onData);
    source.once('end', onEnd);
    source.once('error', onError);
  });

  const isGzip = sniffed.length >= 2 && sniffed.subarray(0, 2).equals(GZIP_MAGIC_BYTES);
  const reconstructed = Readable.from(
    (async function* () {
      yield sniffed;
      yield* source;
    })(),
  );
  return reconstructed.pipe(isGzip ? createGunzip() : createBrotliDecompress());
}

// Streaming twin of BackupPackagerService.unpack(): decompresses + extracts
// an archive stream straight to files under a fresh temp directory instead of
// building a Map<string, Buffer> of every document at once. Caller owns the
// returned directory and must remove it (see removeExtractionDirectory).
export async function unpackStreamToDirectory({
  archiveStream,
}: {
  archiveStream: Readable;
}): Promise<{ manifest: object; files: Map<string, string>; extractDir: string }> {
  const extractDir = join(tmpdir(), `papra-restore-extract-${randomBytes(12).toString('hex')}`);
  await mkdir(extractDir, { recursive: true });

  try {
    const decompressed = await createAutoDetectDecompressStream(archiveStream);
    const extracted: { name: string; path: string }[] = [];

    await pipeline(
      decompressed,
      createTarExtractTransform({ extractDir }),
      async function collect(source: AsyncIterable<{ name: string; path: string }>) {
        for await (const entry of source) {
          extracted.push(entry);
        }
      },
    );

    const manifestEntry = extracted.find((e) => e.name === 'manifest.json');
    if (!manifestEntry) {
      throw new Error('Backup archive is missing manifest.json');
    }
    const manifest = JSON.parse(await readFile(manifestEntry.path, 'utf8')) as object;

    const files = new Map<string, string>();
    for (const entry of extracted) {
      if (entry.name.startsWith('files/')) {
        files.set(entry.name.slice('files/'.length), entry.path);
      }
    }

    return { manifest, files, extractDir };
  } catch (error) {
    await removeExtractionDirectory({ extractDir });
    throw error;
  }
}

// Best-effort cleanup for the directory unpackStreamToDirectory() creates.
export async function removeExtractionDirectory({
  extractDir,
}: {
  extractDir: string;
}): Promise<void> {
  await rm(extractDir, { recursive: true, force: true });
}

// Streaming twin of packTar(): accepts entries one at a time (object mode) and
// emits the exact same ustar bytes, ending with the two zero blocks on flush.
// Used by the envelope builder so a backup never holds more than ONE document
// in memory at a time, no matter how big the organization is — packTar() needs
// every entry resident simultaneously.
//
// Important: only the WRITABLE side is object-mode (entries in). The readable
// side must stay byte-oriented because this transform's output (headers,
// padded contents, end-of-archive blocks) is a real ustar byte stream destined
// for gzip → encryption → disk. Using `objectMode: true` (both sides) would
// make pipeline() choke when the Buffer output hits the byte-mode gzip sink.
export function createTarPackTransform(): Transform {
  return new Transform({
    writableObjectMode: true,
    transform(entry: TarEntry, _encoding, callback) {
      try {
        // Same validation as packTar's up-front loop, but per-entry as it
        // streams through.
        splitUstarPath(entry.name);
        if (entry.content.length > MAX_ENTRY_SIZE_BYTES) {
          throw new Error(
            `Backup entry exceeds the ${MAX_ENTRY_SIZE_BYTES}-byte archive size limit: "${entry.name}"`,
          );
        }
        this.push(buildEntryHeader({ name: entry.name, size: entry.content.length }));
        this.push(padToBlock(entry.content));
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    flush(callback) {
      // End-of-archive marker: two 512-byte zero blocks.
      this.push(Buffer.alloc(BLOCK_SIZE * 2));
      callback();
    },
  });
}

// High-level service. Handles brotli compression on top of tar so the final
// upload is a compressed archive. Note the ratio ceiling: PDFs/images that are
// already internally compressed (scanned pages, embedded JPEGs) won't shrink
// much further under any general-purpose compressor — this mainly helps
// text-heavy content (exported/text PDFs, JSON manifests, OCR sidecars).
export function createBackupPackagerService() {
  return {
    // Build a compressed backup from the manifest + file map. Returns the
    // final bytes ready to be encrypted and uploaded.
    async pack({
      manifest,
      files,
    }: {
      manifest: object;
      files: { name: string; content: Buffer }[];
    }): Promise<Buffer> {
      const entries: TarEntry[] = [
        { name: 'manifest.json', content: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
        ...files.map(({ name, content }) => ({ name: `files/${name}`, content })),
      ];
      const tarball = packTar(entries);
      return await brotliCompress(tarball);
    },

    // Inverse of pack: decompress + extract. Returns the manifest object and
    // a map of file path → Buffer.
    async unpack({
      archive,
    }: {
      archive: Buffer;
    }): Promise<{ manifest: object; files: Map<string, Buffer> }> {
      const tarball = await decompressArchive(archive);
      const entries = unpackTar(tarball);

      const manifestEntry = entries.find((e) => e.name === 'manifest.json');
      if (!manifestEntry) {
        throw new Error('Backup archive is missing manifest.json');
      }
      const manifest = JSON.parse(manifestEntry.content.toString('utf8')) as object;

      const files = new Map<string, Buffer>();
      for (const entry of entries) {
        if (entry.name.startsWith('files/')) {
          files.set(entry.name.slice('files/'.length), entry.content);
        }
      }
      return { manifest, files };
    },

    // Compute SHA256 hash of a buffer (used for backup verification)
    computeHash(content: Buffer): string {
      return createHash('sha256').update(content).digest('hex');
    },
  };
}

async function brotliCompress(input: Buffer): Promise<Buffer> {
  // Wrap the entire pipeline in a Promise resolved by consuming the brotli
  // stream and concatenating chunks. Cleaner than the original pipeline+sink
  // idiom and works in any Node version.
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const brotli = createBrotliCompress(BROTLI_OPTIONS);
    brotli.on('data', (chunk: Buffer) => chunks.push(chunk));
    brotli.on('end', resolve);
    brotli.on('error', reject);
    Readable.from(input).on('error', reject).pipe(brotli);
  });
  return Buffer.concat(chunks);
}

async function gunzip(input: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const gunzip = createGunzip();
    gunzip.on('data', (chunk: Buffer) => chunks.push(chunk));
    gunzip.on('end', resolve);
    gunzip.on('error', reject);
    Readable.from(input).on('error', reject).pipe(gunzip);
  });
  return Buffer.concat(chunks);
}

async function brotliDecompress(input: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const brotli = createBrotliDecompress();
    brotli.on('data', (chunk: Buffer) => chunks.push(chunk));
    brotli.on('end', resolve);
    brotli.on('error', reject);
    Readable.from(input).on('error', reject).pipe(brotli);
  });
  return Buffer.concat(chunks);
}

// Backups created before this change are gzip; new ones are brotli. Gzip
// streams always start with the 2-byte magic number 0x1f8b, so we can tell
// them apart without a format version field and stay backward compatible with
// every backup file already sitting in someone's Google Drive/WebDAV/FTP.
async function decompressArchive(input: Buffer): Promise<Buffer> {
  const isGzip = input.length >= 2 && input.subarray(0, 2).equals(GZIP_MAGIC);
  return isGzip ? await gunzip(input) : await brotliDecompress(input);
}

export type BackupPackagerService = ReturnType<typeof createBackupPackagerService>;
export { isNil };
