import { describe, expect, test } from 'vitest';
import { createInMemoryDatabase } from '../app/database/database.test-utils';
import { documentsTable } from '../documents/documents.table';
import { createFoldersRepository } from './folders.repository';
import { foldersTable } from './folders.table';

const baseDocument = {
  organizationId: 'organization-1',
  mimeType: 'text/plain',
  originalStorageKey: 'organization-1/originals/doc',
  originalName: 'doc.txt',
};

const folderRows: (typeof foldersTable.$inferInsert)[] = [
  { id: 'folder-root-child', name: 'Subfolder', organizationId: 'organization-1', parentId: null },
  {
    id: 'folder-nested',
    name: 'Nested',
    organizationId: 'organization-1',
    parentId: 'folder-root-child',
  },
];

const documentRows: (typeof documentsTable.$inferInsert)[] = [
  {
    ...baseDocument,
    id: 'doc-banana',
    name: 'Banana.txt',
    documentDate: new Date('2024-05-01T00:00:00Z'),
    createdAt: new Date('2024-01-02T00:00:00Z'),
    originalSha256Hash: 'sha-banana',
  },
  {
    ...baseDocument,
    id: 'doc-apple',
    name: 'apple.pdf',
    documentDate: new Date('2024-05-03T00:00:00Z'),
    createdAt: new Date('2024-01-03T00:00:00Z'),
    originalSha256Hash: 'sha-apple',
  },
  {
    ...baseDocument,
    id: 'doc-cherry',
    name: 'cherry.docx',
    documentDate: new Date('2024-05-02T00:00:00Z'),
    createdAt: new Date('2024-01-01T00:00:00Z'),
    originalSha256Hash: 'sha-cherry',
  },
  {
    ...baseDocument,
    id: 'doc-in-subfolder',
    name: 'sub.txt',
    folderId: 'folder-root-child',
    originalSha256Hash: 'sha-sub',
  },
  {
    ...baseDocument,
    id: 'doc-other-org',
    name: 'other.txt',
    organizationId: 'organization-2',
    originalSha256Hash: 'sha-other-org',
  },
];

describe('folders repository', () => {
  describe('getFolderContents', () => {
    type SortArgs = {
      sortField?: 'name' | 'documentDate' | 'createdAt' | 'updatedAt';
      sortOrder?: 'asc' | 'desc';
    };

    const setup = async () => {
      const { db } = await createInMemoryDatabase({
        organizations: [
          { id: 'organization-1', name: 'Organization 1' },
          { id: 'organization-2', name: 'Organization 2' },
        ],
      });

      // Folders are not part of the generic database seeding helper, so insert them
      // manually before the documents that reference them to satisfy foreign keys.
      await db.insert(foldersTable).values(folderRows);

      await db.insert(documentsTable).values(documentRows);

      const foldersRepository = createFoldersRepository({ db });

      return { foldersRepository };
    };

    const listRootDocuments = async (args: SortArgs = {}) => {
      const { foldersRepository } = await setup();

      const { documents } = await foldersRepository.getFolderContents({
        organizationId: 'organization-1',
        folderId: null,
        ...args,
      });

      return documents.map(({ id }) => id);
    };

    test('defaults to case-insensitive ascending name sort scoped to the root level of the organization', async () => {
      expect(await listRootDocuments()).to.eql(['doc-apple', 'doc-banana', 'doc-cherry']);
    });

    test('sorts by document date descending', async () => {
      expect(await listRootDocuments({ sortField: 'documentDate', sortOrder: 'desc' })).to.eql([
        'doc-apple',
        'doc-cherry',
        'doc-banana',
      ]);
    });

    test('sorts by creation date ascending', async () => {
      expect(await listRootDocuments({ sortField: 'createdAt', sortOrder: 'asc' })).to.eql([
        'doc-cherry',
        'doc-banana',
        'doc-apple',
      ]);
    });

    test('lists the direct subfolders and documents of a folder without nested content', async () => {
      const { foldersRepository } = await setup();

      const { folders, documents } = await foldersRepository.getFolderContents({
        organizationId: 'organization-1',
        folderId: 'folder-root-child',
      });

      expect(folders.map(({ id }) => id)).to.eql(['folder-nested']);
      expect(documents.map(({ id }) => id)).to.eql(['doc-in-subfolder']);
    });
  });
});
