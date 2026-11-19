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

## Verification status (read this)
| Part | Status |
|---|---|
| Access rules, grants, names/identities, timing parity, participation reducer | **Unit tests written and passing** (28 tests, run with a stand-in for Vitest in a session without npm access; run `npm test` to confirm in your environment) |
| `index.ts`, `livekit.ts` | Type-checked with stand-in Deno/jose types. **Never run.** Not tested against Firestore, Supabase or LiveKit |
| LiveKit server API field names (`CreateRoom`, `UpdateParticipant`, `GetParticipant`, `MutePublishedTrack`, `RemoveParticipant`, `DeleteRoom`) and the webhook header format | Written from knowledge of the LiveKit API, **not checked against a live project** |
| Firestore rules | Not run in the emulator |
| Two devices in one room, Android Chrome, low bandwidth, attendance end to end | **Not tested** (needs your LiveKit project and real devices) |

## Known limits
- Data-channel messages (chat, whiteboard, hands) cannot be authenticated beyond the sender's identity. Clients will enforce who may draw; the teacher can also switch a learner's data publishing off with `permit`.
- A lesson ended with `end` becomes `completed` and cannot be re-opened by the host.
- Webhook events for an earlier room of the same lesson (after a restart) are ignored, because only the latest room name is stored.
- No per-learner admit/reject yet (decision 6). No recording yet (Phase 5: needs storage, cost and consent decisions).
- LiveKit's free plan: 5,000 participant-minutes a month (about six 45-minute lessons with 15 learners), 100 concurrent participants.

## Next
Phase 3: lazy-loaded `/app/live/:sessionId` classroom (video grid, controls, participants, chat, hands, whiteboard reusing `src/lib/drawing.ts`), "ELA Live Classroom" as a provider in the session form, a Join button in the session dialog, and the manifest orientation change.
