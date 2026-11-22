# Phase 12: Drawing pad and assignment attachments

## Drawing pad
- Page: **Drawing pad** (`/app/pad`) for students and teachers. Practice writing, diagrams and sums. Nothing is uploaded; "Download picture" saves a PNG.
- Tools: pen, highlighter, eraser, line, box, circle; 8 colours; 4 thicknesses; undo/redo (Ctrl+Z); clear (asks first).
- Paper: plain, lined, squares, dots, handwriting lines (for letters and numbers).
- Works with finger, stylus or mouse. The canvas is a fixed 1200x800 picture so saved work looks the same on every screen.
- An unsent page is kept in the browser's own storage (this device only) and restored on return.
- **Draw your answer** in Assignments: the drawing becomes the learner's file submission (a PNG), then they press Submit. It uses the existing `submission` upload, so the 10 MB image limit and all submission rules apply. No rule or storage change.
- Code: `src/lib/drawing.ts` (logic, tested), `src/features/pad/DrawingPad.tsx`, `src/features/pad/PadPage.tsx`.

## Assignment attachments
- Teachers/admins: **Files** button on each assignment. Up to 5 files (image 10 MB, audio 20 MB, document 20 MB). Saved on the assignment as `attachments` (array of file references).
- Learners see the files on the assignment card and in the submit dialog. Files open through short-lived signed links; the file service asks Firestore whether the learner may read that assignment, so only the assigned class/course can open them.
- Storage: existing private `resources` bucket, folder `assignments/{teacherUid}/...`. No new bucket, no new environment variable, no Firestore rules change.
- **You must redeploy the `files` Edge Function** (new purpose `assignment_file`, new download collection `assignments`).
- Code: `supabase/functions/files/{policy,index}.ts`, `src/lib/filePolicy.ts`, `src/services/files.ts`, `src/lib/assignmentFiles.ts`, `src/features/lms/AssignmentFiles.tsx`.

## Not tested live
Unit tests cover undo/redo, paper, draft safety, attachment rules and the file-gateway policy. Drawing on a real touchscreen, the upload and the signed download have not been run against live services: test them once after deploying.

## Test checklist
1. Teacher: Assignments, Files, add a PDF and an image, remove one.
2. Student in that class: open the assignment, open both files.
3. A student in another class cannot open them.
4. Student: Draw your answer, Use this drawing, Submit. Teacher opens the submission and sees the picture.
5. Pad page: draw, undo, change paper, download, refresh (draft returns).

## Update 11: several files in one submission
- A learner can hand in up to 5 files together (a drawing, a written-on worksheet, a photo). Before, there was one file slot, so drawing after attaching a file replaced the attachment.
- The submission keeps `fileRef`/`fileName` (the first file) for older screens and adds `files` (all of them). Re-submitting with new files replaces all old files; submitting with none keeps the old ones.
- Firestore rules check every file is in the learner's own folder (`subFileOk`). The `files` Edge Function signs `submissions/{id}#{index}` from the `files` field. **Deploy both**: publish the rules, redeploy the `files` function.
- If a submit fails, the learner sees "NOT submitted" and the files uploaded so far are removed. The learner's card now shows when it was handed in and the file links.
