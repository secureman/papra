import type { Config } from '../../../config/config.types';
import { createLogger } from '../../../shared/logger/logger';
import {
  createBackupDriverNotConfiguredError,
  createBackupDriverOAuthError,
} from '../../backups.errors';
import {
  GOOGLE_DRIVE_AUTH_ENDPOINT,
  GOOGLE_DRIVE_OAUTH_REQUEST_TIMEOUT_MS,
  GOOGLE_DRIVE_OAUTH_TOKEN_ENDPOINT,
  GOOGLE_DRIVE_SCOPES,
  GOOGLE_DRIVE_USERINFO_ENDPOINT,
} from './google-drive.constants';

// Hand-rolled OAuth2 helper (no `googleapis` dep — we only need 3 endpoints).

const logger = createLogger({ namespace: 'backups:drivers:google-drive:oauth' });

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string; // only present on the initial exchange (prompt=consent)
  token_type: string;
  scope: string;
};

export function createGoogleDriveOAuthService({ config }: { config: Config }) {
  const { oauthClientId, oauthClientSecret, oauthRedirectUri } = config.backups.googleDrive;

  if (!oauthClientId || !oauthClientSecret) {
    throw createBackupDriverNotConfiguredError();
  }

  const getRedirectUri = (): string => {
    if (oauthRedirectUri) {
      return oauthRedirectUri;
    }
    const base = (config.appBaseUrl ?? config.server.baseUrl).replace(/\/+$/, '');
    return `${base}/api/backups/google-drive/callback`;
  };

  // POSTs to Google's token endpoint with a timeout. Google's real error
  // (e.g. `invalid_grant`) is the only thing that explains why a backup run
  // failed — the generic "OAuth handshake failed" message tells the user
  // nothing actionable, so the actual `error`/`error_description` from the
  // response body is surfaced in the thrown error (and lands on the failed
  // run's errorMessage) instead of being discarded.
  async function postTokenEndpoint({
    params,
  }: {
    params: Record<string, string>;
  }): Promise<TokenResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GOOGLE_DRIVE_OAUTH_REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(GOOGLE_DRIVE_OAUTH_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
        signal: controller.signal,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to reach the Google OAuth token endpoint');
      throw createBackupDriverOAuthError({
        message:
          "Could not reach the Google OAuth endpoint. Check the server's internet connection " +
          'and try again. If this persists, reconnect the destination from the web app.',
        cause: error,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const parsed = parseTokenErrorBody(body);
      logger.error(
        { status: response.status, body: body.slice(0, 500) },
        'Google OAuth token request rejected',
      );
      const googleError = parsed?.error;
      const googleDescription = parsed?.error_description;
      throw createBackupDriverOAuthError({
        message: googleError
          ? `Google Drive OAuth failed (${response.status}): ${googleError}` +
            (googleDescription ? ` — ${googleDescription}` : '') +
            '. Reconnect the destination from the web app.'
          : `Google Drive OAuth failed (${response.status}). Reconnect the destination from the web app.`,
        cause: new Error(body.slice(0, 1000)),
      });
    }

    return (await response.json()) as TokenResponse;
  }

  return {
    buildAuthorizationUrl({ state }: { state: string }): string {
      const params = new URLSearchParams({
        client_id: oauthClientId,
        redirect_uri: getRedirectUri(),
        response_type: 'code',
        scope: GOOGLE_DRIVE_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
      });
      return `${GOOGLE_DRIVE_AUTH_ENDPOINT}?${params.toString()}`;
    },

    async exchangeCodeForTokens({ code }: { code: string }): Promise<TokenResponse> {
      return postTokenEndpoint({
        params: {
          code,
          client_id: oauthClientId,
          client_secret: oauthClientSecret,
          redirect_uri: getRedirectUri(),
          grant_type: 'authorization_code',
        },
      });
    },

    async refreshAccessToken({ refreshToken }: { refreshToken: string }): Promise<TokenResponse> {
      return postTokenEndpoint({
        params: {
          client_id: oauthClientId,
          client_secret: oauthClientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        },
      });
    },

    async fetchUserEmail({ accessToken }: { accessToken: string }): Promise<string | null> {
      const response = await fetch(GOOGLE_DRIVE_USERINFO_ENDPOINT, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        return null;
      }
      const { email } = (await response.json()) as { email?: string };
      return email ?? null;
    },
  };
}

function parseTokenErrorBody(body: string): { error?: string; error_description?: string } | null {
  try {
    const parsed = JSON.parse(body) as { error?: string; error_description?: string };
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export type GoogleDriveOAuthService = ReturnType<typeof createGoogleDriveOAuthService>;
