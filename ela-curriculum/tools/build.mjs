// Expands the compact batch sources in tools/batch-sources/ into the committed JSON and Markdown files.
// Usage: node tools/build.mjs            (all batch sources)
// The generated JSON/Markdown under preschool/ are the master copies once committed; edit them directly
// on GitHub. Re-running this script overwrites them, so only re-run it for a brand-new batch.
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, CLASSES, SUBJECTS, programmeDir, programmeId, weekId, lessonId, pad2 } from './common.mjs';

const VERSION = '1.0.0';
const STATUS = 'draft'; // nothing is "approved" until a qualified ELA reviewer says so
const dir = join(ROOT, 'tools', 'batch-sources');
const files = readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
const frameworks = {}; const terms = {};
for (const f of files) {
  const mod = (await import(pathToFileURL(join(dir, f)).href)).default;
  const key = `${mod.classCode}-${mod.subjectCode}`;
  if (mod.kind === 'framework') frameworks[key] = mod; else (terms[key] ??= []).push(mod);
}
const write = (p, s) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, s); };
const j = (o) => JSON.stringify(o, null, 2) + '\n';
const list = (a) => a.map((x) => `- ${x}`).join('\n');

function reflection(obj) {
  const first = obj[0].replace(/^(Children|Child|Learners?) (will )?/i, '').replace(/\.$/, '');
  return [
    `Which children could show "${first}" without help, and who needs another turn tomorrow?`,
    'What did the children say or do that I did not expect, and how will I use it in the next lesson?',
    'Which resource or instruction worked best, and what would I change before I teach this again?',
  ];
}

for (const [key, fw] of Object.entries(frameworks)) {
  const [c, s] = key.split('-');
  const cls = CLASSES[c].name, sub = SUBJECTS[s].name, pid = programmeId(c, s), base = programmeDir(c, s);
  const scope = fw.scope.map((w) => ({ term: w.term, week: w.week, weekId: weekId(c, s, w.term, w.week), topic: w.topic, subtopics: w.subtopics, objectives: w.objectives, vocabulary: w.vocabulary, expectedOutcomes: w.outcomes }));
  const curriculum = {
    id: pid, title: `${cls} ${sub}`, class: cls, subject: sub, level: 'Early Years',
    philosophy: fw.philosophy, rationale: fw.rationale, aims: fw.aims, learningOutcomes: fw.learningOutcomes,
    developmentalExpectations: fw.developmentalExpectations, keyCompetencies: fw.keyCompetencies, strands: fw.strands,
    priorKnowledge: fw.priorKnowledge, yearProgression: fw.yearProgression, assessmentPrinciples: fw.assessmentPrinciples,
    inclusion: fw.inclusion, crossCurricular: fw.crossCurricular, parentConnection: fw.parentConnection,
    scopeAndSequence: scope, references: fw.references, version: VERSION, status: STATUS,
  };
  write(join(base, 'curriculum.json'), j(curriculum));

  write(join(base, 'curriculum.md'), `# ${cls} ${sub}

**Programme ID:** ${pid} · **Version:** ${VERSION} · **Status:** ${STATUS} (not yet approved by an ELA reviewer)

## Subject philosophy
${fw.philosophy}

## Rationale
${fw.rationale}

## Aims
${list(fw.aims)}

## Learning outcomes by the end of the year
${list(fw.learningOutcomes)}

## Developmental expectations
${list(fw.developmentalExpectations)}

## Key competencies
${list(fw.keyCompetencies)}

## Curriculum strands
${fw.strands.map((x) => `- **${x.title}** (${x.id}): ${x.description}`).join('\n')}

## Prior knowledge
${fw.priorKnowledge}

## Progression across the year
${fw.yearProgression.map((x, i) => `- **Term ${i + 1}:** ${x}`).join('\n')}

## Assessment principles
${list(fw.assessmentPrinciples)}

## Inclusion and differentiation
${list(fw.inclusion)}

## Cross-curricular connections
${list(fw.crossCurricular)}

## Parent connection
${list(fw.parentConnection)}

## Source references
${fw.references.map((r) => `- ${r}`).join('\n')} (see \`SOURCE_REGISTER.md\`)

Other files in this folder: \`scope-and-sequence.md\`, \`term-N/scheme-of-work.md\`, \`term-N/week-NN.md\` and \`.json\`.
`);

  write(join(base, 'scope-and-sequence.md'), `# ${cls} ${sub} — annual scope and sequence

Three terms of ten teaching weeks. Five planned lessons a week (150 in the year). Dates are configured by ELA's academic calendar, not written here.

${[1, 2, 3].map((t) => `## Term ${t}: ${fw.yearProgression[t - 1].split('.')[0]}

| Week | Topic | Subtopics | Learning objectives | Key vocabulary | Expected outcomes |
| --- | --- | --- | --- | --- | --- |
${scope.filter((w) => w.term === t).map((w) => `| ${w.week} | ${w.topic} | ${w.subtopics.join('; ')} | ${w.objectives.join(' ')} | ${w.vocabulary.join(', ')} | ${w.expectedOutcomes.join(' ')} |`).join('\n')}
`).join('\n')}`);

  const merged = {};
  for (const m of terms[key] ?? []) { (merged[m.term] ??= { ...m, weeks: [] }).weeks.push(...m.weeks); }
  for (const tm of Object.values(merged)) {
    tm.weeks.sort((a, b) => a.week - b.week);
    const t = tm.term; const sw = [];
    for (const w of tm.weeks) {
      const sc = fw.scope.find((x) => x.term === t && x.week === w.week);
      if (!sc) throw new Error(`No scope entry for ${pid} T${t} W${w.week}`);
      const wid = weekId(c, s, t, w.week);
      if (w.lessons.length !== 5) throw new Error(`${wid} has ${w.lessons.length} lessons`);
      const lessons = w.lessons.map((L, i) => {
        const d = i + 1;
        const obj = L.obj;
        return {
          id: lessonId(c, s, t, w.week, d), title: L.title, class: cls, subject: sub, term: t, week: w.week, day: d,
          durationMin: L.min ?? tm.durationMin ?? 25, topic: sc.topic, subtopic: L.sub, dayType: L.type,
          objectives: obj, successCriteria: L.sc, previousKnowledge: L.prev ?? w.prev, vocabulary: L.vocab ?? sc.vocabulary,
          resources: L.mats, starter: L.starter,
          teacherActivities: L.steps.map((p) => p[0]), learnerActivities: L.steps.map((p) => p[1]),
          presentation: L.steps.map((p, k) => `Step ${k + 1}. Teacher: ${p[0]} Children: ${p[1]}`),
          practical: { title: L.prac[0], steps: L.prac[1], safety: L.prac[2] },
          differentiation: { support: L.sup, extension: L.ext },
          assessment: { method: L.method ?? 'Observe each child during the practical activity and note Emerging, Developing, Secure or Exceeding on the class record. Ask the questions below one to one or in a small group.', questions: L.qa.map((q) => ({ question: q[0], expected: q[1] })) },
          expectedOutcomes: L.outc, conclusion: L.concl, homeConnection: L.home,
          teacherReflection: reflection(obj),
          learnerFacing: { boardContent: L.board, pictures: L.pics, ...(L.song ? { songOrRhyme: L.song } : {}), ...(L.story ? { story: L.story } : {}) },
          activities: [L.prac[0]], references: L.refs ?? w.refs ?? tm.refs ?? fw.references, version: VERSION, status: STATUS,
        };
      });
      const week = {
        id: wid, class: cls, subject: sub, term: t, week: w.week, title: sc.title ?? sc.topic, topic: sc.topic, subtopics: sc.subtopics,
        weekType: sc.weekType, objectives: sc.objectives, vocabulary: sc.vocabulary, content: w.content, teachingActivities: w.teaching,
        learnerActivities: w.learning, resources: w.resources, assessment: w.assessment, expectedOutcomes: sc.outcomes,
        crossCurricular: w.cross, references: w.refs ?? fw.references, version: VERSION, status: STATUS, lessons,
      };
      write(join(base, `term-${t}`, `week-${pad2(w.week)}.json`), j(week));
      write(join(base, `term-${t}`, `week-${pad2(w.week)}.md`), weekMd(week));
      sw.push(week);
    }
    write(join(base, `term-${t}`, 'scheme-of-work.md'), `# ${cls} ${sub} — Term ${t} scheme of work

| Week | Topic and subtopics | Learning objectives | Content | Teaching activities | Learner activities | Resources | Assessment | Expected outcomes | Cross-curricular |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${sw.map((w) => `| ${w.week} | **${w.topic}**: ${w.subtopics.join('; ')} | ${w.objectives.join(' ')} | ${w.content} | ${w.teachingActivities} | ${w.learnerActivities} | ${w.resources.join('; ')} | ${w.assessment} | ${w.expectedOutcomes.join(' ')} | ${w.crossCurricular.join('; ')} |`).join('\n')}
`);
  }
}

function weekMd(w) {
  const DAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  return `# ${w.class} ${w.subject} — Term ${w.term}, Week ${w.week}: ${w.topic}

**ID:** ${w.id} · **Week type:** ${w.weekType} · **Version:** ${w.version} · **Status:** ${w.status}

**Subtopics:** ${w.subtopics.join('; ')}

## Learning objectives
${list(w.objectives)}

**Key vocabulary:** ${w.vocabulary.join(', ')}

**Content:** ${w.content}

**Teaching activities:** ${w.teachingActivities}

**Learner activities:** ${w.learnerActivities}

**Resources:** ${w.resources.join('; ')}

**Assessment:** ${w.assessment}

## Expected outcomes
${list(w.expectedOutcomes)}

**Cross-curricular connections:** ${w.crossCurricular.join('; ')}

${w.lessons.map((L) => `---

## Day ${L.day} (${DAY[L.day - 1]}): ${L.title}

**ID:** ${L.id} · **Duration:** ${L.durationMin} minutes · **Day type:** ${L.dayType} · **Subtopic:** ${L.subtopic}

### Learning objectives
${list(L.objectives)}

### Success criteria
${list(L.successCriteria)}

**Previous knowledge:** ${L.previousKnowledge}

**Key vocabulary:** ${L.vocabulary.join(', ')}

**Instructional materials:** ${L.resources.join('; ')}

### Starter
${L.starter}

### Step-by-step lesson presentation
${L.presentation.map((x) => `${x}`).join('\n\n')}

### Practical activity: ${L.practical.title}
${L.practical.steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}

**Safety:** ${L.practical.safety}

### Differentiation
- **Support:** ${L.differentiation.support}
- **Extension:** ${L.differentiation.extension}

### Assessment
${L.assessment.method}

${L.assessment.questions.map((q) => `- **Ask:** ${q.question}\n  **Expected response:** ${q.expected}`).join('\n')}

### Expected outcomes
${list(L.expectedOutcomes)}

### Conclusion
${L.conclusion}

### Home connection
${L.homeConnection}

### Teacher reflection (private)
${list(L.teacherReflection)}

### Learner-facing content (safe to turn into slides)
**Board or slide content:**
${list(L.learnerFacing.boardContent)}

**Picture suggestions:**
${list(L.learnerFacing.pictures)}
${L.learnerFacing.songOrRhyme ? `\n**Song or rhyme:** ${L.learnerFacing.songOrRhyme}\n` : ''}${L.learnerFacing.story ? `\n**Short story:** ${L.learnerFacing.story}\n` : ''}`).join('\n')}
`;
}
console.log('Build finished.');
