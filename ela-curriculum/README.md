# ELA Preschool Curriculum and Lesson Library

**Episteme Learning Academy, Ilorin, Nigeria. Where Learning Meets Morality.**

This folder is the master, editable curriculum library for Toddler, Nursery 1, Nursery 2 and Reception. GitHub is the source of truth. Nothing here is published automatically to the LMS.

## Plan and status

16 programmes (4 classes x 4 subjects) x 3 terms x 10 weeks x 5 daily lessons = **2,400 lessons**.

Live status is in [`PROGRESS_MANIFEST.md`](PROGRESS_MANIFEST.md) and [`validation/completeness-report.md`](validation/completeness-report.md). Read those, not this paragraph, for what is finished. Everything written so far has status **draft** and needs review by a qualified ELA early-years teacher before use.

## Where things are

| Path | What it holds |
| --- | --- |
| `CURRICULUM_POLICY.md`, `ACADEMIC_FRAMEWORK.md` | Principles, structure, ID rules |
| `STANDARDS_ALIGNMENT.md`, `SOURCE_REGISTER.md` | How the curriculum relates to Nigerian and British frameworks, and exactly which sources were checked |
| `ASSESSMENT_FRAMEWORK.md`, `TEACHER_IMPLEMENTATION_GUIDE.md` | Assessment levels, teacher guidance |
| `LMS_INTEGRATION.md` | How the JSON maps to the existing Curriculum Studio and Lesson Studio |
| `schemas/` | JSON Schemas for lessons, weeks and programmes |
| `shared/` | Glossary, pedagogy, differentiation, rubrics, safety |
| `preschool/progression-matrix.md` | Toddler to Reception progression |
| `preschool/<class>/<subject>/` | `curriculum.md/.json`, `scope-and-sequence.md`, `term-N/scheme-of-work.md`, `term-N/week-NN.md/.json` |
| `tools/` | `validate.mjs` (checks everything), `build.mjs` (expands batch sources) |
| `validation/` | Generated reports |

## Editing from a phone

1. Open a `week-NN.json` (or `.md`) file on GitHub and tap the pencil.
2. Edit the text. In JSON keep the quotation marks and commas.
3. Commit with a clear message such as `Edit Toddler Numeracy T1 W03 D02 starter`.
4. The GitHub Action runs the validator and shows a green tick or red cross.

The `.json` file is the master. If you edit the `.md` version, edit the matching `.json` too (the `.md` files are generated from the JSON by `tools/build.mjs` for a first batch only).

## Checking

```
node tools/validate.mjs
```

Install `ajv` (`npm i -D ajv`) for full JSON Schema validation. Without it the validator says so and only checks required fields.

## Presentation readiness

Each lesson JSON has a `learnerFacing` block (board content, picture suggestions, optional song and story). Copy only that block and the lesson title, objectives and vocabulary into Chalkie AI, Teachy AI or MagicSchool AI. Never paste `teacherReflection`, `differentiation`, `assessment.expected` or `teacherActivities`; they are for teachers only. No presentations are generated here.
