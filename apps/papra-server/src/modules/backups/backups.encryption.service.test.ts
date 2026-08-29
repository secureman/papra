import type { Config } from '../config/config.types';
import { describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { encrypt } from '../shared/crypto/encryption';
import {
  createBackupEncryptionService,
  packBackupEnvelope,
  unwrapCredentials,
  unpackBackupEnvelope,
  readEnvelopeHeaderFromFile,
  wrapCredentials,
} from './backups.encryption.service';

const KEK = '0123456789abcdef'.repeat(4);

function createService(): ReturnType<typeof createBackupEncryptionService> {
  return createBackupEncryptionService({
    config: { backups: { kek: KEK } } as Config,
  });
}

describe('backup encryption service', () => {
  describe('key wrapping roundtrip', () => {
    test('wraps and unwraps a backup key with the KEK', () => {
      const service = createService();
      const dek = service.generateBackupKey();

      const wrapped = service.wrapWithKek({ value: dek });
      expect(service.unwrapWithKek({ wrapped })).toEqual(dek);
    });

    test('generates 256-bit keys', () => {
      const service = createService();

      expect(service.generateBackupKey().length).toBe(32);
    });
  });

  describe('payload encryption roundtrip', () => {
    test('encrypts and decrypts payloads with a per-destination key', () => {
      const service = createService();
      const payload = Buffer.from('archive bytes here');

      const encrypted = service.encryptPayload({ payload, key: service.generateBackupKey() });
      // Ciphertext differs from plaintext (actually encrypted)...
      expect(encrypted.equals(payload)).toBe(false);
    });

    test('decrypts what it encrypted', () => {
      const service = createService();
      const key = service.generateBackupKey();
      const payload = Buffer.from('archive bytes here');

      const decrypted = service.decryptPayload({
        encryptedPayload: service.encryptPayload({ payload, key }),
        key,
      });

      expect(decrypted.toString('utf8')).toBe('archive bytes here');
    });

    test('streamed output is decryptable by the buffer decrypt path', async () => {
      // The spooled-envelope path encrypts via createPayloadEncryptStream; its
      // output MUST be byte-compatible with encryptPayload's layout so the
      // existing decryptPayload() (used everywhere) can read it back.
      const service = createService();
      const key = service.generateBackupKey();
      // Large enough to span multiple GCM/AES blocks.
      const payload = Buffer.alloc(1024 * 1024 + 137, 0x5a);

      const chunks: Buffer[] = [];
      await pipeline(
        Readable.from([payload]),
        service.createPayloadEncryptStream({ key }),
        new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
          },
        }),
      );

      const decrypted = service.decryptPayload({ encryptedPayload: Buffer.concat(chunks), key });
      expect(decrypted.equals(payload)).toBe(true);
    });

    test('decrypts legacy [iv][tag][ciphertext] payloads', () => {
      // Older (non-streaming) backups encrypted the payload via the shared
      // encrypt() helper, which produces [iv][tag][ciphertext]. decryptPayload
      // must still read those back after the format move to tag-last.
      const service = createService();
      const key = service.generateBackupKey();
      const payload = Buffer.from('legacy archive bytes');

      const legacy = encrypt({ key, value: payload });
      const decrypted = service.decryptPayload({ encryptedPayload: legacy, key });

      expect(decrypted.equals(payload)).toBe(true);
    });
  });

  describe('credentials helpers', () => {
    test('wraps and unwraps credential JSON', () => {
      const service = createService();

      const wrapped = wrapCredentials({
        encryption: service,
        credentials: { username: 'u', password: 'p' },
      });
      expect(unwrapCredentials({ encryption: service, wrapped })).toEqual({
        username: 'u',
        password: 'p',
      });
    });
  });

  describe('envelope framing', () => {
    test('pack/unpack roundtrip preserves the wrapped key and payload', () => {
      const wrappedKey = 'base64wrappedkey==';
      const encryptedPayload = Buffer.from([1, 2, 3, 4, 5]);

      const envelope = packBackupEnvelope({ wrappedKey, encryptedPayload });
      const unpacked = unpackBackupEnvelope({ envelope });

      expect(unpacked.wrappedKey).toBe(wrappedKey);
      expect(unpacked.encryptedPayload).toEqual(encryptedPayload);
    });

    test.each([
      ['empty buffer', Buffer.alloc(0)],
      ['shorter than the length prefix', Buffer.alloc(2)],
      [
        'zero-length key',
        (() => {
          const envelope = Buffer.alloc(8);
          envelope.writeUInt32BE(0, 0);
          return envelope;
        })(),
      ],
      [
        'key length running past the end of the buffer',
        (() => {
          const envelope = Buffer.alloc(10);
          envelope.writeUInt32BE(1000, 0);
          return envelope;
        })(),
      ],
    ])(
      'rejects malformed envelopes (%s) with a clean 400 error instead of a RangeError',
      (_label, envelope) => {
        expect(() => unpackBackupEnvelope({ envelope })).toThrowError(
          expect.objectContaining({ code: 'backups.invalid_file', statusCode: 400 }),
        );
      },
    );
  });
});

describe('readEnvelopeHeaderFromFile', () => {
  test('matches unpackBackupEnvelope on the same file', async () => {
    const service = createService();
    const key = service.generateBackupKey();
    const wrapped = service.wrapWithKek({ value: key });
    const encryptedPayload = service.encryptPayload({ payload: Buffer.from('payload bytes'), key });
    const envelope = packBackupEnvelope({ wrappedKey: wrapped, encryptedPayload });

    const tmpPath = join(tmpdir(), `envelope-header-test-${randomBytes(6).toString('hex')}`);
    await writeFile(tmpPath, envelope);
    try {
      const fromBuffer = unpackBackupEnvelope({ envelope });
      const fromFile = await readEnvelopeHeaderFromFile({ path: tmpPath });

      expect(fromFile.wrappedKey).toBe(fromBuffer.wrappedKey);
      expect(envelope.subarray(fromFile.payloadStart).equals(fromBuffer.encryptedPayload)).toBe(true);
    } finally {
      await rm(tmpPath, { force: true });
    }
  });

  test('rejects a truncated file the same way unpackBackupEnvelope rejects a truncated buffer', async () => {
    const tmpPath = join(tmpdir(), `envelope-header-truncated-${randomBytes(6).toString('hex')}`);
    await writeFile(tmpPath, Buffer.alloc(2));
    try {
      await expect(readEnvelopeHeaderFromFile({ path: tmpPath })).rejects.toThrow(
        expect.objectContaining({ code: 'backups.invalid_file' }),
      );
    } finally {
      await rm(tmpPath, { force: true });
    }
  });
});

describe('createPayloadDecryptStream', () => {
  test('round-trips through createPayloadEncryptStream (small payload)', async () => {
    const service = createService();
    const key = service.generateBackupKey();
    const payload = Buffer.from('hello backup world');

    const chunks: Buffer[] = [];
    await pipeline(
      Readable.from(payload),
      service.createPayloadEncryptStream({ key }),
      service.createPayloadDecryptStream({ key }),
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      }),
    );

    expect(Buffer.concat(chunks).toString()).toBe('hello backup world');
  });

  test('round-trips a large payload delivered across many small chunks', async () => {
    const service = createService();
    const key = service.generateBackupKey();
    const payload = Buffer.from('x'.repeat(500_000));

    // Feed the encrypted bytes through the decrypt stream in tiny, awkward
    // chunk sizes to exercise the IV/tag holdback boundary logic.
    const encrypted = service.encryptPayload({ payload, key });
    const chunks: Buffer[] = [];
    await pipeline(
      Readable.from(chunkBuffer(encrypted, 7)),
      service.createPayloadDecryptStream({ key }),
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      }),
    );

    expect(Buffer.concat(chunks).equals(payload)).toBe(true);
  });

  test('rejects a payload with a tampered auth tag', async () => {
    const service = createService();
    const key = service.generateBackupKey();
    const encrypted = service.encryptPayload({ payload: Buffer.from('hi'), key });
    encrypted[encrypted.length - 1] = (encrypted[encrypted.length - 1]! ^ 0xff) & 0xff; // flip a bit in the tag

    await expect(
      pipeline(
        Readable.from(encrypted),
        service.createPayloadDecryptStream({ key }),
        new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

function* chunkBuffer(buffer: Buffer, size: number): Generator<Buffer> {
  for (let offset = 0; offset < buffer.length; offset += size) {
    yield buffer.subarray(offset, offset + size);
  }
}
