import { apiClient } from '../shared/http/api-client';

export type BatchTargetFilter = { documentIds: string[] } | { query: string };

export async function batchTrashDocuments({
  organizationId,
  filter,
}: {
  organizationId: string;
  filter: BatchTargetFilter;
}) {
  await apiClient({
    method: 'POST',
    path: `/api/organizations/${organizationId}/documents/batch/trash`,
    body: { filter },
  });
}

export async function batchUpdateDocumentTags({
  organizationId,
  filter,
  addTagIds,
  removeTagIds,
}: {
  organizationId: string;
  filter: BatchTargetFilter;
  addTagIds?: string[];
  removeTagIds?: string[];
}) {
  await apiClient({
    method: 'POST',
    path: `/api/organizations/${organizationId}/documents/batch/tags`,
    body: { filter, addTagIds, removeTagIds },
  });
}

export async function batchMoveDocuments({
  organizationId,
  filter,
  folderId,
}: {
  organizationId: string;
  filter: BatchTargetFilter;
  folderId: string | null;
}) {
  await apiClient({
    method: 'POST',
    path: `/api/organizations/${organizationId}/documents/batch/move`,
    body: { filter, folderId },
  });
}
