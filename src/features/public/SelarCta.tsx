import { ArrowRight, ShoppingBag } from 'lucide-react';
import { BRAND } from '@/config/brand';

/** Call to action for our Selar store. `strip` is the slim version for inner pages. */
export function SelarCta({ strip = false }: { strip?: boolean }) {
  const link = (cls: string) => (
    <a href={BRAND.selarUrl} target="_blank" rel="noopener noreferrer" className={cls}>Visit our Selar store <ArrowRight className="h-4 w-4" /></a>
  );
  if (strip) {
    return (
      <div className="mt-8 flex flex-col items-start justify-between gap-3 rounded-lg border border-gold-300 bg-cream p-5 sm:flex-row sm:items-center">
        <p className="flex items-center gap-2 text-sm text-ink"><ShoppingBag className="h-5 w-5 text-gold-600" /> Looking for more? Get our learning products on Selar.</p>
        {link('inline-flex items-center gap-1 rounded-md bg-forest-700 px-4 py-2 text-sm font-medium text-white hover:bg-forest-800')}
      </div>
    );
  }
  return (
    <section className="bg-cream">
      <div className="mx-auto max-w-7xl px-4 py-14 md:px-6">
        <div className="flex flex-col items-start justify-between gap-6 rounded-xl border border-gold-300 bg-white p-6 shadow-card md:flex-row md:items-center md:p-8">
          <div className="max-w-2xl">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-gold-600"><ShoppingBag className="h-4 w-4" /> Episteme on Selar</p>
            <h2 className="mt-2 text-2xl font-semibold md:text-3xl">Learning products you can buy and use today</h2>
            <p className="mt-2 text-muted">Explore the courses, materials and digital products from Episteme Learning Academy in our online store. Secure checkout, instant access.</p>
          </div>
          {link('inline-flex shrink-0 items-center gap-2 rounded-md bg-gold-500 px-6 py-3 font-medium text-forest-900 shadow hover:bg-gold-400')}
        </div>
      </div>
    </section>
  );
}
