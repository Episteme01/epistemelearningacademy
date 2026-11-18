# Curriculum policy

1. **Purpose.** An academically ambitious but developmentally appropriate preschool programme for ELA, shaped by Nigerian expectations, British early-years practice and ELA's aim: knowledge, skills, character and contribution.
2. **Four classes.** Toddler, Nursery 1, Nursery 2, Reception. These names are official and used everywhere, including IDs and JSON.
3. **Four subjects per class.** Numeracy, Literacy, Science, Social Habits. They are not the seven EYFS areas; see `STANDARDS_ALIGNMENT.md` for the mapping.
4. **Calendar.** Three terms, ten teaching weeks, five lessons a week: 150 planned lessons per subject per class. Session names and dates are never written into the content.
5. **Pedagogy.** Play, guided play, practical work, stories, songs, role play, outdoor learning; short direct teaching where needed. Little paper work. Low-cost local resources by default.
6. **Behaviour.** No shame, fear, humiliation or physical punishment. Positive guidance only.
7. **Honesty about standards.** No invented codes, standards or quotations; no claim of government approval or certification.
8. **Quality gate.** A lesson is only counted when it passes `tools/validate.mjs`. A programme is only "complete" when all 150 lessons and its framework pass. Status stays `draft` until an ELA reviewer approves.
9. **Language.** British English; Nigerian names, foods and settings; no single-ethnic or religious assumptions in Science and Social Habits.
10. **Safety.** Every practical activity has a safety line; no choking hazards, unsafe chemicals or unsupervised work (see `shared/safety-guidelines.md`).
11. **Teacher-only content.** Teacher notes, expected answers and reflections must never be shown to learners or inside learner-facing exports.
12. **Change control.** Changes by GitHub commit; bump the `version` field when a lesson changes meaningfully.
