import { createPrefixedIdRegex } from '../shared/random/ids.constants.models';

export const folderIdPrefix = 'folder';
export const folderIdRegex = createPrefixedIdRegex({ prefix: folderIdPrefix });

// Mirrors tags.constants-style limits; keeps a self-hosted instance from
// accidentally growing an unbounded folder tree per organization.
export const MAX_FOLDERS_PER_ORGANIZATION = 5000;
export const MAX_FOLDER_NAME_LENGTH = 128;
export const MAX_FOLDER_NESTING_DEPTH = 20;

// Fields usable to sort the documents inside a folder listing ("browse" view).
// "tags" is deliberately absent: the flat folder listing does not join tags,
// so tag-based ordering is not available there (unlike full document search).
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
