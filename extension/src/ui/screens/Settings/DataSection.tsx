import { useState } from 'react';
import { Button } from '@/ui/components/Button';
import { Card } from '@/ui/components/Card';
import { ConfirmDialog } from '@/ui/components/ConfirmDialog';
import { downloadTextFile } from '@/ui/components/download';
import { Field } from '@/ui/components/Field';
import { IconDownload, IconTrash } from '@/ui/components/icons';
import { Input } from '@/ui/components/Input';
import { Section } from '@/ui/components/Section';
import { sendRequest } from '@/ui/bridge';
import { useAppContext } from '@/ui/hooks/useAppContext';

export function DataSection() {
  const app = useAppContext();
  const notify = app.notify;
  const [exporting, setExporting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [resetting, setResetting] = useState(false);

  const exportData = async (): Promise<void> => {
    setExporting(true);
    // A full, re-importable backup (settings, answers, documents, queue, jobs),
    // not just the diagnostics bundle.
    const result = await sendRequest({ type: 'ui.migration.export', format: 'json' });
    setExporting(false);
    if (!result.ok) {
      notify('error', result.error.message);
      return;
    }
    downloadTextFile(result.value.filename, result.value.text);
    notify('success', 'Backup downloaded.');
  };

  const resetAll = async (): Promise<void> => {
    setResetting(true);
    const result = await sendRequest({ type: 'ui.data.reset', confirm: true });
    setResetting(false);
    if (!result.ok) {
      notify('error', result.error.message);
      return;
    }
    setConfirmOpen(false);
    setConfirmText('');
    await app.refreshSettings();
    await app.refreshEngine();
    notify('success', 'Local data cleared. Setup starts again.');
    app.navigate('dashboard');
  };

  const canReset = confirmText.trim().toLowerCase() === 'reset';

  return (
    <Section
      id="data"
      title="Your data"
      description="Download a backup before you reset. Reset cannot be undone."
    >
      <div className="space-y-2 rounded-panel border border-danger/30 bg-surface p-3">
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            iconLeft={<IconDownload size={13} />}
            loading={exporting}
            onClick={() => void exportData()}
          >
            Export private backup
          </Button>
          <Button
            size="sm"
            variant="ghost"
            iconLeft={<IconTrash size={13} />}
            className="text-danger"
            onClick={() => setConfirmOpen(true)}
          >
            Reset local data
          </Button>
        </div>

        <Card tone="danger" padded={false} className="p-2">
          <p className="text-[11.5px] font-medium text-danger">Danger zone</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted">
            Reset removes the queue, jobs, events, answers, document notes, saved searches, and
            settings from this browser. It does not touch anything on Handshake.
          </p>
        </Card>

        <p className="text-[10.5px] leading-snug text-muted">
          Contains your searches, answers, documents and history. Credentials are excluded. Do not
          attach to bug reports.
        </p>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Reset everything?"
        description="This clears all Handshook data in this browser and starts setup from the beginning. Download a backup first if you want a copy."
        confirmLabel="Reset local data"
        tone="danger"
        loading={resetting}
        confirmDisabled={!canReset}
        onConfirm={() => {
          if (canReset) void resetAll();
        }}
        onCancel={() => {
          setConfirmOpen(false);
          setConfirmText('');
        }}
      >
        <Field
          label="Type “reset” to confirm"
          hint="This is deliberately awkward so it cannot happen by accident."
        >
          <Input
            value={confirmText}
            autoComplete="off"
            onChange={(event) => setConfirmText(event.currentTarget.value)}
            placeholder="reset"
          />
        </Field>
        {!canReset && confirmText.length > 0 ? (
          <p role="alert" className="mt-1 text-[11.5px] font-medium text-danger">
            Type the word “reset” exactly.
          </p>
        ) : null}
      </ConfirmDialog>
    </Section>
  );
}
