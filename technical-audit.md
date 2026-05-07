# Alpha Experiences — Technical Audit & Remediation Plan

> Audience: engineering team for Alpha Anywhere
> Scope: **architecture, data, infra, code quality, security, ops.**
> Companion: `product-audit.md` (UX, features, content).
> **Real scale:** ~500 users today, ~5k as a stretch ceiling. **Not** a
> SaaS-scaling problem — an internal tool maintainability problem.
> Constraint: stay on Vercel. Don't add infra we don't need. Don't add
> processes the team won't follow.

This treats today's stack as a working MVP and proposes the smallest
useful set of changes to make it a maintainable system the team can
keep shipping on for a year+ without rewriting. **Most of the work
here is code quality and consistency, not infrastructure.**

---

## 1. Stack snapshot (today)

| Layer | What it is | Evidence |
|---|---|---|
| **Frontend** | Static HTML + vanilla JS, one file per route, inline `<style>`/`<script>` | 17 HTML files at repo root |
| **Routing** | Vercel rewrites | `vercel.json` |
| **API runtime** | Vercel serverless (Node 18+), 16 functions including a giant `[action].js` admin dispatcher | `api/**/*.js` |
| **Auth** | Google OAuth (server flow) → HMAC-SHA256-signed cookie session, 7-day TTL, `HttpOnly; Secure; SameSite=Lax` | `api/_lib/session.js`, `api/auth/[action].js` |
| **Authoritative DB** | One Google Sheet (`1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto`) | hardcoded in 11 files |
| **File storage** | Supabase Storage (signed-upload-URL pattern) | `api/submissions/upload-url.js`, `api/submissions/create.js` |
| **Email** | Intercom REST API + Apps Script (legacy parallel) | `api/_lib/lul-email.js` |
| **Build** | None. `package.json` has no scripts, no deps. | `package.json` |
| **CI / tests / lint** | None | confirmed |
| **Observability** | `console.error` + Vercel runtime logs | every file |

**Scope:** 17,816 lines across 41 files. **9 files break the project's
500-line rule.** Biggest: `api/admin/[action].js` at **2,806 lines**
(32 actions in one switch). Biggest HTML: `admin-lounge-passes.html` at
**1,300 lines**. Others: `admin-registrations.html` 792,
`admin-lounge-sessions` 770, `admin-trip-editor` 753, `trip-detail`
718, `trips` 666, `lounge-pick` 620, `admin-lounge-attendance` 603,
`api/lul/[action].js` 585, `admin-submissions.html` 584.

---

## 2. Reconstructed data model

Tab columns reconstructed from magic indexes in the readers (see
`api/trips/my.js:119-145`):

```
SHEET: 1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto

  FT_Admins          A: email
  FT_Catalog         A: trip_id  B: title  C: desc  D: emoji
                     E: trip_date  F: status  I: thumbnail_url
                     N: thumbnail_focus
  FT_Sessions        A: session_id  B: trip_id
                     C: start_time  D: end_time  (+zoom, nearpod)
  FT_Purchases       A: ?  B: email  D: session_id  E: trip_id
                     G: status (active/cancelled)
  FT_Submissions     id, trip_id, email, name, file_url, location,
                     created_at, reviewed?
  FT_Suggestions     timestamp, email, type, title, desc, status, notes
  FT_Notifications   admin notifications feed
  Sheet1             legacy LUL passes (token, name, email,
                     parent_email, exp_type, mode, date_sent, locked,
                     saved_selections, fulfilled, attendance, notes)
  LUL_Pass_Types     exp_type, label, mode, active
  LUL_Page_Copy      key, value (admin-editable copy)
```

**Implications:** all reads are full-tab `batchGet` (no key-by-id
lookup, every page hit re-fetches); writes are PUT/APPEND/CLEAR with no
transactions, no row IDs (concurrent writes can race); every reader
hardcodes column indices like `r[6]` (reordering a column silently
breaks the app).

**At 500 users, the I/O volume is fine.** The real pain points are
(a) magic column indices and (b) the occasional admin-vs-admin write
race. Both are fixable inside Sheets — see T1.

---

## 3. Auth flow

`/auth/login` → Google sign-in → `/auth/google` sets `ae_oauth_state`
cookie (state + b64url(returnTo)) → Google consent → `/auth/callback`
verifies state, exchanges code, decodes id_token, checks
`isAllowedDomain(email)` (2hourlearning.com / alpha.school) +
`isAdminEmail(email)` (Sheets `FT_Admins` lookup), sets `ae_session`
cookie (HMAC-signed, 7d) and redirects to `returnTo` or `/trips`.
Every API calls `getSession(req)`; `/api/admin/*` additionally requires
`session.isAdmin === true`. Legacy email path: `/lul?token=...` →
`/api/validate-token` → reads `Sheet1` by token (no auth).

**Strengths:** HttpOnly+Secure+SameSite=Lax cookie, constant-time HMAC
compare, OAuth state CSRF, open-redirect guard on `returnTo`, server-
enforced domain allow-list.

**Concerns:** no revocation list (leaked cookie valid 7 days);
`session.isAdmin` baked in at login (promotion needs sign-out + back
in); legacy LUL token in URL ends up in referers / browser history
(mitigated by one-time-use + 30d expiry — treat as sensitive).

---

## 4. The biggest tech debts (ranked by risk × effort)

### T1. Google Sheets is fine — fix it, don't replace it

At 500 users (and even 5k), Sheets is **the right answer**: free,
admins already edit it, "no-code to add a trip" is real value. The
problems are fixable in place, not by migrating to Postgres.

**Symptoms worth fixing:**
1. **Magic column indices** (`r[6]`, `r[12]`) — reordering columns
   silently breaks the app.
2. **Race conditions on writes** — two admins clicking "issue pass"
   at the same instant clobber rows. Once-a-month nuisance today.
3. **No 60s in-process cache** — every page hit re-fetches the same
   ranges. Latency tax, not quota.
4. **Sheets I/O reimplemented in 4+ endpoint files** — touched by T2.

**Fixes (a couple of days, no migration):**
- **Named columns:** header-row reader in `_lib/sheets.js` (reads
  row 1, returns `{ rows, col }` so endpoints write `row[col.email]`
  not `row[6]`). Single source of truth for column layout.
- **In-process LRU cache** in `_lib/sheets.js`, 60s TTL keyed by
  range. Free, survives the warm instance.
- **Read-then-conditional-update** for the `Sheet1` "find by token,
  patch" pattern: re-read the target row inside the same request and
  refuse to write if it mutated. Hacky, correct enough for 5–10
  admins. Prefer `valuesAppend` over `valuesUpdate(range)` wherever
  the operation is "add a row" (atomic at row level).

**Postgres only becomes necessary when** (a) > ~25k rows in any
single tab, (b) hundreds of concurrent writers, or (c) joins matter.
None is true in the 12-month plan. **Skip until a feature needs it.**

### T2. No shared client / data-access layer

Every endpoint reimplements `b64url`, `makeJWT`, `postForm`,
`getAccessToken`, `httpsGet` + Sheets `batchGet` boilerplate. Every
HTML page reimplements `emailHandle`, `initialsFor`, `escapeHtml`,
`fmtSessionTimes`, `setupUserMenu`. **~500 lines duplicated in `api/`,
~600 in HTML.** Changing the auth-token TTL needs 11 file edits.
Direct violation of workspace rule "always reuse functions when we
will benefit from it."

**Build a real `_lib/` layer** (the highest-leverage tech change in
this audit):
- `api/_lib/sheets.js` — Sheets client + named-column reader + 60s
  LRU cache (T1).
- `api/_lib/auth.js` — rename `session.js`; expose `requireSession` /
  `requireAdmin` helpers that 401/403 + return early.
- `api/_lib/notify.js` — wraps Intercom, named template registry.
- `api/_lib/log.js` — one-line structured logger.
- `api/_lib/dispatcher.js` — shared switch helper for T3.
- `/public/lib/portal.js` — shared front-end module (the helpers
  above + `requireAuth` + a typed `apiFetch` that handles 401 → login
  redirect).

### T3. The 2,806-line admin dispatcher

`api/admin/[action].js` packs 32 endpoints in one switch because of
**Vercel Hobby's 12-function deploy cap.** Two options:
(1) Split by domain into 4 dispatchers (each ~700 lines):
`admin/trips.js`, `lounge.js`, `people.js`, `feed.js`, sharing
`api/_lib/dispatcher.js`. (2) Upgrade to **Vercel Pro ($20/mo)** →
32 small files, cleaner. **My pick: spend the $20.** At 500 users,
the only reason to stay on Hobby is principle.

### T4. No build pipeline / TypeScript / lint / tests

`package.json` has 6 lines, zero deps. No `tsconfig`, no `.eslintrc`,
no `tests/`. **Minimal DX layer** (a 1-week investment that pays
back forever):

- TypeScript on `api/` only, file-by-file (HTML JS stays vanilla).
- ESLint + Prettier with `simple-git-hooks` pre-commit.
- Vitest on `_lib/` pure functions only — don't try for full coverage.
- `pnpm` + lockfile.
- Scripts: `dev` (`vercel dev`), `lint`, `typecheck`, `test`,
  `prebuild` runs `tsc --noEmit`.
- GitHub Actions on PR (lint + typecheck + test, blocks merge on red).
- Vercel preview deploys per PR against a staging sheet (override
  `SHEET_ID` env).

### T5. Front-end is ~12,000 lines of duplicated HTML/CSS/JS

Each HTML page redeclares ~150 lines of `:root { --aa-* }`,
`.site-header`, `.user-wrap`/`.user-chip`/`.user-menu`, `.hero` family,
`.site-footer`, plus the JS helpers from T2.

The brand SKILL.md is a *rules* document; we need a **rules-encoded
codebase**. Extract a static design system:

- `/public/styles/tokens.css` — `:root { --aa-* }` (once)
- `/public/styles/components.css` — `.aa-header`, `.aa-button`,
  `.aa-card`, `.aa-pill-cta`, `.aa-back-bar`, `.aa-modal`, `.aa-toast`
- `/public/lib/portal.js` — JS module (T2)
- `/public/lib/components.js` — custom elements (`<aa-header>`,
  `<aa-back-bar>`, `<aa-user-chip>`, `<aa-toast>`). htmx-flavored,
  not React.

Each page becomes ~150 lines of *content* HTML + `<link>` + `<script>`.

**Why not React/Next?** Adds build/router/hydration/hiring filter for
17 routes that don't share much state. Static + custom elements +
shared CSS = 95% of the win at 5% of the complexity tax. **Drops the
HTML codebase from ~12,000 to ~5,000 lines.** This is the single
biggest "feels finished" lever in the audit.

### T6. No caching anywhere

Every page hit re-fetches the same Sheet ranges. At 500 users this
isn't a quota issue — it's a latency issue (every endpoint adds
~300ms of Sheets round-trip).

- **In-process LRU** in `_lib/sheets.js`, 60s TTL keyed by range
  (folded into T1; free, survives the warm instance).
- `Cache-Control: private, max-age=30, stale-while-revalidate=60`
  on read endpoints. Don't cache `/api/auth/me` or any write.

That's it. No KV, no Redis, no edge-cache config. Premature.

### T7. Error handling: "swallow and render empty"

`api/trips/my.js:205-210` catches errors and returns `trips = []`;
pattern repeated in nearly every reader. Pro: transient Sheets quota
hit doesn't blank the app. Con: when broken for real *we don't know*
— student sees empty hub, admin doesn't get paged. Per workspace rule
"DON'T USE FALLBACKS UNLESS EXPLICITLY ASKED" these are silent
fallbacks; they protect student UX. Fix = **observability without
removing the soft-fail**: pipe `console.error` calls through
`_lib/log.js` → Datadog logs (already paid for org-wide), and add
`{ degraded: true }` to responses so the front-end can show a
discreet `<aa-toast variant="warning">` when something's off.

No formal `/api/health` endpoint — at 500 users the Vercel runtime
logs already tell us when something's down. Add it later if/when we
have actual on-call rotation.

### T8. No rate limiting on public POSTs

`/api/experience-suggest` is a public POST — anyone could spam it.
Bare-minimum protection (no infra): in-memory rate limit in
`_lib/ratelimit.js` (Map keyed by IP/email, sliding window — survives
warm instance, resets on cold start; *enough* at 500 users). 30 req/
min per IP on public POSTs. Zod payload validation on every POST
that touches Sheets. CSRF origin-header check on state-changing
endpoints. If we ever see real abuse, swap to `@upstash/ratelimit` +
KV — not before.

### T9. File uploads — Supabase signed URLs, no server validation

`upload-url.js` issues a signed PUT URL given the *client's declared*
content-type. Risks: client lies (uploads `.exe` claiming
`image/jpeg`), no virus scan, no EXIF stripping (kid photos!), no
size enforcement beyond Supabase's cap. **This is scale-independent
— matters at 50 users as much as 5,000.**

- **Server-side post-upload verification:** make
  `submissions/create.js` *the* finalize step — HEAD the file, verify
  content-type via header + magic bytes (`file-type`), strip EXIF
  (`sharp`), reject > 50MB.
- **Two-bucket pattern:** uploads land in `incoming/` (private),
  promoted to `public/` only after `create` validates.
- **Daily cron sweep** auto-deletes unfinalized incoming files.

### T10. Ops: no deploy gate, no observability

Every push to `main` deploys. No PR preview gate. No alerting.
"How many passes issued this week?" requires opening the sheet.

Light-touch fixes (no fancy SaaS):
- **Branch protection on `main`** — require PR + green CI.
- **Logs → Datadog** (already paid for) via the wrapper from T7.
  No APM, no custom metrics, no dashboards in v1 — just
  searchable logs and error grouping.
- **Slack `#alpha-experiences-ops`** webhook on Vercel deploys +
  daily 9am Apps-Script digest of pass/sub/reg counts (one-page
  summary read straight from the sheet — preserves the "no infra"
  promise).

If/when we get above ~2k weekly active users, *then* build a real
KPI dashboard.

---

## 5. What "good enough" looks like at our scale

500 users today, 5k stretch ceiling. That's a **small internal tool**,
not a SaaS. Right-sizing means:

**Light SLOs we promise the team:**
- Portal is up when Vercel + Sheets are up — we don't try to beat
  either provider's SLA.
- Page loads under 2s warm, 4s cold. Don't optimize past that.
- Admin writes either succeed or surface a visible error — no silent
  failures.
- Production errors are visible in Datadog within 30s.
- A new ops team member can add a trip without asking engineering.

**Definition of Done — production-grade for our scale:**
1. Every API has typed input (Zod) + structured output.
2. Every `catch` logs through `_lib/log.js`.
3. PR can't merge without green CI.
4. Vercel preview per PR works against a staging Sheet.
5. `OPERATIONS.md` covers: rotating service-account secret, recovering
   a deleted/corrupted sheet (Drive version history), Supabase outage,
   manually issuing a pass when the API is down.
6. Apps Script nightly export of transactional tabs to a long-term
   Drive folder — cheap insurance.

**Worth doing regardless of scale** (code health + security, not
throughput): T2, T3, T4, T5, T9. Everything else listed in §9 is
deliberately *not* in scope at 500 users.

---

## 6. Security pass — quick triage

| Item | Status | Action |
|---|---|---|
| Cookie HttpOnly + Secure + SameSite | ✓ | none |
| OAuth state CSRF | ✓ | none |
| Open-redirect protection | ✓ | none |
| Server-side admin check | ✓ | log every admin write via `_lib/log.js` |
| Constant-time signature compare | ✓ | none |
| `SHEET_ID` hardcoded | ⚠ | move to env so prod/staging differ |
| Secrets only in env | ✓ | add `.env.example` + README |
| Rate limiting | ✗ | T8 (in-memory, no KV) |
| Payload validation | partial | Zod everywhere |
| File upload validation | ✗ | T9 |
| LUL token in URL | ⚠ tradeoff | mitigated by one-time + 30d expiry |
| Service account JSON in env | ✓ | rotate quarterly (calendar reminder) |
| PII handling | implicit | document what we store + retention |

**No P0 security fires.** Attack surface is small. Once parent surface
ships (Product P2), tighten further (parent of student X must not see
student Y's data).

---

## 7. Target architecture — "Vercel but better"

```
   Google Sheet (one DB)  ──── Vercel serverless (TS) ──── Datadog
                                       │                   (logs only)
                                       │
   _lib/{sheets,auth,notify,log,       │
         dispatcher,ratelimit}         │
                                       ▼
   Static HTML  + tokens.css  +  Supabase Storage  +  Intercom
                + components.css     (uploads)         (email)
                + portal.js
                + custom elements
```

**Same as today:** Vercel, static front-end, Sheets, Google OAuth,
Supabase storage, Intercom email.

**Added:** shared `_lib/`, design-system CSS + JS, build pipeline
(TS + lint + tests + CI), Datadog log pipe.

**Removed:** the 2806-line admin file, the ~12,000 duplicated
front-end lines, magic column indices, swallowed errors.

**Notably *not* added:** Postgres, KV, Redis, Drizzle, audit-log
table, health endpoint, KPI dashboard, APM — options for the day a
real need shows up, not before.

---

## 8. Sequenced engineering plan

**Phase 1 — DX foundation** *(1 week, parallel with Product P0)*
`package.json` scripts + `pnpm` + lockfile · ESLint + Prettier +
pre-commit · TypeScript on `api/`, file-by-file (start with `_lib`) ·
GitHub Actions (lint + typecheck on PR) · `.env.example` + README ·
Dependabot.

**Phase 2 — Front-end design system** *(1–2 weeks; biggest visible win)*
`tokens.css` + `components.css` + `portal.js` · custom elements
(`<aa-header>`, `<aa-back-bar>`, `<aa-toast>`, `<aa-modal>`,
`<aa-user-chip>`) · refactor each HTML page to consume shared assets
(one PR per page, no behavior changes) · delete duplicated inline
styles/JS.

**Phase 3 — Shared API libs + Sheets fixups + admin split** *(1 week)*
`_lib/sheets.js` with named-column reader + 60s LRU cache · `_lib/
log.js` → Datadog · `_lib/auth.js` rename + helpers · `_lib/
ratelimit.js` (in-memory) · split `api/admin/[action].js` → 4 domain
dispatchers via shared `dispatch()`.

**Phase 4 — Hardening** *(1 week)*
File-upload validation (T9) · Zod payload validation everywhere ·
CSRF origin check · `OPERATIONS.md` runbook · quarterly secret-
rotation calendar reminder.

**Phase 5 — Ops light-touch** *(parallel with Phase 1)*
Branch protection · Slack deploy webhook · daily Apps-Script KPI
digest reading from the sheet.

**Total elapsed:** **~4–5 weeks** of focused engineering. No data
migration, no new infra dependencies, no rewrites. Each phase is
independently shippable.

---

## 9. What we're explicitly NOT doing

No microservices · no custom auth (Google OAuth + HMAC cookie is
right) · no GraphQL · no SSR / Next.js migration · no replacing Vercel
· **no Postgres / no KV / no DB migration** (Sheets is the right
answer at this scale) · no replacing Supabase storage (add validation,
don't replace) · no real-time websockets · no k8s / Docker /
containers · no data warehouse · no A/B testing platform · no formal
APM · no custom Datadog dashboards in v1 · no audit-log table · no
on-call rotation.

The minute one of these becomes load-bearing for an actual feature,
revisit. Until then, every one of them is a tax with no benefit at
500 users.

---

## 10. Cost expectations

Net new infra after Phase 4: **~$0–20/mo.** Either stay on Vercel
Hobby (free, keep the 4-dispatcher split) or upgrade to Pro ($20/mo)
for the cleaner 32-file split — see T3. Datadog and Intercom already
billed org-wide. Supabase storage stays on the free tier well past
5k users. **Zero new SaaS subscriptions.**

---

## 11. Honest disagreements with the prompt

1. **The 12-function Hobby cap is the *only* reason `[action].js`
   exists.** Stay on Hobby → split into 4 dispatchers. Move to Pro
   ($20/mo) → 32 small files, codebase is a joy. **My pick: spend
   the $20.**
2. **Sheets vs Postgres.** At 500–5k users, Sheets is correct. Skip
   Postgres until a specific feature needs it. (Earlier draft of this
   doc proposed migrating; that was wrong for our scale.)
3. **Sentry vs Datadog.** We pay for Datadog org-wide → use Datadog
   logs, skip Sentry. Don't bother with Datadog APM at this scale.
4. **Postmark vs keeping Intercom.** Intercom works and pre-creates
   contacts. Keep it; the brand-aligned template rebuild matters far
   more than the provider swap.
5. **Per workspace rule "DON'T USE FALLBACKS UNLESS EXPLICITLY ASKED":**
   the existing `try{}catch{ return [] }` pattern *is* a fallback. I
   propose keeping it (student UX is worth protecting) *but* surfacing
   failure via tracker + UI toast. Push back if you'd rather propagate
   500s and show an error screen.
6. **TypeScript migration timing.** Right answer; ~2 days to convert
   `api/`. Push back if you'd rather stay pure JS with JSDoc.

Push back on any of these and we'll align before doing the work.

---

## Appendix A — Env vars (today + tomorrow)

```bash
# Existing (do not change)
SESSION_SECRET=                # 32+ char random
GOOGLE_SERVICE_ACCOUNT_JSON=   # full service-account JSON
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
INTERCOM_ACCESS_TOKEN=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=

# New (small additions)
SHEET_ID=                      # move out of code; differs prod/staging
DATADOG_API_KEY=               # for log forwarding
APP_BASE_URL=                  # https://parent.alphaanywhere.co
```

Document in `.env.example`, checked into the repo.

---

## Appendix B — Proposed minimum dependencies

Runtime: `zod`, `file-type`, `sharp`. That's it.

Dev: `typescript`, `@types/node`, `@vercel/node`, `eslint` +
`@typescript-eslint/*`, `prettier`, `vitest`, `simple-git-hooks`.

Scripts: `dev` → `vercel dev`; `lint` → `eslint . --fix`; `typecheck`
→ `tsc --noEmit`; `test` → `vitest run`; `prebuild` → `pnpm typecheck`.

No Drizzle, no `@vercel/postgres`, no Upstash, no `dd-trace`. Add any
of those only when a specific feature requires it.
