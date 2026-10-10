# MsSuzie Scheduling Copilot

A parent messages MsSuzie: *"Can we move Amara's 7am class to 7pm today?"* A small team of agents
works out what
they want, checks the tutor's calendar and the rules, and then moves the class, offers other times,
or hands the
request to a person at MsSuzie Ops. It updates Google Calendar and emails the parent and the tutor.

The same app also keeps the earlier **Session Copilot**: paste a tutor's session notes and get
progress data, a risk
check, a two-week plan and a parent update draft.

Everything here uses **fictional learners only**. Do not enter real children's data.

## What is built

| Area | What it does |
| --- | --- |
| **Reschedules** (landing page) | A simulator: pick a parent, send a message, watch the agents and the Scheduler's tool calls live, and see the outcome (before and after in both time zones, the messages sent). A requests list with filters, a detail page, and Ops actions (choose a time, decline with a note). |
| **Schedule** | A week view in any time zone. Classes moved by the agents or by Ops are highlighted and link to why. |
| **Learners / Alerts** | Learner overview and detail; an Ops inbox of learners who may need a call. |
| **Session Copilot** | Notes in; Privacy Guard, Session Analyst, Progress Monitor, Learning Planner and Parent Reporter out. Nothing is sent to a family automatically. |
| **Parent link** | A single-use, 48-hour page reached from an email where a parent confirms one of the offered times. No sign-in. |

## How a rescheduling request is handled

```text
parent message
   │
   ▼
Privacy Guard ── names and contact details become placeholders before any model sees the text
   │
   ▼
Intake agent ─── a model fills a form: intent, which child, which class, new date and time, confidence
   │              (it reports what it understood; it decides nothing)
   ▼
Scheduler agent  a model with three READ-ONLY tools: get_bookings, get_tutor_availability, find_free_slots
   │              (it can only see this child's classes and the tutor's busy times)
   ▼
Policy check ─── PLAIN CODE, not a model. Re-checks everything itself and decides:
   │                 auto-apply  → every check passed
   │                 propose     → the time is taken; up to two verified alternatives
   │                 escalate    → a person must decide
   ▼
move the booking → update Google Calendar → email parent and tutor
```

**The models understand and gather facts. Code decides. The database has the last word on
overlaps.**

The policy escalates, in this order, when: the message contains instructions aimed at the system, it
is not a
reschedule request, it names another family's child, the class is unclear, the class starts within
the minimum notice
(12 hours by default), the new time is unclear or does not exist in that time zone (clock changes),
the model is under
80% sure, or nothing would change. Only then does it check the new time: not too soon, inside the
tutor's hours, no
clash for the tutor or the learner.

### Safety, in one place

- **Privacy:** names and contact details are replaced before any model reads a message. The mapping
  is encrypted
  (AES-256-GCM) and swept after 30 days. A parent's message is stored encrypted.
- **Prompt injection:** a code-side screen plus the model's own flag, and the policy treats either
  as a reason to
  escalate. Emails are fixed templates; a parent's words never reach an email.
- **Email can never reach a real parent by accident:** mail goes only to `EMAIL_ALLOWLIST`; anyone
  else is redirected
  to `DEMO_INBOX` (marked as such) or blocked. Production refuses to start without an allowlist.
  `EMAIL_DRY_RUN=1`
  sends nothing and only records what would have been sent.
- **No double work:** moving a booking is idempotent per request, uses an optimistic version check,
  and the database
  itself refuses overlapping classes. Each email is sent at most once per request, recipient and
  kind. A retry only
  finishes what is left.
- **Accept links:** HMAC-signed, single-use, 48 hours, and every other offered link dies once one is
  used. The page
  never consumes a link on open (email scanners open links); only the button does.
- **Time:** stored in UTC, shown with explicit IANA zones. "7pm" in a parent's message means 7pm in
  the parent's
  zone, and the tutor sees their own local time. Clock-change gaps and repeats are detected, not
  guessed.

## Run it locally (no accounts needed)

Needs Node 22, pnpm, and podman or docker. This uses a throwaway local Postgres, a scripted stand-in
model, an
in-memory calendar and dry-run email. It touches nothing external.

```bash
pnpm install
scripts/local-demo.sh setup    # database, migrations, fictional data
scripts/local-demo.sh web      # terminal 1: http://localhost:3000
scripts/local-demo.sh worker   # terminal 2: without it, runs stay "queued"
```

Sign in as `ebun@example.com` / `demo-password-1` (Ops). Tutors: `daniel@example.com`,
`sophie@example.com`.

From the command line, with the same environment:

```bash
eval "$(scripts/local-demo.sh env)"
pnpm reschedule "Can we move Amara's 7am class on Monday to 7pm?" --guardian Amara
```

The command prints each agent step, the Scheduler's tool calls, the decision and the messages. It
uses an in-memory
calendar unless you add `--live-calendar`.

**The stand-in model is scripted.** It reads simple phrases ("7pm", "noon", weekdays, "tomorrow").
It shows the whole
flow works; it says nothing about how a real model reads messy parents. Use a real model for that
(below).

## Running with the real services

Copy `.env.example` to `.env` and fill it in. `.env` is git-ignored and checked by `pnpm
check:secrets`.

| Setting | Purpose |
| --- | --- |
| `DATABASE_URL`, `DIRECT_URL` | Postgres (Neon: pooled URL for the app, direct URL for migrations) |
| `ENCRYPTION_KEY` | 32 random bytes, base64: `openssl rand -base64 32` |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | Sign-in secret (32+ characters) and the app's public address |
| `LLM_API_KEY`, `LLM_MODEL_MAIN`, `LLM_MODEL_SMALL`, `LLM_BASE_URL` | Gemini through its OpenAI-compatible API |
| `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`, `GOOGLE_CALENDAR_ID` | Calendar. Share the calendar with the service account's email, "Make changes to events" |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | Email (a Gmail app password works for a demo) |
| `EMAIL_ALLOWLIST`, `DEMO_INBOX`, `EMAIL_DRY_RUN` | Who may receive real mail; where everyone else is redirected; `1` = send nothing |
| `ACTION_LINK_SECRET` | HMAC key for accept links (32+ characters) |
| `RESCHEDULE_MIN_NOTICE_HOURS` | Minimum notice for an automatic move (default 12) |
| `DAILY_SPEND_CAP_USD`, `LLM_PRICE_*` | Daily AI budget and prices per million tokens (prices are yours to set; 0 disables the cap) |

Then:

```bash
pnpm db:deploy     # apply migrations (uses DIRECT_URL)
pnpm db:seed       # accounts and the fictional demo data
pnpm worker        # the background worker
pnpm --filter @mssuzie/web dev
```

`MOCK_LLM=1` is refused when `NODE_ENV=production`.

## Tests

| Command | What it runs |
| --- | --- |
| `pnpm typecheck` | TypeScript, strict, all packages |
| `pnpm test:db` | Unit and integration tests against a real throwaway Postgres (queue concurrency, booking moves, notifier, API access rules) |
| `pnpm eval` | **The rescheduling eval**: ten parent messages through the real pipeline (clear, ambiguous, wrong child, relative dates, time zones, prompt injection). Reports decision accuracy and checks safety: no unexpected booking change, **zero emails outside the allowlist**, no injection obeyed. Exits non-zero if a safety rule fails. Needs `TEST_DATABASE_URL` and never touches `DATABASE_URL`. |
| `pnpm e2e` | Playwright in a real browser against its own database, build directory and worker |

```bash
pnpm test:db:up
export TEST_DATABASE_URL="$(bash scripts/test-db.sh url)"
pnpm eval --out eval-report.json          # scripted stand-in model by default
MOCK_LLM= pnpm eval --only clear-evening  # a real model, one case (needs LLM_* set)
```

The eval pins "now" to a fixed Saturday so results do not depend on the day it runs. In the scripted
mode one case
(a message about another family's child) is skipped and reported as skipped, because only a real
model can judge it.
Every run prints which mode it used. A live run makes about five model calls per case; a free-tier
quota may not cover
all ten.

## Layout

```text
apps/web      Next.js (App Router, Tailwind, Better Auth): screens, API, parent link page
apps/worker   Plain Node worker: claims queued runs from Postgres, executes them, retries stuck ones
packages/core Prisma schema and client, agents, Privacy Guard, rescheduling pipeline and policy,
              calendar, mailer, scheduling maths, seed data, CLIs, the eval
scripts       local-demo.sh, e2e.sh, test-db.sh, check-secrets.mjs
docs          provider research notes (Google Calendar, email)
```

The queue is Postgres (`FOR UPDATE SKIP LOCKED`), with heartbeats, stuck-run recovery and a graceful
shutdown. There is
no Redis.

## Deployment (planned shape, not yet exercised)

Web on Vercel, Postgres on Neon, worker on Railway. None of this has been deployed from this
repository yet, so treat
it as a plan to follow and check: set the variables above on both services, run `pnpm db:deploy`
once with the direct
Neon URL, start the worker with `pnpm worker`, and set `NODE_ENV=production`, `EMAIL_ALLOWLIST` and
`ACTION_LINK_SECRET`
(production refuses to start without them).

## Known limits

- **Not yet verified against real services:** Gemini tool calling for the Intake and Scheduler
  agents, Google Calendar,
  and SMTP have only been tested against faked responses. Run `pnpm eval` with a real model before
  trusting the
  agents' reading of real parents.
- Free-tier model quotas are small; the app fails fast with a plain-language message when one is
  exhausted.
- The accept link and Ops "choose a time" re-check the live schedule, but a parent's reply by email
  is not read:
  parents answer through the simulator, or by the link.
- The calendar event carries first names only; the calendar is shared with a service account, so
  keep it private.
- Gmail app passwords are fine for a demo and rate limited; swap the transport for a transactional
  email provider for
  real volume.
