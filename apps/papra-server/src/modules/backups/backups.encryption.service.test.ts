import type { Config } from '../config/config.types';
import { describe, expect, test } from 'vitest';
import {
  createBackupEncryptionService,
  packBackupEnvelope,
  unwrapCredentials,
  unpackBackupEnvelope,
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
