// Minimal typing for the parts of pdf.js the live classroom uses (the "legacy" build runs on older Android browsers).
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  interface Viewport { width: number; height: number }
  export interface PDFPageProxy {
    getViewport(o: { scale: number }): Viewport;
    render(o: { canvasContext: CanvasRenderingContext2D; viewport: Viewport }): { promise: Promise<void> };
    cleanup(): void;
  }
  export interface PDFDocumentProxy { numPages: number; getPage(n: number): Promise<PDFPageProxy>; destroy(): Promise<void> }
  export const GlobalWorkerOptions: { workerSrc: string };
  export function getDocument(src: { data: Uint8Array }): { promise: Promise<PDFDocumentProxy> };
}
