# ELA Live Classroom (LiveKit)

Status: **Phases 1 (architecture) and 2 (backend) written. The browser classroom (Phase 3) is not built yet.** See "Verification status" before relying on anything here.

## Decisions (approved 19 Nov 2026)
| # | Decision |
|---|---|
| 1 | One Supabase Edge Function `live`. No Cloudflare Worker, no Firebase Cloud Functions. |
| 2 | LiveKit Cloud free plan for development and a pilot. Production plan or self-hosting is decided later. |
| 3 | Parents (and directors) get no live-room access. Learners are authorised from `sessions.studentUids`, never from `viewers`. |
| 4 | Attendance for ELA Live lessons comes only from verified LiveKit join/leave webhooks, never from a button click. |
| 5 | Other participants see learners as first name + initial of the last name ("Aisha B."). Hosts show in full. |
| 6 | v1 waiting room: only enrolled learners can enter, and they get no token until the teacher starts the class. |
| 7 | Chat is transient (LiveKit data messages). Nothing is stored. |
| 8 | Allow landscape in the installed app (manifest change comes with Phase 3). |

## Where things live (one authoritative store each)
| Thing | Store |
|---|---|
| Lesson schedule, audience | Firestore `sessions` (existing; a lesson is "ELA Live" when `provider == 'ela_live'` and `online == true`) |
| Room state | Firestore `liveRooms/{sessionId}` (new, server-written) |
| Verified join/leave facts | Firestore `liveParticipation/{sessionId}_{identity}` (new, server-written) |
| Webhook de-duplication | Firestore `liveEvents/{eventId}` (new, no client access) |
| Attendance result | Firestore `sessionAttendance` (existing), `method = 'live_webhook'` |
| Chat, hands, whiteboard strokes | LiveKit data channel only |
| Secrets | Supabase Edge Function secrets only |

## API (`POST https://<project-ref>.supabase.co/functions/v1/live`, JSON, `Authorization: Bearer <Firebase ID token>`)
| action | who | what |
|---|---|---|
| `token` `{sessionId}` | host or listed learner | Learner: `{status:'waiting'}` until the teacher starts, then a LiveKit token. Host: 409 "Start the class first" if no room. |
| `start` `{sessionId}` | host | Creates the room (new random name), marks it live, returns the host's token. Already live: returns a token (idempotent). |
| `end` `{sessionId}` | host | Closes the room, sets the lesson to `completed`, settles attendance. Only ever an explicit host action. |
| `mute` / `mute-all` | host | Mutes microphone track(s) server-side. |
| `remove` `{sessionId, identity}` | host | Removes the person and blocks re-entry until `unblock`. |
| `unblock` `{sessionId, identity}` | host | Lets them back in. |
| `permit` `{sessionId, identity, screenShare?, publish?, data?}` | host | Teacher-controlled permissions; stored so a reconnect keeps them. |
| `participants` `{sessionId}` | host | Verified participation list. |
| `reconcile` `{sessionId}` | host | Re-settles attendance (safe to repeat). |
| webhook `POST ...?hook=livekit` | LiveKit | Signature checked (JWT + body SHA-256). `participant_joined`, `participant_left`, `room_finished`. |

Host = the lesson's own teacher, or `super_admin` / `admin` / `principal`. A teacher cannot moderate another host. Every action re-reads the person's `users/{uid}` and the lesson **as that person**, so the existing Firestore rules decide visibility, and the function then applies `supabase/functions/live/policy.ts`.

## Access rules (policy.ts, unit-tested)
Entry needs: a role in this lesson (host or listed learner) → `provider == 'ela_live'` → `status == 'scheduled'` → inside the window (15 min before start until 30 min after end). A cancelled or completed lesson can no longer be joined.

## LiveKit grants
| | Host | Learner |
|---|---|---|
| Join, subscribe | yes | yes |
| Publish camera + microphone | yes | yes (unless the teacher turns it off) |
| Publish screen / screen audio | yes | only when the teacher permits |
| Data messages (chat, hands, whiteboard) | yes | yes (unless the teacher turns it off) |
| `roomAdmin`, `roomCreate`, `roomList`, `roomRecord`, `hidden`, `recorder` | no | no |

Moderation never uses a browser token: it goes through this function. Tokens last 20 minutes. Rooms close 10 minutes after becoming empty, so a teacher dropping off does not end the lesson. Capacity is audience size + 8, capped at 100 (the free plan's limit).

## Identities
Room name: `ela-` + 128 random bits (no class/teacher/learner information). Participant identity: first 24 hex chars of HMAC-SHA256(`LIVE_ID_SECRET`, `sessionId:uid`), so it is stable inside a lesson, unlinkable across lessons, and reveals nothing. Display names never contain an email or phone number.

## Attendance
1. `participant_joined` for a learner creates `sessionAttendance/{sessionId}_{uid}` only if none exists (`present`, early/on-time/late from the server-recorded join time and `settings/attendance.onTimeGraceMinutes`). A record made by a teacher is never overwritten.
2. When the room ends (`end`, `room_finished`, or `reconcile`), open connections are closed at the end of the lesson, and a record **this system created** is changed to `left_early` if the learner was connected for less than 50% of the scheduled time. A teacher can still correct any record (reason required, as before).
3. Learners who never joined get no record here. The teacher's existing "Finalise" marks absences. No attendance is invented.
4. Webhooks can arrive twice, late or reordered: duplicates are dropped by event id, a "left" arriving before its "joined" is paired correctly, a lost "left" never inflates the connected time.

## Setup (once)
1. **LiveKit:** create a project at livekit.io (Build plan, free). Copy the WebSocket URL, API key and API secret.
2. **Supabase > Edge Functions > Secrets:** `LIVEKIT_URL` (`wss://...`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVE_ID_SECRET` (any long random text, 40+ characters). `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT` already exist for the other functions.
3. **Deploy the function** named `live` from `supabase/functions/live/` (three files: `index.ts`, `policy.ts`, `livekit.ts`), JWT verification **off**.
4. **LiveKit > Settings > Webhooks:** add `https://<project-ref>.supabase.co/functions/v1/live?hook=livekit`.
5. **Publish `firebase/firestore.rules`** again (new blocks `liveRooms`, `liveParticipation`, `liveEvents`).
6. Run the tests: `npm test` (new file `tests/live.test.ts`).

## Browser classroom (Phase 3)
Route `/app/live/:sessionId` (lazy-loaded, signed-in roles only). In the schedule form choose provider **ELA Live Classroom (in the portal)**; the session dialog then shows a button that opens the room. For these sessions the button does **not** mark attendance; only LiveKit webhooks do.

Files: `src/lib/live/protocol.ts` (chat, hands, whiteboard packets, validation, rate limit, tile priority), `src/features/live/` (`api.ts`, `useLiveRoom.ts`, `VideoTile.tsx`, `Whiteboard.tsx`, `Panels.tsx`, `Classroom.tsx`, `LiveClassroomPage.tsx`), `tests/liveProtocol.test.ts`. Edited: `package.json` (adds `livekit-client`), `src/App.tsx`, `src/services/schedule.ts`, `src/features/schedule/SessionForm.tsx`, `SessionDialog.tsx`, `vite.config.ts` (orientation any).

Behaviour: learners wait (polling every 5 s) until the teacher starts the class; audio-only mode; reconnect with back-off; wake lock; chat, raise hand, whiteboard (pen, highlighter, eraser, line, rectangle, ellipse, undo, clear; learners draw only when the teacher allows); teacher can mute, remove, unblock and end the class.

Setup extra: run `npm install` (new dependency). The function URL is derived from the existing files gateway; set `VITE_LIVE_GATEWAY_URL` only to override it.

## Verification status (read this)
| Part | Status |
|---|---|
| Access rules, grants, identities, participation reducer | Unit tests written, 28 passing with a stand-in for Vitest |
| Classroom protocol (chat, hands, board, tiles) | 23 tests passing the same way. Run `npm test` to confirm |
| `index.ts`, `livekit.ts` | Type-checked with stand-in types only. **Never run** |
| React components, `useLiveRoom.ts`, livekit-client calls | Syntax-checked only. **Not type-checked** against real React/livekit-client types. Run `npm run typecheck` |
| LiveKit server API field names and webhook format | Written from knowledge, **not checked against a live project** |
| Firestore rules | Not run in the emulator |
| Two devices, Android Chrome, low bandwidth, attendance end to end | **Not tested** |

## Known limits
- Data-channel messages cannot be authenticated beyond sender identity; clients enforce who may draw, and the teacher can switch a learner's publishing off.
- Android Chrome generally cannot share the screen (button hidden when unsupported).
- Whiteboard: no text tool, no pages, not saved after class. No microphone picker.
- A lesson ended with `end` becomes `completed` and cannot be re-opened.
- Events from an earlier room of the same lesson are ignored.
- No per-learner admit; no recording (Phase 5).
- LiveKit free plan: 5,000 participant-minutes a month, 100 concurrent participants.

## Next
Phase 4: attendance labels, session history and reports for `live_webhook`. Phase 5: recording (storage, cost, consent). Phase 6: full device testing report.
