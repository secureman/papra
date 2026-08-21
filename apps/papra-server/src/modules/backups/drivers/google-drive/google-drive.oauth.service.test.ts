import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Config } from '../../../config/config.types';
import {
  createGoogleDriveOAuthService,
} from './google-drive.oauth.service';
import type { GoogleDriveOAuthService } from './google-drive.oauth.service';
import { GOOGLE_DRIVE_OAUTH_TOKEN_ENDPOINT } from './google-drive.constants';

function createService(overrides: Partial<Config> = {}): GoogleDriveOAuthService {
  return createGoogleDriveOAuthService({
    config: {
      appBaseUrl: 'http://localhost:1221',
      backups: {
        googleDrive: {
          oauthClientId: 'client-id',
          oauthClientSecret: 'client-secret',
        },
      },
      ...overrides,
    } as Config,
  });
}

function createResponse({
  ok,
  status,
  body,
}: {
  ok: boolean;
  status: number;
  body: object | string;
}): Response {
  return {
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  } as Response;
}

describe('google drive oauth service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('refreshAccessToken', () => {
    test('returns the refreshed tokens on success', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        createResponse({
          ok: true,
          status: 200,
          body: { access_token: 'at', expires_in: 3600, token_type: 'Bearer', scope: 'drive.file' },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const tokens = await createService().refreshAccessToken({ refreshToken: 'rt' });

      expect(tokens.access_token).toBe('at');
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(GOOGLE_DRIVE_OAUTH_TOKEN_ENDPOINT);
      expect(String(init?.body)).toContain('refresh_token=rt');
      expect(String(init?.body)).toContain('grant_type=refresh_token');
      // Every token request must carry a timeout signal so a blocked network
      // cannot leave a backup run stuck in "pending" forever.
      expect((init as RequestInit | undefined)?.signal).toBeDefined();
    });

    test('surfaces Google error and description when the token is rejected', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          createResponse({
            ok: false,
            status: 400,
            body: {
              error: 'invalid_grant',
              error_description: 'Token has been expired or revoked.',
            },
          }),
        ),
      );

      await expect(
        createService().refreshAccessToken({ refreshToken: 'rt' }),
      ).rejects.toThrowError(/invalid_grant/);
      await expect(
        createService().refreshAccessToken({ refreshToken: 'rt' }),
      ).rejects.toThrowError(/Token has been expired or revoked/);
      await expect(
        createService().refreshAccessToken({ refreshToken: 'rt' }),
      ).rejects.toThrowError(/reconnect/i);
    });

    test('includes the HTTP status when the body is not JSON', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          createResponse({ ok: false, status: 502, body: '<html>proxy error</html>' }),
        ),
      );

      await expect(
        createService().refreshAccessToken({ refreshToken: 'rt' }),
      ).rejects.toThrowError(/502/);
    });

    test('fails loudly when the token endpoint is unreachable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('fetch failed (network unreachable)')),
      );

      await expect(
        createService().refreshAccessToken({ refreshToken: 'rt' }),
      ).rejects.toThrowError(/could not reach/i);
    });
  });

  describe('exchangeCodeForTokens', () => {
    test('surfaces Google error and description when the exchange is rejected', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          createResponse({
            ok: false,
            status: 400,
            body: {
              error: 'redirect_uri_mismatch',
              error_description: 'The redirect URI in the request does not match.',
            },
          }),
        ),
      );

      await expect(createService().exchangeCodeForTokens({ code: 'code' })).rejects.toThrowError(
        /redirect_uri_mismatch/,
      );
      await expect(createService().exchangeCodeForTokens({ code: 'code' })).rejects.toThrowError(
        /reconnect/i,
      );
    });
  });
});