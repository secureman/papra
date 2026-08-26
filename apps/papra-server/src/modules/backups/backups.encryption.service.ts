import type { Config } from '../config/config.types';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { decrypt, encrypt } from '../shared/crypto/encryption';
import { createBackupsNotConfiguredError, createBackupInvalidFileError } from './backups.errors';

// Every backup destination gets its own random 256-bit key (the "DEK"). The DEK
// is wrapped with the server-wide KEK (BACKUPS_KEK) and stored on the destination
// row. The same wrap/unwrap mechanism is reused to encrypt the destination's
// credentials (refresh token, username/password) at rest — they're just treated
// as another "key" being wrapped, whatever their actual byte length.
//
// Why a key per destination instead of one key for everything: a leaked
// destination row only compromises that destination's backups, not every backup
// this org has ever taken elsewhere.

const KEY_LENGTH = 32;
const ALGORITHM = 'aes-256-gcm';
// Must match the IV length used by the payload cipher so the streamed output is
// byte-for-byte decodable by decryptPayload().
const IV_LENGTH = 12;
// AES-GCM auth tag length.
const TAG_LENGTH = 16;

function getKek({ config }: { config: Config }): Buffer {
  const hex = config.backups.kek;
  if (!hex) {
    throw createBackupsNotConfiguredError();
  }
  return Buffer.from(hex, 'hex');
}

export interface BackupEncryptionService {
  algorithm: string;
  generateBackupKey(): Buffer;
  wrapWithKek(args: { value: Buffer }): string;
  unwrapWithKek(args: { wrapped: string }): Buffer;
  encryptPayload(args: { payload: Buffer; key: Buffer }): Buffer;
  decryptPayload(args: { encryptedPayload: Buffer; key: Buffer }): Buffer;
  // Streaming twin of encryptPayload: emits [iv][...ciphertext...][tag], the
  // exact byte layout encryptPayload() produces, so decryptPayload() and every
  // existing backup file stay compatible. Lets the envelope builder pipe
  // tar → gzip → encryption → disk without ever holding the whole archive.
  //
  // Note this layout (iv then ciphertext then tag) differs from the *key
  // wrapping* format (shared crypto `encrypt()`, which is iv→tag→cipher): the
  // tag can only be computed after all ciphertext, so a single streaming pass
  // cannot put it first. The payload deliberately uses the streamable order.
  createPayloadEncryptStream(args: { key: Buffer }): Transform;
}

export function createBackupEncryptionService({
  config,
}: {
  config: Config;
}): BackupEncryptionService {
  const kek = getKek({ config });

  return {
    algorithm: ALGORITHM,

    generateBackupKey(): Buffer {
      return randomBytes(KEY_LENGTH);
    },

    wrapWithKek({ value }: { value: Buffer }): string {
      return encrypt({ key: kek, value }).toString('base64');
    },

    unwrapWithKek({ wrapped }: { wrapped: string }): Buffer {
      const encrypted = Buffer.from(wrapped, 'base64');
      return decrypt({ encryptedValue: encrypted, key: kek });
    },

    encryptPayload({ payload, key }: { payload: Buffer; key: Buffer }): Buffer {
      // [iv][ciphertext][tag] — the same layout createPayloadEncryptStream
      // produces, so both the buffered and streamed paths are interchangeable.
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
      return Buffer.concat([iv, encrypted, cipher.getAuthTag()]);
    },

    createPayloadEncryptStream({ key }: { key: Buffer }): Transform {
      // Same layout as encryptPayload: fresh random IV written first,
      // ciphertext streamed through, auth tag appended last.
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      let headerWritten = false;

      return new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          try {
            if (!headerWritten) {
              this.push(iv);
              headerWritten = true;
            }
            const encrypted = cipher.update(chunk);
            if (encrypted.length > 0) {
              this.push(encrypted);
            }
            callback();
          } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
          }
        },
        flush(callback) {
          try {
            const final = cipher.final();
            if (final.length > 0) {
              this.push(final);
            }
            this.push(cipher.getAuthTag());
            callback();
          } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
    },

    decryptPayload({ encryptedPayload, key }: { encryptedPayload: Buffer; key: Buffer }): Buffer {
      // Two payload layouts have existed over the life of the format, and AES-GCM
      // tag verification reliably picks whichever one a given file actually uses:
      //   - legacy: [iv][tag][ciphertext]  (old in-RAM builder via shared encrypt())
      //   - current: [iv][ciphertext][tag] (the streaming producer)
      // Try the current tag-last layout first, then fall back to legacy.
      if (encryptedPayload.length < IV_LENGTH + TAG_LENGTH) {
        throw createBackupInvalidFileError();
      }
      try {
        return decryptPayloadCipherTextLast({ encryptedPayload, key });
      } catch {
        return decrypt({ encryptedValue: encryptedPayload, key });
      }
    },
  };
}

// [iv][ciphertext][tag] — the layout encryptPayload / createPayloadEncryptStream
// produce. Decryption side of that layout used as the primary attempt in
// decryptPayload (see above).
function decryptPayloadCipherTextLast({
  encryptedPayload,
  key,
}: {
  encryptedPayload: Buffer;
  key: Buffer;
}): Buffer {
  const iv = encryptedPayload.subarray(0, IV_LENGTH);
  const ciphertextLength = encryptedPayload.length - IV_LENGTH - TAG_LENGTH;
  const encryptedBuffer = encryptedPayload.subarray(IV_LENGTH, IV_LENGTH + ciphertextLength);
  const tag = encryptedPayload.subarray(encryptedPayload.length - TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
}

// ----- Credential JSON helpers -----
// Credentials are a small JSON object (e.g. { refreshToken } or { username,
// password }). We JSON-stringify then wrap with the KEK for storage, and reverse
// that on read.

export function wrapCredentials({
  encryption,
  credentials,
}: {
  encryption: BackupEncryptionService;
  credentials: Record<string, string>;
}): string {
  return encryption.wrapWithKek({ value: Buffer.from(JSON.stringify(credentials), 'utf8') });
}

export function unwrapCredentials({
  encryption,
  wrapped,
}: {
  encryption: BackupEncryptionService;
  wrapped: string;
}): Record<string, string> {
  const buffer = encryption.unwrapWithKek({ wrapped });
  return JSON.parse(buffer.toString('utf8')) as Record<string, string>;
}

// ----- Single-file envelope -----
// One uploaded file per backup, not two. The wrapped key travels inside the same
// file as the encrypted payload, instead of a separate sidecar next to it — one
// less upload per backup, one less thing that can end up mismatched or deleted
// independently of the file it belongs to.
//
// Layout: [4-byte big-endian length of the wrapped-key string][wrapped-key
// bytes (utf8)][encrypted archive payload, everything after that].
export function packBackupEnvelope({
  wrappedKey,
  encryptedPayload,
}: {
  wrappedKey: string;
  encryptedPayload: Buffer;
}): Buffer {
  const wrappedKeyBuffer = Buffer.from(wrappedKey, 'utf8');
  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32BE(wrappedKeyBuffer.length, 0);
  return Buffer.concat([lengthPrefix, wrappedKeyBuffer, encryptedPayload]);
}

export function unpackBackupEnvelope({ envelope }: { envelope: Buffer }): {
  wrappedKey: string;
  encryptedPayload: Buffer;
} {
  // Validate the framing before touching it — a truncated or non-envelope file
  // would otherwise throw an opaque Buffer RangeError instead of a clean,
  // user-facing "not a backup file" error.
  if (envelope.length < 4) {
    throw createBackupInvalidFileError();
  }
  const keyLength = envelope.readUInt32BE(0);
  if (keyLength === 0 || keyLength > envelope.length - 4) {
    throw createBackupInvalidFileError();
  }
  const wrappedKey = envelope.subarray(4, 4 + keyLength).toString('utf8');
  const encryptedPayload = envelope.subarray(4 + keyLength);
  return { wrappedKey, encryptedPayload };
}
