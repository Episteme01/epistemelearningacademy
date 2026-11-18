# LMS integration specification

Status: **specification only. Nothing is imported or published automatically, and no Firestore collection or security rule is changed.**

## What exists in the ELA app (inspected in source)

- `src/lib/curriculum.ts`: `Topic {id, curriculumId, parentId, title, order, objectives?, outcomes?, durationMin?}` (topic and subtopic only, one level), `SchemeRow {id, curriculumId, termId, week, topicId, subtopicId, objectives, activities, materials, assessment, outcomes, teacherUid, notes?}`, `MAX_WEEKS = 20`, `LEVELS` includes "Early Years".
- `src/lib/lessons.ts`: `LessonDoc` with `title, status, durationMin, objectives[], materials[], references[], subjectId, topicId, week` and rich sections `previousKnowledge, introduction, presentation, teacherActivities, learnerActivities, examples, practical, assessmentQuestions, assignment, conclusion`; teacher-only `lessonGuides` with `notes, preparation, teachingGuidance, expectedAnswers, differentiation`. Statuses: draft, review, approved, published, archived.
- Collections: `curricula`, `curriculumTopics`, `schemeOfWork`, `lessonPlans`, `lessonGuides/{lessonId}`.

The documentation and code agree on these names; the scheme has no day level, so daily lessons map to `lessonPlans`, not scheme rows.

## Mapping

| Library field | LMS target | Notes |
| --- | --- | --- |
| Programme (`ELA-PS-TOD-NUM`) | `curricula` doc, level "Early Years", `title` "Toddler Numeracy" | Store the library ID in a new optional field `libraryId` |
| Class | Class record (by name "Toddler" etc.) | Match to ELA class names in the LMS settings |
| Subject | Subject record (by name) | Match to the LMS subject list |
| Strand / week topic | `curriculumTopics` (parentId '') | One topic per distinct week topic |
| Week subtopic | `curriculumTopics` (child) | Subtopics of the week |
| Term, week | `schemeOfWork.termId`, `week` | `termId` must be mapped to the school's configured term record |
| Week objectives, activities, resources, assessment, outcomes | `schemeOfWork` fields | Join arrays with line breaks |
| Daily lesson | `lessonPlans` doc | `subjectId`, `topicId`, `week`, `durationMin`, `objectives[]`, `materials[]` |
| Lesson sections | Rich fields: `previousKnowledge`, `introduction` (= starter), `presentation` (= presentation steps), `teacherActivities`, `learnerActivities`, `practical`, `assessmentQuestions` (questions only), `conclusion`, `assignment` (= homeConnection) | Convert plain text to simple HTML paragraphs |
| Differentiation, expected answers, teacher reflection | `lessonGuides/{lessonId}` (teacher-only) | **Never** into `lessonPlans` rich fields |
| `learnerFacing` | Not imported; used for presentation prompts | |
| Status | `draft` on import | Approval stays in the LMS workflow |

## Import rules (for a future importer)

1. Dry run first, with a printed list of what would be created.
2. Create everything as `draft`.
3. Idempotent: look up by `libraryId` and skip or update, never duplicate.
4. The importer runs from an admin account in a script or Edge Function, not from a learner or parent session.
5. A library programme is imported only if `validation-results.json` has no errors for it.
6. Keep teacher-only data out of any learner-readable collection.
7. Month-sized batches: 500 writes per Firestore batch maximum, so a 150-lesson programme needs a few batches.

## Known gaps to decide before building the importer

- `lessonPlans` has no field for the `dayType`, `successCriteria` or `vocabulary`; either add optional fields (an explicit schema decision) or fold them into the rich text.
- Class and subject IDs are environment-specific, so a mapping table is needed per school.
