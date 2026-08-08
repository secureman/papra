import type { DialogTriggerProps } from '@kobalte/core/dialog';
import type { RowSelectionState } from '@tanstack/solid-table';
import type { Component } from 'solid-js';
import { A, useNavigate, useParams } from '@solidjs/router';
import { useMutation, useQuery } from '@tanstack/solid-query';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { DocumentsBatchMoveDialog } from '@/modules/documents/components/documents-batch-move-dialog.component';
import {
  createdAtColumn,
  DocumentsPaginatedList,
  standardActionsColumn,
  tagsColumn,
} from '@/modules/documents/components/documents-list.component';
import { useFolderAwareUpload } from '@/modules/documents/composables/use-folder-aware-upload';
import {
  batchMoveDocuments,
  batchTrashDocuments,
} from '@/modules/documents/documents-batch.services';
import { invalidateOrganizationDocumentsQuery } from '@/modules/documents/documents.composables';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { useConfirmModal } from '@/modules/shared/confirm';
import { useI18nApiErrors } from '@/modules/shared/http/composables/i18n-api-errors';
import { queryClient } from '@/modules/shared/query/query-client';
import { Button } from '@/modules/ui/components/button';
import { Checkbox, CheckboxControl, CheckboxLabel } from '@/modules/ui/components/checkbox';
import { EmptyState } from '@/modules/ui/components/empty';
import { createToast } from '@/modules/ui/components/sonner';
import { buildFolderPath } from '../composables/folder-tree';
import { CreateFolderDialog, RenameFolderDialog } from '../components/folder-dialogs.component';
import { deleteFolder, fetchFolderContents, fetchOrganizationFolders } from '../folders.services';
import type { Folder } from '../folders.types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/modules/ui/components/dropdown-menu';

const FolderCard: Component<{ organizationId: string; folder: Folder }> = (props) => {
  const { t } = useI18n();
  const { confirm } = useConfirmModal();
  const { getErrorMessage } = useI18nApiErrors({ t });
  const [getIsRenameOpen, setIsRenameOpen] = createSignal(false);

  const deleteMutation = useMutation(() => ({
    mutationFn: async ({ force }: { force: boolean }) =>
      deleteFolder({ organizationId: props.organizationId, folderId: props.folder.id, force }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['organizations', props.organizationId, 'folders'],
        refetchType: 'all',
      });
      createToast({ message: t('folders.delete.success'), type: 'success' });
    },
    onError: (error) => {
      createToast({ message: getErrorMessage({ error }), type: 'error' });
    },
  }));

  const handleDelete = async () => {
    const confirmed = await confirm({
      title: t('folders.delete.confirm.title'),
      message: t('folders.delete.confirm.message'),
      confirmButton: { text: t('folders.delete.confirm.confirm-button'), variant: 'destructive' },
      cancelButton: { text: t('folders.delete.confirm.cancel-button') },
    });

    if (!confirmed) {
      return;
    }

    try {
      await deleteMutation.mutateAsync({ force: false });
    } catch (error) {
      // 409 folders.not_empty -> offer a force-delete as a second confirmation
      const status = (error as { statusCode?: number })?.statusCode;

      if (status !== 409) {
        return;
      }

      const confirmedForce = await confirm({
        title: t('folders.delete.confirm.title'),
        message: t('folders.delete.confirm.not-empty-message'),
        confirmButton: { text: t('folders.delete.confirm.confirm-button'), variant: 'destructive' },
        cancelButton: { text: t('folders.delete.confirm.cancel-button') },
      });

      if (confirmedForce) {
        await deleteMutation.mutateAsync({ force: true });
      }
    }
  };

  return (
    <div class="flex items-center gap-2 border rounded-lg p-3 hover:bg-accent/30 transition">
      <A
        href={`/organizations/${props.organizationId}/folders/${props.folder.id}`}
        class="flex items-center gap-2 flex-1 min-w-0"
      >
        <div class="i-tabler-folder-filled size-6 text-primary flex-shrink-0" />
        <div class="min-w-0">
          <div class="font-medium truncate">{props.folder.name}</div>
          <div class="text-xs text-muted-foreground">
            {t('folders.documents-count', { count: props.folder.documentsCount ?? 0 })}
          </div>
        </div>
      </A>

      <DropdownMenu>
        <DropdownMenuTrigger
          as={(triggerProps: DialogTriggerProps) => (
            <Button variant="ghost" size="icon" {...triggerProps}>
              <div class="i-tabler-dots-vertical size-4" />
            </Button>
          )}
        />
        <DropdownMenuContent class="w-40">
          <DropdownMenuItem class="cursor-pointer" onClick={() => setIsRenameOpen(true)}>
            <div class="i-tabler-pencil size-4 mr-2" />
            <span>{t('folders.subfolders.actions.rename')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem class="cursor-pointer text-red" onClick={handleDelete}>
            <div class="i-tabler-trash size-4 mr-2" />
            <span>{t('folders.subfolders.actions.delete')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Show when={getIsRenameOpen()}>
        <RenameFolderDialog
          open={getIsRenameOpen()}
          onOpenChange={setIsRenameOpen}
          organizationId={props.organizationId}
          folder={props.folder}
        />
      </Show>
    </div>
  );
};

export const FolderPage: Component = () => {
  const params = useParams<{ organizationId: string; folderId?: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { getErrorMessage } = useI18nApiErrors({ t });
  const { confirm } = useConfirmModal();
  const [getIsCurrentFolderRenameOpen, setIsCurrentFolderRenameOpen] = createSignal(false);

  const currentFolderId = () => params.folderId ?? null;

  const contentsQuery = useQuery(() => ({
    queryKey: ['organizations', params.organizationId, 'folders', 'contents', currentFolderId()],
    queryFn: async () =>
      fetchFolderContents({ organizationId: params.organizationId, folderId: currentFolderId() }),
  }));

  const [getDocumentRowSelection, setDocumentRowSelection] = createSignal<RowSelectionState>({});

  const getSelectedDocumentIds = createMemo(() => {
    const selection = getDocumentRowSelection();
    return Object.keys(selection).filter((id) => selection[id]);
  });

  const clearDocumentSelection = () => setDocumentRowSelection({});

  const invalidateFolderContents = async () => {
    await Promise.all([
      contentsQuery.refetch(),
      invalidateOrganizationDocumentsQuery({ organizationId: params.organizationId }),
    ]);
  };

  const batchTrashMutation = useMutation(() => ({
    mutationFn: async () =>
      batchTrashDocuments({
        organizationId: params.organizationId,
        filter: { documentIds: getSelectedDocumentIds() },
      }),
    onSuccess: async () => {
      const count = getSelectedDocumentIds().length;
      clearDocumentSelection();
      await invalidateFolderContents();
      createToast({ message: t('documents.list.batch.trash.success', { count }), type: 'success' });
    },
    onError: (error) => {
      createToast({ message: getErrorMessage({ error }), type: 'error' });
    },
  }));

  const [getMoveDialogOpen, setMoveDialogOpen] = createSignal(false);

  const batchMoveMutation = useMutation(() => ({
    mutationFn: async ({ folderId }: { folderId: string | null }) =>
      batchMoveDocuments({
        organizationId: params.organizationId,
        filter: { documentIds: getSelectedDocumentIds() },
        folderId,
      }),
    onSuccess: async () => {
      const count = getSelectedDocumentIds().length;
      clearDocumentSelection();
      await invalidateFolderContents();
      createToast({ message: t('documents.list.batch.move.success', { count }), type: 'success' });
    },
    onError: (error) => {
      createToast({ message: getErrorMessage({ error }), type: 'error' });
    },
  }));

  const handleBatchTrash = async () => {
    const count = getSelectedDocumentIds().length;
    const confirmed = await confirm({
      title: t('documents.list.batch.trash.confirm.title'),
      message: t('documents.list.batch.trash.confirm.description', { count }),
      confirmButton: {
        text: t('documents.list.batch.trash.confirm.label'),
        variant: 'destructive',
      },
      cancelButton: { text: t('documents.list.batch.trash.confirm.cancel') },
    });
    if (!confirmed) {
      return;
    }
    batchTrashMutation.mutate();
  };

  // Flat list is cheap (capped per-org) and lets us build the breadcrumb path
  // client-side without one request per ancestor.
  const allFoldersQuery = useQuery(() => ({
    queryKey: ['organizations', params.organizationId, 'folders'],
    queryFn: async () => fetchOrganizationFolders({ organizationId: params.organizationId }),
  }));

  const getBreadcrumbPath = createMemo(() => {
    const folders = allFoldersQuery.data?.folders ?? [];
    const { path } = buildFolderPath({ folders, folderId: currentFolderId() });
    return path;
  });

  const getCurrentFolder = () => getBreadcrumbPath().at(-1) ?? null;

  const deleteCurrentFolderMutation = useMutation(() => ({
    mutationFn: async ({ force }: { force: boolean }) => {
      const folder = getCurrentFolder();
      if (!folder) {
        throw new Error('No current folder to delete');
      }
      return deleteFolder({ organizationId: params.organizationId, folderId: folder.id, force });
    },
    onSuccess: async () => {
      const folder = getCurrentFolder();
      await queryClient.invalidateQueries({
        queryKey: ['organizations', params.organizationId, 'folders'],
        refetchType: 'all',
      });
      createToast({ message: t('folders.delete.success'), type: 'success' });
      const parentId = folder?.parentId ?? null;
      navigate(
        parentId
          ? `/organizations/${params.organizationId}/folders/${parentId}`
          : `/organizations/${params.organizationId}/folders`,
      );
    },
    onError: (error) => {
      createToast({ message: getErrorMessage({ error }), type: 'error' });
    },
  }));

  const handleDeleteCurrentFolder = async () => {
    const confirmed = await confirm({
      title: t('folders.delete.confirm.title'),
      message: t('folders.delete.confirm.message'),
      confirmButton: { text: t('folders.delete.confirm.confirm-button'), variant: 'destructive' },
      cancelButton: { text: t('folders.delete.confirm.cancel-button') },
    });
    if (!confirmed) {
      return;
    }

    try {
      await deleteCurrentFolderMutation.mutateAsync({ force: false });
    } catch (error) {
      const status = (error as { statusCode?: number })?.statusCode;
      if (status !== 409) {
        return;
      }

      const confirmedForce = await confirm({
        title: t('folders.delete.confirm.title'),
        message: t('folders.delete.confirm.not-empty-message'),
        confirmButton: { text: t('folders.delete.confirm.confirm-button'), variant: 'destructive' },
        cancelButton: { text: t('folders.delete.confirm.cancel-button') },
      });
      if (confirmedForce) {
        await deleteCurrentFolderMutation.mutateAsync({ force: true });
      }
    }
  };

  const refreshAfterUpload = async () => {
    await Promise.all([
      contentsQuery.refetch(),
      invalidateOrganizationDocumentsQuery({ organizationId: params.organizationId }),
      queryClient.invalidateQueries({
        queryKey: ['organizations', params.organizationId, 'folders'],
        refetchType: 'all',
      }),
    ]);
  };

  const {
    hasPendingFolderConfirmation,
    getPendingFileCount,
    getRecreateFolderStructure,
    setRecreateFolderStructure,
    cancelPendingUpload,
    confirmPendingUpload,
    promptFiles,
    promptFolder,
    handleDrop,
  } = useFolderAwareUpload({
    organizationId: params.organizationId,
    rootFolderId: currentFolderId,
  });

  const [isDraggingOverFolder, setIsDraggingOverFolder] = createSignal(false);

  const handleUploadFiles = async () => {
    try {
      await promptFiles();
      await refreshAfterUpload();
    } catch (error) {
      createToast({ message: getErrorMessage({ error }), type: 'error' });
    }
  };

  const handleUploadFolder = async () => {
    try {
      await promptFolder();
      await refreshAfterUpload();
    } catch (error) {
      createToast({ message: getErrorMessage({ error }), type: 'error' });
    }
  };

  const handleConfirmPendingUpload = async () => {
    try {
      await confirmPendingUpload();
      await refreshAfterUpload();
    } catch (error) {
      createToast({ message: getErrorMessage({ error }), type: 'error' });
    }
  };

  const handleFolderDrop = async (event: DragEvent) => {
    event.preventDefault();
    setIsDraggingOverFolder(false);
    if (!event.dataTransfer) {
      return;
    }
    try {
      await handleDrop(event.dataTransfer);
      await refreshAfterUpload();
    } catch (error) {
      createToast({ message: getErrorMessage({ error }), type: 'error' });
    }
  };

  const getIsEmpty = () =>
    (contentsQuery.data?.folders.length ?? 0) === 0 &&
    (contentsQuery.data?.documents.length ?? 0) === 0;

  return (
    <div
      class="p-6 mt-4 pb-32 mx-auto max-w-5xl relative"
      classList={{
        'outline outline-2 outline-primary outline-dashed rounded-lg': isDraggingOverFolder(),
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDraggingOverFolder(true);
      }}
      onDragLeave={() => setIsDraggingOverFolder(false)}
      onDrop={handleFolderDrop}
    >
      <Show when={hasPendingFolderConfirmation()}>
        <div class="border rounded-lg p-4 mb-4 flex flex-col gap-3 bg-background">
          <p class="text-sm">
            {t('documents.upload.folder-detected', { count: getPendingFileCount() })}
          </p>

          <Checkbox
            checked={getRecreateFolderStructure()}
            onChange={setRecreateFolderStructure}
            class="flex items-center gap-2"
          >
            <CheckboxControl />
            <CheckboxLabel class="text-sm cursor-pointer">
              {t('documents.upload.recreate-folder-structure')}
            </CheckboxLabel>
          </Checkbox>

          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={cancelPendingUpload}>
              {t('documents.upload.cancel')}
            </Button>
            <Button size="sm" onClick={handleConfirmPendingUpload}>
              {t('documents.upload.confirm-upload')}
            </Button>
          </div>
        </div>
      </Show>

      <div class="flex justify-between sm:items-center pb-6 gap-4 flex-col sm:flex-row">
        <div class="flex items-center gap-1 flex-wrap text-sm">
          <A
            href={`/organizations/${params.organizationId}/folders`}
            class="flex items-center gap-1 hover:underline font-medium"
            classList={{ 'text-muted-foreground': Boolean(currentFolderId()) }}
          >
            <div class="i-tabler-home size-4" />
            {t('folders.root-label')}
          </A>
          <For each={getBreadcrumbPath()}>
            {(folder, index) => (
              <>
                <div class="i-tabler-chevron-right size-3.5 text-muted-foreground" />
                <A
                  href={`/organizations/${params.organizationId}/folders/${folder.id}`}
                  class="hover:underline"
                  classList={{
                    'font-medium': index() === getBreadcrumbPath().length - 1,
                    'text-muted-foreground': index() !== getBreadcrumbPath().length - 1,
                  }}
                >
                  {folder.name}
                </A>
              </>
            )}
          </For>
        </div>

        <div class="flex gap-2 flex-shrink-0">
          <CreateFolderDialog organizationId={params.organizationId} parentId={currentFolderId()}>
            {(dialogProps) => (
              <Button variant="outline" {...dialogProps}>
                <div class="i-tabler-folder-plus size-4 mr-2" />
                {t('folders.new-folder')}
              </Button>
            )}
          </CreateFolderDialog>

          <DropdownMenu>
            <DropdownMenuTrigger as={Button}>
              <div class="i-tabler-upload size-4 mr-2" />
              {t('folders.upload-here')}
            </DropdownMenuTrigger>
            <DropdownMenuContent class="w-48">
              <DropdownMenuItem class="cursor-pointer" onClick={handleUploadFiles}>
                <div class="i-tabler-file-upload size-4 mr-2" />
                <span>{t('documents.upload.select-files')}</span>
              </DropdownMenuItem>
              <DropdownMenuItem class="cursor-pointer" onClick={handleUploadFolder}>
                <div class="i-tabler-folder-up size-4 mr-2" />
                <span>{t('documents.upload.select-folder')}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Show when={currentFolderId()}>
            <DropdownMenu>
              <DropdownMenuTrigger as={Button} variant="outline" size="icon">
                <div class="i-tabler-dots-vertical size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent class="w-48">
                <DropdownMenuItem
                  class="cursor-pointer"
                  onClick={() => setIsCurrentFolderRenameOpen(true)}
                >
                  <div class="i-tabler-pencil size-4 mr-2" />
                  <span>{t('folders.subfolders.actions.rename')}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="cursor-pointer text-red"
                  onClick={handleDeleteCurrentFolder}
                >
                  <div class="i-tabler-trash size-4 mr-2" />
                  <span>{t('folders.subfolders.actions.delete')}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </Show>
        </div>
      </div>

      <Show when={getIsCurrentFolderRenameOpen() && getCurrentFolder()}>
        {(folder) => (
          <RenameFolderDialog
            open={getIsCurrentFolderRenameOpen()}
            onOpenChange={setIsCurrentFolderRenameOpen}
            organizationId={params.organizationId}
            folder={folder()}
          />
        )}
      </Show>

      <Show when={contentsQuery.data}>
        {(getData) => (
          <Show
            when={!getIsEmpty()}
            fallback={
              <EmptyState
                title={t('folders.empty.title')}
                icon="i-tabler-folder-open"
                description={t('folders.empty.description')}
              />
            }
          >
            <Show when={getData().folders.length > 0}>
              <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
                <For each={getData().folders}>
                  {(folder) => (
                    <FolderCard organizationId={params.organizationId} folder={folder} />
                  )}
                </For>
              </div>
            </Show>

            <Show when={getData().documents.length > 0}>
              <Show when={getSelectedDocumentIds().length > 0}>
                <div class="flex items-center gap-2 mb-3 p-2 border rounded-lg bg-muted/40">
                  <span class="text-sm text-muted-foreground pl-2">
                    {t('documents.list.batch.selected-count', {
                      count: getSelectedDocumentIds().length,
                    })}
                  </span>

                  <div class="flex-1" />

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setMoveDialogOpen(true)}
                    disabled={batchTrashMutation.isPending || batchMoveMutation.isPending}
                  >
                    <div class="i-tabler-folder-symlink size-4 mr-2" />
                    {t('documents.list.batch.move-action')}
                  </Button>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleBatchTrash}
                    isLoading={batchTrashMutation.isPending}
                    disabled={batchMoveMutation.isPending}
                    class="text-red-500 hover:text-red-600"
                  >
                    <div class="i-tabler-trash size-4 mr-2" />
                    {t('documents.list.batch.trash-action')}
                  </Button>

                  <Button
                    variant="ghost"
                    size="icon"
                    class="size-8"
                    onClick={clearDocumentSelection}
                    disabled={batchTrashMutation.isPending || batchMoveMutation.isPending}
                    aria-label={t('documents.list.batch.clear')}
                  >
                    <div class="i-tabler-x size-4" />
                  </Button>
                </div>
              </Show>

              <DocumentsPaginatedList
                documents={getData().documents}
                documentsCount={getData().documents.length}
                enableBatchSelection
                getRowSelection={getDocumentRowSelection}
                setRowSelection={setDocumentRowSelection}
                showPagination={false}
                extraColumns={[tagsColumn, createdAtColumn, standardActionsColumn]}
              />

              <DocumentsBatchMoveDialog
                open={getMoveDialogOpen()}
                onOpenChange={setMoveDialogOpen}
                organizationId={params.organizationId}
                selectionCount={getSelectedDocumentIds().length}
                isPending={batchMoveMutation.isPending}
                onSubmit={({ folderId }) => {
                  setMoveDialogOpen(false);
                  batchMoveMutation.mutate({ folderId });
                }}
              />
            </Show>
          </Show>
        )}
      </Show>
    </div>
  );
};
