// ELA curriculum validator. Run from the ela-curriculum folder:  node tools/validate.mjs
// Uses "ajv" for JSON Schema validation if it is installed (npm i -D ajv); otherwise the built-in
// structural check below runs and the report says that full schema validation was NOT performed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, CLASSES, SUBJECTS, TERMS, WEEKS_PER_TERM, DAYS_PER_WEEK, weekId, lessonId, programmeId, programmeDir, walk, pad2 } from './common.mjs';

const problems = [];
const warn = [];
const bad = (file, msg) => problems.push({ file: relative(ROOT, file), message: msg });
const note = (file, msg) => warn.push({ file: relative(ROOT, file), message: msg });

// ---------- schema engine ----------
let ajv = null;
let schemaMode = 'builtin-required-fields-only';
try {
  const { default: Ajv } = await import('ajv');
  ajv = new Ajv({ allErrors: true, strict: false });
  for (const n of ['lesson', 'scheme-of-work', 'curriculum']) ajv.addSchema(JSON.parse(readFileSync(join(ROOT, 'schemas', `${n}.schema.json`), 'utf8')));
  schemaMode = 'ajv-json-schema-draft-07';
} catch { /* fall back */ }
const schemaId = (n) => `https://episteme01.github.io/ela-curriculum/${n}.schema.json`;
function schemaCheck(file, data, name) {
  const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', `${name}.schema.json`), 'utf8'));
  if (ajv) {
    const v = ajv.getSchema(schemaId(name));
    if (!v(data)) for (const e of v.errors.slice(0, 8)) bad(file, `schema (${data.id ?? name}): ${e.instancePath ?? e.dataPath ?? ''} ${e.message}`);
  } else {
    for (const k of schema.required ?? []) if (!(k in data)) bad(file, `missing required property "${k}"`);
  }
}

// ---------- sources ----------
const sourceFile = join(ROOT, 'SOURCE_REGISTER.md');
const sourceIds = new Set(existsSync(sourceFile) ? [...readFileSync(sourceFile, 'utf8').matchAll(/\bSRC-[A-Z0-9-]+\b/g)].map((m) => m[0]) : []);

// ---------- scan ----------
const US = /\b(color|colors|colored|organize|organized|recognize|recognized|center|centers|practice (?:the|with|your)|neighbor|favorite|behavior|gray|program(?!me)\b|meter|liter|analyze|realize)\b/i;
const PLACEHOLDER = /(to be added|lorem|tbd|todo|continue similarly|and so on|\.\.\.|…|placeholder|lesson content)/i;
const files = [...walk(join(ROOT, 'preschool'))];
const jsonFiles = files.filter((f) => f.endsWith('.json'));
const seenIds = new Map();
const contentHashes = new Map();
const programmes = {};
for (const c of Object.keys(CLASSES)) for (const s of Object.keys(SUBJECTS)) programmes[programmeId(c, s)] = { class: CLASSES[c].name, subject: SUBJECTS[s].name, weeks: new Set(), lessons: new Set(), hasCurriculum: false };

const text = (v) => JSON.stringify(v);
for (const f of jsonFiles) {
  let data;
  try { data = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { bad(f, `invalid JSON: ${e.message}`); continue; }
  const rel = relative(ROOT, f);
  if (rel.includes(`${'preschool'}/config/`)) continue;
  if (/curriculum\.json$/.test(f)) {
    schemaCheck(f, data, 'curriculum');
    const p = programmes[data.id];
    if (!p) bad(f, `unknown programme id ${data.id}`); else p.hasCurriculum = true;
    for (const r of data.references ?? []) if (!sourceIds.has(r)) bad(f, `reference ${r} is not in SOURCE_REGISTER.md`);
    continue;
  }
  if (!/week-\d\d\.json$/.test(f)) continue;
  schemaCheck(f, data, 'scheme-of-work');
  const m = /^ELA-PS-(TOD|N1|N2|REC)-(NUM|LIT|SCI|SOC)-T([1-3])-W(\d\d)$/.exec(data.id ?? '');
  if (!m) { bad(f, `bad week id ${data.id}`); continue; }
  const [, c, s, t, w] = m;
  const prog = programmes[programmeId(c, s)];
  if (data.class !== CLASSES[c].name) bad(f, `class "${data.class}" does not match id (${CLASSES[c].name})`);
  if (data.subject !== SUBJECTS[s].name) bad(f, `subject "${data.subject}" does not match id (${SUBJECTS[s].name})`);
  if (Number(t) !== data.term || Number(w) !== data.week) bad(f, 'term/week do not match the id');
  if (!f.includes(`/${CLASSES[c].folder}/${SUBJECTS[s].folder}/term-${t}/week-${w}.json`)) bad(f, 'file is in the wrong folder for its id');
  if (seenIds.has(data.id)) bad(f, `duplicate week id (also ${seenIds.get(data.id)})`); else seenIds.set(data.id, rel);
  prog.weeks.add(data.id);
  for (const r of data.references ?? []) if (!sourceIds.has(r)) bad(f, `reference ${r} is not in SOURCE_REGISTER.md`);
  if (!Array.isArray(data.lessons)) continue;
  const days = new Set();
  for (const L of data.lessons) {
    const where = `${rel} (${L.id})`;
    schemaCheck(f, L, 'lesson');
    if (L.id !== lessonId(c, s, Number(t), Number(w), L.day)) bad(f, `lesson id ${L.id} does not match its day ${L.day}`);
    if (L.class !== data.class || L.subject !== data.subject || L.term !== data.term || L.week !== data.week) bad(f, `${L.id}: class/subject/term/week differ from the week record`);
    if (days.has(L.day)) bad(f, `${L.id}: duplicate day ${L.day}`); days.add(L.day);
    if (seenIds.has(L.id)) bad(f, `duplicate lesson id ${L.id} (also ${seenIds.get(L.id)})`); else seenIds.set(L.id, rel);
    prog.lessons.add(L.id);
    for (const r of L.references ?? []) if (!sourceIds.has(r)) bad(f, `${L.id}: reference ${r} is not in SOURCE_REGISTER.md`);
    // empty/placeholder/duplicate content
    const body = text([L.starter, L.presentation, L.teacherActivities, L.learnerActivities, L.practical, L.assessment]);
    if (PLACEHOLDER.test(body)) bad(f, `${L.id}: contains placeholder-style text (${PLACEHOLDER.exec(body)[0]})`);
    if (US.test(text(L))) note(f, `${L.id}: possible non-British spelling (${US.exec(text(L))[0]})`);
    const h = createHash('sha1').update(body).digest('hex');
    if (contentHashes.has(h)) bad(f, `${L.id}: lesson content duplicates ${contentHashes.get(h)}`); else contentHashes.set(h, L.id);
    const stub = text(L.presentation);
    if (stub.length < 400) note(f, `${L.id}: very short lesson presentation (${stub.length} characters)`);
  }
  for (let d = 1; d <= DAYS_PER_WEEK; d++) if (!days.has(d)) bad(f, `${data.id}: missing day ${d}`);
  if (data.lessons.length !== DAYS_PER_WEEK) bad(f, `${data.id}: ${data.lessons.length} lessons (expected ${DAYS_PER_WEEK})`);
}

// ---------- completeness ----------
const report = [];
let totalWeeks = 0, totalLessons = 0, complete = 0;
for (const [id, p] of Object.entries(programmes)) {
  const wk = p.weeks.size, ls = p.lessons.size;
  totalWeeks += wk; totalLessons += ls;
  const status = wk === TERMS * WEEKS_PER_TERM && ls === TERMS * WEEKS_PER_TERM * DAYS_PER_WEEK && p.hasCurriculum ? 'complete' : wk === 0 && !p.hasCurriculum ? 'not-started' : 'partial';
  if (status === 'complete') complete++;
  const termWeeks = [1, 2, 3].map((t) => [...p.weeks].filter((x) => x.includes(`-T${t}-`)).length);
  report.push({ id, class: p.class, subject: p.subject, status, frameworkJson: p.hasCurriculum, termWeeks, weeks: wk, lessons: ls, missingWeeks: [1, 2, 3].flatMap((t) => Array.from({ length: WEEKS_PER_TERM }, (_, i) => weekId(id.split('-')[2], id.split('-')[3], t, i + 1))).filter((x) => !p.weeks.has(x)).length });
}
const result = {
  generatedBy: 'tools/validate.mjs',
  schemaValidation: schemaMode,
  note: schemaMode === 'builtin-required-fields-only' ? 'ajv was not installed, so JSON Schema rules were NOT fully enforced. Run "npm i -D ajv" (or the GitHub Action) for full validation.' : 'Full JSON Schema validation ran.',
  expected: { programmes: 16, terms: 48, weeks: 480, lessons: 2400 },
  found: { programmesComplete: complete, weeks: totalWeeks, lessons: totalLessons },
  errorCount: problems.length,
  warningCount: warn.length,
  errors: problems.slice(0, 200),
  warnings: warn.slice(0, 200),
  programmes: report,
};
writeFileSync(join(ROOT, 'validation', 'validation-results.json'), JSON.stringify(result, null, 2) + '\n');
const rows = report.map((r) => `| ${r.id} | ${r.class} | ${r.subject} | ${r.status} | ${r.frameworkJson ? 'yes' : 'no'} | ${r.termWeeks.join(' / ')} | ${r.lessons} / 150 |`).join('\n');
writeFileSync(join(ROOT, 'validation', 'completeness-report.md'), `# Completeness report

Generated by \`tools/validate.mjs\`. Do not edit by hand.

- Schema validation: **${schemaMode}**
- Errors: **${problems.length}**, warnings: **${warn.length}**
- Programmes complete: **${complete} / 16**
- Weekly plans present: **${totalWeeks} / 480**
- Daily lessons present: **${totalLessons} / 2,400**

| Programme | Class | Subject | Status | Framework JSON | Weeks present (T1 / T2 / T3) | Lessons |
| --- | --- | --- | --- | --- | --- | --- |
${rows}

A programme is "complete" only when its framework JSON exists and all 30 weeks and 150 lessons validate.
`);
console.log(`schema: ${schemaMode}\nerrors: ${problems.length}, warnings: ${warn.length}\nprogrammes complete: ${complete}/16, weeks: ${totalWeeks}/480, lessons: ${totalLessons}/2400`);
for (const p of problems.slice(0, 40)) console.log(`ERROR ${p.file}: ${p.message}`);
for (const p of warn.slice(0, 15)) console.log(`warn  ${p.file}: ${p.message}`);
process.exit(problems.length ? 1 : 0);
