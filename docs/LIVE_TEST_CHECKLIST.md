# ELA Live Classroom: test checklist (Phase 6)

Do the parts in order. Mark each step Pass or Fail. For every Fail, copy the exact error text or take a screenshot and send it back. Never paste your LiveKit API secret or `LIVE_ID_SECRET` anywhere.

You need: a teacher login, two learner logins (call them Learner A and Learner B, both enrolled in the test class), two phones (teacher on one, Learner A on the other), and ideally a third device for Learner B.

## Part 1: Setup (once)
1. Create a free project at livekit.io. Copy the WebSocket URL (`wss://...`), API key and API secret.
2. Supabase > Edge Functions > Secrets: add `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVE_ID_SECRET` (40+ random characters). Check `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT` exist.
3. Deploy the function `live` from `supabase/functions/live/` (`index.ts`, `policy.ts`, `livekit.ts`) with JWT verification **off**.
4. LiveKit > Settings > Webhooks: add `https://<project-ref>.supabase.co/functions/v1/live?hook=livekit`.
5. Firebase console > Firestore > Rules: publish `firebase/firestore.rules`.
6. On your computer: unzip all phase zips over the repo, then run `npm install`, `npm run typecheck`, `npm test`. All three must finish with no errors. If typecheck fails, send me the messages.
7. Push to GitHub, wait for the Pages deploy, and open the site once on each phone (reload to be sure you have the new version).

| Step | Result | Notes |
|---|---|---|
| 1-5 done | | |
| typecheck clean | | |
| tests pass | | |
| site deployed | | |

## Part 2: Scheduling
1. As teacher, create a session starting in about 10 minutes, provider **ELA Live Classroom (in the portal)**, with Learner A and B invited.
2. Open the session. The "ELA Live Classroom" block and Join button appear.
3. As Learner A, open the session. The dialog shows "Attendance is recorded automatically" and no manual check-in button.

## Part 3: Waiting room
1. Learner A taps Join before the teacher starts. Expect a waiting screen, no error.
2. Teacher opens the room and starts the class. Within about 10 seconds Learner A should enter automatically.
3. A learner not invited to the session (any other learner login) must be refused.
4. A learner opening the room much earlier than 15 minutes before the start must be refused.

## Part 4: In the room (two phones)
| Step | Result | Notes |
|---|---|---|
| Teacher video and audio reach Learner A | | |
| Learner A mic and camera work, teacher sees and hears | | |
| Mute/unmute and camera on/off update on the other phone | | |
| Chat both directions (wait ~2 s between messages) | | |
| Sending 6 chat messages quickly gets rate limited, no crash | | |
| Learner raises hand; teacher sees it in People, acknowledges it | | |
| Teacher opens the board; Learner A can draw only after "Learners can draw" is on | | |
| Both draw; strokes appear on the other phone; undo works | | |
| Teacher clears the board | | |
| Learner B joins late and receives the existing drawing | | |
| Teacher mutes Learner A from People | | |
| Teacher "Mute all" | | |
| Teacher removes Learner A; A cannot rejoin; teacher unblocks; A rejoins | | |
| Screen share button is hidden on Android Chrome (expected) | | |
| Rotate phone to landscape and back: layout stays usable | | |

## Part 5: Bad connections
| Step | Result | Notes |
|---|---|---|
| Learner A turns on Audio only: video stops, sound continues | | |
| Switch Learner A from Wi-Fi to mobile data: reconnects within about 20 s | | |
| Airplane mode for 10 s then off: shows "Reconnecting" then returns | | |
| Lock the screen for 30 s then unlock: returns to the room | | |
| Low-data test: Learner A on 3G/weak signal stays connected in audio only | | |
| No "tap to hear" prompt problem: if one appears, tapping it starts sound | | |

## Part 6: Attendance (check after the class is ended)
1. Teacher taps **End class** (confirm). Both phones show the ended screen.
2. Open the session dialog as teacher. Expect:

| Check | Expected | Result |
|---|---|---|
| Learner A | Present, correct early/on time/late, "joined the live classroom", connected minutes close to real | |
| Learner A joined twice (after the airplane-mode test) | joins count is 2 or more, minutes not doubled | |
| Learner B who joined for only 1-2 minutes | Left early | |
| A learner who never joined | Not recorded (until the teacher presses Finalise) | |
| Teacher corrects Learner A (reason required) | change saved and not overwritten later | |
| Attendance page and Analytics include the class | | |

3. In LiveKit > Webhooks, check recent deliveries show success (200). If they fail, send me the status and message.
4. In Supabase > Edge Functions > `live` > Logs, look for errors and send me any you see.

## Part 7: Security spot checks
1. Open the room URL while signed out: you are sent to sign in.
2. As a parent login: the room is refused.
3. As a learner, the People panel shows no mute/remove controls.
4. In your browser's page source or network tab, no LiveKit API secret appears anywhere.

## Reporting back
Send me: the Fail rows, the exact error text or screenshot, the phone model and Chrome version, and the Supabase function logs for the time of the failure.
