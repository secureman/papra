import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createLocalDeliveryService } from './backups.local-delivery.service';

describe('local delivery service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const envelopeArgs = {
    runId: 'bkrun_1',
    envelope: Buffer.from('backup-bytes'),
    fileName: 'papra-backup.papra-backup',
    organizationId: 'org_1',
    onExpire: () => {},
  };

  describe('holdForDownload / takeReadyDownload', () => {
    test('delivers the envelope once, then nothing (one-shot claim)', () => {
      const service = createLocalDeliveryService();
      service.holdForDownload({ ...envelopeArgs, onExpire: vi.fn() });

      const claimed = service.takeReadyDownload({ runId: 'bkrun_1', organizationId: 'org_1' });
      expect(claimed?.envelope.toString()).toBe('backup-bytes');
      expect(claimed?.fileName).toBe('papra-backup.papra-backup');

      // Second tab / retry can't double-download.
      expect(
        service.takeReadyDownload({ runId: 'bkrun_1', organizationId: 'org_1' }),
      ).toBeUndefined();
    });

    test('refuses claims for a different organization', () => {
      const service = createLocalDeliveryService();
      service.holdForDownload({ ...envelopeArgs, onExpire: vi.fn() });

      expect(
        service.takeReadyDownload({ runId: 'bkrun_1', organizationId: 'org_other' }),
      ).toBeUndefined();

      // The legitimate org can still claim it afterwards.
      expect(
        service.takeReadyDownload({ runId: 'bkrun_1', organizationId: 'org_1' }),
      ).toBeDefined();
    });
  });

  describe('expiry', () => {
    test('fires onExpire and frees the entry after the TTL', () => {
      const onExpire = vi.fn();
      const service = createLocalDeliveryService();
      service.holdForDownload({ ...envelopeArgs, onExpire });

      vi.advanceTimersByTime(10 * 60 * 1000);

      expect(onExpire).toHaveBeenCalledOnce();
      expect(
        service.takeReadyDownload({ runId: 'bkrun_1', organizationId: 'org_1' }),
      ).toBeUndefined();
    });

    test('claiming before the TTL cancels the expiry callback', () => {
      const onExpire = vi.fn();
      const service = createLocalDeliveryService();
      service.holdForDownload({ ...envelopeArgs, onExpire });

      service.takeReadyDownload({ runId: 'bkrun_1', organizationId: 'org_1' });
      vi.advanceTimersByTime(10 * 60 * 1000);

      expect(onExpire).not.toHaveBeenCalled();
    });
  });

  describe('discard', () => {
    test('frees the envelope and cancels the expiry callback', () => {
      const onExpire = vi.fn();
      const service = createLocalDeliveryService();
      service.holdForDownload({ ...envelopeArgs, onExpire });

      service.discard({ runId: 'bkrun_1' });
      vi.advanceTimersByTime(10 * 60 * 1000);

      expect(onExpire).not.toHaveBeenCalled();
      expect(
        service.takeReadyDownload({ runId: 'bkrun_1', organizationId: 'org_1' }),
      ).toBeUndefined();
    });
  });
});
