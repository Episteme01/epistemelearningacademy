# Phase 3: Live-class attendance

## How it works
1. **Link click = attendance (changed Nov 2026).** When a learner opens the class link from the website, `recordLinkAttendance` writes their attendance at once as *present* (method `link_click`, early / on time / late from the server clock) with no teacher verification step. Only enrolled learners, once per class, from 15 min before the start to the end; the click is also logged in `sessionAccess`. **Limit:** a click proves the link was opened, not that the learner stayed or took part, so teachers can still correct any record (reason required) or use *Left early* / *Absent*. Learners who cannot use the link still have the manual *check me in* (pending verification). Rules: `attLinkCreate` in firestore.rules (republish them).
2. **Learner check-in.** Inside the class window (15 min before the start until the end) a learner presses "check me in". The record is created with the **server time** and status `pending_verification`. Firestore rules make it create-only, so it cannot be edited, repeated (document id is `{sessionId}_{studentUid}`), or made for another learner.
3. **Teacher confirms.** The session's teacher or an admin/principal confirms (no reason needed) or marks/corrects (reason of 5+ characters required). Confirming locks in early / on time / late.
4. **Finalise.** After the class starts, "Finalise" marks every invited learner with no record as Absent (`auto_finalised`).
5. **Corrections** write the record and an `attendanceLog` entry in one batch. The rules reject a change without a matching log entry, and the log is append-only.

## Early / on time / late
Early: before the scheduled start. On time: from the start up to the grace period (default 5 min, `settings/attendance.onTimeGraceMinutes`, editable by admins on the Class attendance page). Late: after that, with "late by N min" measured from the start.

## Statuses
pending verification, present (early / on time / late), left early, absent, excused. "No record" is shown when nothing was recorded.

## Reports (`/app/attendance`)
Filters: date range, academic session, class, course, teacher, learner/child. Group by learner, class, course, teacher or session. CSV export and print. Percentage = confirmed attendances / (expected sessions minus excused). Pending and "no record" are never counted as attended. Learners see only themselves, parents only their children, teachers only their own classes, leaders and directors everyone.

## Schema
- `sessionAttendance/{sessionId}_{studentUid}` (see `SessionAttendance` in `src/types/models.ts`)
- `attendanceLog/{auto}` (see `AttendanceLog`)
- `settings/attendance` `{ onTimeGraceMinutes }`
No composite indexes are needed (equality-only queries).

## Known limits
- Check-in is student-asserted; that is why it stays pending until a teacher verifies it.
- There is no check-out or join/leave data. That needs a meeting-provider API (Zoom/Meet/Teams). "Left early" is a manual teacher status.
- Absent records need "Finalise" (an optional Cloud Function could automate it).
- A parent linked after sessions were created only appears on a session once its audience is re-saved.
- The rules and UI were not run against the Firebase emulator in this environment. Test with real accounts after publishing the rules.
