/* TTB Label Checker — plain JS, no deps. All checks go through POST /api/verify. */
"use strict";

// ── constants ────────────────────────────────────────────────────────────────
const TURNSTILE_SITEKEY = "0x4AAAAAAFHT209vgWKKWBl2"; // widget: treasury-labelcheck-verify
const API_URL = "/api/verify";  // single Worker route (must match src/index.ts)
const MAX_ITEMS = 10;          // server limit per request
const MIN_TOKEN_LEN = 55;      // shorter tokens are test placeholders → treat as absent

const MSG_UNREACHABLE = "Couldn't reach the checker. Your image wasn't lost — try again.";
const MSG_TOKEN = "The robot check wasn't done (or has expired). Tick the box above, then try again.";

const FIELD_ORDER = [
  ["brandName", "Brand name"],
  ["classType", "Class / type"],
  ["alcoholContent", "Alcohol content"],
  ["netContents", "Net contents"],
  ["bottler", "Bottler / producer"],
  ["countryOfOrigin", "Country of origin"],
];

const PILL_LABEL = {
  pass: "Match",
  flag: "Check",
  missing: "Not on label",
  error: "Error",
  not_checked: "No filed value",
};

const CSV_COLUMNS = {
  file: "file",
  brand_name: "brandName",
  class_type: "classType",
  alcohol_content: "alcoholContent",
  net_contents: "netContents",
  country_of_origin: "countryOfOrigin",
  bottler: "bottler",
};

// ── right-pane viewer (SIEM split: evidence at right) ───────────────────────
const viewer = { url: null, own: false, fit: true, scale: 1, rotate: 0 };
const ZOOM_STEPS = [1, 1.25, 1.5, 2, 3, 4];

function viewerPaint() {
  const img = $("viewer-img");
  img.classList.toggle("img--fit", viewer.fit);
  img.style.width = viewer.fit ? "" : (viewer.scale * 100) + "%";
  img.style.transform = "rotate(" + viewer.rotate + "deg)";
  $("viewer-zoom").textContent = viewer.fit ? "Fit" : Math.round(viewer.scale * 100) + "%";
}

function showInViewer(url, label, own) {
  if (viewer.own && viewer.url && viewer.url !== url) URL.revokeObjectURL(viewer.url);
  viewer.url = url;
  viewer.own = !!own;
  viewer.fit = true;
  viewer.scale = 1;
  viewer.rotate = 0;
  const img = $("viewer-img");
  img.onload = null;
  img.src = url;
  show(img, true);
  show($("viewer-empty"), false);
  const meta = $("viewer-meta");
  clear(meta);
  const dims = el("span", null, "measuring…");
  img.onload = function () { dims.textContent = img.naturalWidth + " × " + img.naturalHeight + " px"; };
  meta.appendChild(el("span", null, label));
  meta.appendChild(dims);
  show(meta, true);
  viewerPaint();
}

function clearViewer(url) {
  if (viewer.url !== url) return;
  if (viewer.own) URL.revokeObjectURL(viewer.url);
  viewer.url = null;
  viewer.own = false;
  const img = $("viewer-img");
  img.removeAttribute("src");
  show(img, false);
  show($("viewer-meta"), false);
  show($("viewer-empty"), true);
}

function viewBatchFile(name) {
  const file = state.batchFiles.find(function (f) { return f.name === name; });
  if (file) showInViewer(URL.createObjectURL(file), file.name, true);
}

// ── state ────────────────────────────────────────────────────────────────────
const state = {
  singleFile: null,          // File
  singlePreviewUrl: null,
  singleTimer: null,         // interval id
  batchFiles: [],            // File[]
  csv: new Map(),            // filename -> {brandName, classType, ...}
  batchRunning: false,
  batchChunks: [],           // File[][]
  batchDone: 0,              // files with a verdict
  batchStartMs: 0,
  widgetId: null,
};

// ── tiny DOM helpers (server strings only ever go through textContent) ───────
function $(id) { return document.getElementById(id); }
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function show(node, on) { node.hidden = !on; }

// ── Turnstile lifecycle ──────────────────────────────────────────────────────
// The API is ready only when window.turnstile.render is a function — an element
// with id="turnstile" (or a stub) would otherwise shadow the script's global.
function turnstileReady() {
  return typeof window.turnstile !== "undefined" && typeof window.turnstile.render === "function";
}

function renderWidget() {
  if (state.widgetId !== null || !turnstileReady()) return;
  state.widgetId = window.turnstile.render("#robot-check", {
    sitekey: TURNSTILE_SITEKEY,
    action: "verify",
    callback: function () {
      $("turnstile-status").textContent = "Robot check done. You can run a check now.";
    },
  });
  $("turnstile-status").textContent = "Tick the box above before each check.";
}

function waitForWidget() {
  if (turnstileReady()) { renderWidget(); return; }
  let waited = 0;
  const t = setInterval(function () {
    waited += 400;
    if (turnstileReady()) { clearInterval(t); renderWidget(); }
    else if (waited >= 10000) {
      clearInterval(t);
      $("turnstile-status").textContent =
        "The robot check didn't load. Check your connection and reload the page.";
    }
  }, 400);
}

function resetTurnstile() {
  // Token is single-use: reset after every attempt, success or failure.
  if (turnstileReady() && state.widgetId !== null) window.turnstile.reset(state.widgetId);
  $("turnstile-status").textContent = "Tick the robot box again before the next check.";
}

function getToken() {
  if (!turnstileReady() || state.widgetId === null) return null;
  const t = window.turnstile.getResponse(state.widgetId);
  if (!t || t.length < MIN_TOKEN_LEN) return null; // placeholder / expired → absent
  return t;
}

// ── verify request ───────────────────────────────────────────────────────────
// Resolves with results[]; rejects with {kind: "token"|"unreachable"|"http400", text}.
async function verifyRequest(items) {
  const token = getToken();
  if (!token) throw { kind: "token" };

  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: items, turnstile: { token: token } }),
    });
  } catch (e) {
    resetTurnstile();
    throw { kind: "unreachable" };
  }
  resetTurnstile();

  if (res.status === 403) throw { kind: "token" };
  if (res.status === 400) {
    let text = "";
    try {
      const body = await res.json();
      text = body && body.error ? String(body.error) : "";
    } catch (e) { /* fall through */ }
    if (!text) { try { text = await res.text(); } catch (e) { /* ignore */ } }
    throw { kind: "http400", text: text || "The request was rejected (HTTP 400)." };
  }
  if (!res.ok) throw { kind: "unreachable" };

  const data = await res.json();
  if (!data || !Array.isArray(data.results)) throw { kind: "unreachable" };
  return data.results;
}

function errorFor(kind, text) {
  if (kind === "token") return MSG_TOKEN;
  if (kind === "unreachable") return MSG_UNREACHABLE;
  return text || "Something went wrong. Please try again.";
}

// ── alerts ───────────────────────────────────────────────────────────────────
function showAlert(container, message, onRetry, retryLabel) {
  clear(container);
  show(container, true);
  container.appendChild(el("span", null, message));
  if (onRetry) {
    const b = el("button", "btn", retryLabel || "Try again");
    b.type = "button";
    b.addEventListener("click", onRetry);
    container.appendChild(b);
  }
}

// ── result rendering (shared by single card and batch rows) ─────────────────
function statusPill(status) {
  // Carbon tag presets: neutral gray (pass / not checked), support-tinted when
  // attention is needed, support-red for errors. Carbon has no green tag — a
  // passive "pass" intentionally stays neutral rather than inventing colors.
  const role = status === "error" ? "red" : "gray";
  const warn = status === "flag" || status === "missing" ? " pill-warn" : "";
  const s = el("span", "bx--tag bx--tag--" + role + " pill" + warn, PILL_LABEL[status] || status || "—");
  s.dataset.status = status || "not_checked";
  return s;
}

function latencyBadge(ms) {
  const secs = (ms / 1000).toFixed(1);
  const frag = document.createDocumentFragment();
  const b = el("span", "latency" + (ms > 5000 ? " slow" : ""), "checked in " + secs + " s");
  frag.appendChild(b);
  if (ms > 5000) frag.appendChild(el("span", "latency-note", "Slow — took over 5 seconds."));
  return frag;
}

function renderResult(result) {
  const wrap = el("div", "result");

  const v = result.status || "error";
  const banner = el("div", "verdict " + v);
  if (v === "pass") {
    banner.appendChild(el("span", null, "PASS — looks good"));
  } else if (v === "flag") {
    banner.appendChild(el("span", null, "FLAG — differences found, review needed"));
  } else {
    banner.appendChild(el("span", null, "ERROR — could not check"));
    banner.appendChild(el("small", null,
      "AI couldn't read this label (time-out or failure) — retry or reject image for resubmission."));
  }
  wrap.appendChild(banner);

  wrap.appendChild(latencyBadge(result.latencyMs || 0));

  if (Array.isArray(result.imageIssues) && result.imageIssues.length) {
    const box = el("p", "issues", "Problems reading this image:");
    const ul = el("ul", "summary issues");
    result.imageIssues.forEach(function (s) { ul.appendChild(el("li", null, String(s))); });
    wrap.appendChild(box);
    wrap.appendChild(ul);
  }

  const fields = result.fields || {};
  const rows = FIELD_ORDER.filter(function (f) { return fields[f[0]]; });
  if (rows.length) {
    const table = el("table", "fields");
    const thead = el("thead");
    const hr = el("tr");
    ["Field", "Application value", "On label", "Result"].forEach(function (h) {
      hr.appendChild(el("th", null, h));
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el("tbody");
    rows.forEach(function (f) {
      const val = fields[f[0]] || {};
      const tr = el("tr");
      tr.appendChild(el("td", null, f[1]));
      tr.appendChild(el("td", null, val.expected === undefined || val.expected === null || val.expected === "" ? "—" : String(val.expected)));
      const labelCell = el("td", val.onLabel ? null : "missing-val",
        val.onLabel ? String(val.onLabel) : "not found on label");
      tr.appendChild(labelCell);
      const resCell = el("td");
      resCell.appendChild(statusPill(val.status));
      if (val.note) resCell.appendChild(el("span", "pill-note", String(val.note)));
      tr.appendChild(resCell);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  if (fields.warning) {
    const w = el("p", "warn-card");
    w.textContent = "Warning: " + String(fields.warning);
    wrap.appendChild(w);
  }

  if (Array.isArray(result.summary) && result.summary.length) {
    const ul = el("ul", "summary");
    result.summary.forEach(function (s) { ul.appendChild(el("li", null, String(s))); });
    wrap.appendChild(ul);
  }

  return wrap;
}

// ── federal regulation checklist (server-computed over VLM observations) ────
function renderRegList(result, target) {
  clear(target);
  const checks = Array.isArray(result.regulations) ? result.regulations : [];
  checks.forEach(function (c) {
    const li = el("li", "regrow regrow--" + (c.status || "not_checked"));
    const head = el("div", "regrow__head");
    head.appendChild(statusPill(c.status));
    head.appendChild(el("span", "regrow__req", c.requirement));
    head.appendChild(el("span", "regrow__cite", c.citation));
    li.appendChild(head);
    li.appendChild(el("p", "regrow__detail", c.detail));
    target.appendChild(li);
  });
  return checks.length > 0;
}

function showRegCard(result) {
  const ok = result && renderRegList(result, $("reg-list"));
  show($("reg-card"), !!ok);
}

// ── CSV parsing (RFC4180-ish: quotes, doubled quotes, CRLF) ─────────────────
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false, i = 0;
  text = text.replace(/^\uFEFF/, "");
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvToMap(rows) {
  const map = new Map();
  if (!rows.length) return map;
  const header = rows[0].map(function (h) { return h.trim().toLowerCase(); });
  const idx = {};
  Object.keys(CSV_COLUMNS).forEach(function (col) {
    const at = header.indexOf(col);
    if (at >= 0) idx[CSV_COLUMNS[col]] = at;
  });
  if (idx.file === undefined) throw new Error("missing file column");
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const file = (row[idx.file] || "").trim();
    if (!file) continue;
    const rec = {};
    Object.keys(idx).forEach(function (key) {
      if (key !== "file") rec[key] = (row[idx[key]] || "").trim();
    });
    map.set(file, rec);
  }
  return map;
}

function csvEscape(v) {
  v = String(v === undefined || v === null ? "" : v);
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

// ── demo: pre-loaded TTB sample labels (see scripts/make-labels.mjs) ─────────
const DEMO_APPS = {
  "oldtom-pass.png": {
    brandName: "Old Tom Distillery",
    classType: "Kentucky Straight Bourbon Whiskey",
    alcoholContent: "45% Alc./Vol. (90 Proof)",
    netContents: "750 mL",
    countryOfOrigin: "United States",
    bottler: "bottled by Old Tom Distillery, 123 Main St, Louisville, KY",
  },
  "blackridge-abv-mismatch.png": {
    brandName: "Black Ridge",
    classType: "Kentucky Straight Bourbon Whiskey",
    alcoholContent: "45% Alc./Vol. (90 Proof)",
    netContents: "750 mL",
    countryOfOrigin: "United States",
    bottler: "bottled by Black Ridge Distillery, 456 Oak Ave, Bardstown, KY",
  },
  "stonesthrow-style.png": {
    brandName: "Stone's Throw",
    classType: "Straight Rye Whisky",
    alcoholContent: "40% Alc./Vol. (80 Proof)",
    netContents: "750 mL",
    countryOfOrigin: "United States",
    bottler: "bottled by Stone's Throw Distilling, 78 Creek Rd, Lawrenceburg, IN",
  },
  "aurora-warn-titlecase.png": {
    brandName: "Aurora Reserve",
    classType: "American Gin",
    alcoholContent: "47% Alc./Vol.",
    netContents: "750 mL",
    countryOfOrigin: "United States",
    bottler: "bottled by Aurora Reserve Spirits, 9 Harbor Way, Portland, OR",
  },
  "harbor-warn-missing.png": {
    brandName: "Harbor Light",
    classType: "Pale Ale",
    alcoholContent: "5.2% Alc./Vol.",
    netContents: "355 mL",
    countryOfOrigin: "United States",
    bottler: "brewed by Harbor Light Brewing, 21 Pier Ln, Portsmouth, NH",
  },
  "inlet-batch-cases.png": {
    brandName: "Inlet Bay",
    classType: "New England IPA",
    alcoholContent: "6.8% Alc./Vol.",
    netContents: "473 mL",
    countryOfOrigin: "United States",
    bottler: "brewed by Inlet Bay Brewing, 3 Dock St, San Pedro, CA",
  },
};

async function onDemoPick(e) {
  const name = e.target.value;
  show($("demo-gone"), false);
  if (!name) return;
  let res;
  try {
    res = await fetch(encodeURIComponent(name));
  } catch (err) {
    res = null;
  }
  if (!res || !res.ok) {
    showAlert($("demo-gone"), "Demo image " + name + " could not be loaded from the server.");
    return;
  }
  const blob = await res.blob();
  const file = new File([blob], name, { type: blob.type || "image/png" });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = $("single-file");
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));

  const app = DEMO_APPS[name];
  if (app) {
    $("s-brand").value = app.brandName || "";
    $("s-class").value = app.classType || "";
    $("s-abv").value = app.alcoholContent || "";
    $("s-net").value = app.netContents || "";
    $("s-country").value = app.countryOfOrigin || "";
    $("s-bottler").value = app.bottler || "";
    show($("single-prefill"), true);
  }
}

// ── photo → application form: the extraction IS the record we're building ───
function prefillFromExtraction(ext) {
  if (!ext) return;
  const fill = function (id, value) { if (value) $(id).value = value; };
  fill("s-brand", ext.brand_name);
  fill("s-class", ext.class_type);
  fill("s-abv", ext.alcohol_content);
  fill("s-net", ext.net_contents);
  fill("s-country", ext.country_of_origin);
  fill("s-bottler", ext.bottler);
  show($("single-prefill"), true);
}

// ── single flow ──────────────────────────────────────────────────────────────
function onSingleFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  state.singleFile = file;
  if (viewer.url === state.singlePreviewUrl) clearViewer(state.singlePreviewUrl);
  if (state.singlePreviewUrl) URL.revokeObjectURL(state.singlePreviewUrl);
  state.singlePreviewUrl = URL.createObjectURL(file);
  showInViewer(state.singlePreviewUrl, file.name, false);
  show($("single-clear"), true);
  show($("single-prefill"), false);

  // Prefill from CSV when the filename matches.
  const rec = state.csv.get(file.name);
  if (rec) {
    $("s-brand").value = rec.brandName || "";
    $("s-class").value = rec.classType || "";
    $("s-abv").value = rec.alcoholContent || "";
    $("s-net").value = rec.netContents || "";
    $("s-country").value = rec.countryOfOrigin || "";
    $("s-bottler").value = rec.bottler || "";
    show($("single-prefill"), true);
  }

  show($("single-result"), false);
  clear($("single-result"));
  show($("single-error"), false);
  $("single-check").disabled = false;
}

function clearSingle() {
  state.singleFile = null;
  $("single-file").value = "";
  if (state.singlePreviewUrl) { clearViewer(state.singlePreviewUrl); URL.revokeObjectURL(state.singlePreviewUrl); state.singlePreviewUrl = null; }
  show($("single-clear"), false);
  show($("single-prefill"), false);
  $("single-check").disabled = true;
}

function fileToDataUrl(file) {
  return new Promise(function (resolve, reject) {
    const r = new FileReader();
    r.onload = function () { resolve(String(r.result)); };
    r.onerror = function () { reject(new Error("read failed")); };
    r.readAsDataURL(file);
  });
}

function startSingleTimer() {
  const t0 = Date.now();
  $("single-timer-text").textContent = "Checking… 0 s";
  show($("single-status"), true);
  state.singleTimer = setInterval(function () {
    $("single-timer-text").textContent =
      "Checking… " + Math.round((Date.now() - t0) / 1000) + " s";
  }, 1000);
}
function stopSingleTimer() {
  if (state.singleTimer) { clearInterval(state.singleTimer); state.singleTimer = null; }
  show($("single-status"), false);
}

async function checkSingle() {
  if (!state.singleFile || state.singleTimer) return;

  // Fields are normally empty on the first run — extraction fills them.
  // Whatever was typed is sent as the application side for comparison.
  const app = {};
  const brand = $("s-brand").value.trim();
  const cls = $("s-class").value.trim();
  const abv = $("s-abv").value.trim();
  const net = $("s-net").value.trim();
  const country = $("s-country").value.trim();
  const bottler = $("s-bottler").value.trim();
  if (brand) app.brandName = brand;
  if (cls) app.classType = cls;
  if (abv) app.alcoholContent = abv;
  if (net) app.netContents = net;
  if (country) app.countryOfOrigin = country;
  if (bottler) app.bottler = bottler;

  const btn = $("single-check");
  btn.disabled = true;
  show($("single-error"), false);
  clear($("single-result"));
  startSingleTimer();

  try {
    const image = await fileToDataUrl(state.singleFile);
    const results = await verifyRequest([{ file: state.singleFile.name, image: image, app: app }]);
    stopSingleTimer();
    const out = $("single-result");
    clear(out);
    if (results.length) {
      const result = results[0];
      prefillFromExtraction(result.extraction);
      showRegCard(result);
      out.appendChild(renderResult(result));
    }
    show(out, true);
  } catch (err) {
    stopSingleTimer();
    showAlert($("single-error"), errorFor(err.kind, err.text), checkSingle);
  } finally {
    btn.disabled = false;
  }
}

// ── batch flow ───────────────────────────────────────────────────────────────
function onBatchFiles(e) {
  state.batchFiles = Array.prototype.slice.call(e.target.files || []);
  renderBatchPrep();
}

function onBatchCsv(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function () {
    try {
      state.csv = csvToMap(parseCsv(String(reader.result)));
    } catch (err) {
      state.csv = new Map();
      file_input_reset_csv(e);
      showAlert($("batch-mismatch"),
        "That CSV couldn't be read. It needs a header row with a 'file' column — see samples.csv.");
      renderBatchPrep();
      return;
    }
    show($("csv-clear"), true);
    renderBatchPrep();
  };
  reader.readAsText(file);
}

function file_input_reset_csv(e) { e.target.value = ""; }

function renderBatchPrep() {
  const box = $("batch-mismatch");
  clear(box);
  show($("batch-mismatch"), false);

  const names = state.batchFiles.map(function (f) { return f.name; });
  const csvLoaded = state.csv.size > 0;

  if (csvLoaded) {
    const imagesNoRow = names.filter(function (n) { return !state.csv.has(n); });
    if (imagesNoRow.length) {
      const card = el("div", "warn-card bx--toast-notification bx--toast-notification--warning");
      card.appendChild(el("h3", null, "No application data for " + imagesNoRow.length + " photo(s)"));
      card.appendChild(el("p", null,
        "These photos have no matching CSV row. They will still be checked — warnings (spelling, missing required text) still apply — but there is nothing to compare against:"));
      const ul = el("ul");
      imagesNoRow.forEach(function (n) { ul.appendChild(el("li", null, n)); });
      card.appendChild(ul);
      box.appendChild(card);
    }
    const rowsNoImage = [];
    state.csv.forEach(function (_rec, file) {
      if (names.indexOf(file) === -1) rowsNoImage.push(file);
    });
    if (rowsNoImage.length) {
      const card = el("div", "warn-card bx--toast-notification bx--toast-notification--warning");
      card.appendChild(el("h3", null, rowsNoImage.length + " CSV row(s) match no chosen photo"));
      card.appendChild(el("p", null,
        "These won't be sent. Check the filenames match the photos exactly (including extension):"));
      const ul = el("ul");
      rowsNoImage.forEach(function (n) { ul.appendChild(el("li", null, n)); });
      card.appendChild(ul);
      box.appendChild(card);
    }
  }

  const hasContent = box.childNodes.length > 0;
  show(box, hasContent);
  $("batch-start").disabled = state.batchRunning || state.batchFiles.length === 0;
}

function appForFile(file) {
  const rec = state.csv.get(file.name);
  if (!rec) return null;
  const app = { brandName: rec.brandName || "" };
  if (rec.classType) app.classType = rec.classType;
  if (rec.alcoholContent) app.alcoholContent = rec.alcoholContent;
  if (rec.netContents) app.netContents = rec.netContents;
  if (rec.countryOfOrigin) app.countryOfOrigin = rec.countryOfOrigin;
  return app;
}

function setProgress(done, total, prefix) {
  show($("batch-progress"), true);
  $("batch-bar-fill").style.width = (total ? Math.round((done / total) * 100) : 0) + "%";
  probeProgress();
  $("batch-progress-text").textContent =
    (prefix || ("Processing " + done + " / " + total + "…"));
}

function appendBatchRow(result) {
  const rec = state.csv.get(result.file);
  const brand = (rec && rec.brandName) ||
    (result.fields && result.fields.brandName && result.fields.brandName.expected) || "";

  const det = el("details", "rowcard");
  const sum = el("summary");
  sum.appendChild(statusPill(result.status));
  sum.appendChild(el("span", "fname", result.file));
  if (brand) sum.appendChild(el("span", "brand", brand));
  sum.appendChild(el("span", "lat", ((result.latencyMs || 0) / 1000).toFixed(1) + " s"));
  sum.addEventListener("toggle", function () {
    if (det.open) {
      viewBatchFile(result.file);
      showRegCard(result);
    }
  });
  det.appendChild(sum);
  const details = el("div", "details");
  details.appendChild(renderResult(result));
  det.appendChild(details);
  $("batch-rows").appendChild(det);
}

function finishBatch() {
  show($("batch-progress"), false);
  const counts = { pass: 0, flag: 0, error: 0 };
  const results = [];
  state.batchResults.forEach(function (r) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    results.push(r);
  });
  const secs = ((Date.now() - state.batchStartMs) / 1000).toFixed(0);

  const banner = $("batch-banner");
  clear(banner);
  show(banner, true);
  banner.appendChild(el("strong", null, "Batch complete: " + results.length + " label(s) checked in " + secs + " s total"));
  const c = el("div", "counts");
  c.appendChild(el("span", "pill pass", "Pass: " + (counts.pass || 0)));
  c.appendChild(el("span", "pill flag", "Flag: " + (counts.flag || 0)));
  c.appendChild(el("span", "pill error", "Error: " + (counts.error || 0)));
  banner.appendChild(c);

  const dl = el("button", "btn primary", "Download results CSV");
  dl.type = "button";
  dl.addEventListener("click", function () { downloadResultsCsv(results); });
  banner.appendChild(dl);

  state.batchRunning = false;
  $("batch-start").disabled = state.batchFiles.length === 0;
}

function downloadResultsCsv(results) {
  const lines = ["file,status,brand,notes,latency_ms"];
  results.forEach(function (r) {
    const rec = state.csv.get(r.file);
    const brand = (rec && rec.brandName) ||
      (r.fields && r.fields.brandName && r.fields.brandName.expected) || "";
    const notes = Array.isArray(r.summary) ? r.summary.join("; ") : "";
    lines.push([r.file, r.status, brand, notes, r.latencyMs || 0].map(csvEscape).join(","));
  });
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "label-results.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}
function batchError(err) {
  state.batchRunning = false;
  $("batch-start").disabled = false;
  const retry = function () {
    show($("batch-error"), false);
    runBatch(state.chunkIndex);
  };
  const label = err.kind === "token" ? "I've ticked the box — retry" : "Try again";
  showAlert($("batch-error"), errorFor(err.kind, err.text) +
    " Files already checked are shown below; retrying continues from where it stopped.",
    retry, label);
}

/** Match Carbon's section title; React updates aria-valuenow, our static bar probes at 100. */
function probeProgress() {
  $("batch-progress").querySelector(".bx--progress-bar")?.setAttribute("aria-valuenow", "100");
}

async function runBatch(chunkIndex) {
  state.batchRunning = true;
  $("batch-start").disabled = true;
  if (chunkIndex === 0) {
    clear($("batch-rows"));
    show($("batch-banner"), false);
    state.batchResults = [];
    state.batchDone = 0;
    state.batchStartMs = Date.now();
  }

  const total = state.batchFiles.length;
  try {
    for (let ci = chunkIndex; ci < state.batchChunks.length; ci++) {
      state.chunkIndex = ci;
      setProgress(state.batchDone, total, "Processing " + state.batchDone + " / " + total + "…");
      const chunk = state.batchChunks[ci];
      const items = await Promise.all(chunk.map(async function (file) {
        return { file: file.name, image: await fileToDataUrl(file), app: appForFile(file) };
      }));
      const results = await verifyRequest(items);
      results.forEach(function (r) {
        state.batchResults.push(r);
        appendBatchRow(r);
      });
      state.batchDone += chunk.length;
    }
    finishBatch();
  } catch (err) {
    batchError(err);
  }
}

function startBatch() {
  if (state.batchRunning || !state.batchFiles.length) return;
  show($("batch-error"), false);
  state.batchChunks = [];
  for (let i = 0; i < state.batchFiles.length; i += MAX_ITEMS) {
    state.batchChunks.push(state.batchFiles.slice(i, i + MAX_ITEMS));
  }
  runBatch(0);
}

// ── wire up ──────────────────────────────────────────────────────────────────
$("single-file").addEventListener("change", onSingleFile);
$("single-clear").addEventListener("click", clearSingle);
$("single-check").addEventListener("click", checkSingle);

$("batch-files").addEventListener("change", onBatchFiles);
$("batch-csv").addEventListener("change", onBatchCsv);
$("csv-clear").addEventListener("click", function () {
  state.csv = new Map();
  $("batch-csv").value = "";
  show($("csv-clear"), false);
  renderBatchPrep();
});
$("batch-start").addEventListener("click", startBatch);
$("demo-pick").addEventListener("change", onDemoPick);

// ── viewer controls ──────────────────────────────────────────────────────────
function stepZoom(dir) {
  if (!viewer.url || viewer.fit) {
    viewer.fit = false;
    viewer.scale = dir > 0 ? 1.5 : 1;
  } else {
    const i = ZOOM_STEPS.findIndex(function (s) { return Math.abs(s - viewer.scale) < 0.01; });
    const next = Math.min(Math.max(i + dir, 0), ZOOM_STEPS.length - 1);
    viewer.scale = ZOOM_STEPS[next];
    if (viewer.scale === 1) viewer.fit = true;
  }
  viewerPaint();
}
$("viewer-zoom-in").addEventListener("click", function () { stepZoom(1); });
$("viewer-zoom-out").addEventListener("click", function () { stepZoom(-1); });
$("viewer-fit").addEventListener("click", function () { viewer.fit = true; viewer.scale = 1; viewerPaint(); });
$("viewer-rotate").addEventListener("click", function () { viewer.rotate = (viewer.rotate + 90) % 360; viewerPaint(); });
$("viewer-full").addEventListener("click", function () { if (viewer.url && viewer.own !== null) window.open(viewer.url, "_blank", "noopener"); });

// Paste an image anywhere → single flow (SIEM analyst muscle memory).
document.addEventListener("paste", function (e) {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.indexOf("image/") !== 0) continue;
    const file = items[i].getAsFile();
    if (!file) continue;
    e.preventDefault();
    const input = $("single-file");
    const dt = new DataTransfer();
    dt.items.add(new File([file], file.name || "pasted-image.png", { type: file.type }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
});

waitForWidget();
