// Shared constants for the ELA curriculum tools. No dependencies.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const CLASSES = {
  TOD: { name: 'Toddler', folder: 'toddler' },
  N1: { name: 'Nursery 1', folder: 'nursery-1' },
  N2: { name: 'Nursery 2', folder: 'nursery-2' },
  REC: { name: 'Reception', folder: 'reception' },
};
export const SUBJECTS = {
  NUM: { name: 'Numeracy', folder: 'numeracy' },
  LIT: { name: 'Literacy', folder: 'literacy' },
  SCI: { name: 'Science', folder: 'science' },
  SOC: { name: 'Social Habits', folder: 'social-habits' },
};
export const TERMS = 3;
export const WEEKS_PER_TERM = 10;
export const DAYS_PER_WEEK = 5;
export const pad2 = (n) => String(n).padStart(2, '0');
export const programmeId = (c, s) => `ELA-PS-${c}-${s}`;
export const weekId = (c, s, t, w) => `ELA-PS-${c}-${s}-T${t}-W${pad2(w)}`;
export const lessonId = (c, s, t, w, d) => `${weekId(c, s, t, w)}-D${pad2(d)}`;
export const programmeDir = (c, s) => join(ROOT, 'preschool', CLASSES[c].folder, SUBJECTS[s].folder);

export function* walk(dir) {
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f === '.git') continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}
export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
