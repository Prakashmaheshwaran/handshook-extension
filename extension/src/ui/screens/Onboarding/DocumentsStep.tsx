import { Card } from '@/ui/components/Card';
import { DocumentChoices, type DocumentChoicesProps } from '@/ui/components/DocumentChoices';

export type DocumentsStepProps = DocumentChoicesProps;

export function DocumentsStep(props: DocumentsStepProps) {
  return (
    <Card>
      <h2 className="mb-2 text-[14px] font-semibold text-ink">Choose your documents</h2>
      <DocumentChoices {...props} />
    </Card>
  );
}
