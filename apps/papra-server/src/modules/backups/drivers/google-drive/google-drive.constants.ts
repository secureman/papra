export const GOOGLE_DRIVE_UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files';
export const GOOGLE_DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
export const GOOGLE_DRIVE_OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_DRIVE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_DRIVE_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo';

// `drive.file` only lets the app see files/folders IT created — Papra never sees
// the rest of the user's Drive.
export const GOOGLE_DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
];

export const GOOGLE_DRIVE_DEFAULT_FOLDER_NAME = 'Papra Backups';
export const GOOGLE_DRIVE_BACKUP_FILE_MIME_TYPE = 'application/octet-stream';

// A stuck connection with no timeout at all just hangs the whole restore job
// forever with zero feedback — better to fail loudly after a generous window
// than sit there indistinguishable from "still working".
export const GOOGLE_DRIVE_REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;

// Shorter timeout for the OAuth token endpoint: a hung token request blocks
// the whole backup run (refresh happens before anything else), and 10 minutes
// of silence is indistinguishable from "still working" — fail after 30s so the
// run gets marked failed with a real message instead of hanging in "pending".
export const GOOGLE_DRIVE_OAUTH_REQUEST_TIMEOUT_MS = 30 * 1_000;
