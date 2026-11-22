# Progress manifest

Updated at the end of every batch. Counts come from `tools/validate.mjs`; see `validation/completeness-report.md`.

## Totals (target 16 programmes, 480 weeks, 2,400 lessons)

| Item | Done | Target |
| --- | --- | --- |
| Programmes complete | 2 (Toddler Numeracy, Toddler Literacy; both draft) | 16 |
| Programme frameworks written | 2 (Toddler Numeracy, Toddler Literacy; each with 30-week scope and sequence) | 16 |
| Weekly plans | 60 | 480 |
| Daily lessons | 300 | 2,400 |

## Batch log

| Batch | Content | Validation | Notes |
| --- | --- | --- | --- |
| 0 | Repository audit, framework documents, schemas, validator, progression matrix, shared files | Validator run: 0 errors (ajv JSON Schema), 8 warnings | Standards sources only partly verified (see SOURCE_REGISTER.md) |
| 1a | Toddler Numeracy: framework, 30-week scope and sequence, Term 1 Weeks 1 to 5 (25 lessons) | Passes validator; 8 warnings for short lesson presentations in Weeks 3 to 5 | Status draft. Weeks 3 to 5 are thinner than Weeks 1 and 2 and should be enriched |
| 1b | Toddler Numeracy Term 1 Weeks 6 to 10 (25 lessons) and the Term 1 scheme of work | Passes validator; 11 warnings in total for short Day 5 presentations | Status draft. Weeks 3 to 5 still to be enriched |
| 2 | Toddler Numeracy Term 2 complete: Weeks 1 to 10 (50 lessons) and Term 2 scheme of work | Passes validator (0 errors); warnings are short Day 5 presentations | Status draft |
| 3 | Toddler Numeracy Term 3 (Weeks 1 to 10, 50 lessons) and Term 3 scheme of work. Toddler Numeracy now has all 150 lessons | Passes validator (0 errors); 24 warnings, all short lesson presentations | Status draft. Programme is structurally complete, not yet reviewed or enriched |
| 4 | Toddler Literacy complete: framework, 30-week scope, phonics sequence (shared/phonics-sequence.md), Terms 1 to 3 (150 lessons) and term schemes of work. Also the portal importer (in the app repo, not in this folder) | Passes validator (0 errors, ajv JSON Schema); 57 warnings across both programmes, mostly short Day 5 presentations | Status draft. Weeks are untested with children and unreviewed by an early-years specialist |

## Remaining for Toddler Numeracy and Literacy

- Enrich Term 1 Weeks 3 to 5 and the Day 5 lessons flagged by the validator
- Enrich short Day 5 and review lessons in Toddler Literacy (same validator warning)
- Check the phonics sequence and the pure-sound pronunciation guidance with a phonics-trained teacher

## Remaining programmes (not started)

Toddler: Science, Social Habits. Nursery 1, Nursery 2, Reception: all four subjects each. Their frameworks, scopes and 150 lessons each.

## Status of everything written

`draft`. No reviewer has approved any content. Standards alignment is provisional.
