# Alpha Experiences — Product Audit & Redesign Plan

> Audience: CPO + product team for Alpha Anywhere
> Scope: **Student-, parent-, and admin-facing UX, content, IA, features.**
> Companion: `technical-audit.md` (DB, infra, code quality).
> Brand source: `/Users/tomas/Downloads/SKILL.md` (AlphaAnywhere brand).

This audit reads the product as it exists today, names the friction with
**named UX/behavioral research**, and proposes a sequenced plan with
**metrics for each change** so we know whether the change worked.

---

## 1. The honest one-paragraph take

LUL works. The VFT portal is built. Both flows ship value. But the surface
feels like **two products glued together by a header**: a legacy email-only
LUL pass (`/lul?token=...`) running parallel to a portal-first flow
(`/lounge`, `/lounge/pick?pass=...`), with VFT bolted on (`/trips`,
`/trips/:id`, `/submit`, `/gallery`). Navigation labels, back-bar styles,
user-menu contents, marketplace terminology, and even the logo sublabel
change page to page. The brand system is *referenced* (correct AA Navy,
AA Blue, Be Vietnam Pro / AF Sobremesa, pill CTAs, rounded shapes), but
the brand's **judgment rules** — anchor element, shape variety, full-
saturation hero, highlight pattern, "one primary CTA per view" — are
mostly absent. The result reads as "a template with AA colors painted on"
rather than AA itself. Almost no greenfield invention is needed; the work
is **editorial + IA + a small set of new flows** (notifications, profile,
calendar, onboarding).

---

## 2. The three users, ranked by leverage

| User | Need | Today | Biggest miss |
|---|---|---|---|
| **Student** (2hourlearning.com / alpha.school) | A place to see what they unlocked, when, and what to do next | A trips list + a lounge tab | No personalized "today" view, no notifications, no streak/progress, no "spend alphas" hub |
| **Parent** | Confidence their kid signed up, knows the time, and showed up | Email-only — *receives* LUL/VFT confirmation, never logs in | Email templates are off-brand and don't cleanly tell the parent what to do next |
| **Internal team** | Create trips/sessions, register kids, watch attendance — without code | A dense forest of admin pages, mostly working but inconsistent | No global dashboard, fragmented chrome, `alert()`/`confirm()` everywhere, fulfillment UI half-wired |

**Implication:** the highest-leverage work is on the *student* surface.
Parent emails come second (every issued pass = one parent touch). Admin
gets cleanup, not rebuild.

---

## 3. Brand alignment vs SKILL.md (drift table)

| Issue | Where | Brand rule violated |
|---|---|---|
| Body uses Arial, hero uses `#0D3270` (not AA Navy) | `index.html:7-19` | §1 rule 5; §2 typography |
| Hero subtitle in `--aa-dark-grey` on AA Navy (low contrast — fails WCAG 2.2 AA at 14px non-bold) | `trips.html:43`, `lounge.html:55`, `lounge-pick.html:47` | §1 rule 2 |
| Off-palette gradients on trip thumbs | `trips.html:346-353`, `gallery.html:191-197` | §1 rule 5 |
| Email templates use `#006AFF` (not `#006FF9`) and Arial | `api/_lib/lul-email.js:101,121` | §1 rule 5; §2 fallback type |
| Email header/footer not using canonical shell | `api/_lib/lul-email.js` | §9 Email canonical shell |
| Multiple "anchor candidates" competing on `/trips` | `trips.html:108-258` | §8 Anchoring element |
| All cards are Canvas — no shape variety | every page | §8 Shape variety |
| Highlight pattern not used at hero scale anywhere | every page | §5 + §8 Proportion |
| Pastel-card-stack risk (Light variants as full card backgrounds for stacked content) | `lounge.html:79`, `trip-detail.html:125-130` | §1 rule 6 |
| `--aa-red` referenced but undefined → renders invalid | `admin.html`, `admin-registrations.html`, `admin-submissions.html`, `admin-access.html` | actual rendering bug |

The squint test: today the portal looks like a competent SaaS skin on AA
colors. With the §6 fixes it would look like AA.

---

## 4. The student journey — what's broken

### 4a. Map (today)

```
       Email (LUL) or Marketplace (VFT)
                  │
        ┌─────────┴───────────┐
        ▼                     ▼
   /lul?token=...         /auth/login → Google
   (legacy, no auth)      → /trips → /trips/:id → /submit → /gallery
        │
        ▼
   pick 2 / full-week /
   celebration; one-time
   Zoom links
```

### 4b. Specific friction (each labeled with the concrete cost)

1. **Two LUL flows = two mental models.** Students who get an email link
   land on `/lul`, see a back-link to `/lounge`, click it, get bounced to
   login, end up confused. (Source: `lul.html:124-126`, `lounge.html:153-154`.)
   *Cost:* support tickets; abandoned passes; sense of unpolish.
2. **Marketplace deep links are placeholders.** `MARKETPLACE_URL = ''` →
   `alert("coming soon — ask your coach")` (`lounge.html:228-231,554-561`).
   `/trips` empty state says "Alpha Bank Marketplace"; `/lounge` says
   "Alpha Anywhere Marketplace" — same place, two names.
   *Cost:* literally the revenue/retention CTA is broken.
3. **No personalized "today" view.** A student with a session in 2 hours
   sees the same card layout as one with a session in 3 weeks.
   *Cost:* misses the **Zeigarnik effect** (open loops drive return
   visits — Zeigarnik 1927); the portal isn't sticky.
4. **No notification inbox / no submission status.** Student submits a
   project → success card says gallery will update "shortly" → silence.
   Admin has a Reviewed toggle (`admin-submissions.html`); student never
   sees it.
   *Cost:* breaks the **Hook Model "investment" loop** (Eyal 2014) — without
   feedback the action doesn't deepen the relationship; submission rate
   drops on subsequent trips.
5. **No calendar / agenda.** A student with two VFTs and a Friday LUL
   has to mentally union three sections.
   *Cost:* high working-memory tax. Cowan (2001) puts working memory at
   ~4 chunks; we're forcing the student to be the integrator.
6. **No "spend my alphas" surface.** This is the *core marketed value*
   ("spending alphas on experiences feels better than a gift card"). The
   portal *displays* what you've already redeemed — nothing about what's
   available.
   *Cost:* defeats the **goal-gradient hypothesis** (Kivetz et al. 2006):
   visible progress toward a reward accelerates behavior. We hide the
   reward.
7. **Gallery doesn't surface "yours."** No filter, no badge.
   *Cost:* misses the **IKEA effect** (Norton, Mochon, Ariely 2012):
   people value 6× more what they helped create. Pinning the student's
   own submission on top would multiply gallery time-on-page.
8. **Login copy mismatch.** Says "Student & Staff Portal" but wrong-domain
   error says "**Alpha Anywhere team members** can sign in"
   (`auth/login.html:88-89`).
   *Cost:* a kid trying personal Gmail reads it as "I'm not allowed."
9. **`index.html` is a stub.** No real homepage, no sign-in CTA, no help.
10. **No onboarding.** A first-time student arrives at `/trips`, sees
    nothing personalized, learns the product by clicking. Per the **Fogg
    Behavior Model** (Fogg 2009: B = M·A·P), motivation is highest in the
    first 30 seconds; we waste it on a generic empty state.

### 4c. Chrome inconsistency table — the single biggest "looks unfinished" signal

| Element | `/trips` | `/trips/:id` | `/submit` | `/gallery` | `/lounge` | `/lounge/pick` | `/lul` |
|---|---|---|---|---|---|---|---|
| **exp-tabs** | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ |
| **back-bar style** | none | white | white | grey + border | grey | grey | inline |
| **logo sublabel** | Student Portal | Student Portal | Student Portal | Student Portal | **Level Up Lounge** | **Level Up Lounge** | **Level Up Lounge** |
| **user menu items** | Sign out | Sign out | Sign out | + My trips | + My experiences, Gallery | + Lounge, My experiences | + Lounge, My experiences, Gallery |
| **footer line** | "Alpha Experiences · Alpha Anywhere" | same | same | same | "Alpha Experiences · Level Up Lounge" | same | "Breakthrough Coaching · Level Up Lounge" |

3 back-bar treatments. 4 user-menu variants. 3 footers. 2 sublabels.
Per **Jakob's Law** (Nielsen) users expect consistency — every
inconsistency taxes attention.

---

## 5. Behavioral science principles we'll lean on

These are the levers each recommendation in §6 pulls. Listed once here so
the table stays scannable.

| # | Principle | Source | How we use it |
|---|---|---|---|
| B1 | **Zeigarnik effect** (open loops → return) | Zeigarnik 1927 | "Up Next" anchor + countdown; submission status pill |
| B2 | **Goal-gradient hypothesis** | Kivetz, Urminsky, Zheng 2006 | Visible alphas-to-next-reward bar |
| B3 | **Endowed progress effect** | Nunes & Drèze 2006 | New students start with "1/3 ways to earn" pre-stamped |
| B4 | **IKEA effect** | Norton, Mochon, Ariely 2012 | Pin user's own submission on top in /gallery |
| B5 | **Loss aversion** | Kahneman & Tversky 1979 | Streak counter on LUL ("don't break your 4-week streak") |
| B6 | **Peak-end rule** | Kahneman 2011 | Post-session confirmation moment matters more than the wait — invest there |
| B7 | **Implementation intentions** | Gollwitzer 1999 | After locking in a session: "When my link unlocks, I'll be at my computer" prompt → +91% follow-through in original studies |
| B8 | **Social proof** | Cialdini 1984 | "12 students from your trip have submitted" on /submit |
| B9 | **Default effect / status-quo bias** | Thaler & Sunstein 2008 | Smart defaults for parent email, notification preferences |
| B10 | **Paradox of choice** | Schwartz 2004 | Limit "Full Week" pass display to current day + tomorrow first |
| B11 | **Working memory limit (~4 chunks)** | Cowan 2001 | Max 4 nav items per surface; chunk dense admin tables |
| B12 | **Self-Determination Theory (autonomy, competence, relatedness)** | Deci & Ryan 1985 | Pick-your-sessions = autonomy; profile mastery = competence; gallery = relatedness |
| B13 | **Fogg Behavior Model (B = M·A·P)** | Fogg 2009 | Onboarding hits all three: motivation (you have alphas), ability (one tap), prompt (welcome modal) |
| B14 | **Fresh-start effect** | Dai, Milkman, Riis 2014 | Issue weekly LUL passes Sunday night, not random midweek |
| B15 | **Mere exposure / brand consistency** | Zajonc 1968 | Unified chrome → faster trust |
| B16 | **Reciprocity** | Cialdini 1984 | Frame submissions as "show your work to your crew" not "submit your project" |
| B17 | **Habit formation timeline (~66 days median)** | Lally et al. 2010 | Calendar + streaks targeted for the first 9 weeks of usage |
| B18 | **Recognition over recall** | Nielsen heuristic #6 | Icons + labels in nav, not text-only |
| B19 | **Feedback latency tolerance** | Nielsen 1993 (~1s, ~10s thresholds) | Snappy optimistic UI on toggles; spinners only past 1s |
| B20 | **Don't crowd out intrinsic motivation** | Deci 1971; Hanus & Fox 2015 | Streaks and badges *yes*, leaderboards *no* — rivalrous gamification can backfire in education |

**COM-B framing** (Michie/van Stralen/West 2011) — for each persona, the
bottleneck of {**C**apability, **O**pportunity, **M**otivation}:

- *Student attendance:* opportunity ✓, capability gap (knowing it's today),
  motivation ✓ → **calendar + reminders**.
- *Submission rate:* capability ✓, opportunity gap (post-trip prompt),
  motivation gap (peers see it) → **in-app reminder + IKEA-effect gallery**.
- *Pass redemption rate:* capability ✓, opportunity gap (email delays),
  motivation ✓ → **in-app pass arrives even when email is late**.

---

## 6. Recommendations — sequenced, evidence-anchored, measurable

Each item has: **WHAT** (the change), **WHY** (research lever from §5),
**METRIC** (how we'll know), **EFFORT** (S ≤1d, M 2–5d, L >1w).

### P0 — Quick wins (1 week sprint, parallel-shippable)

| # | What | Why | Metric | Effort |
|---|---|---|---|---|
| 1 | Unify chrome: one shared header partial, one back-bar style, one footer line, one logo sublabel ("Student Portal"), one user-menu | B15, B18 | Self-reported "feels finished" in a 5-user think-aloud (Nielsen 1993 — 5 users surface 80% of issues) | M |
| 2 | Add `exp-tabs` to every authenticated page | B11, Jakob's Law | Bounce rate on `/trip-detail` ↓ (no more "where am I") | S |
| 3 | Fix hero subtitle contrast on Navy (white + text-shadow) | WCAG 2.2 AA contrast (4.5:1 for body text) | Lighthouse a11y score from ~83 → 95+ | S |
| 4 | Pick **one** marketplace name (Alpha Anywhere Marketplace), fill in `MARKETPLACE_URL`, replace the alert | UX heuristic #5 (error prevention — Nielsen) | Click-through to marketplace from portal: track baseline | S |
| 5 | Fix `--aa-red` undefined in admin pages | rendering bug | visual regression in Storybook (once §T2 ships); manual for now | S |
| 6 | Replace student-facing `alert()` / `confirm()` with `<aa-toast>` / `<aa-modal>` (especially silent `console.log` save failure in `lul.html:469-471` — currently invisible failures) | B19 (snappy feedback), Norman (visibility of system status) | Reported "I clicked but nothing happened" tickets → 0 | M |
| 7 | Make `index.html` a real homepage (chrome + 2 CTAs + 1 paragraph) | Recovery + B13 (prompt + ability) | % anonymous landings that convert to sign-in: ≥40% | S |
| 8 | Login copy fix — drop "team members" framing | reduces falsely-rejected sign-ins | Domain-error → retry-with-correct-email rate ≥80% | S |
| 9 | Pin the student's submission to top of `/gallery` with a "Yours ✨" chip | **B4** IKEA effect (Norton/Mochon/Ariely 2012, ~6× WTP for self-built items) | Repeat-visit rate to `/gallery` (within 7d of submission): target +30% over baseline | S |
| 10 | Add WCAG 2.2 AA fixes on legacy LUL session cards (currently clickable `div`s with no keyboard access — `lul.html:415-426`) | a11y minimum bar | Keyboard-only completion of LUL flow: 100% | S |

### P1 — Structural redesigns (weeks 2–6)

| # | What | Why | Metric | Effort |
|---|---|---|---|---|
| 11 | **"Up Next" hero anchor** on `/trips` — full AA Navy bg, white-outlined CTA, **live countdown**, link button swaps to live link 15 min before. Shape: Ascent. | **B1** Zeigarnik (open loop) + B6 peak-end (the moment the link goes live is a peak — engineer for it) | Session join rate (joined / picked LUL sessions): baseline → +15% | M |
| 12 | **Notification inbox** — bell icon w/ unread count, `/inbox` listing "Pass issued", "Trip in 24h", "Submission live", "Submission approved", "New trip published" | **B9** defaults (default = on, with one-tap pause), **B11** keep notification types ≤4 | Day-7 retention of new students: baseline → +20% | L |
| 13 | **Submission status loop** — pill on `/trips/:id` ("Submitted · 2d ago"), "Live in gallery" once admin reviews, badge on `/gallery` | **Hook model investment phase** (Eyal 2014); **B19** feedback latency | % of completed VFTs that result in a submission: baseline → +40% | M |
| 14 | **Calendar / agenda view** — third tab showing VFT + LUL chronologically, "Add to calendar (.ics)" per session | **B11** working memory; **B17** habit formation needs cadence visibility | LUL no-show rate: baseline → −25% | M |
| 15 | **Marketplace inline on the portal** — `/marketplace` mirrors available trips + LUL pass types + workshops + breakthrough-coaching, with deep links to the buy flow in Alpha Bank | **B2** goal-gradient (visible reward accelerates earning); **B12** autonomy (you choose what to spend on) | Alphas-spent-on-experiences as % of total alphas spent — needs Bank join | L |
| 16 | **Profile / settings page** — display name, parent email, timezone, notification prefs | **B12** autonomy; reduces a class of admin tickets | "Can you change my parent email" tickets → −80% | M |
| 17 | **Email templates rebuild** to brand SKILL §9 canonical shell — coded header/footer with hosted PNG logos at `parent.alphaanywhere.co/AA-logo-*-white.png`, `#006FF9`, `#072256`, bold system sans, 3-tier hierarchy, **one** anchor card, no inline-word "highlights" | brand SKILL §9; transactional email best-practice (one CTA per email — Postmark/Litmus benchmarks) | Pass-email click-through rate: baseline → +15% | M |
| 18 | **Single LUL flow.** Portal-first. Legacy `?token=` URL becomes a signed-in shortcut that auto-redirects logged-in students to `/lounge/pick?pass=...` and only renders the standalone picker for non-logged-in users | reduces dual-mental-model; **B11** | "Where do I see my passes" support tickets → −90% | M |
| 19 | **Copy + voice pass** — every empty state, every error message, every confirmation, every CTA verb phrase. Brand SKILL §4: 2–5 words per button. | **Mailchimp Voice & Tone** principles; **B16** reciprocity framing | n/a (qualitative — review by an editor with the brand voice) | M |
| 20 | **Onboarding (first-run) flow** — see §7 below | **B13** Fogg Behavior Model | Day-1 to Day-7 activation (defined as: at least 1 LUL session picked OR 1 trip detail viewed): baseline → ≥75% | M |

### P2 — Strategic moves (Q2)

| # | What | Why | Metric | Effort |
|---|---|---|---|---|
| 21 | **Streak system** for LUL attendance ("4-week streak"), VFT participation ("3 trips completed"). Surface on profile + Up Next. **Caveat:** soft public-facing (just to the student); avoid ranked leaderboards (B20 — extrinsic crowd-out risk in education, Hanus & Fox 2015). | **B5** loss aversion ("don't break your streak" — same lever Snapchat/Duolingo ride); **B17** habit formation | 4-week active streak rate among LUL-pass-holders: target ≥40% | M |
| 22 | **Parent surface — read-only mini-portal.** Magic-link auth → upcoming experience, attendance history, submission gallery. | parent confidence; closes the "email-only" gap | Parent magic-link open rate: ≥35% | L |
| 23 | **Gallery as a destination** — featured submissions per trip, reaction emojis (no comments — moderation tax), per-trip pages | **B8** social proof; **B16** reciprocity | Median session duration on `/gallery`: baseline → +50% | L |
| 24 | **Workshops + Talks + Trial Coaching as first-class types.** `/trips` becomes `/experiences` with type filters. Sheet-row driven (preserves no-code promise). | executes founder roadmap; **B12** autonomy (more spending choices) | New experience types adopted by ops without engineering: 3+ | L |
| 25 | **Admin dashboard rebuild** — KPIs, "needs attention" list (unfulfilled passes, unreviewed submissions, broken-link clicks, suggestions waiting > 7d), shortcuts | **B11** working memory; reduces "where do I click" tax | Admin time-to-resolve a typical task (timed test): baseline → −40% | L |
| 26 | **Wire up or delete orphaned "Fulfilled" pass UI** — exists in `admin-lounge-passes.html:803-846` but never called from `renderPasses` | dead code; per workspace rule "Always clean up unused functions" | n/a | S |
| 27 | **In-product changelog banner** so coaches know when admin features change. Sheet-driven. | reduces training tax | "Did you know about X?" Slack messages → measurable drop | S |

---

## 7. The first-run / onboarding spec (high leverage, missing today)

Today: a brand-new student lands on `/trips`, sees an empty state, learns
the product by clicking. Per Fogg (B13), motivation peaks in the first
30 seconds; we waste it.

**Proposed first-run (after first Google sign-in):**

1. **Welcome modal** (Dialogue shape per brand SKILL §3):
   - "Hey **Santiago** — welcome to Alpha Experiences."
   - One sentence: "This is where you spend alphas on field trips,
     game sessions, and workshops with your crew."
   - **Three** small chips: 🎮 Lounge · 🌍 Trips · 📸 Gallery
     (taps go to a 1-screen explainer per brand SKILL Dialogue shape)
   - One CTA: "Let's go →" (closes modal, lands on `/trips`)
2. **Empty state on `/trips` is now opinionated** — not "no trips yet"
   but **endowed-progress (B3)** card:
   "You've earned **0 of 3** ways to spend alphas this week →
   [Browse Marketplace]" with the bar starting at the marketplace icon
   pre-stamped — Nunes & Drèze 2006 showed pre-stamping a punch card
   *doubles* completion rate vs an empty card with the same "real" steps
   remaining.
3. **First pass arrival** triggers a one-time toast: "🎉 Your first
   Lounge pass is here — pick your sessions when you're ready."
4. **First session join** triggers a one-time post-session prompt:
   "How was it? · 👍 / 👎 · One thing I'd change: [text]" — feeds
   directly into `FT_Suggestions`. **B7 implementation intention** is set
   here for next week ("When my next pass arrives, I will pick within 24h").
5. **First completed VFT** triggers the submission prompt with social
   proof (B8): "**12 of your crew** have submitted from this trip — add
   yours →"

**Build cost:** ~M (one onboarding component + a `users.first_seen_at`
column to gate the surfaces). **Expected lift:** Day-7 activation
+25–40 pp based on standard SaaS onboarding benchmarks (Wes Bush,
*Product-Led Growth*, 2019; Pendo benchmarks for B2C ed).

---

## 8. Redesigned student journey (target state)

```
                    parent.alphaanywhere.co
                            │
       ┌────────────────────┼─────────────────────┐
       ▼                    ▼                     ▼
 anonymous landing      email link            signed-in deep link
 (real /index)          (?token=...)          (/trips/123, etc.)
       │                    │                     │
       │                    ▼                     │
       │           "Sign in for the              │
       │           full portal" prompt           │
       └────────► /auth/login ◄───────────────────┘
                            │
                ┌───────────┴────────────┐
            FIRST SIGN-IN             RETURN
                │                        │
        Welcome modal (§7)              │
                │                        │
                ▼                        ▼
        ┌─────────────────────────────────────┐
        │  /trips (= the hub)                 │
        │  ─────────────────────────────────  │
        │  ANCHOR: "Up Next" — countdown +    │ ◄── full Navy, Ascent,
        │  one-tap join 15 min before         │     B1 + B6
        │                                     │
        │  Tabs: Trips · Lounge · Marketplace │
        │       · Schedule                    │ ◄── B11 (≤4 chunks)
        │                                     │
        │  Streak strip ("4-week streak")     │ ◄── B5
        │                                     │
        │  Sections (rhythm — no card/card):  │
        │  • Your VFTs (Canvas + Parallel hero)
        │  • Coming up (Perspective)          │
        │  • Your LUL passes (Dialogue)       │
        │  • Recent gallery (link out)        │
        │  • Suggest →                        │
        └─────────────────────────────────────┘
              │       │       │       │
              ▼       ▼       ▼       ▼
       /trips/:id  /lounge  /market /schedule
              │
              ▼
       /trips/:id/submit  ── status pill once submitted
              │
              ▼
       /gallery  ── "Yours ✨" pinned (B4)

  Always available in chrome:
  • Bell → /inbox (B9 default = on, ≤4 types)
  • Avatar → /profile (B12 autonomy)
```

Brand SKILL shape mapping (per §3):
- **Up Next anchor** → Ascent (milestone)
- **LUL pass cards** → Dialogue (asymmetric corner — the "speak" surface)
- **Trip cards** → Canvas (default content)
- **Coming up / showcase** → Perspective (fresh angle)
- **Featured trip hero photo** → Parallel (momentum)
- **Highlight pattern at hero scale** on the empty state ("Earn your first
  **pass**") and on the marketplace card ("Spend alphas on
  **experiences**, not gift cards") — exactly one per page per SKILL §5

---

## 9. Voice & microcopy — short prescription with research

The brand voice (SKILL §7): clear, concrete, parent-facing, short
sentences, use the student's name. Pull from today's product:

| Today | Brand-aligned | Research basis |
|---|---|---|
| "Hey Santiago! Choose Your Sessions! · You've earned a 2-Session LUL Pass — pick your 2 favorites below!" | "Santiago — pick **two sessions** for this week." (Highlight on "two sessions") | Schwartz B10 (concrete number, not "favorites"); SKILL §5 |
| "🎟️ Your LUL Sessions Are Confirmed!" (email subject) | "Santiago, your sessions are locked in." | Personalization → +14–26% open rate (Experian / Postmark benchmarks) |
| "Use the link from your email to access your pass." (`index.html`) | "Sign in to see your experiences. → [Sign in with Alpha email]" | Nielsen heuristic #2 (system status visible); B13 (prompt + ability) |
| "🔒 Zoom and Nearpod links will appear here 15 minutes before your session starts." | "Your link unlocks **15 min before** your session." (Highlight) | Cowan B11 (chunked); SKILL §5 |
| "🎉 You're all set! · Your one-time links are ready — click only when you're in the room. See you in the Lounge!" | "You're in. Link unlocks 15 min before — we'll surface it then." | B7 implementation intention nearby |

Voice rules to enforce:
- **One emoji per surface, max** — currently it's 3+ on most cards.
  Emoji density correlates negatively with comprehension (Nielsen 2017).
- **2–5 words on every button.** Today: "Browse Marketplace →",
  "View My Sessions →", "Lock In My Spot 🎊" — too long. Try
  "Earn alphas →", "View sessions →", "Lock in →".
- **Use "Santiago" not "you" or "your child"** in parent emails. Concrete
  > abstract (Heath & Heath, *Made to Stick*, 2007).
- **Stop apologizing in error states** — "Pass not found" is fine.
- **Implementation-intention prompts** at the success moment (B7) —
  Gollwitzer 1999 found these prompts move follow-through by 40–90 pp
  in field studies.

---

## 10. KPIs — what we measure to know it worked

**North Star:** **Weekly active redemption rate** = (students who
attended ≥1 session that week) / (students with ≥1 active pass that week).
Target: 65%+ (industry benchmarks for high-engagement education tools
sit at 55–75% — Pendo / Amplitude 2023 ed-vertical reports).

**Tier 2 KPIs (track per release):**

| KPI | Definition | Baseline | Target |
|---|---|---|---|
| **Pass-to-pick conversion** | LUL passes locked in / passes issued | TBD (instrument) | ≥85% within 48h |
| **Pick-to-attend rate** | LUL sessions attended / picked | TBD | ≥80% |
| **VFT submission rate** | Submissions / completed VFT registrations | TBD | ≥60% (community programs benchmark ~35–55%) |
| **Day-7 activation** (new students) | ≥1 pass picked or trip detail viewed within 7d of first sign-in | TBD | ≥75% |
| **4-week return rate** | Students returning to portal in 4 of 4 weeks after first sign-in | TBD | ≥50% |
| **Parent email CTR** | Clicks / delivered | TBD | ≥40% (transactional benchmark — Postmark ~25–45%) |
| **Gallery time-on-page** | median session duration on `/gallery` | TBD | +50% post-IKEA-pin (P0 #9) |
| **Submission status read-through** | % of submitters who return to see their gallery position | TBD | ≥60% |
| **Admin task time** | timed completion of "issue a celebration pass to one student" | TBD | -40% post-cleanup |
| **Support ticket rate** | "where do I see my passes" / "marketplace not working" / "wrong domain" tickets per 100 active students | TBD | -75% post-P0 |

**Instrument these in Phase 1** (technical-audit T10) — a single Datadog
dashboard pinned in Slack so the team sees the numbers move.

**Anti-metrics (we deliberately do NOT optimize):**
- Time-in-app for its own sake (B20 — we don't want to turn this into
  a TikTok loop; the brand voice is "real, scheduled, mastery").
- Notification volume — cap at 3/week per student (research on
  notification fatigue: Pielot et al. 2014, ~40% of notifications are
  perceived as annoying past 3/day).
- Vanity gamification (XP bars without meaning, unlockable cosmetics).

---

## 11. Admin-side: cleanup, not rebuild

1. **Restore global admin nav** on trip editor + `/admin/notifications` +
   `/admin/access` (currently drop the sub-nav).
2. **Replace `alert()` / `confirm()`** in `admin-lounge-passes.html`
   (delete attendance, fulfilled save), `admin-submissions.html`
   (delete failure), `admin-suggestions.html` (save failure),
   `admin-lounge-sessions.html` (toggle failure). Use the in-page banner
   pattern that already exists. **Tognazzini's principle:** "Undo > confirm"
   — for non-destructive actions, optimistic UI + undo toast is better than
   a confirm dialog.
3. **Trip editor** — CMD/CTRL+S hotkey, sticky save bar.
4. **Wire up or delete the orphaned Fulfilled UI** (P2 #26).
5. **Admin dashboard rebuild** (P2 #25).
6. **In-product changelog** (P2 #27).

---

## 12. What we're explicitly NOT doing

- No native iOS/Android. PWA install prompt is the ceiling.
- No real-time sockets / push. 30s polling is sufficient.
- No LMS / progress tracking. That's another product.
- No comments in gallery. Reactions only — moderation tax is real.
- No ranked leaderboards (B20 — extrinsic crowd-out in education).
- No DB migration in the same release as UX work — that's a separate
  technical track.

---

## 13. Sequenced rollout

| Sprint | Theme | Items |
|---|---|---|
| Week 1 | "Looks finished" | P0 #1–10 (chrome unification, contrast, marketplace link, alerts → toasts, real homepage, login copy, gallery pin, a11y) |
| Weeks 2–3 | Today + Inbox | P1 #11 Up Next, #12 inbox, #13 submission status, #18 single LUL flow |
| Weeks 4–6 | Schedule + Profile + Email + Onboarding | P1 #14 schedule, #16 profile, #17 email rebuild, #19 voice pass, #20 onboarding (§7) |
| Quarter 2 | Strategic | P2 #21 streaks, #22 parent surface, #23 gallery program, #24 experience types, #25 admin dashboard |

Everything in P0 and P1 is achievable inside the existing tech stack
(static HTML + Vercel functions + Sheets) without waiting on technical
remediation. The technical-audit work runs in parallel.

---

## 14. Honest pushback (per "always question my suggestions" rule)

1. **Streaks (P2 #21) are double-edged.** Hanus & Fox (2015) found
   education gamification has *mixed* results, sometimes reducing intrinsic
   motivation. Mitigate: keep streaks **private to the student** (no
   leaderboard) and frame around **process not outcome** ("3 weeks of
   showing up curious"). If you'd rather not ship streaks at all,
   defensible.
2. **Notification inbox (P1 #12) is a real surface.** Once we ship,
   students expect it to work — we'll need schema + pipeline. Biggest
   scope-creep risk in P1. Submission status (P1 #13) needs *some*
   notification surface, so a minimal version is unavoidable.
3. **Onboarding modal (P1 #20).** Well-meaning onboarding is the most
   commonly *broken* onboarding (Bush 2019). The §7 spec is deliberately
   one screen + opportunistic toasts; do not let it grow into a 5-step
   tour.
4. **Parent surface (P2 #22).** Adds an auth surface + real moderation
   (parent of student X must not see student Y's data). Worth the
   engineering only if parent reassurance is a measured pain point —
   survey first.

---

## Appendix A — Files referenced

Student: `index.html`, `auth/login.html`, `trips.html`, `trip-detail.html`,
`submit.html`, `gallery.html`, `lounge.html`, `lounge-pick.html`,
`lul.html`, `brand-fonts.css`. Admin: `admin*.html`, `admin-link.js`,
`admin-notif-badge.js`. Email: `api/_lib/lul-email.js` (mirrored in Apps
Script per file header). Brand source: `/Users/tomas/Downloads/SKILL.md`.

## Appendix B — Research bibliography (short)

Cialdini *Influence* (1984) · Cowan (2001) on working memory · Dai/Milkman/
Riis (2014) fresh start effect · Deci & Ryan SDT · Eyal *Hooked* (2014) ·
Fogg behavior model (2009) · Gollwitzer (1999) implementation intentions ·
Hanus & Fox (2015) gamification meta-analysis · Heath & Heath
*Made to Stick* (2007) · Kahneman *Thinking Fast & Slow* (2011) · Kahneman
& Tversky (1979) prospect theory · Kivetz/Urminsky/Zheng (2006) goal-
gradient · Lally et al. (2010) habit formation · Michie/van Stralen/West
(2011) COM-B · Nielsen *Usability Engineering* (1993) · Norton/Mochon/
Ariely (2012) IKEA effect · Nunes & Drèze (2006) endowed progress ·
Pielot et al. (2014) notification fatigue · Schwartz *Paradox of Choice*
(2004) · Thaler & Sunstein *Nudge* (2008) · Bush *Product-Led Growth*
(2019) · Zeigarnik (1927).
