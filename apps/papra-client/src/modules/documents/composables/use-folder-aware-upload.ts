import type { UploadableFile } from '@/modules/shared/files/upload';
import { createSignal } from 'solid-js';
import {
  containsFolderStructure,
  getFilesFromDataTransfer,
  promptUploadFiles,
  promptUploadFolder,
} from '@/modules/shared/files/upload';
import { resolveUploadFolderStructure } from '@/modules/folders/composables/resolve-upload-folder-structure';
import { useDocumentUpload } from '../components/document-import-status.component';

// Shared by any upload entry point (drop zone, "select folder" button, etc.) that needs to:
// - accept a folder (drag-and-drop or a folder picker),
// - ask the person whether the folder structure should be recreated as real folders,
// - resolve/create those folders once, and
// - kick off the upload with the right folderId attached to each file.
export function useFolderAwareUpload({
  organizationId,
  rootFolderId,
}: {
  organizationId: string;
  rootFolderId: () => string | null;
}) {
  const { uploadDocuments } = useDocumentUpload();
  const [getRecreateFolderStructure, setRecreateFolderStructure] = createSignal(true);
  const [getPendingFiles, setPendingFiles] = createSignal<UploadableFile[] | null>(null);

  const uploadResolvedFiles = async ({
    files,
    recreateFolderStructure,
  }: {
    files: UploadableFile[];
    recreateFolderStructure: boolean;
  }) => {
    if (!recreateFolderStructure || !containsFolderStructure(files)) {
      await uploadDocuments({
        files: files.map(({ file }) => ({ file, folderId: rootFolderId() })),
      });
      return;
    }

    const directoryPaths = files
      .map(({ relativePath }) => relativePath.split('/').slice(0, -1).join('/'))
      .filter((path) => path.length > 0);

    const { folderIdsByPath } = await resolveUploadFolderStructure({
      organizationId,
      directoryPaths,
      rootFolderId: rootFolderId(),
    });

    await uploadDocuments({
      files: files.map(({ file, relativePath }) => {
        const directoryPath = relativePath.split('/').slice(0, -1).join('/');
        const folderId = directoryPath
          ? (folderIdsByPath.get(directoryPath) ?? rootFolderId())
          : rootFolderId();
        return { file, folderId };
      }),
    });
  };

  const startUpload = async (files: UploadableFile[]) => {
    if (containsFolderStructure(files)) {
      // Ask whether to recreate the folder structure before creating anything.
      setPendingFiles(files);
      return;
    }

    await uploadResolvedFiles({ files, recreateFolderStructure: false });
  };

  return {
    hasPendingFolderConfirmation: () => getPendingFiles() !== null,
    getPendingFileCount: () => getPendingFiles()?.length ?? 0,
    getRecreateFolderStructure,
    setRecreateFolderStructure,
    cancelPendingUpload: () => setPendingFiles(null),
    confirmPendingUpload: async () => {
      const files = getPendingFiles();
      if (!files) {
        return;
      }
      setPendingFiles(null);
      await uploadResolvedFiles({ files, recreateFolderStructure: getRecreateFolderStructure() });
    },
    promptFiles: async () => {
      const { files } = await promptUploadFiles();
      await startUpload(files.map((file) => ({ file, relativePath: '' })));
    },
    promptFolder: async () => {
      const { files } = await promptUploadFolder();
      await startUpload(files);
    },
    handleDrop: async (dataTransfer: DataTransfer) => {
      const { files } = await getFilesFromDataTransfer(dataTransfer);
      await startUpload(files);
    },
  };
}
