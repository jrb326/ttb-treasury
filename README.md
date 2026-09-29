# LabelCheck

A take-home prototype for TTB alcohol-beverage label compliance review. The core job is **extracting the label data from a photo to prefill the application**: upload a label image (or a batch) and LabelCheck reads it with a vision model — brand name, class/type, alcohol content, net contents, bottler/producer, country of origin — returning a structured record you review and correct. The same extraction powers the government-warning checks against 27 CFR part 16 (heading format, body text, minimum type size). When a filed application value is present (typed form fields, or a CSV joined by filename), every extracted field is also compared against it: matching fields pass, differing ones flag. The same pass also scores the label against a **federal-regulation checklist** (27 CFR citations, VLM observations) rendered in the left panel. It does not decide compliance — the difference here (or the reviewed extraction, if no filed value exists) is the deliverable, and the reviewer makes the call.

## Quick start & deploy (Cloudflare)

```bash
npm install
npx wrangler login                    # session for deploys (this is NOT the AI token)
npx wrangler secret put TURNSTILE_SECRET   # Turnstile secret key from the dashboard
npx wrangler secret put AGENT_AI_TOKEN     # Cloudflare API token, Account → Workers AI → Edit
npx wrangler d1 create labelcheck-budget   # first time only; add binding per wrangler.jsonc
npx wrangler d1 execute labelcheck-budget --remote --command \
  "CREATE TABLE IF NOT EXISTS ai_budget (day TEXT PRIMARY KEY, neurons INTEGER NOT NULL DEFAULT 0);"
npm run dev                                # http://localhost:8787
npm run deploy                             # → https://treasury-labelcheck.jrb326.workers.dev
```

`AGENT_AI_TOKEN` is an **API token** (dash → profile → API tokens → custom, `Account / Workers AI / Edit`), chosen so the Worker can call the OpenAI-compatible endpoint with a short-lived `fetch` instead of holding an account-scoped credential. Store it without ever printing it:

```bash
umask 077; read -rsp 'CF API token: ' t; echo; printf '%s' "$t" > ~/.cf-ai-token; unset t
```

For local dev the same two values live in `.dev.vars` (gitignored): `TURNSTILE_SECRET=…`, `AGENT_AI_TOKEN=…`. `TURNSTILE_HOSTNAMES` and `CF_ACCOUNT_ID` are plain vars in `wrangler.jsonc`; the allowlist already contains `localhost`, `127.0.0.1`, and `treasury-labelcheck.jrb326.workers.dev`. Add the final host before the first production check — the gate fails closed by design.

Tests and types:

```bash
npm run test        # vitest
npm run typecheck   # tsc --noEmit
```

## Architecture

```
browser (public/, static assets)
  │  POST /api/verify  { items: [{file, image, app}] (≤10), turnstile: {token} }
  ▼
Turnstile siteverify          fail-closed gate; action must be "verify",
  │                           hostname must be in TURNSTILE_HOSTNAMES
  ▼
Workers AI REST     POST …/accounts/:id/ai/v1/chat/completions
  │                 (OpenAI-compatible; model @cf/meta/llama-4-scout-17b-16e-instruct)
  │                 One structured-JSON extraction per image (fields + readability +
  │                 warning format + regulation cues). MEASURED 3.9–6.1 s per label
  │                 (median 5.2 s) across the current prompt, 6/6 clean parses.
  │                 Why REST and not the env.AI binding: every
  │                 native image input — moondream ({} responses), prompt+images,
  │                 content-blocks — silently dropped the image on this account;
  │                 only the OpenAI-compatible route delivered pixels (verified by
  │                 an answer only visible eyes could give: "Old Tom Distillery").
  │                 9 s hard budget (fetch abort) + Promise.race backstop.
  ▼
deterministic verification    normalize + classify each field:
  │                             text: exact / style-only / similar / mismatch
  │                             ABV: ±0.5% tolerance, proof/2 unification
  │                             net contents: unit conversion (750 mL = 0.75 L)
  │                             warning: body vs canonical 27 CFR 16.21 text,
  │                                      heading must be ALL CAPS *and* bold
  ▼
verdict                       pass / flag / error, rolled up across fields
```

The model only transcribes. All judgment lives in `src/normalize.ts` and `src/verify.ts` — pure, testable functions. The model never decides pass/fail, and a parse failure retries once, then surfaces as a per-image `error` verdict rather than a silent pass.

## Batch design

Reviewers don't check one bottle; they get import dumps of 200–300 images with a spreadsheet of application data. So:

- The client chunks files into groups of 10 (the server's hard per-request cap) and sends the chunks **sequentially** — each image is one model call, and sequential requests keep a 300-image run simple and resumable from the failed chunk.
- The CSV of application data is parsed **in the browser** (`public/app.js`), keyed by filename. Nothing about the spreadsheet leaves the machine except the rows for the images being checked.
- Mismatches surface **before** anything is sent: images with no CSV row are listed (they'll still be checked for warnings/spelling, just with nothing to compare), and CSV rows matching no chosen photo are listed as "won't be sent."
- **No server storage of application data or images.** Neither ever persists or is logged; requests are stateless: verify and forget, results CSV assembled client-side. D1 holds exactly one row per day — `ai_budget(day, neurons)` — for the free-tier rate limit (see *Daily AI-budget rate limit*); it contains counts, never content. Per Marcus: nothing sensitive is stored.

## UX decisions

- **5-second rule (Sarah).** Every result shows a latency badge ("checked in 4.9 s"); anything over 5 s is visibly marked slow. The extraction budget is 9 s hard — over 5 s is tolerated but called out, never hidden. Measured with the current (trimmed) prompt on the fixture set: **3.9–6.1 s, median 5.2 s**, 6/6 clean parses. (Earlier runs hit 2.3–3.8 s; provider latency varies run-to-run — same prompt measured 8.2 s median on a congested stretch. The badge reports what actually happened.)
- **Batch mode** exists because the workload is 200–300-image import dumps, not single bottles. Single-image mode stays for quick spot checks.
- **"My mother could figure out" (stakeholder).** Big controls, three steps: tick the robot box, drop files, click start. Plain-language error copy ("Tick the robot box again before the next check"), no jargon, no modal wizards.
- **Style-only differences are PASS, not FLAG (Dave's Stone's Throw anecdote).** A label printing `STONE'S THROW` against an application saying `Stone's Throw` is the same words — casing and punctuation are normalized away. Only actual word differences flag.
- **The warning is held to exactness (Jenny).** The government warning body is compared to the canonical 27 CFR 16.21 statement, and the heading must be rendered ALL CAPS **and** bold per TTB formatting rules. Title-case heading → flag. Missing warning → flag. On top of that the check follows 27 CFR 16.22: text after the heading must *not* be bold, and the warning must sit on a contrasting background. Minimum type size (16.22(b)) is *schema'd but inert on this model* — measurements in *Trade-offs*, so heading/body/contrast and the verbatim text are the operative checks.

## Bot protection

Free-tier Workers AI quota is the only thing a crawler could burn here, so **every** `POST /api/verify` passes Turnstile siteverify **before** a single token is spent on the model:

- Token missing, malformed, expired, or `success: false` → 403.
- `action` must equal `"verify"` — a token minted for some other widget on the same sitekey doesn't count.
- `hostname` must be in the `TURNSTILE_HOSTNAMES` allowlist — a stolen sitekey can't be replayed from an attacker's domain.
- Fail-closed: siteverify network error or non-2xx → 403, never "assume human."
- Tokens are single-use; the widget resets after every attempt, success or failure, so the UI always demands a fresh tick.

## Requirements audit — original instructions → code

Tracked against `treasurytakehome-rgb/instructions` README (the take-home brief). The brief itself does not quote the warning's font rules directly; it says to review ttb.gov for label requirements, so the concrete typography rules come from the regulation it points at — **27 CFR 16.22**: heading "GOVERNMENT WARNING" in capitals and bold, remainder not bold, and minimum type size (1 mm ≤237 mL / 2 mm ≤3 L / 3 mm above), readily legible on a contrasting background.

| Requirement | Where |
|---|---|
| ~5 s per label or agents won't use it (Sarah) | measured 3.9–6.1 s/label (median 5.2 s) with the current prompt; latency badge on every result; 9 s hard abort |
| Batch upload of 200–300 labels (Sarah/Janet) | file picker + optional CSV, chunks of 10 sent sequentially, resume from failed chunk |
| "My mother could figure it out" UX | three-step flat form, plain-language errors, no wizards |
| Style-only diff = PASS (Dave, "STONE'S THROW") | `matchText` → `style_only`; fixture `stonesthrow-style.png` must pass |
| Warning verbatim, heading ALL CAPS + bold (Jenny) | `compareWarning` + `aurora-warn-titlecase.png` (flag) + `harbor-warn-missing.png` (flag) |
| Warning legibility: type size, not-bold body, contrast (27 CFR 16.22 via ttb.gov) | `checkWarning` → `body_bold`/`contrast_ok`/`size_issue` flags from the VLM. **Measured limitation:** llama-4-scout reports `size_issue="none"` even for 6 px grey microprint, so the 16.22(b) size rule never fires in practice (see *Trade-offs*) — fixture `inlet-batch-cases.png` documents this |
| Bottler/producer name+address mandatory (27 CFR 5.63(b)) | "Bottler / producer" form field + `bottler` CSV column, absence → flag when the application provides it |
| Brand, class/type, ABV, net contents, country of origin | deterministic checks incl. ±0.5% ABV tolerance and mL/L conversion |
| Vendor firewall (Marcus) | Carbon CSS + Plex fonts served from `public/vendor/`, zero external assets except the Turnstile script |
| Nothing crazy / no storage (Marcus) | no application data or image persistence; D1 used only for the daily neuron count |
| Bot protection before AI spend | Turnstile siteverify gate in front of `/api/verify` (design rationale in *Bot protection*) |
| 5 verdicts in sample-label matrix; extra fixtures encouraged | 6 synthetic fixtures + `scripts/expected-results.json` ground truth |
| Federal-regulation check using the VLM + left-panel checklist | `regulation_cues` extraction + `src/regulations.ts` (10 cited rules) → `#reg-card` in the left pane; VLM marks "unknown", not checked, never flags |

Known gaps are listed under *Trade-offs and limitations* (notably: typographic instructions cannot be read out of a photo except by model judgement, and original artwork files would be required for exact font metadata).

## Approach, tools and assumptions

**Approach.** One vision-model call per image produces a structured record — the label data that prefills the application — and every *judgment* in the app is deterministic code after that. The model transcribes; `normalize.ts`/`verify.ts` decide. Splitting it this way means rules can be fixed without prompt engineering, verdicts are unit-testable, and a model failure surfaces as a red `error` row instead of a confident wrong answer. A 9 s hard abort + Sarah's 5 s badge keeps latency honest (measured 3.9–6.1 s, median 5.2 s on the fixture set; provider latency varies run to run, so the badge reports what actually happened).

**Tools.**

| Layer | Choice | Why |
|---|---|---|
| Hosting | Cloudflare Workers + static assets (`wrangler`) | one command deploy, no server to run, Workers AI lives on the same account |
| Inference | `@cf/meta/llama-4-scout-17b-16e-instruct` via OpenAI-compatible REST | only route that actually delivered pixels on this account (the `env.AI` binding silently dropped every image-input shape); scout beat mistral on latency and `heading_bold` accuracy |
| Bot gate | Cloudflare Turnstile (widget + server siteverify, fail-closed) | protects the free-tier AI quota before a token is spent |
| Frontend | vanilla HTML/CSS/JS + vendored IBM Carbon 10.58.1 + IBM Plex Sans | no framework to build; Carbon meets the plain-UI ask; *vendored* because the environment blocks CDN egress |
| Tests | vitest (96 tests, incl. the budget ledger) + `tsc --noEmit`; puppeteer-core E2E/radius audits | deterministic core gets unit tests; browser flows get one script |
| Fixtures | sharp + SVG → PNG (`scripts/make-labels.mjs`) | reproducible ground-truth labels, including deliberate violations |

**Assumptions made.**

1. No COLA system access — the "filed application" is whatever the reviewer types or drops into `samples.csv`, joined to photos by **exact filename**.
2. Form fields are optional inputs, not requirements: empty = "extraction only" (`No filed value` pill); populated = compare against the printed label.
3. Style-only differences (casing/punctuation) are **acceptable**, per Dave's `STONE'S THROW` story; word changes are not.
4. Warning legibility checks treat model observations (`heading_bold`, `body_bold`, `contrast_ok`, `size_issue`) as evidence — model judgement, not font metadata; the 27 CFR 16.22(b) minimum-type-size rule is schema'd but inert on this model (see *Trade-offs*), and exactness needs the original artwork.
5. Verdict semantics: `pass` / `flag` / `error` only; the tool flags, the reviewer decides; `error` means "couldn't read it", never "it passed."
6. Batch = sequential chunks of 10, client-side CSV parse, zero server storage (Marcus's "don't store anything sensitive").
7. Sample labels are synthetic; the repo contains no third-party label artwork.
8. Secrets never touch the repo: `AGENT_AI_TOKEN`/`TURNSTILE_SECRET` live in `.dev.vars` (gitignored) and `wrangler secret`; `.gitignore` also excludes `.env*`, `*.pem`, `*.key`, `*token*` and similar so a GitHub upload stays clean.

## Daily AI-budget rate limit (free tier protection)

Cloudflare gives **10,000 free neurons/day** per account (resets 00:00 UTC — [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)); scout costs **24,545 neurons/M input + 77,273/M output**. Measured on the fixtures: ~2.1–2.3k input + ~280 output ≈ **77 neurons/label**.

The Worker keeps a two-phase ledger in **D1** (`src/budget.ts`, binding `BUDGET`):

1. **Reserve before any model call** — per-label cost parsed from the image header (`src/imageSize.ts`: PNG IHDR / JPEG SOF / WebP — no decoders), converted to a conservative input-token estimate at pricelist rates: an 800×1100 fixture books ~120 neurons, a 4032×3024 phone photo ~760 (a flat reserve would under-book 6× on real uploads). Booked in one guarded `UPDATE … WHERE neurons + cost <= 8000 RETURNING` — atomic, **fail-closed**: over cap → `429 DAILY_BUDGET_EXHAUSTED` *before* any model call. Cap = **8,000/day** (20% headroom under CF's 10,000 hard stop) ⇒ ~66 fixture labels/day, ~10 phone-photo labels per 10-image batch call.
2. **Settle after** — the chat client accumulates cumulative `usage` (retries included — `chat.usageTotal` sums every call, never overwrites); `verifyItems` charges the per-label delta at exact pricelist rates; `settle()` moves the ledger to *actual*, **including charging overshoot above the reservation** (the ledger must never under-report what Cloudflare billed) and refunding shortfalls (test doubles → full refund). No usage measured (aborted calls) → keep the reservation; usage is never invented.

**Belt-and-braces:** even if our estimate were low, Cloudflare itself hard-stops the account at 10,000 neurons/day — further Workers AI operations fail (docs) — so a ledger mistake cannot produce paid overage; the worst case is a failed request with our 429-style error surface instead of silent spend. Tune: `DAILY_BUDGET` / `RESERVE_PER_LABEL` in `src/budget.ts`; today's row: `npx wrangler d1 execute labelcheck-budget --remote --command "SELECT * FROM ai_budget WHERE day = strftime('%Y-%m-%d','now');"`

## Trade-offs and limitations

Honest list, roughly by how much it would cost to fix:

- **No COLA integration.** Application data is pasted or CSV-parsed, keyed by filename. A real system pulls the application by COLA ID; this prototype has no access to one.
- **Full Turnstile E2E could not be exercised in this build environment.** Three browser engines on this machine (Chromium, WebKit) refused the managed challenge itself — reproduced with Cloudflare's own minimal snippet and their always-pass test keys — so the client challenge never completes here. The server gate was verified differently: a bogus token hits real siteverify and gets 403. The widget domains, action check, and hostname allowlist are configured for localhost + the deployed host; run `node scripts/e2e.mjs <base-url>` from a normal browser environment for the full path.
- **Vision model accuracy varies** on glare, blur, heavy skew, or cropped labels. Mitigation is honest, not clever: the model self-reports `readable: false` plus image issues, and unreadable images are flagged for a human — there is no de-skew/OCR-fallback pipeline.
- **Warning boldness and contrast are judged by the model eyeballing the rendering.** `heading_bold`, `body_bold`, and `contrast_ok` are vision-model opinions, not font metrics. **Minimum type size (27 CFR 16.22(b)) is effectively NOT checked:** numeric mm estimation returned a constant 1.5 mm across all fixtures (measured), and a visual smallness cue (`size_issue`) does not fire — llama-4-scout returns `"none"` even for warning text rendered at 6 px in grey (measured three ways). The rule exists in the schema and will flag if the model ever reports it, but on this model it is inert. A real check needs the artwork file (vector/PDF) or a separate legibility task (crop + "transcribe this" — legibility then fails as unparseable). The warning *text* and *heading format* checks are unaffected — they work.
- **Sequential batch throughput.** 10 images/request, one model call per image, chunks one after another. Parallel chunking is straightforward later; it wasn't worth the complexity for a prototype and it makes quota burn harder to reason about.
- **Turnstile hostname allowlist must include the final deployed host.** `TURNSTILE_HOSTNAMES` fails closed — a fresh host 403s until both it and the widget's `--domain` list are updated, by design.
- **Tests are unit/route level with an injected fake chat client.** No live-model golden tests; extraction-quality regressions won't be caught by CI. `scripts/e2e.mjs` covers live extraction when run with credentials.
- **Fixtures are synthetic SVG-rendered labels, not photographs.** Clean type on flat cream backgrounds. Real submissions are phone photos of curved glass with glare.

## Sample labels

Six synthetic fixtures (`oldtom` … `inlet`) exercise the verdict matrix — clean pass, ABV mismatch, style-only casing (must still pass), title-case warning heading, missing warning, and an under-sized warning that documents the inert size check. The Demo picker also carries three real user-supplied labels (`demo-wheatbeer.png`, `demo-stout-keg.png`, `demo-milos-ale.png`) whose records came from live extraction runs — graphic-backed backgrounds, the case synthetic flat fixtures can't cover.

```bash
node scripts/make-labels.mjs     # writes public/*.png (needs sharp, already a devDep)
```

Ground truth per image lives in `scripts/expected-results.json` (expected verdict + flagged fields + the application record). The **Demo** card at the top of the app pre-loads any of these six samples — same records, no file to pick. To run the batch flow by hand: serve the deployed (or `wrangler dev`) site, switch to batch mode, select all six PNGs, load `public/samples.csv`, start. Note `samples.csv` deliberately carries application rows that disagree with the printed labels, so the run produces a mix of PASS and FLAG rows; `expected-results.json` holds the matching-application ground truth.

## Theme

IBM Carbon: vendored compiled CSS (`public/vendor/carbon-components.min.css`, carbon-components@10.58.1) plus three IBM Plex Sans weights served locally from `public/vendor/fonts/`. Vendored, not CDN — Marcus's firewall blocks third-party egress. Form controls, buttons, tags, notifications and the progress bar are Carbon `bx--` patterns; app-specific pieces (verdict banner, result table, batch rows) sit in `styles.css` on Carbon tokens. Corners flat throughout (`border-radius: 0` on tags; the spinner circle is a status glyph, not a box).

## Deployed URL

**https://treasury-labelcheck.jrb326.workers.dev** — Cloudflare Workers, single deploy, static assets + `/api/*` in one Worker.

## Repo structure

```
.
├── src/
│   ├── index.ts         worker entry: routing, request cap, Turnstile gate, budget reserve/settle
│   ├── siteverify.ts    Turnstile siteverify (fail-closed, action + hostname checks)
│   ├── completions.ts   OpenAI-compatible chat client (model + 9 s abort + cumulative usage)
│   ├── extract.ts       extraction prompt, JSON coercion, retry + budget
│   ├── verify.ts        field checks + verdict rollup
│   ├── regulations.ts   federal-regulation checklist rules (27 CFR citations)
│   ├── normalize.ts     normalization, text/ABV/volume matching, warning compare
│   ├── budget.ts        daily neuron ledger: size-aware reserve + settle
│   ├── imageSize.ts     PNG/JPEG/WebP header → dimensions (for reserve estimate)
│   ├── warning.ts       canonical 27 CFR part 16 statement
│   ├── codec.ts         runtime shape guards
│   └── types.ts         shared types
├── public/             static UI (index.html, app.js, styles.css)
│   ├── vendor/         vendored Carbon CSS + IBM Plex Sans woff2/woff
│   ├── samples.csv     demo application data
│   └── *.png           generated fixtures + real demo labels
├── scripts/
│   ├── make-labels.mjs      fixture generator (SVG → PNG via sharp)
│   ├── e2e.mjs              browser E2E: single + batch live flows (puppeteer)
│   └── expected-results.json ground truth for the fixtures
├── wrangler.jsonc      Worker config (assets, D1, Turnstile + account vars)
└── .dev.vars           local secrets (gitignored)
```
