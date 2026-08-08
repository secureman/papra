import type { Component } from 'solid-js';
import { useQuery } from '@tanstack/solid-query';
import { createEffect, createMemo, createSignal, on, Show } from 'solid-js';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { buildIndentedFolderList } from '@/modules/folders/composables/folder-tree';
import { fetchOrganizationFolders } from '@/modules/folders/folders.services';
import type { Folder } from '@/modules/folders/folders.types';
import { Button } from '@/modules/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

type FolderOption = { id: string | null; label: string };

export const DocumentsBatchMoveDialog: Component<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  selectionCount: number;
  isPending?: boolean;
  onSubmit: (args: { folderId: string | null }) => void;
}> = (props) => {
  const { t } = useI18n();
  const [getFolderId, setFolderId] = createSignal<string | null | undefined>(undefined);

  const foldersQuery = useQuery(() => ({
    queryKey: ['organizations', props.organizationId, 'folders'],
    queryFn: async () => fetchOrganizationFolders({ organizationId: props.organizationId }),
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

  createEffect(
    on(
      () => props.open,
      () => setFolderId(undefined),
    ),
  );

  function handleSubmit() {
    const folderId = getFolderId();
    if (folderId === undefined) return;
    props.onSubmit({ folderId });
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t('documents.list.batch.move.dialog.title')}</DialogTitle>
          <DialogDescription>
            {t('documents.list.batch.move.dialog.description', { count: props.selectionCount })}
          </DialogDescription>
        </DialogHeader>

        <Show when={props.open}>
          <Select<FolderOption>
            options={getOptions()}
            optionValue="id"
            optionTextValue="label"
            value={getOptions().find((option) => option.id === getFolderId())}
            onChange={(value) => setFolderId(value?.id)}
            itemComponent={(itemProps) => (
              <SelectItem class="cursor-pointer" item={itemProps.item}>
                {itemProps.item.rawValue.label}
              </SelectItem>
            )}
          >
            <SelectTrigger>
              <SelectValue<FolderOption>>{(state) => state.selectedOption()?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
        </Show>

        <DialogFooter>
          <div class="flex gap-2 justify-end flex-col-reverse sm:flex-row">
            <Button
              variant="secondary"
              onClick={() => props.onOpenChange(false)}
              disabled={props.isPending}
            >
              {t('documents.list.batch.move.dialog.cancel')}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={props.isPending || getFolderId() === undefined}
              isLoading={props.isPending}
            >
              {t('documents.list.batch.move.dialog.submit')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
