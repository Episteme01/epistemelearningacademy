import { PenTool } from 'lucide-react';
import { Card, CardBody, PageHeader } from '@/components/ui/card';
import { useAuth } from '@/features/auth/AuthContext';
import { DrawingPad } from './DrawingPad';

/** Practice pad: write, draw, do sums. Nothing is uploaded; learners download the picture if they want to keep or share it. */
export function PadPage() {
  const { uid } = useAuth();
  return (
    <>
      <PageHeader title="Drawing pad" description="Practise handwriting, draw diagrams and work out problems. To send a drawing as homework, open the assignment and choose “Draw your answer”." />
      <Card><CardBody>
        <p className="mb-3 flex items-center gap-2 text-sm text-muted"><PenTool className="h-4 w-4 text-forest-500" /> Tip: pick “Handwriting lines” paper to practise letters and numbers.</p>
        <DrawingPad persistKey={`practice-${uid ?? 'guest'}`} />
      </CardBody></Card>
    </>
  );
}
