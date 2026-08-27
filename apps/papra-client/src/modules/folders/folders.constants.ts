// Sort options for the folder browse view (the "files" listing inside a folder).
// Mirrors the server whitelist in apps/papra-server/.../folders/folders.constants.ts.
// Note: unlike full document search, tags are not sortable in this flat listing.
export const FOLDER_CONTENTS_SORT_FIELDS = [
  'name',
  'documentDate',
  'createdAt',
  'updatedAt',
] as const;
export type FolderContentsSortField = (typeof FOLDER_CONTENTS_SORT_FIELDS)[number];

export const FOLDER_CONTENTS_SORT_ORDERS = ['asc', 'desc'] as const;
export type FolderContentsSortOrder = (typeof FOLDER_CONTENTS_SORT_ORDERS)[number];

export const DEFAULT_FOLDER_CONTENTS_SORT_FIELD: FolderContentsSortField = 'name';
export const DEFAULT_FOLDER_CONTENTS_SORT_ORDER: FolderContentsSortOrder = 'asc';
