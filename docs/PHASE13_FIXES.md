# Phase 13: fixes after live testing

## 1. Automatic attendance on the class link (root cause found)
The code read the learner's attendance record before creating it. The security rules refuse a read of a record that does not exist yet, so every attempt failed with "could not be recorded". It now checks with a query carrying the learner's own id (allowed), then creates the record. Learners also see a clear message when they are not on the class list, and an error code when something else blocks it.
File: `src/services/attendance.ts`, `src/features/schedule/SessionDialog.tsx`.

## 2. PowerPoint shown inside the page
.ppt/.pptx files now open in a free online viewer (Microsoft by default, one button switches to Google's), with Full screen and Download. The file is passed as a short-lived signed link. Needs an internet connection; animations and some fonts can differ. If a viewer cannot load a file, Download still works. PDF and Google Slides are unchanged.
File: `src/features/learning/Viewers.tsx`, `src/lib/learning.ts`.

## 3. Assignments
- New field "Files for learners" on the assignment create/edit form (up to 5 files). The "Files" button on each row still works.
- The assignment list now shows "Handed in 3 / 12" and a "to mark" badge, live, plus the number of submissions on the Submissions button.
- Files: `src/components/common/FilesField.tsx` (new form field type `files`), `src/features/lms/work.tsx`.

## 4. Notifications reach only the right learners
Cause: a timetable class stores a copy of who it is for. When a learner changed class, the old class kept them (so they kept getting its notices and reminders) and the new class never had them.
- Changing a learner's class (edit form, or "Promote class") now updates their upcoming sessions: removed from the old class, added to the new class (unless the teacher had left them out). Past sessions and attendance history are never changed. A parent is removed only if none of their other children are in that class.
- Only the learner and their own parents are told about their class change.
- Notification titles now name the class, for example "Class updated: Phonics (Nursery 2)".
- One-off clean-up for lists that are already wrong: Students page, button **Fix timetable lists** (admin / principal). Individual or mixed-group sessions with no class are not touched.
- Needs an admin or principal login to update sessions (security rules). Teachers and admissions staff saving a class change will see a message asking an admin to save it.
- Files: `src/services/sessionSync.ts`, `src/lib/schedule/audienceSync.ts`, `src/services/ems.ts`, `src/features/ems/people.tsx`, `src/services/schedule.ts`, `supabase/functions/notify/*`.

## Deploy
1. Upload the files in the zip.
2. Redeploy the `notify` Edge Function (optional: it adds the class name to class reminders).
3. No new Firestore rules this time. If attendance still fails, republish `firebase/firestore.rules` (the link-attendance rule `attLinkCreate` must be live) and read the error code shown.
4. After deploying, an admin presses **Fix timetable lists** once.

## Not tested live
184 unit tests pass (class-change audience logic, viewer links, drawing pad, file rules). The attendance fix, the online viewer, uploads and the timetable update have not been run against live services.
