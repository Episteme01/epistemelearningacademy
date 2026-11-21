import { MAX_SOURCE_BYTES } from '@/lib/live/slideSources';

/** A PDF opened in the browser. Pages are drawn on demand into pictures (JPEG, longest side 1600 px) that are then shared like any other picture. */
export interface PdfDoc { pages: number; render: (n: number) => Promise<File>; close: () => void }
const MAX_EDGE = 1600;

export async function openPdf(data: ArrayBuffer, baseName: string): Promise<PdfDoc> {
  if (data.byteLength > MAX_SOURCE_BYTES) throw new Error('This PDF is too large (max 40 MB).');
  // loaded only when a teacher actually adds a PDF, so it costs nothing for everyone else
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
  let doc;
  try { doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise; } catch (e) {
    const name = e instanceof Error ? e.name : '';
    throw new Error(name === 'PasswordException' ? 'This PDF is password protected. Remove the password and try again.' : 'This PDF could not be read. Try saving it again as a PDF.');
  }
  if (doc.numPages < 1) { void doc.destroy(); throw new Error('This PDF has no pages.'); }
  const base = baseName.replace(/\.pdf$/i, '').replace(/[^\w-]+/g, '_').slice(0, 40) || 'slides';
  return {
    pages: doc.numPages,
    close: () => { void doc.destroy().catch(() => undefined); },
    render: async (n) => {
      const page = await doc.getPage(n);
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3, MAX_EDGE / Math.max(natural.width, natural.height)) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('This browser cannot draw PDF pages.');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
      canvas.width = 1; canvas.height = 1;                                   // hand the memory back (matters on phones)
      if (!blob) throw new Error(`Page ${n} could not be drawn.`);
      return new File([blob], `${base}-p${n}.jpg`, { type: 'image/jpeg' });
    },
  };
}
