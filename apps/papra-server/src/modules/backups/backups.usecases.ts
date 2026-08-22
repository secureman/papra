import type { Readable } from 'node:stream';
import type { Config } from '../config/config.types';
import type { DocumentsRepository } from '../documents/documents.repository';
import type { DocumentUsecaseDependencies } from '../documents/documents.usecases';
import type { FoldersRepository } from '../folders/folders.repository';
import type { Logger } from '../shared/logger/logger';
import type { BackupsRepository } from './backups.repository';
import type { BackupsServices } from './backups.services';
import type { BackupRunTrigger, BackupSchedule } from './backups.types';
import { Readable as NodeReadable } from 'node:stream';
import { createDocumentActivityRepository } from '../documents/document-activity/document-activity.repository';
import { createDocumentCreationUsecase, restoreDocument } from '../documents/documents.usecases';
import { createFoldersRepository } from '../folders/folders.repository';
import { createFolder as createFolderUsecase } from '../folders/folders.usecases';
import { createLogger } from '../shared/logger/logger';
import { generateId } from '../shared/random/ids';
import { addTagToDocument as addTagToDocumentUsecase } from '../tags/tags.usecases';
import { createTagsRepository } from '../tags/tags.repository';
import { computeNextScheduledAt, parseScheduleDays } from './backups.models';
import {
  backupRestoreJobIdPrefix,
  BACKUP_FILE_EXTENSION,
  BACKUP_FILE_MIME_TYPE,
  BACKUP_PROGRESS_PERSIST_INTERVAL_MS,
  RESTORE_PROGRESS_PERSIST_INTERVAL_MS,
  STALE_IN_PROGRESS_RESTORE_JOB_TIMEOUT_MS,
  STALE_IN_PROGRESS_RUN_TIMEOUT_MS,
  STALE_READY_FOR_DOWNLOAD_RUN_TIMEOUT_MS,
} from './backups.constants';
import {
  packBackupEnvelope,
  unpackBackupEnvelope,
  unwrapCredentials,
  wrapCredentials,
} from './backups.encryption.service';
import {
  createBackupAlreadyInProgressError,
  createBackupDestinationNotFoundError,
  createBackupLocalScheduleNotSupportedError,
  createBackupRestoreJobNotFoundError,
  createBackupRunNotFoundError,
  createBackupsNotConfiguredError,
} from './backups.errors';
import type { BackupDriverName } from './drivers/drivers.registry';

const logger = createLogger({ namespace: 'backups:usecases' });

export function assertBackupsConfigured({ config }: { config: Config }): void {
  if (!config.backups.kek) {
    throw createBackupsNotConfiguredError();
  }
}

// ----- Create / test / update / delete a destination -----

export async function testDestinationConnectionUsecase({
  services,
  driver,
  credentials,
  settings,
}: {
  services: BackupsServices;
  driver: BackupDriverName;
  credentials: Record<string, string>;
  settings: Record<string, unknown>;
}): Promise<{ accountLabel?: string }> {
  const backupDriver = services.getDriver(driver);
  return backupDriver.testConnection({ credentials, settings });
}

export async function createDestinationUsecase({
  config,
  services,
  repository,
  organizationId,
  driver,
  displayName,
  credentials,
  settings,
}: {
  config: Config;
  services: BackupsServices;
  repository: BackupsRepository;
  organizationId: string;
  driver: BackupDriverName;
  displayName: string;
  credentials: Record<string, string>;
  settings: Record<string, unknown>;
}): Promise<{ destinationId: string }> {
  assertBackupsConfigured({ config });
  const encryption = services.requireEncryption();

  const { accountLabel } = await testDestinationConnectionUsecase({
    services,
    driver,
    credentials,
    settings,
  });

  const dek = encryption.generateBackupKey();

  const { destination } = await repository.createDestination({
    destination: {
      id: generateId({ prefix: 'bkdst' }),
      organizationId,
      driver,
      displayName,
      settingsJson: JSON.stringify(settings ?? {}),
      encryptedCredentials: wrapCredentials({ encryption, credentials }),
      accountLabel: accountLabel ?? null,
      wrappedBackupKey: encryption.wrapWithKek({ value: dek }),
      backupKeyAlgorithm: encryption.algorithm,
      remoteFolderRef: null,
      isScheduleEnabled: false,
      scheduleDaysJson: '[]',
      scheduleHour: null,
      scheduleMinute: null,
      isEnabled: true,
    },
  });

  return { destinationId: destination.id };
}

export async function listDestinationsUsecase({
  repository,
  organizationId,
}: {
  repository: BackupsRepository;
  organizationId: string;
}) {
  const { destinations } = await repository.listDestinationsByOrganizationId({ organizationId });
  return {
    destinations: destinations.map((d) => ({
      id: d.id,
      driver: d.driver,
      displayName: d.displayName,
      settings: JSON.parse(d.settingsJson) as Record<string, unknown>,
      accountLabel: d.accountLabel,
      isEnabled: d.isEnabled,
      schedule: {
        isEnabled: d.isScheduleEnabled,
        days: parseScheduleDays(d.scheduleDaysJson),
        hour: d.scheduleHour,
        minute: d.scheduleMinute,
      } satisfies BackupSchedule,
      lastRunAt: d.lastRunAt,
      nextScheduledAt: d.nextScheduledAt,
      createdAt: d.createdAt,
    })),
  };
}

export async function updateDestinationScheduleUsecase({
  repository,
  organizationId,
  destinationId,
  schedule,
}: {
  repository: BackupsRepository;
  organizationId: string;
  destinationId: string;
  schedule: BackupSchedule;
}): Promise<{ nextScheduledAt: Date | null }> {
  const { destination } = await repository.getDestinationById({ destinationId, organizationId });
  if (!destination) {
    throw createBackupDestinationNotFoundError();
  }

  if (schedule.isEnabled && destination.driver === 'local') {
    throw createBackupLocalScheduleNotSupportedError();
  }

  const nextScheduledAt = computeNextScheduledAt({ schedule, from: new Date() });

  await repository.updateDestination({
    destinationId,
    fields: {
      isScheduleEnabled: schedule.isEnabled,
      scheduleDaysJson: JSON.stringify(schedule.days),
      scheduleHour: schedule.hour,
      scheduleMinute: schedule.minute,
      nextScheduledAt,
    },
  });

  return { nextScheduledAt };
}

export async function renameDestinationUsecase({
  repository,
  organizationId,
  destinationId,
  displayName,
}: {
  repository: BackupsRepository;
  organizationId: string;
  destinationId: string;
  displayName: string;
}): Promise<void> {
  const { destination } = await repository.getDestinationById({ destinationId, organizationId });
  if (!destination) {
    throw createBackupDestinationNotFoundError();
  }
  await repository.updateDestination({ destinationId, fields: { displayName } });
}

export async function deleteDestinationUsecase({
  repository,
  organizationId,
  destinationId,
}: {
  repository: BackupsRepository;
  organizationId: string;
  destinationId: string;
}): Promise<{ deleted: boolean }> {
  const { deleted } = await repository.deleteDestination({ destinationId, organizationId });
  if (!deleted) {
    throw createBackupDestinationNotFoundError();
  }
  return { deleted: true };
}

// ----- List / delete runs -----

export async function listRunsUsecase({
  repository,
  destinationId,
}: {
  repository: BackupsRepository;
  destinationId: string;
}) {
  const { runs } = await repository.listRunsByDestinationId({ destinationId });
  return { runs };
}

// ----- Run a backup -----

export async function runBackupUsecase({
  config,
  services,
  repository,
  documentsRepository,
  globalDeps,
  organizationId,
  destinationId,
  trigger,
  logger: providedLogger = logger,
}: {
  config: Config;
  services: BackupsServices;
  repository: BackupsRepository;
  documentsRepository: DocumentsRepository;
  globalDeps: Pick<
    import('../app/server.types').GlobalDependencies,
    'db' | 'taskServices' | 'documentsStorageService' | 'eventServices'
  >;
  organizationId: string;
  destinationId: string;
  trigger: BackupRunTrigger;
  logger?: Logger;
}): Promise<{ runId: string }> {
  assertBackupsConfigured({ config });
  const encryption = services.requireEncryption();

  const { destination } = await repository.getDestinationById({ destinationId, organizationId });
  if (!destination) {
    throw createBackupDestinationNotFoundError();
  }

  await repository.markStaleInProgressRunsAsFailed({
    destinationId,
    statuses: ['pending', 'packaging', 'uploading'],
    staleBefore: new Date(Date.now() - STALE_IN_PROGRESS_RUN_TIMEOUT_MS),
    errorMessage: 'Backup marked as failed because the previous run did not complete.',
  });

  // Local runs waiting to be claimed keep their envelope in memory only — if
  // the server restarted, that envelope is gone forever and nothing will ever
  // transition the row again. Reap them just past the client-side download TTL
  // so they don't sit at ready_for_download forever (which also keeps the
  // destination's "Run now" button disabled in the UI).
  await repository.markStaleInProgressRunsAsFailed({
    destinationId,
    statuses: ['ready_for_download'],
    staleBefore: new Date(Date.now() - STALE_READY_FOR_DOWNLOAD_RUN_TIMEOUT_MS),
    errorMessage: 'Backup was ready but never downloaded — open the backups page and run it again.',
  });

  // The insert itself is the concurrency guard: the partial unique index on
  // (destination_id) WHERE status IN ('pending','uploading') turns a second
  // simultaneous insert into a no-op, so there's no check-then-insert race.
  const { run } = await repository.createRun({
    run: {
      id: generateId({ prefix: 'bkrun' }),
      destinationId,
      organizationId,
      trigger,
      status: 'pending',
    },
  });

  if (!run) {
    throw createBackupAlreadyInProgressError();
  }

  // Fire and forget: the route returns immediately, the client polls run history.
  void runBackupPipeline({
    config,
    repository,
    documentsRepository,
    documentsStorageService: globalDeps.documentsStorageService,
    db: globalDeps.db,
    services,
    encryption,
    organizationId,
    destinationId,
    runId: run.id,
    logger: providedLogger,
  });

  return { runId: run.id };
}

// Builds the manifest embedded in every backup archive. Beyond basic document
// fields, this captures each document's tags (by name/color, not id — ids won't
// exist yet on a fresh install) and its full folder path (root-to-leaf names,
// same reasoning: recreate by name, don't depend on the original folder id
// still existing).
async function buildBackupManifest({
  organizationId,
  docs,
  db,
}: {
  organizationId: string;
  docs: Awaited<
    ReturnType<DocumentsRepository['getAllOrganizationUndeletedDocumentsForBackup']>
  >['documents'];
  db: import('../app/database/database.types').Database;
}) {
  const tagsRepository = createTagsRepository({ db });
  const foldersRepository = createFoldersRepository({ db });

  const { tagsByDocumentId } = await tagsRepository.getTagsByDocumentIds({
    documentIds: docs.map((d) => d.id),
  });
  const { folders } = await foldersRepository.getOrganizationFolders({ organizationId });
  const foldersById = new Map(folders.map((f) => [f.id, f]));

  function computeFolderPath(folderId: string | null): string[] | null {
    if (!folderId) {
      return null;
    }
    const path: string[] = [];
    let current = foldersById.get(folderId);
    const seen = new Set<string>(); // guard against any accidental cycle
    while (current && !seen.has(current.id)) {
      path.unshift(current.name);
      seen.add(current.id);
      current = current.parentId ? foldersById.get(current.parentId) : undefined;
    }
    return path.length > 0 ? path : null;
  }

  return {
    schemaVersion: 2,
    organizationId,
    createdAt: new Date().toISOString(),
    documents: docs.map((d) => ({
      id: d.id,
      name: d.name,
      originalName: d.originalName,
      mimeType: d.mimeType,
      originalSize: d.originalSize,
      originalSha256Hash: d.originalSha256Hash,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      documentDate: d.documentDate,
      notes: d.notes,
      folderId: d.folderId,
      folderPath: computeFolderPath(d.folderId),
      tags: (tagsByDocumentId[d.id] ?? []).map((t) => ({
        name: t.name,
        color: t.color,
        description: t.description,
      })),
    })),
  };
}

// Everything from "fetch the org's documents" through "produce an encrypted,
// self-contained envelope" — shared by destination-based backups and by a
// direct "download a backup copy" with no destination involved at all.
async function buildEncryptedBackupEnvelope({
  organizationId,
  documentsRepository,
  documentsStorageService,
  services,
  encryption,
  dek,
  db,
  logger,
  onStart,
  onProgress,
}: {
  organizationId: string;
  documentsRepository: DocumentsRepository;
  documentsStorageService: import('../documents/storage/documents.storage.services').DocumentStorageService;
  services: BackupsServices;
  encryption: NonNullable<BackupsServices['encryption']>;
  dek: Buffer;
  db: import('../app/database/database.types').Database;
  logger: Logger;
  // Fired once, right after the document list + sizes are known, before any
  // file is actually read — lets the caller persist real totals immediately
  // instead of the run sitting at "pending" with no numbers for however long
  // the fetch-and-tar loop below takes.
  onStart?: (args: { documentsCount: number; totalRawBytes: number }) => void | Promise<void>;
  // Fired after each document is read (successfully or not — skipped docs
  // still count toward "processed" so the bar keeps moving and reaches 100%).
  onProgress?: (args: {
    processedDocumentsCount: number;
    processedBytes: number;
  }) => void | Promise<void>;
}): Promise<{ envelope: Buffer; documentsCount: number }> {
  const { documents: docs } =
    await documentsRepository.getAllOrganizationUndeletedDocumentsForBackup({ organizationId });

  const totalRawBytes = docs.reduce((sum, d) => sum + (d.originalSize ?? 0), 0);
  await onStart?.({ documentsCount: docs.length, totalRawBytes });

  const files: { name: string; content: Buffer }[] = [];
  let processedBytes = 0;

  for (const [index, doc] of docs.entries()) {
    try {
      const { fileStream } = await documentsStorageService.getFileStream({
        storageKey: doc.originalStorageKey,
        fileEncryptionAlgorithm: doc.fileEncryptionAlgorithm,
        fileEncryptionKekVersion: doc.fileEncryptionKekVersion,
        fileEncryptionKeyWrapped: doc.fileEncryptionKeyWrapped,
      });
      const chunks: Buffer[] = [];
      for await (const chunk of fileStream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const content = Buffer.concat(chunks);
      files.push({
        name: `${doc.id}-${doc.originalName.replace(/[^\w.-]/g, '_')}`,
        content,
      });
      processedBytes += content.length;
    } catch (error) {
      logger.error({ error, documentId: doc.id }, 'Failed to fetch document for backup; skipping');
      // Still count the (unread) doc's expected size so the bar doesn't stall
      // short of 100% just because one document failed to fetch.
      processedBytes += doc.originalSize ?? 0;
    }
    await onProgress?.({ processedDocumentsCount: index + 1, processedBytes });
  }

  const manifest = await buildBackupManifest({ organizationId, docs, db });

  const archive = await services.packager.pack({ manifest, files });
  const encrypted = encryption.encryptPayload({ payload: archive, key: dek });
  const envelope = packBackupEnvelope({
    wrappedKey: encryption.wrapWithKek({ value: dek }),
    encryptedPayload: encrypted,
  });

  return { envelope, documentsCount: docs.length };
}

// Mirrors createRestoreProgressReporter below: wires the packaging/upload
// callbacks in buildEncryptedBackupEnvelope + driver.uploadFile onto the run
// row, throttled, so the client's poll actually gets a moving percentage
// instead of a status word that sits still for however long each phase takes.
function createBackupProgressReporter({
  repository,
  runId,
}: {
  repository: BackupsRepository;
  runId: string;
}) {
  let lastPackagingPersistedAt = 0;
  let lastUploadPersistedAt = 0;
  // Progress only ever moves forward — persisting an older value after a newer
  // one (async writes can complete out of order) makes the client's bar jump
  // backwards, so skip anything that isn't strictly increasing.
  let lastPackagingDocumentsCount = -1;
  let lastUploadedBytes = -1;

  const onPackagingStart = async ({
    documentsCount,
    totalRawBytes,
  }: {
    documentsCount: number;
    totalRawBytes: number;
  }): Promise<void> => {
    await repository.updateRunStatus({
      runId,
      status: 'packaging',
      fields: { documentsCount, totalRawBytes, processedDocumentsCount: 0, processedBytes: 0 },
    });
  };

  const onPackagingProgress = ({
    processedDocumentsCount,
    processedBytes,
  }: {
    processedDocumentsCount: number;
    processedBytes: number;
  }): void => {
    const now = Date.now();
    if (
      processedDocumentsCount <= lastPackagingDocumentsCount ||
      now - lastPackagingPersistedAt < BACKUP_PROGRESS_PERSIST_INTERVAL_MS
    ) {
      return;
    }
    lastPackagingDocumentsCount = processedDocumentsCount;
    lastPackagingPersistedAt = now;
    repository
      .updateRunProgress({ runId, fields: { processedDocumentsCount, processedBytes } })
      .catch((error) =>
        logger.error({ error, runId }, 'Failed to persist backup packaging progress'),
      );
  };

  const onUploadProgress = ({ uploadedBytes }: { uploadedBytes: number }): void => {
    const now = Date.now();
    if (
      uploadedBytes <= lastUploadedBytes ||
      now - lastUploadPersistedAt < BACKUP_PROGRESS_PERSIST_INTERVAL_MS
    ) {
      return;
    }
    lastUploadedBytes = uploadedBytes;
    lastUploadPersistedAt = now;
    repository
      .updateRunProgress({ runId, fields: { uploadedBytes } })
      .catch((error) => logger.error({ error, runId }, 'Failed to persist backup upload progress'));
  };

  return { onPackagingStart, onPackagingProgress, onUploadProgress };
}

async function runBackupPipeline({
  repository,
  documentsRepository,
  documentsStorageService,
  db,
  services,
  encryption,
  organizationId,
  destinationId,
  runId,
  logger,
}: {
  config: Config;
  repository: BackupsRepository;
  documentsRepository: DocumentsRepository;
  documentsStorageService: import('../documents/storage/documents.storage.services').DocumentStorageService;
  db: import('../app/database/database.types').Database;
  services: BackupsServices;
  encryption: NonNullable<BackupsServices['encryption']>;
  organizationId: string;
  destinationId: string;
  runId: string;
  logger: Logger;
}): Promise<void> {
  const { destination } = await repository.getDestinationById({ destinationId, organizationId });
  if (!destination) {
    return;
  }

  const credentials = unwrapCredentials({ encryption, wrapped: destination.encryptedCredentials });
  const dek = encryption.unwrapWithKek({ wrapped: destination.wrappedBackupKey });
  const settings = JSON.parse(destination.settingsJson) as Record<string, unknown>;
  const driver = services.getDriver(destination.driver);
  const isLocalDestination = destination.driver === 'local';
  const progress = createBackupProgressReporter({ repository, runId });

  try {
    const { envelope, documentsCount } = await buildEncryptedBackupEnvelope({
      organizationId,
      documentsRepository,
      documentsStorageService,
      services,
      encryption,
      dek,
      db,
      logger,
      onStart: progress.onPackagingStart,
      onProgress: progress.onPackagingProgress,
    });

    const fileName = `papra-backup-${organizationId.slice(-6)}-${new Date().toISOString().replace(/[:.]/g, '-')}${BACKUP_FILE_EXTENSION}`;

    // Local destinations have nowhere server-side to upload to — hand the
    // envelope to the in-memory delivery service and wait for the client's
    // browser to claim it, instead of calling driver.uploadFile at all.
    if (isLocalDestination) {
      // Register the envelope BEFORE flipping the status. The client polls for
      // status === 'ready_for_download' and immediately hits the download
      // endpoint, so flipping first leaves a race window where a claim 404s
      // because the envelope isn't registered yet.
      services.localDelivery.holdForDownload({
        runId,
        envelope,
        fileName,
        organizationId,
        onExpire: () => {
          repository
            .updateRunStatus({
              runId,
              status: 'failed',
              fields: {
                errorMessage:
                  'Backup was ready but never downloaded — open the backups page and run it again.',
                completedAt: new Date(),
              },
            })
            .catch((updateError) => {
              logger.error(
                { error: updateError, runId },
                'Failed to mark expired local backup run as failed',
              );
            });
        },
      });
      await repository.updateRunStatus({
        runId,
        status: 'ready_for_download',
        fields: { documentsCount, totalSizeBytes: envelope.length },
      });
      logger.info(
        { runId, destinationId, size: envelope.length, documentsCount },
        'Backup ready for client download',
      );
      return;
    }

    await repository.updateRunStatus({
      runId,
      status: 'uploading',
      fields: { documentsCount, totalSizeBytes: envelope.length, uploadedBytes: 0 },
    });

    let folderRef = destination.remoteFolderRef;
    if (!folderRef) {
      const folder = await driver.ensureRemoteFolder({ credentials, settings });
      folderRef = folder.folderRef;
      await repository.updateDestination({ destinationId, fields: { remoteFolderRef: folderRef } });
    }

    const uploaded = await driver.uploadFile({
      credentials,
      settings,
      folderRef,
      fileName,
      mimeType: BACKUP_FILE_MIME_TYPE,
      content: envelope,
      onProgress: progress.onUploadProgress,
    });

    await repository.updateRunStatus({
      runId,
      status: 'succeeded',
      fields: {
        remoteFileId: uploaded.remoteFileId,
        remoteFileName: uploaded.remoteFileName,
        uploadedBytes: envelope.length,
        completedAt: new Date(),
      },
    });
    await repository.updateDestination({ destinationId, fields: { lastRunAt: new Date() } });

    logger.info(
      { runId, destinationId, size: envelope.length, documentsCount },
      'Backup run completed',
    );
  } catch (error) {
    logger.error({ error, runId, destinationId }, 'Backup run failed');
    // The whole pipeline runs fire-and-forget (`void runBackupPipeline(...)`),
    // so a throwing status write here would escape as an unhandled rejection.
    try {
      await repository.updateRunStatus({
        runId,
        status: 'failed',
        fields: {
          errorMessage: (error as Error)?.message?.slice(0, 500) ?? 'Unknown error',
          completedAt: new Date(),
        },
      });
    } catch (updateError) {
      logger.error({ error: updateError, runId }, 'Failed to persist failed status for backup run');
    }
  }
}

// ----- Delete a run (removes the remote file too, best-effort) -----

export async function deleteRunUsecase({
  config,
  services,
  repository,
  organizationId,
  destinationId,
  runId,
}: {
  config: Config;
  services: BackupsServices;
  repository: BackupsRepository;
  organizationId: string;
  destinationId: string;
  runId: string;
}): Promise<{ deleted: boolean }> {
  assertBackupsConfigured({ config });
  const encryption = services.requireEncryption();

  const { run } = await repository.getRunById({ runId, organizationId });
  if (!run) {
    throw createBackupRunNotFoundError();
  }
  if (run.destinationId !== destinationId) {
    throw createBackupRunNotFoundError();
  }

  if (run.remoteFileId) {
    const { destination } = await repository.getDestinationById({ destinationId, organizationId });
    if (destination) {
      try {
        const credentials = unwrapCredentials({
          encryption,
          wrapped: destination.encryptedCredentials,
        });
        const settings = JSON.parse(destination.settingsJson) as Record<string, unknown>;
        const driver = services.getDriver(destination.driver);
        await driver.deleteFile({ credentials, settings, remoteFileId: run.remoteFileId });
      } catch (error) {
        logger.error(
          { error, runId },
          'Failed to delete remote file; removing local record anyway',
        );
      }
    }
  }

  // A local-destination run sitting at 'ready_for_download' still has its
  // envelope held in memory (see backups.local-delivery.service) — free it
  // instead of leaking until the TTL fires.
  if (run.status === 'ready_for_download') {
    services.localDelivery.discard({ runId });
  }

  // Actually delete the run row (restore jobs referencing it get their run_id
  // set to null by the FK). The remote file deletion above is best-effort —
  // the local record is removed regardless.
  const { deleted } = await repository.deleteRun({ runId });
  if (!deleted) {
    throw createBackupRunNotFoundError();
  }
  return { deleted: true };
}

// ----- Restore -----

// Shared core of "restore": given a destination we can already talk to and a
// remote file id, download + decrypt + unpack + re-import. Used both by
// restoreRunUsecase (restoring something we have local history for) and by
// restoreFromRemoteFileUsecase (disaster recovery: local DB is empty/fresh,
// but the backup still exists on the remote destination).
// The actual "unwrap key, decrypt, unpack, re-import" work, independent of
// where the envelope bytes came from. Used both by the driver-based restore
// (destination downloads the file) and by restoring a file the person already
// has in hand and just uploads directly — no destination, no driver, no
// connection to anything at all, just the file + your BACKUPS_KEK.
async function restoreFromEnvelopeUsecase({
  services,
  documentUsecaseDeps,
  documentsRepository,
  foldersRepository,
  organizationId,
  envelope,
  userId,
  onManifestReady,
  onProgress,
}: {
  services: BackupsServices;
  documentUsecaseDeps: import('../app/server.types').GlobalDependencies;
  documentsRepository: DocumentsRepository;
  foldersRepository: FoldersRepository;
  organizationId: string;
  envelope: Buffer;
  userId?: string;
  // Fired once the manifest is unpacked and the real document count is known
  // (before the per-document loop starts) — this is what lets the UI switch
  // from an indeterminate spinner to a real N/total progress bar + ETA.
  onManifestReady?: (args: { totalDocumentsCount: number }) => void | Promise<void>;
  // Fired after each manifest entry is processed (restored, skipped, or failed).
  onProgress?: (args: { processedCount: number; totalCount: number }) => void | Promise<void>;
}): Promise<{
  restoredDocumentsCount: number;
  untrashedDocumentsCount: number;
  skippedDuplicatesCount: number;
  totalDocumentsCount: number;
}> {
  const encryption = services.requireEncryption();

  const { wrappedKey, encryptedPayload } = unpackBackupEnvelope({ envelope });
  const dek = encryption.unwrapWithKek({ wrapped: wrappedKey });

  const archive = encryption.decryptPayload({ encryptedPayload, key: dek });
  const { manifest, files: unpackedFiles } = await services.packager.unpack({ archive });

  const manifestDocs = (
    manifest as {
      documents: {
        id: string;
        originalName: string;
        mimeType: string;
        originalSha256Hash: string;
        createdAt?: string | Date;
        documentDate?: string | Date | null;
        notes?: string | null;
        folderId: string | null;
        folderPath?: string[] | null;
        tags?: { name: string; color: string; description?: string | null }[];
      }[];
    }
  ).documents;

  await onManifestReady?.({ totalDocumentsCount: manifestDocs.length });

  const createDocument = createDocumentCreationUsecase({ ...documentUsecaseDeps });
  const tagsRepository = createTagsRepository({ db: documentUsecaseDeps.db });
  const documentActivityRepository = createDocumentActivityRepository({
    db: documentUsecaseDeps.db,
  });

  // ----- Folder resolution: prefer the original id if it still exists (fast,
  // common case for a same-install restore); otherwise recreate the folder
  // path by name (the fresh-install / "folder got deleted" case). Memoized so
  // many documents sharing a folder only create it once per run. -----
  const folderIdExistsCache = new Map<string, boolean>();
  const folderPathCache = new Map<string, string>(); // key: `${parentId ?? 'root'}::${name}` -> folder id

  async function resolveOrRecreateFolderId(entry: {
    folderId: string | null;
    folderPath?: string[] | null;
  }): Promise<string | undefined> {
    if (entry.folderId) {
      if (!folderIdExistsCache.has(entry.folderId)) {
        const { folder } = await foldersRepository.getFolderById({
          folderId: entry.folderId,
          organizationId,
        });
        folderIdExistsCache.set(entry.folderId, Boolean(folder));
      }
      if (folderIdExistsCache.get(entry.folderId)) {
        return entry.folderId;
      }
    }

    if (!entry.folderPath || entry.folderPath.length === 0) {
      return undefined;
    }

    let parentId: string | undefined;
    for (const name of entry.folderPath) {
      const cacheKey = `${parentId ?? 'root'}::${name}`;
      let folderId = folderPathCache.get(cacheKey);

      if (!folderId) {
        const { folders: siblings } = await foldersRepository.getChildFolders({
          organizationId,
          parentId: parentId ?? null,
        });
        const existingFolder = siblings.find((f) => f.name === name);
        if (existingFolder) {
          folderId = existingFolder.id;
        } else {
          try {
            const { folder } = await createFolderUsecase({
              organizationId,
              name,
              parentId,
              foldersRepository,
            });
            folderId = folder!.id;
          } catch (error) {
            logger.error(
              { error, name, parentId },
              'Failed to recreate folder during restore; falling back to its parent',
            );
            break;
          }
        }
        folderPathCache.set(cacheKey, folderId);
      }
      parentId = folderId;
    }

    return parentId;
  }

  // ----- Tag resolution: match by name within the org, create if missing. -----
  const { tags: existingOrgTags } = await tagsRepository.getOrganizationTags({ organizationId });
  const tagIdByName = new Map<string, string>(existingOrgTags.map((t) => [t.name, t.id]));

  async function resolveTagId(tag: {
    name: string;
    color: string;
    description?: string | null;
  }): Promise<string | undefined> {
    const existingId = tagIdByName.get(tag.name);
    if (existingId) {
      return existingId;
    }
    try {
      const { tag: created } = await tagsRepository.createTag({
        tag: {
          organizationId,
          name: tag.name,
          color: tag.color,
          description: tag.description ?? undefined,
        },
      });
      tagIdByName.set(tag.name, created!.id);
      return created!.id;
    } catch (error) {
      // Another entry in this same restore run may have created it a moment
      // ago (race within this loop is unlikely since we're sequential, but a
      // concurrent request isn't impossible) — re-check before giving up.
      const { tags: refreshed } = await tagsRepository.getOrganizationTags({ organizationId });
      const match = refreshed.find((t) => t.name === tag.name);
      if (match) {
        tagIdByName.set(tag.name, match.id);
        return match.id;
      }
      logger.error(
        { error, tagName: tag.name },
        'Failed to resolve/create tag during restore; skipping this tag',
      );
      return undefined;
    }
  }

  async function applyTagsToDocument({
    documentId,
    tags = [],
  }: {
    documentId: string;
    tags?: { name: string; color: string; description?: string | null }[];
  }): Promise<void> {
    if (tags.length === 0) {
      return;
    }
    const { tagsByDocumentId } = await tagsRepository.getTagsByDocumentIds({
      documentIds: [documentId],
    });
    const alreadyAttached = new Set((tagsByDocumentId[documentId] ?? []).map((t) => t.id));

    for (const tag of tags) {
      const tagId = await resolveTagId(tag);
      if (!tagId || alreadyAttached.has(tagId)) {
        continue;
      }
      try {
        await addTagToDocumentUsecase({
          tagId,
          documentId,
          organizationId,
          userId,
          tag: { ...tag, id: tagId, organizationId } as Parameters<
            typeof addTagToDocumentUsecase
          >[0]['tag'],
          tagsRepository,
          webhookTriggerServices: documentUsecaseDeps.webhookTriggerServices,
          documentActivityRepository,
        });
      } catch (error) {
        logger.error(
          { error, documentId, tagName: tag.name },
          'Failed to attach tag to restored document; skipping this tag',
        );
      }
    }
  }

  async function applyMetadata({
    documentId,
    entry,
  }: {
    documentId: string;
    entry: (typeof manifestDocs)[number];
  }): Promise<void> {
    try {
      await documentsRepository.updateDocument({
        documentId,
        organizationId,
        documentDate: entry.documentDate ? new Date(entry.documentDate) : undefined,
        notes: entry.notes ?? undefined,
        createdAt: entry.createdAt ? new Date(entry.createdAt) : undefined,
      });
    } catch (error) {
      logger.error(
        { error, documentId },
        'Failed to restore document metadata (date/notes); document content is still intact',
      );
    }
  }

  let restoredCount = 0;
  let untrashedCount = 0;
  let skippedCount = 0;
  let processedCount = 0;

  for (const entry of manifestDocs) {
    // Reported regardless of how this entry turns out (restored, skipped,
    // untrashed, missing file, or failed) — it tracks loop progress for the
    // ETA, not restore outcomes.
    processedCount += 1;
    await onProgress?.({ processedCount, totalCount: manifestDocs.length });

    const matchingFileKey = [...unpackedFiles.keys()].find((name) =>
      name.startsWith(`${entry.id}-`),
    );
    if (!matchingFileKey) {
      continue;
    }
    const content = unpackedFiles.get(matchingFileKey)!;

    // Resolved once per entry, up front, so it's available regardless of
    // which branch below actually runs — restore should put a document back
    // where the backup says it belonged even if the document itself already
    // existed (matched by hash) rather than being freshly created.
    const folderId = await resolveOrRecreateFolderId(entry);

    // On a fresh install this will always be undefined (empty documents table),
    // so every manifest entry goes through createDocument below. On a
    // non-fresh install, this is what makes restore safe to re-run.
    const { document: existing } = await documentsRepository.getOrganizationDocumentBySha256Hash({
      sha256Hash: entry.originalSha256Hash,
      organizationId,
    });

    if (existing) {
      // Soft-deleted (trashed) rows still match by hash — bring those back
      // rather than leaving them stuck in trash while reporting "already there".
      if (existing.isDeleted) {
        try {
          await restoreDocument({
            documentId: existing.id,
            organizationId,
            userId: userId ?? '',
            documentsRepository,
            eventServices: documentUsecaseDeps.eventServices,
          });
          // restoreDocument only undoes the trash — it doesn't know about the
          // backup's folder placement, so that has to be applied separately
          // (moveDocuments requires isDeleted: false, which is why this runs
          // after restoreDocument rather than before it).
          if ((existing.folderId ?? null) !== (folderId ?? null)) {
            await documentsRepository.moveDocuments({
              documentIds: [existing.id],
              organizationId,
              folderId: folderId ?? null,
            });
          }
          await applyMetadata({ documentId: existing.id, entry });
          await applyTagsToDocument({ documentId: existing.id, tags: entry.tags });
          untrashedCount += 1;
        } catch (error) {
          logger.error(
            { error, documentId: existing.id },
            'Failed to untrash document during restore; skipping',
          );
        }
        continue;
      }

      // Already present and active — nothing to restore content-wise, but
      // still worth reconciling folder placement with what the backup
      // recorded (e.g. the document was moved after the backup was taken).
      if ((existing.folderId ?? null) !== (folderId ?? null)) {
        try {
          await documentsRepository.moveDocuments({
            documentIds: [existing.id],
            organizationId,
            folderId: folderId ?? null,
          });
        } catch (error) {
          logger.error(
            { error, documentId: existing.id },
            'Failed to restore folder placement for already-present document',
          );
        }
      }

      skippedCount += 1;
      continue;
    }

    const fileStream: Readable = NodeReadable.from(content);

    try {
      const { document } = await createDocument({
        fileStream,
        fileName: entry.originalName,
        mimeType: entry.mimeType,
        userId,
        organizationId,
        folderId,
      });
      await applyMetadata({ documentId: document.id, entry });
      await applyTagsToDocument({ documentId: document.id, tags: entry.tags });
      restoredCount += 1;
    } catch (error) {
      logger.error(
        { error, documentId: entry.id },
        'Failed to restore document from backup; skipping',
      );
    }
  }

  return {
    restoredDocumentsCount: restoredCount,
    untrashedDocumentsCount: untrashedCount,
    skippedDuplicatesCount: skippedCount,
    totalDocumentsCount: manifestDocs.length,
  };
}

// ----- Background restore job plumbing -----
// A restore run against Google Drive/WebDAV/FTP can easily take longer than a
// typical HTTP request timeout once you count the download plus re-importing
// every document. Rather than holding the request open (and the client having
// to raise its timeout to match), the route creates a job row and returns
// immediately; this reporter wires the restore core's callbacks to persist
// progress onto that row so the client can poll it and show a real ETA.
function createRestoreProgressReporter({
  repository,
  jobId,
}: {
  repository: BackupsRepository;
  jobId: string;
}) {
  let lastPersistedAt = 0;
  let lastPersistedCount = -1;
  let lastDownloadPersistedAt = 0;
  let lastDownloadedBytes = -1;

  const onDownloadStart = async (): Promise<void> => {
    await repository.updateRestoreJob({
      jobId,
      status: 'downloading',
      fields: { startedAt: new Date() },
    });
  };

  const onDownloadProgress = ({
    downloadedBytes,
    totalBytes,
  }: {
    downloadedBytes: number;
    totalBytes: number | null;
  }): void => {
    const now = Date.now();
    if (
      downloadedBytes <= lastDownloadedBytes ||
      now - lastDownloadPersistedAt < RESTORE_PROGRESS_PERSIST_INTERVAL_MS
    ) {
      return;
    }
    lastDownloadedBytes = downloadedBytes;
    lastDownloadPersistedAt = now;
    // Fire-and-forget: this runs inside the driver's streaming read loop,
    // which shouldn't be slowed down waiting on a DB write for a progress
    // update that's inherently best-effort anyway.
    repository
      .updateRestoreJob({ jobId, fields: { downloadedBytes, totalBytes } })
      .catch((error) =>
        logger.error({ error, jobId }, 'Failed to persist restore download progress'),
      );
  };

  const onManifestReady = async ({
    totalDocumentsCount,
  }: {
    totalDocumentsCount: number;
  }): Promise<void> => {
    await repository.updateRestoreJob({
      jobId,
      status: 'restoring',
      // startedAt may already be set (driver-based restore set it at download
      // start) — re-setting it here covers the uploaded-file case, where
      // there's no download phase and this is the first progress write.
      fields: { totalDocumentsCount, startedAt: new Date() },
    });
  };

  const onProgress = async ({
    processedCount,
    totalCount,
  }: {
    processedCount: number;
    totalCount: number;
  }): Promise<void> => {
    const now = Date.now();
    const isLastDocument = processedCount >= totalCount;
    // Throttle DB writes on large restores — the UI only needs to feel live,
    // not see every single document. Always persist the final one though, so
    // the progress bar doesn't visibly stall short of 100%.
    if (!isLastDocument && now - lastPersistedAt < RESTORE_PROGRESS_PERSIST_INTERVAL_MS) {
      return;
    }
    if (processedCount === lastPersistedCount) {
      return;
    }
    lastPersistedAt = now;
    lastPersistedCount = processedCount;
    await repository.updateRestoreJob({
      jobId,
      fields: { processedDocumentsCount: processedCount },
    });
  };

  return { onDownloadStart, onDownloadProgress, onManifestReady, onProgress };
}

type RestoreOutcome = {
  restoredDocumentsCount: number;
  untrashedDocumentsCount: number;
  skippedDuplicatesCount: number;
  totalDocumentsCount: number;
};

// Fire-and-forget: runs `execute` (whichever restore flavor the caller needs),
// wiring progress into the job row and settling it to succeeded/failed. Never
// throws — errors are captured onto the job row instead, since there is no
// HTTP response left to send by the time this runs.
async function runRestoreJobPipeline({
  repository,
  jobId,
  logger: providedLogger = logger,
  execute,
}: {
  repository: BackupsRepository;
  jobId: string;
  logger?: Logger;
  execute: (reporter: ReturnType<typeof createRestoreProgressReporter>) => Promise<RestoreOutcome>;
}): Promise<void> {
  const reporter = createRestoreProgressReporter({ repository, jobId });

  try {
    const result = await execute(reporter);

    await repository.updateRestoreJob({
      jobId,
      status: 'succeeded',
      fields: {
        restoredDocumentsCount: result.restoredDocumentsCount,
        untrashedDocumentsCount: result.untrashedDocumentsCount,
        skippedDuplicatesCount: result.skippedDuplicatesCount,
        totalDocumentsCount: result.totalDocumentsCount,
        processedDocumentsCount: result.totalDocumentsCount,
        completedAt: new Date(),
      },
    });

    providedLogger.info({ jobId, ...result }, 'Restore job completed');
  } catch (error) {
    providedLogger.error({ error, jobId }, 'Restore job failed');
    // Same fire-and-forget exposure as the backup pipeline: a throwing write
    // here must never escape as an unhandled rejection.
    try {
      await repository.updateRestoreJob({
        jobId,
        status: 'failed',
        fields: {
          errorMessage: (error as Error)?.message?.slice(0, 500) ?? 'Unknown error',
          completedAt: new Date(),
        },
      });
    } catch (updateError) {
      providedLogger.error(
        { error: updateError, jobId },
        'Failed to persist failed status for restore job',
      );
    }
  }
}

// Driver-based restore: destination downloads the envelope file, then hands off
// to the shared core above.
async function restoreArchiveUsecase({
  services,
  documentUsecaseDeps,
  documentsRepository,
  foldersRepository,
  organizationId,
  destination,
  remoteFileId,
  userId,
  onDownloadStart,
  onDownloadProgress,
  onManifestReady,
  onProgress,
}: {
  services: BackupsServices;
  documentUsecaseDeps: import('../app/server.types').GlobalDependencies;
  documentsRepository: DocumentsRepository;
  foldersRepository: FoldersRepository;
  organizationId: string;
  destination: import('./backups.types').BackupDestination;
  remoteFileId: string;
  userId?: string;
  onDownloadStart?: () => void | Promise<void>;
  onDownloadProgress?: (args: { downloadedBytes: number; totalBytes: number | null }) => void;
  onManifestReady?: (args: { totalDocumentsCount: number }) => void | Promise<void>;
  onProgress?: (args: { processedCount: number; totalCount: number }) => void | Promise<void>;
}) {
  const encryption = services.requireEncryption();
  const credentials = unwrapCredentials({ encryption, wrapped: destination.encryptedCredentials });
  const settings = JSON.parse(destination.settingsJson) as Record<string, unknown>;
  const driver = services.getDriver(destination.driver);

  await onDownloadStart?.();
  const envelope = await driver.downloadFile({
    credentials,
    settings,
    remoteFileId,
    onProgress: onDownloadProgress,
  });

  return restoreFromEnvelopeUsecase({
    services,
    documentUsecaseDeps,
    documentsRepository,
    foldersRepository,
    organizationId,
    envelope,
    userId,
    onManifestReady,
    onProgress,
  });
}

// ----- Download a backup copy directly, no destination involved at all — a
// one-off manual export straight to the browser. Gets its own random key (like
// every backup), wrapped and embedded in the same envelope, same as any other
// backup. Nothing about this run is persisted anywhere; it's not tracked in
// run history since there's no destination for it to belong to. -----

export async function downloadBackupCopyUsecase({
  config,
  services,
  documentsRepository,
  documentsStorageService,
  organizationId,
  db,
  logger: providedLogger = logger,
}: {
  config: Config;
  services: BackupsServices;
  documentsRepository: DocumentsRepository;
  documentsStorageService: import('../documents/storage/documents.storage.services').DocumentStorageService;
  organizationId: string;
  db: import('../app/database/database.types').Database;
  logger?: Logger;
}): Promise<{ envelope: Buffer; fileName: string; documentsCount: number }> {
  assertBackupsConfigured({ config });
  const encryption = services.requireEncryption();
  const dek = encryption.generateBackupKey();

  const { envelope, documentsCount } = await buildEncryptedBackupEnvelope({
    organizationId,
    documentsRepository,
    documentsStorageService,
    services,
    encryption,
    dek,
    db,
    logger: providedLogger,
  });

  const fileName = `papra-backup-${organizationId.slice(-6)}-${new Date().toISOString().replace(/[:.]/g, '-')}${BACKUP_FILE_EXTENSION}`;

  return { envelope, fileName, documentsCount };
}

// ----- Claim the envelope of a 'local' destination run that's sitting at
// 'ready_for_download' (see runBackupPipeline + backups.local-delivery.service).
// One-shot: the envelope is gone from memory after this resolves, whether or
// not the caller actually finishes streaming it to the response. -----
export async function downloadReadyBackupRunUsecase({
  services,
  repository,
  organizationId,
  runId,
}: {
  services: BackupsServices;
  repository: BackupsRepository;
  organizationId: string;
  runId: string;
}): Promise<{ envelope: Buffer; fileName: string }> {
  const { run } = await repository.getRunById({ runId, organizationId });
  if (!run || run.status !== 'ready_for_download') {
    throw createBackupRunNotFoundError();
  }

  const claimed = services.localDelivery.takeReadyDownload({ runId, organizationId });
  if (!claimed) {
    // Expired (10 min TTL) or already downloaded by another tab/request.
    throw createBackupRunNotFoundError();
  }

  await repository.updateRunStatus({
    runId,
    status: 'succeeded',
    fields: { remoteFileName: claimed.fileName, completedAt: new Date() },
  });
  await repository.updateDestination({
    destinationId: run.destinationId,
    fields: { lastRunAt: new Date() },
  });

  return { envelope: claimed.envelope, fileName: claimed.fileName };
}

// ----- Restore directly from an uploaded file — no destination, no driver, no
// connection to anything at all. You already have the file (copied off your
// phone, an SD card, wherever); this just needs it + your BACKUPS_KEK. -----

export async function restoreFromUploadedFileUsecase({
  config,
  services,
  repository,
  documentUsecaseDeps,
  documentsRepository,
  foldersRepository,
  organizationId,
  envelope,
  userId,
  logger: providedLogger = logger,
}: {
  config: Config;
  services: BackupsServices;
  repository: BackupsRepository;
  documentUsecaseDeps: import('../app/server.types').GlobalDependencies;
  documentsRepository: DocumentsRepository;
  foldersRepository: FoldersRepository;
  organizationId: string;
  envelope: Buffer;
  userId?: string;
  logger?: Logger;
}): Promise<{ jobId: string }> {
  assertBackupsConfigured({ config });

  await repository.markStaleInProgressRestoreJobsAsFailed({
    organizationId,
    staleBefore: new Date(Date.now() - STALE_IN_PROGRESS_RESTORE_JOB_TIMEOUT_MS),
    errorMessage: 'Restore marked as failed because the previous job did not complete.',
  });

  const { job } = await repository.createRestoreJob({
    job: {
      id: generateId({ prefix: backupRestoreJobIdPrefix }),
      organizationId,
      destinationId: null,
      runId: null,
      source: 'uploaded_file',
      status: 'pending',
    },
  });

  // Fire and forget: the route returns immediately, the client polls the job.
  void runRestoreJobPipeline({
    repository,
    jobId: job.id,
    logger: providedLogger,
    execute: ({ onManifestReady, onProgress }) =>
      restoreFromEnvelopeUsecase({
        services,
        documentUsecaseDeps,
        documentsRepository,
        foldersRepository,
        organizationId,
        envelope,
        userId,
        onManifestReady,
        onProgress,
      }),
  });

  return { jobId: job.id };
}

// ----- Restore from local run history (normal case: same install that took the backup) -----

export async function restoreRunUsecase({
  config,
  services,
  repository,
  documentUsecaseDeps,
  documentsRepository,
  foldersRepository,
  organizationId,
  destinationId,
  runId,
  userId,
  logger: providedLogger = logger,
}: {
  config: Config;
  services: BackupsServices;
  repository: BackupsRepository;
  documentUsecaseDeps: import('../app/server.types').GlobalDependencies;
  documentsRepository: DocumentsRepository;
  foldersRepository: FoldersRepository;
  organizationId: string;
  destinationId: string;
  runId: string;
  userId?: string;
  logger?: Logger;
}): Promise<{ jobId: string }> {
  assertBackupsConfigured({ config });

  const { run } = await repository.getRunById({ runId, organizationId });
  if (!run || !run.remoteFileId) {
    throw createBackupRunNotFoundError();
  }
  const { destination } = await repository.getDestinationById({ destinationId, organizationId });
  if (!destination) {
    throw createBackupDestinationNotFoundError();
  }

  await repository.markStaleInProgressRestoreJobsAsFailed({
    organizationId,
    staleBefore: new Date(Date.now() - STALE_IN_PROGRESS_RESTORE_JOB_TIMEOUT_MS),
    errorMessage: 'Restore marked as failed because the previous job did not complete.',
  });

  const { job } = await repository.createRestoreJob({
    job: {
      id: generateId({ prefix: backupRestoreJobIdPrefix }),
      organizationId,
      destinationId,
      runId,
      source: 'run',
      status: 'pending',
    },
  });

  const remoteFileId = run.remoteFileId;

  // Fire and forget: the route returns immediately, the client polls the job.
  void runRestoreJobPipeline({
    repository,
    jobId: job.id,
    logger: providedLogger,
    execute: ({ onDownloadStart, onDownloadProgress, onManifestReady, onProgress }) =>
      restoreArchiveUsecase({
        services,
        documentUsecaseDeps,
        documentsRepository,
        foldersRepository,
        organizationId,
        destination,
        remoteFileId,
        userId,
        onDownloadStart,
        onDownloadProgress,
        onManifestReady,
        onProgress,
      }),
  });

  return { jobId: job.id };
}

// ----- Disaster recovery: list + restore backups that exist on a destination -----
// even when the local database (destinations, run history) has no record of them
// — e.g. a fresh install, or an install pointed at a fresh/empty database while
// the remote destination still has the old backups sitting on it.

export async function listRemoteBackupsUsecase({
  config,
  services,
  repository,
  organizationId,
  destinationId,
}: {
  config: Config;
  services: BackupsServices;
  repository: BackupsRepository;
  organizationId: string;
  destinationId: string;
}): Promise<{ files: { remoteFileId: string; name: string; size?: number; modifiedAt?: Date }[] }> {
  assertBackupsConfigured({ config });
  const encryption = services.requireEncryption();

  const { destination } = await repository.getDestinationById({ destinationId, organizationId });
  if (!destination) {
    throw createBackupDestinationNotFoundError();
  }

  const credentials = unwrapCredentials({ encryption, wrapped: destination.encryptedCredentials });
  const settings = JSON.parse(destination.settingsJson) as Record<string, unknown>;
  const driver = services.getDriver(destination.driver);

  let folderRef = destination.remoteFolderRef;
  if (!folderRef) {
    const folder = await driver.ensureRemoteFolder({ credentials, settings });
    folderRef = folder.folderRef;
    await repository.updateDestination({ destinationId, fields: { remoteFolderRef: folderRef } });
  }

  const { files } = await driver.listFiles({ credentials, settings, folderRef });
  return { files: files.filter((f) => f.name.endsWith(BACKUP_FILE_EXTENSION)) };
}

export async function restoreFromRemoteFileUsecase({
  config,
  services,
  repository,
  documentUsecaseDeps,
  documentsRepository,
  foldersRepository,
  organizationId,
  destinationId,
  remoteFileId,
  userId,
  logger: providedLogger = logger,
}: {
  config: Config;
  services: BackupsServices;
  repository: BackupsRepository;
  documentUsecaseDeps: import('../app/server.types').GlobalDependencies;
  documentsRepository: DocumentsRepository;
  foldersRepository: FoldersRepository;
  organizationId: string;
  destinationId: string;
  remoteFileId: string;
  userId?: string;
  logger?: Logger;
}): Promise<{ jobId: string }> {
  assertBackupsConfigured({ config });

  const { destination } = await repository.getDestinationById({ destinationId, organizationId });
  if (!destination) {
    throw createBackupDestinationNotFoundError();
  }

  await repository.markStaleInProgressRestoreJobsAsFailed({
    organizationId,
    staleBefore: new Date(Date.now() - STALE_IN_PROGRESS_RESTORE_JOB_TIMEOUT_MS),
    errorMessage: 'Restore marked as failed because the previous job did not complete.',
  });

  const { job } = await repository.createRestoreJob({
    job: {
      id: generateId({ prefix: backupRestoreJobIdPrefix }),
      organizationId,
      destinationId,
      runId: null,
      source: 'remote_file',
      status: 'pending',
    },
  });

  // Fire and forget: the route returns immediately, the client polls the job.
  void runRestoreJobPipeline({
    repository,
    jobId: job.id,
    logger: providedLogger,
    execute: ({ onDownloadStart, onDownloadProgress, onManifestReady, onProgress }) =>
      restoreArchiveUsecase({
        services,
        documentUsecaseDeps,
        documentsRepository,
        foldersRepository,
        organizationId,
        destination,
        remoteFileId,
        userId,
        onDownloadStart,
        onDownloadProgress,
        onManifestReady,
        onProgress,
      }),
  });

  return { jobId: job.id };
}

// ----- Restore job status (polled by the client for progress/ETA) -----

export async function getRestoreJobUsecase({
  repository,
  organizationId,
  jobId,
}: {
  repository: BackupsRepository;
  organizationId: string;
  jobId: string;
}): Promise<{ job: import('./backups.types').BackupRestoreJob }> {
  const { job } = await repository.getRestoreJobById({ jobId, organizationId });
  if (!job) {
    throw createBackupRestoreJobNotFoundError();
  }
  return { job };
}

// Lets the client find "is anything restoring right now?" on page load/nav
// without having to have kept a jobId around — e.g. the user kicked off a
// restore, closed the tab, and came back later.
export async function getActiveRestoreJobUsecase({
  repository,
  organizationId,
}: {
  repository: BackupsRepository;
  organizationId: string;
}): Promise<{ job: import('./backups.types').BackupRestoreJob | undefined }> {
  const { job } = await repository.getActiveRestoreJobForOrganization({ organizationId });
  return { job };
}

// ----- Scheduler tick (called by tasks/backup-scheduler-tick.task.ts) -----

export async function runDueScheduledBackupsUsecase({
  config,
  services,
  repository,
  documentsRepository,
  globalDeps,
  now = new Date(),
  logger: providedLogger = logger,
}: {
  config: Config;
  services: BackupsServices;
  repository: BackupsRepository;
  documentsRepository: DocumentsRepository;
  globalDeps: Pick<
    import('../app/server.types').GlobalDependencies,
    'db' | 'taskServices' | 'documentsStorageService' | 'eventServices'
  >;
  now?: Date;
  logger?: Logger;
}): Promise<{ triggeredCount: number }> {
  if (!config.backups.kek) {
    return { triggeredCount: 0 };
  }

  const { destinations } = await repository.getDueScheduledDestinations({ now });
  let triggeredCount = 0;

  for (const destination of destinations) {
    // Defense in depth: updateDestinationScheduleUsecase already refuses to
    // enable scheduling on a local destination, but skip here too in case a
    // row was ever left over from before that guard existed.
    if (destination.driver === 'local') {
      continue;
    }
    try {
      await runBackupUsecase({
        config,
        services,
        repository,
        documentsRepository,
        globalDeps,
        organizationId: destination.organizationId,
        destinationId: destination.id,
        trigger: 'scheduled',
        logger: providedLogger,
      });
      triggeredCount += 1;
    } catch (error) {
      providedLogger.error(
        { error, destinationId: destination.id },
        'Scheduled backup failed to start',
      );
    }

    // Recompute the next occurrence regardless of success/failure, so a failure
    // doesn't cause the scheduler to hammer the destination every 15 minutes.
    const schedule: BackupSchedule = {
      isEnabled: destination.isScheduleEnabled,
      days: parseScheduleDays(destination.scheduleDaysJson),
      hour: destination.scheduleHour,
      minute: destination.scheduleMinute,
    };
    const nextScheduledAt = computeNextScheduledAt({ schedule, from: now });
    await repository.updateDestination({
      destinationId: destination.id,
      fields: { nextScheduledAt },
    });
  }

  return { triggeredCount };
}

// ----- Backup Verification -----

export async function verifyBackupRunUsecase({
  config,
  services,
  repository,
  organizationId,
  destinationId,
  runId,
}: {
  config: Config;
  services: BackupsServices;
  repository: BackupsRepository;
  organizationId: string;
  destinationId: string;
  runId: string;
}): Promise<{
  valid: boolean;
  totalDocuments: number;
  validDocuments: number;
  invalidDocuments: number;
  errors: string[];
}> {
  assertBackupsConfigured({ config });
  const encryption = services.requireEncryption();

  // Get the run and destination
  const { run } = await repository.getRunById({ runId, organizationId });
  if (!run || !run.remoteFileId) {
    throw createBackupRunNotFoundError();
  }

  const { destination } = await repository.getDestinationById({ destinationId, organizationId });
  if (!destination) {
    throw createBackupDestinationNotFoundError();
  }

  const errors: string[] = [];

  try {
    // Download the backup file
    const credentials = unwrapCredentials({
      encryption,
      wrapped: destination.encryptedCredentials,
    });
    const settings = JSON.parse(destination.settingsJson) as Record<string, unknown>;
    const driver = services.getDriver(destination.driver);

    const envelope = await driver.downloadFile({
      credentials,
      settings,
      remoteFileId: run.remoteFileId,
    });

    // Unpack and verify
    const { wrappedKey, encryptedPayload } = unpackBackupEnvelope({ envelope });
    const dek = encryption.unwrapWithKek({ wrapped: wrappedKey });

    const archive = encryption.decryptPayload({ encryptedPayload, key: dek });
    const { manifest, files: unpackedFiles } = await services.packager.unpack({ archive });

    const manifestDocs = (
      manifest as {
        documents: {
          id: string;
          originalSha256Hash: string;
        }[];
      }
    ).documents;

    // Verify each document's hash
    let validCount = 0;
    let invalidCount = 0;

    for (const doc of manifestDocs) {
      // Find the file in the archive that matches this document
      // Files are named as "files/{doc.id}-{originalName}" in the tar archive
      // After unpacking, the key is just "{doc.id}-{originalName}"
      const fileKey = Array.from(unpackedFiles.keys()).find((key) => key.startsWith(`${doc.id}-`));
      if (!fileKey) {
        errors.push(`Document ${doc.id}: file not found in backup archive`);
        invalidCount++;
        continue;
      }

      const content = unpackedFiles.get(fileKey)!;
      const actualHash = services.packager.computeHash(content);

      if (actualHash !== doc.originalSha256Hash) {
        errors.push(
          `Document ${doc.id}: hash mismatch (expected ${doc.originalSha256Hash}, got ${actualHash})`,
        );
        invalidCount++;
      } else {
        validCount++;
      }
    }

    return {
      valid: errors.length === 0,
      totalDocuments: manifestDocs.length,
      validDocuments: validCount,
      invalidDocuments: invalidCount,
      errors,
    };
  } catch (error) {
    errors.push((error as Error).message);
    return {
      valid: false,
      totalDocuments: 0,
      validDocuments: 0,
      invalidDocuments: 0,
      errors,
    };
  }
}
