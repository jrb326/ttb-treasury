# LabelCheck

A take-home prototype for TTB alcohol-beverage label compliance review. Upload a label photo (or a batch of them) plus the COLA application data, and LabelCheck reads the label with a vision model, then runs deterministic comparisons against what the application claims: brand name, class/type, alcohol content, net contents, country of origin, and the 27 CFR part 16 government warning. It does not decide compliance — it flags differences between the printed label and the filed application, and the reviewer (the agent, in the real workflow) makes the call. Every verdict carries the field-by-field evidence behind it.

## Quick start

```bash
npm install
npx wrangler login
npx wrangler secret put TURNSTILE_SECRET   # Turnstile secret key from the dashboard
npm run dev                                # http://localhost:8750
npm run deploy
```

Local dev needs the secret outside git — `wrangler dev` reads `.dev.vars`:

```bash
echo 'TURNSTILE_SECRET=<your-secret-key>' > .dev.vars
```

`TURNSTILE_HOSTNAMES` is a plain var (not a secret) set in `wrangler.jsonc`; the defaults cover `localhost` and `127.0.0.1`, so local dev works as-is. Override it in `.dev.vars` only if you're testing on another host. Before deploy, the var carries a `__WORKER_HOST__` placeholder — after the first deploy, replace it with the real `*.workers.dev` hostname (or pass it through your deploy script) or every production request 403s at the bot gate.

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
Workers AI                    cf/moondream/moondream3.1-9B-A2B — one structured-JSON
  │                           extraction per image (fields + readability + warning
  │                           format cues); 8 s budget via Promise.race because the
  │                           AI binding can't actually be aborted
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

- **5-second rule (Sarah).** Every result shows a latency badge ("checked in 2.3 s"); anything over 5 s is visibly marked slow. The extraction budget is 8 s hard — over 5 s is tolerated but called out, never hidden.
- **Batch mode** exists because the workload is 200–300-image import dumps, not single bottles. Single-image mode stays for quick spot checks.
- **"My mother could figure out" (stakeholder).** Big controls, three steps: tick the robot box, drop files, click start. Plain-language error copy ("Tick the robot box again before the next check"), no jargon, no modal wizards.
- **Style-only differences are PASS, not FLAG (Dave's Stone's Throw anecdote).** A label printing `STONE'S THROW` against an application saying `Stone's Throw` is the same words — casing and punctuation are normalized away. Only actual word differences flag.
- **The warning is held to exactness (Jenny).** The government warning body is compared to the canonical 27 CFR 16.21 statement, and the heading must be rendered ALL CAPS **and** bold per TTB formatting rules. Title-case heading → flag. Missing warning → flag.

## Bot protection

Free-tier Workers AI quota is the only thing a crawler could burn here, so **every** `POST /api/verify` passes Turnstile siteverify **before** a single token is spent on the model:

- Token missing, malformed, expired, or `success: false` → 403.
- `action` must equal `"verify"` — a token minted for some other widget on the same sitekey doesn't count.
- `hostname` must be in the `TURNSTILE_HOSTNAMES` allowlist — a stolen sitekey can't be replayed from an attacker's domain.
- Fail-closed: siteverify network error or non-2xx → 403, never "assume human."
- Tokens are single-use; the widget resets after every attempt, success or failure, so the UI always demands a fresh tick.

## Trade-offs and limitations

Honest list, roughly by how much it would cost to fix:

- **No COLA integration.** Application data is pasted or CSV-parsed, keyed by filename. A real system pulls the application by COLA ID; this prototype has no access to one.
- **Moondream extraction accuracy varies** on glare, blur, heavy skew, or cropped labels. Mitigation is honest, not clever: the model self-reports `readable: false` plus image issues, and unreadable images are flagged for a human — there is no de-skew/OCR-fallback pipeline.
- **Warning boldness is judged by the model eyeballing the rendering.** `heading_bold` is a vision-model opinion, not font metadata. It's the weakest link in the warning check and a known false-positive/negative risk. A real system would want the artwork file, not a photo.
- **Sequential batch throughput.** 10 images/request, one model call per image, chunks one after another. Parallel chunking is straightforward later; it wasn't worth the complexity for a prototype and it makes quota burn harder to reason about.
- **Turnstile hostname allowlist must include the final deployed host.** The `__WORKER_HOST__` placeholder in `wrangler.jsonc` fails closed until replaced — deliberate, but it means a fresh deploy 403s by design.
- **Tests are unit/route level with a mocked AI binding.** No live-model golden tests; extraction-quality regressions won't be caught by CI.
- **Fixtures are synthetic SVG-rendered labels, not photographs.** Clean type on flat cream backgrounds. Real submissions are phone photos of curved glass with glare.

## Sample labels

Five fixture labels exercise the verdict matrix: clean pass, ABV mismatch, style-only casing (must still pass), title-case warning heading, and missing warning.

```bash
node scripts/make-labels.mjs     # writes public/*.png (needs sharp, already a devDep)
```

Ground truth per image lives in `scripts/expected-results.json` (expected verdict + flagged fields + the application record). To run the batch flow by hand: serve the deployed (or `wrangler dev`) site, switch to batch mode, select `public/oldtom-pass.png` … `public/harbor-warn-missing.png`, load `public/samples.csv`, start. Note `samples.csv` deliberately carries application rows that disagree with the printed labels, so the run produces a mix of PASS and FLAG rows; `expected-results.json` holds the matching-application ground truth.

## Deployed URL

TODO(deploy): fill after deploy — `https://treasury-labelcheck.<account>.workers.dev`

Then update `TURNSTILE_HOSTNAMES` in `wrangler.jsonc` (replace `__WORKER_HOST__`) and the `TURNSTILE_HOSTS` list in `public/app.js`, and redeploy.

## Repo structure

```
.
├── src/
│   ├── index.ts        worker entry: routing, request cap, Turnstile gate
│   ├── siteverify.ts   Turnstile siteverify (fail-closed, action + hostname checks)
│   ├── extract.ts      vision-model prompt, JSON coercion, 8 s budget
│   ├── verify.ts       field checks + verdict rollup
│   ├── normalize.ts    normalization, text/ABV/volume matching, warning compare
│   ├── warning.ts      canonical 27 CFR part 16 statement
│   ├── codec.ts        runtime shape guards
│   └── types.ts        shared types
├── public/             static UI (index.html, app.js, styles.css)
│   ├── samples.csv     demo application data
│   └── *.png           generated sample labels
├── scripts/
│   ├── make-labels.mjs      fixture generator (SVG → PNG via sharp)
│   └── expected-results.json ground truth for the fixtures
├── wrangler.jsonc      Worker config (AI binding, assets, Turnstile vars)
└── .dev.vars           local secrets (gitignored)
```
