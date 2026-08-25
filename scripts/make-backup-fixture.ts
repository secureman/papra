// Generates a real .papra-backup fixture using the fork's own packager and
// encryption services, so the Flutter decoder is verified against the exact
// producer of these files. Run: node_modules/.bin/tsx scripts/make-fixture.ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { createBackupPackagerService } from '../apps/papra-server/src/modules/backups/backups.packager.service';
import { createBackupEncryptionService } from '../apps/papra-server/src/modules/backups/backups.encryption.service';

const kek = Buffer.from(
  'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4',
  'hex',
);
const dek = Buffer.alloc(32, 7);

// Minimal config stub — the encryption service only reads backups.kek.
const encryption = createBackupEncryptionService({ config: { backups: { kek: kek.toString('hex') } } as any });
const packager = createBackupPackagerService();

const manifest = {
  schemaVersion: 2,
  organizationId: 'org-real-001',
  createdAt: new Date().toISOString(),
  documents: [
    {
      id: 'doc-1111',
      name: 'Invoice January',
      originalName: 'invoice-january.pdf',
      mimeType: 'application/pdf',
      originalSize: 10240,
      originalSha256Hash: 'deadbeef',
      createdAt: '2026-01-15T08:30:00.000Z',
      updatedAt: '2026-01-15T08:30:00.000Z',
      documentDate: '2026-01-01T00:00:00.000Z',
      notes: 'Paid via bank transfer.',
      folderId: null,
      folderPath: ['Finance', '2026'],
      tags: [
        { name: 'invoice', color: '#1e88e5', description: null },
        { name: '2026', color: '#43a047', description: null },
      ],
    },
    {
      id: 'doc-2222',
      name: 'Root doc (no folder)',
      originalName: 'root-doc.txt',
      mimeType: 'text/plain',
      originalSize: 27,
      createdAt: '2026-02-20T12:00:00.000Z',
      folderPath: null,
      tags: [],
    },
  ],
};

const files = [
  { name: 'doc-1111-invoice-january.pdf', content: Buffer.from([37, 80, 68, 70, 45, 49, 46, 55]) }, // %PDF-1.7
  { name: 'doc-2222-root-doc.txt', content: Buffer.from('hello from the real server', 'utf8') },
];

const archive = await packager.pack({ manifest, files });
const encrypted = encryption.encryptPayload({ payload: archive, key: dek });
const wrappedKey = encryption.wrapWithKek({ value: dek });

const wrappedKeyBuffer = Buffer.from(wrappedKey, 'utf8');
const lengthPrefix = Buffer.alloc(4);
lengthPrefix.writeUInt32BE(wrappedKeyBuffer.length, 0);
const envelope = Buffer.concat([lengthPrefix, wrappedKeyBuffer, encrypted]);

mkdirSync('/tmp/opencode/papra-fixture', { recursive: true });
writeFileSync('/tmp/opencode/papra-fixture/real.papra-backup', envelope);
console.log('wrote /tmp/opencode/papra-fixture/real.papra-backup,', envelope.length, 'bytes');
