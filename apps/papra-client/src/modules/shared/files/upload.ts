export type UploadableFile = {
  file: File;
  // Path of the file relative to the folder the user picked/dropped, e.g. "invoices/2024/jan.pdf".
  // Empty string when the file wasn't part of a folder selection.
  relativePath: string;
};

export async function promptUploadFiles({
  acceptedTypes,
}: {
  acceptedTypes?: string;
} = {}): Promise<{ files: File[] }> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;

    if (acceptedTypes) {
      input.accept = acceptedTypes;
    }

    input.onchange = () => {
      resolve({ files: [...(input.files ?? [])] });
    };

    input.click();
  });
}

export async function promptUploadFolder(): Promise<{ files: UploadableFile[] }> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    // Non-standard but supported by all major browsers (Chrome, Firefox, Safari, Edge)
    // for letting the user pick a whole folder from the native file picker.
    input.webkitdirectory = true;

    input.onchange = () => {
      const files = [...(input.files ?? [])].map((file) => ({
        file,
        // webkitRelativePath looks like "my-folder/sub-folder/file.pdf"
        relativePath: file.webkitRelativePath ?? '',
      }));
      resolve({ files });
    };

    input.click();
  });
}

// Recursively walks a FileSystemDirectoryEntry, resolving every descendant file
// along with its path relative to the dropped root folder.
async function readDirectoryEntry(
  entry: FileSystemDirectoryEntry,
  basePath: string,
): Promise<UploadableFile[]> {
  const reader = entry.createReader();

  // readEntries() only returns a batch at a time (spec quirk), so it must be called
  // repeatedly until it resolves an empty array.
  const readAllEntries = async (): Promise<FileSystemEntry[]> => {
    const entries: FileSystemEntry[] = [];
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
      if (batch.length === 0) {
        break;
      }
      entries.push(...batch);
    }
    return entries;
  };

  const entries = await readAllEntries();

  const results = await Promise.all(
    entries.map(async (childEntry) => {
      const childPath = `${basePath}${childEntry.name}`;

      if (childEntry.isDirectory) {
        return readDirectoryEntry(childEntry as FileSystemDirectoryEntry, `${childPath}/`);
      }

      const file = await new Promise<File>((resolve, reject) => {
        (childEntry as FileSystemFileEntry).file(resolve, reject);
      });

      return [{ file, relativePath: childPath }];
    }),
  );

  return results.flat();
}

// Resolves the files dropped onto a drop zone, walking any dropped folders recursively.
// Falls back to the flat `dataTransfer.files` list when the (non-standard, but universally
// supported) `webkitGetAsEntry` API isn't available.
export async function getFilesFromDataTransfer(
  dataTransfer: DataTransfer,
): Promise<{ files: UploadableFile[] }> {
  const items = dataTransfer.items ? [...dataTransfer.items] : [];
  const canWalkEntries = items.length > 0 && typeof items[0]?.webkitGetAsEntry === 'function';

  if (!canWalkEntries) {
    return {
      files: [...(dataTransfer.files ?? [])].map((file) => ({ file, relativePath: '' })),
    };
  }

  const entries = items
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);

  const results = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory) {
        return readDirectoryEntry(entry as FileSystemDirectoryEntry, `${entry.name}/`);
      }

      const file = await new Promise<File>((resolve, reject) => {
        (entry as FileSystemFileEntry).file(resolve, reject);
      });

      return [{ file, relativePath: '' }];
    }),
  );

  return { files: results.flat() };
}

// True when at least one of the resolved files came from a folder (drag-and-drop or
// folder picker), as opposed to a flat multi-file selection.
export function containsFolderStructure(files: UploadableFile[]): boolean {
  return files.some(({ relativePath }) => relativePath.includes('/'));
}
