import type { Folder } from '../folders.types';
import { createFolder, fetchOrganizationFolders } from '../folders.services';

// Given a set of directory paths like "invoices/2024/scans", finds or creates the
// matching nested folders on the server (reusing existing folders where names already
// match) and returns a map from directory path -> folderId, so callers can attach
// each uploaded file to the right destination folder.
export async function resolveUploadFolderStructure({
  organizationId,
  directoryPaths,
  rootFolderId = null,
}: {
  organizationId: string;
  directoryPaths: string[];
  rootFolderId?: string | null;
}): Promise<{ folderIdsByPath: Map<string, string> }> {
  const { folders: existingFolders } = await fetchOrganizationFolders({ organizationId });

  // Key: `${parentId ?? 'root'}::${normalized name}` -> folder, so we can reuse a folder
  // that already exists with the same name under the same parent instead of creating a duplicate.
  const byParentAndName = new Map<string, Folder>();
  for (const folder of existingFolders) {
    byParentAndName.set(makeKey(folder.parentId, folder.name), folder);
  }

  const folderIdsByPath = new Map<string, string>();

  // Sort so parent directories are always resolved before their children.
  const sortedPaths = [...new Set(directoryPaths)].sort(
    (a, b) => a.split('/').length - b.split('/').length,
  );

  for (const path of sortedPaths) {
    const segments = path.split('/').filter(Boolean);
    let parentId = rootFolderId;
    let currentPath = '';

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;

      const cached = folderIdsByPath.get(currentPath);
      if (cached) {
        parentId = cached;
        continue;
      }

      const existing = byParentAndName.get(makeKey(parentId, segment));

      if (existing) {
        folderIdsByPath.set(currentPath, existing.id);
        parentId = existing.id;
        continue;
      }

      const { folder } = await createFolder({ organizationId, name: segment, parentId });
      byParentAndName.set(makeKey(parentId, segment), folder);
      folderIdsByPath.set(currentPath, folder.id);
      parentId = folder.id;
    }
  }

  return { folderIdsByPath };
}

function makeKey(parentId: string | null, name: string) {
  return `${parentId ?? 'root'}::${name.trim().toLowerCase()}`;
}
