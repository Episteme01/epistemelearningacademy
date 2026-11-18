# Phase 14: resources, Selar store, timetable days

## 1. Resource groups
Resources page: tabs **All / Classes / Subjects / Courses**. Each tab shows headings (for example "Nursery 2", "Maths", a course title) and anything without one goes under **Others**, always last. Set Class, Subject and Course when you add or edit a resource.

## 2. Learners and parents only see resources given to them
- A learner or parent can open a resource only when it is **published** AND attached to:
  - an assignment, homework, classwork, project or presentation for them (parents of those learners too), or
  - a lesson of a course they are enrolled in (learners).
- Resources not attached to anything are visible to teachers and school leaders only. The old "Students / Parents" tick boxes are gone.
- How it works: each resource stores `viewerUids` (learners and parents of the work using it) and `courseLinks` (up to 3 courses). The work's audience is the same one the assignment already uses ("Refresh audience" re-reads it).
- **Firestore rules changed: republish `firebase/firestore.rules`.**
- After deploying, a leader or teacher must press **Refresh who can see** on the Resources page once. It gives access to resources already used by existing assignments and lessons. Until then learners will not see them.
- When learners join a class later, press "Refresh audience" on the assignment (as before); resources follow it.
- Limits: 6 resources per piece of work; 3 courses per resource.

## 3. Pick resources into work
Assignment form (homework, classwork, project) has **Learning materials from Resources**: search, tick, done. New type **Presentation (view only, nothing to hand in)**: learners see it in Assignments with the materials and no submit button; it is not counted as homework in the parent monitor. Learners open materials in the in-page viewer (PDF, PowerPoint, Google Slides, video, pictures) with a download link. Draft resources are flagged in the picker: publish them so learners can open them. Course lessons already pick a resource and now give enrolled learners access automatically.

## 4. Selar store
Home page section "Episteme on Selar" with a gold button, a slim banner on the public Resources page, and "Our store on Selar" in the footer. The link lives in `src/config/links.ts` only.

## 5. Timetable: pick the days once
Schedule a class, **Repeats: Weekly, on the days I choose**, tick the days (for example Mon, Wed, Sat, Sun) and leave **Ends: Automatically, at the end of the term**. The calendar creates every session on those days from the first class date to the term end (terms come from Academic settings), with a live preview ("10 sessions will be created, from … to …") and the usual clash check. The first date does not need to be a chosen day. If the first date is not inside a term, choose a count or an end date instead. A single schedule is limited to 150 sessions. To give one learner their own days, tick only that learner under "Who attends".

## Deploy
1. Upload the zip. 2. Republish `firestore.rules`. 3. Press **Refresh who can see** once. 4. No new environment variables or functions.

## Not tested live
200 unit tests pass (access rules logic, grouping, day generation). The Firestore rules, the picker and the schedule form have not been run against the real database; test with a student, a parent and a teacher login after deploying.
