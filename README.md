# LabelCheck

A take-home prototype for TTB alcohol-beverage label compliance review. The core job is **extracting the label data from a photo to prefill the application**: upload a label image (or a batch) and LabelCheck reads it with a vision model — brand name, class/type, alcohol content, net contents, bottler/producer, country of origin — returning a structured record you review and correct. The same extraction powers the government-warning checks against 27 CFR part 16 (heading format, body text, minimum type size). When a filed application value is present (typed form fields, or a CSV joined by filename), every extracted field is also compared against it: matching fields pass, differing ones flag. It does not decide compliance — the difference here (or the reviewed extraction, if no filed value exists) is the deliverable, and the reviewer makes the call.

## Quick start

```bash
npm install
npx wrangler login
npx wrangler secret put TURNSTILE_SECRET   # Turnstile secret key from the dashboard
npx wrangler secret put AGENT_AI_TOKEN     # Cloudflare API token, Account → Workers AI → Edit
npm run dev                                # http://localhost:8787
npm run deploy
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
  │                 warning format cues). MEASURED 2.3–3.8 s per label, full parse on
  │                 all five fixtures. Why REST and not the env.AI binding: every
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
- **No server storage of anything.** No KV, no D1, no R2, no logs of image content. Per Marcus: nothing sensitive is stored. Each request is stateless: verify and forget. Results CSV is assembled and downloaded client-side.

## UX decisions

- **5-second rule (Sarah).** Every result shows a latency badge ("checked in 2.3 s"); anything over 5 s is visibly marked slow. The extraction budget is 9 s hard — over 5 s is tolerated but called out, never hidden. Measured on the fixture set: scout extraction 2.3–3.8 s, all five under 5 s.
- **Batch mode** exists because the workload is 200–300-image import dumps, not single bottles. Single-image mode stays for quick spot checks.
- **"My mother could figure out" (stakeholder).** Big controls, three steps: tick the robot box, drop files, click start. Plain-language error copy ("Tick the robot box again before the next check"), no jargon, no modal wizards.
- **Style-only differences are PASS, not FLAG (Dave's Stone's Throw anecdote).** A label printing `STONE'S THROW` against an application saying `Stone's Throw` is the same words — casing and punctuation are normalized away. Only actual word differences flag.
- **The warning is held to exactness (Jenny).** The government warning body is compared to the canonical 27 CFR 16.21 statement, and the heading must be rendered ALL CAPS **and** bold per TTB formatting rules. Title-case heading → flag. Missing warning → flag. On top of that the check follows 27 CFR 16.22: text after the heading must *not* be bold, and the warning must meet the minimum type size for the container (1 mm ≤237 mL, 2 mm ≤3 L, 3 mm above) — an estimated x-height below the threshold flags. The type-size estimate is vision-model judgement with 15% slack, so only clearly-too-small type flags.

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
| ~5 s per label or agents won't use it (Sarah) | measured 2.3–3.8 s/fixture; latency badge on every result; 9 s hard abort |
| Batch upload of 200–300 labels (Sarah/Janet) | file picker + optional CSV, chunks of 10 sent sequentially, resume from failed chunk |
| "My mother could figure it out" UX | three-step flat form, plain-language errors, no wizards |
| Style-only diff = PASS (Dave, "STONE'S THROW") | `matchText` → `style_only`; fixture `stonesthrow-style.png` must pass |
| Warning verbatim, heading ALL CAPS + bold (Jenny) | `compareWarning` + `aurora-warn-titlecase.png` (flag) + `harbor-warn-missing.png` (flag) |
| Warning legibility: type size, not-bold body, contrast (27 CFR 16.22 via ttb.gov) | `checkWarning` → `requiredTypeSizeMm`/`compareTypeSize`; `body_bold` flag; contrasting-background design is model-visible only, not checked — fixture `inlet-batch-cases.png` (flag) |
| Bottler/producer name+address mandatory (27 CFR 5.63(b)) | "Bottler / producer" form field + `bottler` CSV column, absence → flag when the application provides it |
| Brand, class/type, ABV, net contents, country of origin | deterministic checks incl. ±0.5% ABV tolerance and mL/L conversion |
| Vendor firewall (Marcus) | Carbon CSS + Plex fonts served from `public/vendor/`, zero external assets except the Turnstile script |
| Nothing crazy / no storage (Marcus) | no KV/D1/R2, no image persistence, stateless verify-and-forget |
| Bot protection before AI spend | Turnstile siteverify gate in front of `/api/verify` (design rationale in *Bot protection*) |
| 5 verdicts in sample-label matrix; extra fixtures encouraged | 6 synthetic fixtures + `scripts/expected-results.json` ground truth |

Known gaps are listed under *Trade-offs and limitations* (notably: typographic instructions cannot be read out of a photo except by model judgement, and original artwork files would be required for exact font metadata).

## Trade-offs and limitations

Honest list, roughly by how much it would cost to fix:

- **No COLA integration.** Application data is pasted or CSV-parsed, keyed by filename. A real system pulls the application by COLA ID; this prototype has no access to one.
- **Full Turnstile E2E could not be exercised in this build environment.** Three browser engines on this machine (Chromium, WebKit) refused the managed challenge itself — reproduced with Cloudflare's own minimal snippet and their always-pass test keys — so the client challenge never completes here. The server gate was verified differently: a bogus token hits real siteverify and gets 403. The widget domains, action check, and hostname allowlist are configured for localhost + the deployed host; run `node scripts/e2e.mjs <base-url>` from a normal browser environment for the full path.
- **Vision model accuracy varies** on glare, blur, heavy skew, or cropped labels. Mitigation is honest, not clever: the model self-reports `readable: false` plus image issues, and unreadable images are flagged for a human — there is no de-skew/OCR-fallback pipeline.
- **Warning boldness and type size are judged by the model eyeballing the rendering.** `heading_bold`, `body_bold`, and `type_size_mm` are vision-model opinions, not font metadata. The type-size estimate carries 15% slack so only clearly-too-small warning text flags — borderline cases will need human eyes. This is the weakest link in the warning check and a known false-positive/negative risk. A real system would want the artwork file (vector/PDF), not a photo, to measure fonts exactly.
- **Sequential batch throughput.** 10 images/request, one model call per image, chunks one after another. Parallel chunking is straightforward later; it wasn't worth the complexity for a prototype and it makes quota burn harder to reason about.
- **Turnstile hostname allowlist must include the final deployed host.** `TURNSTILE_HOSTNAMES` fails closed — a fresh host 403s until both it and the widget's `--domain` list are updated, by design.
- **Tests are unit/route level with an injected fake chat client.** No live-model golden tests; extraction-quality regressions won't be caught by CI. `scripts/e2e.mjs` covers live extraction when run with credentials.
- **Fixtures are synthetic SVG-rendered labels, not photographs.** Clean type on flat cream backgrounds. Real submissions are phone photos of curved glass with glare.

## Sample labels

Six fixture labels exercise the verdict matrix: clean pass, ABV mismatch, style-only casing (must still pass), title-case warning heading, missing warning, and an under-sized warning (27 CFR 16.22(b)).

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
│   ├── index.ts        worker entry: routing, request cap, Turnstile gate
│   ├── siteverify.ts   Turnstile siteverify (fail-closed, action + hostname checks)
│   ├── completions.ts  OpenAI-compatible chat client (model + 9 s abort)
│   ├── extract.ts      extraction prompt, JSON coercion, retry + budget
│   ├── verify.ts       field checks + verdict rollup
│   ├── normalize.ts    normalization, text/ABV/volume matching, warning compare
│   ├── warning.ts      canonical 27 CFR part 16 statement
│   ├── codec.ts        runtime shape guards
│   └── types.ts        shared types
├── public/             static UI (index.html, app.js, styles.css)
│   ├── vendor/         vendored Carbon CSS + IBM Plex Sans woff2/woff
│   ├── samples.csv     demo application data
│   └── *.png           generated sample labels
├── scripts/
│   ├── make-labels.mjs      fixture generator (SVG → PNG via sharp)
│   ├── e2e.mjs              browser E2E: single + batch live flows (puppeteer)
│   └── expected-results.json ground truth for the fixtures
├── wrangler.jsonc      Worker config (assets, Turnstile + account vars)
└── .dev.vars           local secrets (gitignored)
```
