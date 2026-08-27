import type { Component } from 'solid-js';
import type { Document } from '@/modules/documents/documents.types';
import { useMutation, useQuery } from '@tanstack/solid-query';
import { createEffect, createMemo, createSignal, on, Show } from 'solid-js';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { useI18nApiErrors } from '@/modules/shared/http/composables/i18n-api-errors';
import { queryClient } from '@/modules/shared/query/query-client';
import { Button } from '@/modules/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/modules/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/modules/ui/components/select';
import { createToast } from '@/modules/ui/components/sonner';
import { updateDocument } from '@/modules/documents/documents.services';
import { invalidateOrganizationDocumentsQuery } from '@/modules/documents/documents.composables';
import { fetchOrganizationFolders } from '../folders.services';
import { buildIndentedFolderList } from '../composables/folder-tree';
import type { Folder } from '../folders.types';

type FolderOption = { id: string | null; label: string };

export const MoveDocumentDialog: Component<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: Document;
}> = (props) => {
  const { t } = useI18n();
  const { getErrorMessage } = useI18nApiErrors({ t });

  // Destination folder selection. Initialized with the document's current
  // location when the dialog opens; the move is only ever committed through
  // the explicit "Move" button, never directly from the select onChange.
  const [getFolderId, setFolderId] = createSignal<string | null | undefined>(undefined);

  const foldersQuery = useQuery(() => ({
    queryKey: ['organizations', props.document.organizationId, 'folders'],
    queryFn: async () =>
      fetchOrganizationFolders({ organizationId: props.document.organizationId }),
  }));

  const getOptions = createMemo<FolderOption[]>(() => {
    const folders = foldersQuery.data?.folders ?? [];
    const { indentedFolders } = buildIndentedFolderList({ folders });

    return [
      { id: null, label: t('folders.root-label') },
      ...indentedFolders.map(({ folder, depth }: { folder: Folder; depth: number }) => ({
        id: folder.id,
        label: `${'— '.repeat(depth)}${folder.name}`,
      })),
    ];
  });

  // Reset the selection to the document's current folder each time the dialog opens,
  // so reopening after a cancel can never confirm a stale selection.
  createEffect(
    on(
      () => props.open,
      () => setFolderId(props.document.folderId ?? null),
    ),
  );

  const getCurrentFolderId = () => props.document.folderId ?? null;

  const moveMutation = useMutation(() => ({
    mutationFn: async (folderId: string | null) =>
      updateDocument({
        documentId: props.document.id,
        organizationId: props.document.organizationId,
        folderId,
      }),
    onSuccess: async () => {
      await Promise.all([
        invalidateOrganizationDocumentsQuery({ organizationId: props.document.organizationId }),
        queryClient.invalidateQueries({
          queryKey: ['organizations', props.document.organizationId, 'folders'],
          refetchType: 'all',
        }),
      ]);

      createToast({ message: t('folders.move.success'), type: 'success' });
      props.onOpenChange(false);
    },
    onError: (error) => {
      createToast({ message: getErrorMessage({ error }), type: 'error' });
    },
  }));

  function handleConfirm() {
    const folderId = getFolderId();
    if (folderId === undefined) return;

    moveMutation.mutate(folderId);
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('folders.move.title')}</DialogTitle>
        </DialogHeader>

        <Show when={props.open}>
          <Select<FolderOption>
            options={getOptions()}
            optionValue="id"
            optionTextValue="label"
            value={getOptions().find((option) => option.id === getFolderId())}
            onChange={(value) => setFolderId(value?.id ?? null)}
            itemComponent={(itemProps) => (
              <SelectItem class="cursor-pointer" item={itemProps.item}>
                {itemProps.item.rawValue.label}
              </SelectItem>
            )}
          >
            <SelectTrigger>
              <SelectValue<FolderOption>>
                {(state) => state.selectedOption()?.label ?? t('folders.move.select-placeholder')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
        </Show>

        <DialogFooter>
          <div class="flex gap-2 justify-end flex-col-reverse sm:flex-row">
            <Button
              type="button"
              variant="secondary"
              onClick={() => props.onOpenChange(false)}
              disabled={moveMutation.isPending}
            >
              {t('folders.delete.confirm.cancel-button')}
            </Button>
            <Button
              type="button"
              onClick={handleConfirm}
              isLoading={moveMutation.isPending}
              disabled={moveMutation.isPending || getFolderId() === getCurrentFolderId()}
            >
              {t('folders.move.confirm-button')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
