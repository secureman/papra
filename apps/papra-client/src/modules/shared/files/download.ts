export function downloadFile({ url, fileName = 'file' }: { url: string; fileName?: string }) {
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
}

// Prefers the File System Access API (lets the person pick an actual folder
// on their machine, like a real "local backup" instead of whatever the
// browser's default downloads folder is) and falls back to a plain anchor
// download when it's unavailable (Firefox, Safari, non-secure contexts).
export async function saveBlobToDisk({
  blob,
  fileName,
}: {
  blob: Blob;
  fileName: string;
}): Promise<{ saved: boolean; cancelled: boolean }> {
  const picker = (window as unknown as {
    showSaveFilePicker?: (options: {
      suggestedName: string;
      types?: { description: string; accept: Record<string, string[]> }[];
    }) => Promise<{
      createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>;
    }>;
  }).showSaveFilePicker;

  if (picker) {
    try {
      const handle = await picker({
        suggestedName: fileName,
        types: [{ description: 'Papra backup', accept: { 'application/octet-stream': ['.papra-backup'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { saved: true, cancelled: false };
    } catch (error) {
      // AbortError = the person closed the picker without choosing a folder —
      // that's a deliberate cancel, not a failure, so don't fall back to a
      // surprise auto-download they didn't ask for.
      if (error instanceof Error && error.name === 'AbortError') {
        return { saved: false, cancelled: true };
      }
      // Any other error (e.g. permission denied) — fall through to the plain
      // download below rather than losing the backup the server already built.
    }
  }

  const url = URL.createObjectURL(blob);
  downloadFile({ url, fileName });
  URL.revokeObjectURL(url);
  return { saved: true, cancelled: false };
}

export function downloadTextFile({
  content,
  fileName = 'file.txt',
}: {
  content: string;
  fileName?: string;
}) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  downloadFile({ url, fileName });
  URL.revokeObjectURL(url);
}
