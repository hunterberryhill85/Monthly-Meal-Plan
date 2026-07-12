/* Meal Plan app — daily meals, recipes, 1–5 ratings with GitHub write-back.
   Data comes from meals.json. Ratings live in localStorage and, when a GitHub
   token is configured, are committed to ratings.json in the repo on each rating. */

const app = document.getElementById("app");
const LS_RATINGS = "mealRatings";
const LS_GH = "mealGitHub";

let PLAN = null;        // loaded meals.json
let dayIndex = 0;       // which day is showing
let view = "day";       // "day" | "detail" | "settings"
let detailCtx = null;   // { dayIndex, slot: "dinner"|"lunch" }

/* ---------- helpers ---------- */
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function getRatings() {
  try { return JSON.parse(localStorage.getItem(LS_RATINGS)) || {}; }
  catch { return {}; }
}
function saveRatings(r) { localStorage.setItem(LS_RATINGS, JSON.stringify(r)); }
function getGH() {
  try { return JSON.parse(localStorage.getItem(LS_GH)) || {}; }
  catch { return {}; }
}
function saveGH(g) { localStorage.setItem(LS_GH, JSON.stringify(g)); }
function ghReady() {
  const g = getGH();
  return !!(g.owner && g.repo && g.token);
}

/* ---------- rating store ---------- */
function ratingFor(title) {
  const r = getRatings();
  return r[title] ? r[title].rating : 0;
}
function recordRating(title, type, value, dateStr) {
  const r = getRatings();
  const entry = r[title] || { title, type, count: 0, history: [] };
  entry.type = type;
  entry.rating = value;
  entry.at = new Date().toISOString();
  entry.history = entry.history || [];
  entry.history.push({ date: dateStr, rating: value, at: entry.at });
  entry.count = entry.history.length;
  r[title] = entry;
  saveRatings(r);
  return r;
}

/* ---------- GitHub write-back ---------- */
let pushTimer = null;
function schedulePush(statusEl) {
  if (!ghReady()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushRatings(statusEl), 600);
}

async function pushRatings(statusEl, attempt = 0) {
  const g = getGH();
  const branch = g.branch || "main";
  const path = g.path || "ratings.json";
  const api = `https://api.github.com/repos/${g.owner}/${g.repo}/contents/${path}`;
  const headers = {
    "Authorization": `Bearer ${g.token}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
  };
  const payload = {
    updated: new Date().toISOString(),
    plan: PLAN ? PLAN.title : null,
    ratings: getRatings(),
  };
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));

  const setStatus = (msg, cls) => {
    if (statusEl) { statusEl.textContent = msg; statusEl.className = "rate-status " + (cls || ""); }
  };

  try {
    setStatus("Saving to GitHub…", "");
    // Look up current file sha (needed to update an existing file).
    let sha;
    const getRes = await fetch(`${api}?ref=${encodeURIComponent(branch)}`, { headers });
    if (getRes.ok) {
      const j = await getRes.json();
      sha = j.sha;
    } else if (getRes.status !== 404) {
      throw new Error(`read ${getRes.status}`);
    }
    const putRes = await fetch(api, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: `Update ratings (${new Date().toLocaleString()})`,
        content,
        branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (putRes.status === 409 && attempt < 2) {
      return pushRatings(statusEl, attempt + 1); // sha raced — retry with fresh sha
    }
    if (!putRes.ok) {
      const t = await putRes.text();
      throw new Error(`${putRes.status} ${t.slice(0, 120)}`);
    }
    setStatus("Saved & synced to GitHub ✓", "ok");
  } catch (e) {
    setStatus("Saved on this device (GitHub sync failed: " + e.message + ")", "err");
  }
}

/* ---------- views ---------- */
function render() {
  if (view === "settings") return renderSettings();
  if (view === "detail") return renderDetail();
  return renderDay();
}

function header() {
  return `
    <div class="app-header">
      <span class="app-title">${esc(PLAN.title)}</span>
      <button class="icon-btn" id="gearBtn" aria-label="Settings">⚙</button>
    </div>`;
}

function starsMini(title) {
  const v = ratingFor(title);
  if (!v) return `<span class="mini-unrated">Not rated yet</span>`;
  let s = "";
  for (let i = 1; i <= 5; i++) s += `<span class="${i <= v ? "on" : "off"}">★</span>`;
  return `<span class="mini-stars">${s}</span>`;
}

function renderDay() {
  const day = PLAN.days[dayIndex];
  const d = parseDate(day.date);
  const isToday = day.date === todayStr();
  const dateSub = `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

  const card = (slot) => {
    const meal = day[slot];
    return `
      <div class="meal-card" data-slot="${slot}">
        <div class="meal-label ${slot}">${slot === "dinner" ? "Dinner" : "Lunch"}</div>
        <div class="meal-name">${esc(meal.title)}</div>
        <div class="meal-foot">
          ${starsMini(meal.title)}
          <span class="chev">›</span>
        </div>
      </div>`;
  };

  app.innerHTML = `
    ${header()}
    <div class="date-nav">
      <button class="nav-arrow" id="prevDay" ${dayIndex === 0 ? "disabled" : ""}>‹</button>
      <div class="date-center">
        <div class="date-dow">${DOW[d.getDay()]}</div>
        <div class="date-sub">${dateSub}</div>
        ${isToday ? `<span class="today-pill">Today</span>` : ""}
      </div>
      <button class="nav-arrow" id="nextDay" ${dayIndex === PLAN.days.length - 1 ? "disabled" : ""}>›</button>
    </div>
    ${card("dinner")}
    ${card("lunch")}
  `;

  document.getElementById("gearBtn").onclick = () => { view = "settings"; render(); };
  const prev = document.getElementById("prevDay");
  const next = document.getElementById("nextDay");
  if (prev) prev.onclick = () => { if (dayIndex > 0) { dayIndex--; render(); } };
  if (next) next.onclick = () => { if (dayIndex < PLAN.days.length - 1) { dayIndex++; render(); } };
  app.querySelectorAll(".meal-card").forEach((el) => {
    el.onclick = () => { detailCtx = { dayIndex, slot: el.dataset.slot }; view = "detail"; render(); };
  });
}

function renderDetail() {
  const day = PLAN.days[detailCtx.dayIndex];
  const slot = detailCtx.slot;
  const meal = day[slot];
  const d = parseDate(day.date);
  const dateLine = `${DOW[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}`;
  const hasRecipe = meal.ingredients && meal.ingredients.length;

  let body = "";
  if (hasRecipe) {
    body += `<div class="section-head">Ingredients</div><div class="card">`;
    meal.ingredients.forEach((ing) => {
      body += `<div class="ingredient"><span class="dot"></span><span>${esc(ing)}</span></div>`;
    });
    body += `</div>`;

    body += `<div class="section-head">Recipe</div><div class="card">`;
    meal.steps.forEach((st, i) => {
      const linkified = esc(st).replace(
        /((?:https?:\/\/)?[\w.-]+\.[a-z]{2,}\/[\w./-]+)/gi,
        (m) => `<a class="recipe-link" href="${m.startsWith("http") ? m : "https://" + m}" target="_blank" rel="noopener">${m}</a>`
      );
      body += `<div class="step"><span class="num">${i + 1}</span><span>${linkified}</span></div>`;
    });
    body += `</div>`;
  } else {
    body += `<div class="note-box">${esc(meal.note || meal.title)}</div>`;
  }

  const current = ratingFor(meal.title);
  let starRow = "";
  for (let i = 1; i <= 5; i++) {
    starRow += `<button class="star-btn ${i <= current ? "filled" : ""}" data-val="${i}">★</button>`;
  }

  app.innerHTML = `
    ${header()}
    <button class="detail-back" id="backBtn">‹ ${DOW[d.getDay()]}</button>
    <div class="detail-kicker ${slot === "dinner" ? "" : ""}" style="color:var(--${slot})">${slot === "dinner" ? "Dinner" : "Lunch"}</div>
    <div class="detail-title">${esc(meal.title)}</div>
    <div class="detail-date">${dateLine}</div>
    ${body}
    <div class="rate-block">
      <div class="rate-prompt">${current ? "Your rating" : "How was it? Tap to rate"}</div>
      <div class="stars" id="stars">${starRow}</div>
      <div class="rate-status ${ghReady() ? "" : ""}" id="rateStatus">${current ? "" : ""}</div>
    </div>
  `;

  document.getElementById("gearBtn").onclick = () => { view = "settings"; render(); };
  document.getElementById("backBtn").onclick = () => { view = "day"; render(); };

  const statusEl = document.getElementById("rateStatus");
  app.querySelectorAll(".star-btn").forEach((btn) => {
    btn.onclick = () => {
      const val = Number(btn.dataset.val);
      recordRating(meal.title, slot, val, day.date);
      // repaint stars
      app.querySelectorAll(".star-btn").forEach((b) => {
        b.classList.toggle("filled", Number(b.dataset.val) <= val);
      });
      if (ghReady()) {
        schedulePush(statusEl);
      } else {
        statusEl.textContent = "Saved on this device. Add a GitHub token in ⚙ to sync a ratings file.";
        statusEl.className = "rate-status";
      }
    };
  });
}

function renderSettings() {
  const g = getGH();
  const connected = ghReady();
  app.innerHTML = `
    ${header()}
    <button class="detail-back" id="backBtn">‹ Back</button>
    <div class="detail-title" style="font-size:24px;margin-bottom:14px;">Ratings sync</div>
    <div class="sync-badge"><span class="sync-dot ${connected ? "on" : ""}"></span>${connected ? "Connected — ratings commit to your repo" : "Not connected — ratings save on this device only"}</div>
    <div class="explain">
      When set up, every rating writes an updated <code>ratings.json</code> to your GitHub repo,
      so your meal-plan project can read it. Create a <b>fine-grained token</b> at
      github.com/settings/tokens with <b>Contents: Read and write</b> on just this one repo,
      then paste it below. It stays on this device and is never added to the code.
    </div>
    <div class="settings-wrap">
      <div class="field">
        <label>GitHub username (owner)</label>
        <input id="f-owner" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(g.owner || "")}" placeholder="e.g. hunterberryhill">
      </div>
      <div class="field">
        <label>Repository name</label>
        <input id="f-repo" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(g.repo || "")}" placeholder="e.g. meal-plan-app">
      </div>
      <div class="field">
        <label>Branch</label>
        <input id="f-branch" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(g.branch || "main")}" placeholder="main">
      </div>
      <div class="field">
        <label>Ratings file path</label>
        <input id="f-path" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(g.path || "ratings.json")}" placeholder="ratings.json">
      </div>
      <div class="field">
        <label>Access token</label>
        <input id="f-token" type="password" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(g.token || "")}" placeholder="github_pat_…">
        <div class="hint">Fine-grained token, Contents: Read and write, this repo only.</div>
      </div>
      <button class="btn-primary" id="saveGh">Save</button>
      <button class="btn-ghost" id="testGh">Save & test sync now</button>
      <button class="btn-ghost" id="exportBtn">Export ratings.json (manual backup)</button>
      <div class="status-line" id="ghStatus"></div>
    </div>
  `;

  document.getElementById("gearBtn").onclick = () => { view = "day"; render(); };
  document.getElementById("backBtn").onclick = () => { view = "day"; render(); };

  const readForm = () => ({
    owner: document.getElementById("f-owner").value.trim(),
    repo: document.getElementById("f-repo").value.trim(),
    branch: document.getElementById("f-branch").value.trim() || "main",
    path: document.getElementById("f-path").value.trim() || "ratings.json",
    token: document.getElementById("f-token").value.trim(),
  });
  const statusEl = document.getElementById("ghStatus");

  document.getElementById("saveGh").onclick = () => {
    saveGH(readForm());
    statusEl.textContent = "Saved.";
    statusEl.className = "status-line ok";
  };
  document.getElementById("testGh").onclick = async () => {
    saveGH(readForm());
    if (!ghReady()) {
      statusEl.textContent = "Fill in owner, repo, and token first.";
      statusEl.className = "status-line err";
      return;
    }
    statusEl.textContent = "Testing…";
    statusEl.className = "status-line";
    await realTest(statusEl);
  };
  document.getElementById("exportBtn").onclick = () => {
    const payload = {
      updated: new Date().toISOString(),
      plan: PLAN ? PLAN.title : null,
      ratings: getRatings(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "ratings.json";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };
}

async function realTest(statusEl) {
  const g = getGH();
  const branch = g.branch || "main";
  const path = g.path || "ratings.json";
  const api = `https://api.github.com/repos/${g.owner}/${g.repo}/contents/${path}`;
  const headers = {
    "Authorization": `Bearer ${g.token}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
  };
  const payload = { updated: new Date().toISOString(), plan: PLAN ? PLAN.title : null, ratings: getRatings() };
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));
  try {
    let sha;
    const getRes = await fetch(`${api}?ref=${encodeURIComponent(branch)}`, { headers });
    if (getRes.ok) sha = (await getRes.json()).sha;
    else if (getRes.status === 401 || getRes.status === 403) throw new Error("token rejected (check permissions)");
    else if (getRes.status === 404 && !sha) { /* file doesn't exist yet — fine, we'll create it */ }
    const putRes = await fetch(api, {
      method: "PUT", headers,
      body: JSON.stringify({ message: "Test sync from Meal Plan app", content, branch, ...(sha ? { sha } : {}) }),
    });
    if (!putRes.ok) throw new Error(`${putRes.status} ${(await putRes.text()).slice(0, 100)}`);
    statusEl.textContent = "Success — ratings.json written to your repo ✓";
    statusEl.className = "status-line ok";
  } catch (e) {
    statusEl.textContent = "Failed: " + e.message;
    statusEl.className = "status-line err";
  }
}

/* ---------- boot ---------- */
function pickStartDay() {
  const t = todayStr();
  const exact = PLAN.days.findIndex((d) => d.date === t);
  if (exact >= 0) return exact;
  // clamp to range
  if (t < PLAN.days[0].date) return 0;
  if (t > PLAN.days[PLAN.days.length - 1].date) return PLAN.days.length - 1;
  // within range but no exact (shouldn't happen for contiguous plan) — nearest future
  const fut = PLAN.days.findIndex((d) => d.date >= t);
  return fut >= 0 ? fut : 0;
}

fetch("./meals.json")
  .then((r) => r.json())
  .then((data) => {
    PLAN = data;
    dayIndex = pickStartDay();
    render();
  })
  .catch((e) => {
    app.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-dim)">Couldn't load meals.json<br><small>${esc(e.message)}</small></div>`;
  });

/* PWA */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
