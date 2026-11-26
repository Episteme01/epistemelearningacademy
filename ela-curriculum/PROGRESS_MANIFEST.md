# Progress manifest

Updated at the end of every batch. Counts come from `tools/validate.mjs`; see `validation/completeness-report.md`.

## Totals (target 16 programmes, 480 weeks, 2,400 lessons)

| Item | Done | Target |
| --- | --- | --- |
| Programmes complete | 5 (Toddler Numeracy, Literacy, Science, Social Habits; Nursery 1 Numeracy; all draft) | 16 |
| Programme frameworks written | 5 (all Toddler subjects and Nursery 1 Numeracy; each with 30-week scope and sequence) | 16 |
| Weekly plans | 150 | 480 |
| Daily lessons | 750 | 2,400 |

## Batch log

| Batch | Content | Validation | Notes |
| --- | --- | --- | --- |
| 0 | Repository audit, framework documents, schemas, validator, progression matrix, shared files | Validator run: 0 errors (ajv JSON Schema), 8 warnings | Standards sources only partly verified (see SOURCE_REGISTER.md) |
| 1a | Toddler Numeracy: framework, 30-week scope and sequence, Term 1 Weeks 1 to 5 (25 lessons) | Passes validator; 8 warnings for short lesson presentations in Weeks 3 to 5 | Status draft. Weeks 3 to 5 are thinner than Weeks 1 and 2 and should be enriched |
| 1b | Toddler Numeracy Term 1 Weeks 6 to 10 (25 lessons) and the Term 1 scheme of work | Passes validator; 11 warnings in total for short Day 5 presentations | Status draft. Weeks 3 to 5 still to be enriched |
| 2 | Toddler Numeracy Term 2 complete: Weeks 1 to 10 (50 lessons) and Term 2 scheme of work | Passes validator (0 errors); warnings are short Day 5 presentations | Status draft |
| 3 | Toddler Numeracy Term 3 (Weeks 1 to 10, 50 lessons) and Term 3 scheme of work. Toddler Numeracy now has all 150 lessons | Passes validator (0 errors); 24 warnings, all short lesson presentations | Status draft. Programme is structurally complete, not yet reviewed or enriched |
| 4 | Toddler Literacy complete: framework, 30-week scope, phonics sequence (shared/phonics-sequence.md), Terms 1 to 3 (150 lessons) and term schemes of work. Also the portal importer (in the app repo, not in this folder) | Passes validator (0 errors, ajv JSON Schema); 57 warnings across both programmes, mostly short Day 5 presentations | Status draft. Weeks are untested with children and unreviewed by an early-years specialist |
| 5 | Toddler Science complete: framework, 30-week scope, Terms 1 to 3 (150 lessons) and term schemes of work | Passes validator (0 errors); 105 warnings across three programmes, mostly short Day 5 presentations | Status draft. Untested with children; science activities need a safety read-through by the school |
| 6 | Toddler Social Habits complete: framework, 30-week scope, Terms 1 to 3 (150 lessons) and term schemes of work. The Toddler class is now complete (600 lessons) | Passes validator (0 errors); 205 warnings across four programmes, mostly short Day 5 presentations | Status draft. Week 6 of Term 3 (body safety) must be checked against the school safeguarding policy and shared with parents before use; untested with children |
| 7 | Nursery 1 Numeracy complete: framework, 30-week scope, Terms 1 to 3 (150 lessons) and term schemes of work | Passes validator (0 errors); 324 warnings across five programmes, mostly short Day 5 presentations | Status draft. Money week uses play money only; untested with children |

## Remaining for Toddler Numeracy and Literacy

- Enrich Term 1 Weeks 3 to 5 and the Day 5 lessons flagged by the validator
- Enrich short Day 5 and review lessons in Toddler Literacy, Science and Social Habits and Nursery 1 Numeracy (same validator warning)
- Check the phonics sequence and the pure-sound pronunciation guidance with a phonics-trained teacher

## Remaining programmes (not started)

Nursery 1 Literacy, Science and Social Habits; Nursery 2 and Reception (all four subjects each). Each needs a framework, scope and 150 lessons.

## Status of everything written

`draft`. No reviewer has approved any content. Standards alignment is provisional.
