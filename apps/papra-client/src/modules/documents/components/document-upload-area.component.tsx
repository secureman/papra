import type { Component } from 'solid-js';
import { createSignal, Show } from 'solid-js';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { cn } from '@/modules/shared/style/cn';
import { Button } from '@/modules/ui/components/button';
import { Checkbox, CheckboxControl, CheckboxLabel } from '@/modules/ui/components/checkbox';
import { useFolderAwareUpload } from '../composables/use-folder-aware-upload';
import { useDocumentUpload } from './document-import-status.component';

export const DocumentUploadArea: Component<{ organizationId: string; folderId?: string | null }> = (
  props,
) => {
  const { t } = useI18n();
  const [isDragging, setIsDragging] = createSignal(false);
  const { promptImport } = useDocumentUpload();

  const {
    hasPendingFolderConfirmation,
    getPendingFileCount,
    getRecreateFolderStructure,
    setRecreateFolderStructure,
    cancelPendingUpload,
    confirmPendingUpload,
    promptFolder,
    handleDrop,
  } = useFolderAwareUpload({
    organizationId: props.organizationId,
    rootFolderId: () => props.folderId ?? null,
  });

  const handleDragOver = (event: DragEvent) => {
    event.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDropEvent = async (event: DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    if (!event.dataTransfer) {
      return;
    }
    await handleDrop(event.dataTransfer);
  };

  return (
    <div>
      <div
        class={cn(
          'border border-[2px] border-dashed text-muted-foreground rounded-lg p-6 sm:py-16 flex flex-col items-center justify-center text-center',
          { 'border-primary': isDragging() },
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDropEvent}
      >
        <div class="i-tabler-cloud-upload size-12 mb-4" />
        <p>{isDragging() ? t('documents.upload.drop-hint') : t('documents.upload.drag-hint')}</p>

        <div class="flex items-center gap-2 mt-4">
          <Button variant="outline" onClick={promptImport}>
            <div class="i-tabler-upload mr-2" />
            {t('documents.upload.select-files')}
          </Button>

          <Button variant="outline" onClick={promptFolder}>
            <div class="i-tabler-folder-up mr-2" />
            {t('documents.upload.select-folder')}
          </Button>
        </div>
      </div>

      <Show when={hasPendingFolderConfirmation()}>
        <div class="border rounded-lg p-4 mt-4 flex flex-col gap-3">
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
            <Button size="sm" onClick={confirmPendingUpload}>
              {t('documents.upload.confirm-upload')}
            </Button>
          </div>
        </div>
      </Show>
    </div>
  );
};
