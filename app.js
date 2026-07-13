/* Meal Plan app — daily meals, recipes, 1–5 ratings with GitHub write-back.
   Data comes from meals.json. Ratings live in localStorage and, when a GitHub
   token is configured, are committed to ratings.json in the repo on each rating. */

const app = document.getElementById("app");
const LS_RATINGS = "mealRatings";
const LS_GH = "mealGitHub";
const LS_ANTHROPIC = "mealAnthropic";

let genPlan = null;     // last AI-generated plan awaiting preview/apply

let PLAN = null;        // loaded meals.json
let dayIndex = 0;       // which day is showing
let view = "day";       // "day" | "week" | "groceries" | "detail" | "settings"
let detailCtx = null;   // { dayIndex, slot: "dinner"|"lunch" }
let detailReturn = "day"; // which tab to return to from a detail view
let weekAnchor = null;  // "YYYY-MM-DD" Sunday of the week shown in Week/Groceries

/* ---------- helpers ---------- */
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function fmtDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function todayStr() { return fmtDate(new Date()); }
function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}
// Sunday that begins the week containing dateStr.
function sundayOf(dateStr) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() - d.getDay());
  return fmtDate(d);
}
// The seven dates (Sun→Sat) of the week starting at anchor.
function weekDates(anchor) {
  return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(anchor, i));
}
function dayIndexByDate(dateStr) {
  return PLAN.days.findIndex((d) => d.date === dateStr);
}
// Plan bounds as week anchors, for enabling/disabling week navigation.
function planFirstSunday() { return sundayOf(PLAN.days[0].date); }
function planLastSunday() { return sundayOf(PLAN.days[PLAN.days.length - 1].date); }
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
function getAnthropicKey() { try { return localStorage.getItem(LS_ANTHROPIC) || ""; } catch { return ""; } }
function saveAnthropicKey(k) { localStorage.setItem(LS_ANTHROPIC, k); }
function ghReady() {
  const g = getGH();
  return !!(g.owner && g.repo && g.token);
}

/* ---------- schedule overrides (skip / move) ----------
   Stored per plan so they auto-clear when next month's meals.json loads.
   cells[`${date}|${slot}`] = { skip:true } | { meal:<mealObj>, movedFrom:<date> } */
const LS_OVERRIDES = "mealOverrides";
function getOverrides() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_OVERRIDES));
    if (o && o.cells && o.plan === (PLAN ? PLAN.title : null)) return o;
  } catch {}
  return { plan: PLAN ? PLAN.title : null, cells: {} };
}
function saveOverrides(o) {
  o.plan = PLAN ? PLAN.title : null;
  localStorage.setItem(LS_OVERRIDES, JSON.stringify(o));
  schedulePushOverrides(); // mirror skips/moves up to the repo so the widget can see them
}
function cellKey(date, slot) { return `${date}|${slot}`; }
function hasChanges() { return Object.keys(getOverrides().cells).length > 0; }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function shortDay(dateStr) {
  const d = parseDate(dateStr);
  return `${DOW[d.getDay()].slice(0, 3)} ${MON[d.getMonth()]} ${d.getDate()}`;
}

// Effective meal for a day+slot, honoring overrides (may be flagged skipped).
function resolveMeal(dayIndex, slot) {
  const day = PLAN.days[dayIndex];
  const base = day[slot];
  const ov = getOverrides().cells[cellKey(day.date, slot)];
  if (ov) {
    if (ov.skip) return { title: base.title, skipped: true };
    if (ov.meal) return Object.assign({}, ov.meal, { movedFrom: ov.movedFrom });
  }
  return base;
}
// The real meal object for scheduling (ignores a skip flag — used when moving).
function mealObjFor(dayIndex, slot) {
  const day = PLAN.days[dayIndex];
  const ov = getOverrides().cells[cellKey(day.date, slot)];
  if (ov && ov.meal) return ov.meal;
  return day[slot];
}
function stripStatus(m) {
  const c = Object.assign({}, m);
  delete c.skipped; delete c.movedFrom;
  return c;
}
function skipMeal(dayIndex, slot) {
  const o = getOverrides();
  o.cells[cellKey(PLAN.days[dayIndex].date, slot)] = { skip: true };
  saveOverrides(o);
}
function swapMeals(aIndex, bIndex, slot) {
  const o = getOverrides();
  const a = PLAN.days[aIndex], b = PLAN.days[bIndex];
  const mealA = stripStatus(mealObjFor(aIndex, slot));
  const mealB = stripStatus(mealObjFor(bIndex, slot));
  o.cells[cellKey(a.date, slot)] = { meal: mealB, movedFrom: b.date };
  o.cells[cellKey(b.date, slot)] = { meal: mealA, movedFrom: a.date };
  saveOverrides(o);
}
function resetCell(dayIndex, slot) {
  const o = getOverrides();
  const day = PLAN.days[dayIndex];
  const key = cellKey(day.date, slot);
  const ov = o.cells[key];
  delete o.cells[key];
  // undo the other half of a fresh swap
  if (ov && ov.movedFrom) {
    const pk = cellKey(ov.movedFrom, slot);
    const p = o.cells[pk];
    if (p && p.movedFrom === day.date) delete o.cells[pk];
  }
  saveOverrides(o);
}
function resetAllSchedule() { saveOverrides({ plan: PLAN ? PLAN.title : null, cells: {} }); }

/* ---------- grocery list ----------
   Builds a Sun→Saturday shopping list from that week's dinner ingredients,
   deduplicated and sorted into store-aisle categories. Checked-off items are
   remembered per week (and cleared automatically when a new plan loads). */
const LS_GROCERY = "mealGrocery";
function getGrocery() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_GROCERY));
    if (o && o.plan === (PLAN ? PLAN.title : null)) {
      o.checks = o.checks || {};
      o.extras = o.extras || {};   // per-week custom items: { anchor: [text, …] }
      o.staples = o.staples || {}; // "always have" items: { norm: true } (all weeks)
      return o;
    }
  } catch {}
  return { plan: PLAN ? PLAN.title : null, checks: {}, extras: {}, staples: {} };
}
function saveGrocery(o) {
  o.plan = PLAN ? PLAN.title : null;
  localStorage.setItem(LS_GROCERY, JSON.stringify(o));
}
function groceryKey(anchor, norm) { return `${anchor}|${norm}`; }
function isChecked(anchor, norm) { return !!getGrocery().checks[groceryKey(anchor, norm)]; }
function toggleChecked(anchor, norm) {
  const g = getGrocery();
  const k = groceryKey(anchor, norm);
  if (g.checks[k]) delete g.checks[k]; else g.checks[k] = true;
  saveGrocery(g);
}
function clearWeekChecks(anchor) {
  const g = getGrocery();
  const pre = `${anchor}|`;
  Object.keys(g.checks).forEach((k) => { if (k.startsWith(pre)) delete g.checks[k]; });
  saveGrocery(g);
}
// Custom items you add for a given week.
function addExtra(anchor, text) {
  const t = String(text).trim();
  if (!t) return;
  const g = getGrocery();
  g.extras[anchor] = g.extras[anchor] || [];
  if (!g.extras[anchor].some((x) => x.toLowerCase() === t.toLowerCase())) g.extras[anchor].push(t);
  saveGrocery(g);
}
function removeExtra(anchor, norm) {
  const g = getGrocery();
  g.extras[anchor] = (g.extras[anchor] || []).filter((x) => x.toLowerCase() !== norm);
  saveGrocery(g);
}
// "Always have" staples are hidden from the shopping part of the list.
function isStaple(norm) { return !!getGrocery().staples[norm]; }
function toggleStaple(norm) {
  const g = getGrocery();
  if (g.staples[norm]) delete g.staples[norm]; else g.staples[norm] = true;
  saveGrocery(g);
}

// Store-aisle buckets. Longest matching keyword across all categories wins, so
// "bell pepper" lands in Produce while a bare "pepper" lands in Pantry.
const GROCERY_CATS = [
  { key: "produce", label: "Produce", icon: "🥬", kw: ["bell pepper", "peppers", "onion", "garlic", "potato", "potatoes", "tomato", "tomatoes", "cabbage", "lime", "lemon", "lettuce", "romaine", "carrot", "carrots", "celery", "greens", "watermelon", "cilantro", "avocado", "jalapeño", "jalapeno", "mushroom", "broccoli", "corn", "peas", "green bean", "green beans", "rosemary", "thyme", "sage", "spinach", "zucchini", "cucumber", "banana", "apple", "berry", "scallion", "ginger", "kale", "squash", "sweet potato", "herbs"] },
  { key: "meat", label: "Meat & Seafood", icon: "🥩", kw: ["chicken sausage", "chicken sausages", "chicken", "ground beef", "beef", "pork chop", "pork chops", "pork", "steak", "steaks", "sausage", "sausages", "brats", "bratwurst", "bacon", "ham", "turkey", "tilapia", "salmon", "cod", "shrimp", "tuna", "fish", "hot dog", "hot dogs", "burger", "burgers", "patties", "meatball", "meatballs"] },
  { key: "dairy", label: "Dairy & Eggs", icon: "🧀", kw: ["shredded cheese", "sliced cheese", "cheese", "milk", "butter", "sour cream", "half-and-half", "cream", "yogurt", "eggs", "egg", "parmesan", "mozzarella", "cheddar", "crema"] },
  { key: "grains", label: "Bakery & Grains", icon: "🍞", kw: ["garlic bread", "cornbread", "bread", "tortilla", "tortillas", "buns", "bun", "bagel", "bagels", "rice", "pasta", "spaghetti", "noodle", "flour", "cornmeal", "croutons", "crouton", "roll", "rolls", "oats"] },
  { key: "pantry", label: "Pantry & Spices", icon: "🧂", kw: ["salt", "pepper", "oil", "cumin", "chili powder", "chili", "smoked paprika", "paprika", "garlic powder", "italian seasoning", "seasoning", "sugar", "marinara", "caesar dressing", "dressing", "sauce", "chicken broth", "beef broth", "broth", "stock", "vinegar", "mustard", "ranch", "condiments", "condiment", "ketchup", "mayo", "jar", "honey", "syrup", "nutmeg", "turmeric", "red pepper flakes", "flakes", "extract", "baking", "chips", "croutons"] },
];
function categoryFor(item) {
  const s = item.toLowerCase();
  let best = null, bestLen = 0;
  for (const cat of GROCERY_CATS) {
    for (const k of cat.kw) {
      if (k && s.includes(k) && k.length > bestLen) { best = cat; bestLen = k.length; }
    }
  }
  return best || { key: "other", label: "Other", icon: "🛒" };
}

// Deduplicated shopping rows for the week (plan ingredients + your custom items),
// tagged with category, staple flag, and source, in category order.
function groceryItems(anchor) {
  const map = new Map(); // norm -> { text, norm, count, cat, source }
  weekDates(anchor).forEach((date) => {
    const di = dayIndexByDate(date);
    if (di < 0) return;
    const meal = resolveMeal(di, "dinner");
    if (meal.skipped || !meal.ingredients || !meal.ingredients.length) return;
    meal.ingredients.forEach((raw) => {
      const text = String(raw).trim();
      if (!text) return;
      const norm = text.toLowerCase();
      if (map.has(norm)) map.get(norm).count++;
      else map.set(norm, { text, norm, count: 1, cat: categoryFor(text), source: "plan" });
    });
  });
  // Your own added items for this week (don't duplicate a plan ingredient).
  (getGrocery().extras[anchor] || []).forEach((text) => {
    const norm = String(text).toLowerCase();
    if (!map.has(norm)) map.set(norm, { text, norm, count: 1, cat: categoryFor(text), source: "extra" });
  });
  const g = getGrocery();
  const order = GROCERY_CATS.map((c) => c.key).concat("other");
  return [...map.values()]
    .map((it) => Object.assign(it, { staple: !!g.staples[it.norm] }))
    .sort((a, b) => {
      const ai = order.indexOf(a.cat.key), bi = order.indexOf(b.cat.key);
      if (ai !== bi) return ai - bi;
      return a.text.localeCompare(b.text);
    });
}

/* ---------- bottom sheet + toast ---------- */
function closeSheet() {
  const s = document.getElementById("sheet-overlay");
  if (s) s.remove();
}
function openSheet(title, innerHTML) {
  closeSheet();
  const wrap = document.createElement("div");
  wrap.id = "sheet-overlay";
  wrap.className = "sheet-overlay";
  wrap.innerHTML = `<div class="sheet"><div class="sheet-grip"></div><div class="sheet-title">${esc(title)}</div>${innerHTML}</div>`;
  wrap.addEventListener("click", (e) => { if (e.target === wrap) closeSheet(); });
  document.body.appendChild(wrap);
  return wrap;
}
function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2400);
}

function afterScheduleChange() { view = detailReturn || "day"; render(); }

function openMealActions(dayIndex, slot) {
  const day = PLAN.days[dayIndex];
  const ov = getOverrides().cells[cellKey(day.date, slot)];
  let btns = `<button class="sheet-btn" data-act="move">📅  Move to another day</button>`;
  if (ov && ov.skip) {
    btns += `<button class="sheet-btn" data-act="restore">↩︎  Restore to plan</button>`;
  } else {
    btns += `<button class="sheet-btn danger" data-act="skip">🚫  Skip completely</button>`;
    if (ov) btns += `<button class="sheet-btn" data-act="restore">↩︎  Reset to plan</button>`;
  }
  btns += `<button class="sheet-btn cancel" data-act="cancel">Cancel</button>`;
  const w = openSheet(`Skip or move ${slot}`, `<div class="sheet-list">${btns}</div>`);
  w.querySelectorAll(".sheet-btn").forEach((b) => {
    b.onclick = () => {
      switch (b.dataset.act) {
        case "cancel": return closeSheet();
        case "move": return openMovePicker(dayIndex, slot);
        case "skip":
          skipMeal(dayIndex, slot); closeSheet();
          toast(`${cap(slot)} skipped`); afterScheduleChange(); break;
        case "restore":
          resetCell(dayIndex, slot); closeSheet();
          toast("Restored to plan"); afterScheduleChange(); break;
      }
    };
  });
}
function openMovePicker(dayIndex, slot) {
  let rows = "";
  PLAN.days.forEach((d, i) => {
    if (i === dayIndex) return;
    const m = resolveMeal(i, slot);
    rows += `<button class="day-row" data-i="${i}">
        <span class="day-row-dow">${shortDay(d.date)}</span>
        <span class="day-row-meal">${m.skipped ? "— skipped —" : esc(m.title)}</span>
      </button>`;
  });
  const w = openSheet(`Move ${slot} to which day?`,
    `<div class="sheet-sub">The two ${slot}s swap places, so no night is left empty.</div><div class="day-picker">${rows}</div>`);
  w.querySelectorAll(".day-row").forEach((b) => {
    b.onclick = () => {
      const target = Number(b.dataset.i);
      swapMeals(dayIndex, target, slot);
      closeSheet();
      toast(`Moved to ${DOW[parseDate(PLAN.days[target].date).getDay()]}`);
      afterScheduleChange();
    };
  });
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

/* Sync schedule overrides (skips/moves) to overrides.json so the widget and the
   meal planner see the effective schedule. Silent + debounced; local save always
   wins even if this fails (offline, no token). */
let overridesPushTimer = null;
function schedulePushOverrides() {
  if (!ghReady()) return;
  clearTimeout(overridesPushTimer);
  overridesPushTimer = setTimeout(() => pushOverrides(), 700);
}
async function pushOverrides(attempt = 0) {
  if (!ghReady()) return;
  const g = getGH();
  const branch = g.branch || "main";
  const api = `https://api.github.com/repos/${g.owner}/${g.repo}/contents/overrides.json`;
  const headers = {
    "Authorization": `Bearer ${g.token}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
  };
  const o = getOverrides();
  const payload = {
    updated: new Date().toISOString(),
    plan: PLAN ? PLAN.title : null,
    cells: o.cells,
  };
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));
  try {
    let sha;
    const getRes = await fetch(`${api}?ref=${encodeURIComponent(branch)}`, { headers });
    if (getRes.ok) sha = (await getRes.json()).sha;
    else if (getRes.status !== 404) throw new Error(`read ${getRes.status}`);
    const putRes = await fetch(api, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: `Update schedule overrides (${new Date().toLocaleString()})`,
        content,
        branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (putRes.status === 409 && attempt < 2) return pushOverrides(attempt + 1);
    // Any other failure is non-fatal: the schedule is already saved on the device.
  } catch (e) { /* offline or not configured — ignore */ }
}

/* ---------- hydrate from repo ----------
   The app commits ratings/overrides to the repo but, on a fresh device or after
   clearing browser data, local storage starts empty. On load (when sync is on) we
   pull ratings.json + overrides.json back and merge them in, so the data is durable
   and consistent across devices. Fetched via the GitHub API so the service worker
   never serves a stale copy. Merges do NOT trigger a push (avoids commit loops). */
async function ghGetJSON(path) {
  const g = getGH();
  const branch = g.branch || "main";
  const api = `https://api.github.com/repos/${g.owner}/${g.repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(api, {
    headers: { "Authorization": `Bearer ${g.token}`, "Accept": "application/vnd.github+json" },
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  const j = await res.json();
  const text = decodeURIComponent(escape(atob(String(j.content || "").replace(/\n/g, ""))));
  return JSON.parse(text);
}

// Merge two ratings maps ({title: entry}); histories are unioned by timestamp and
// the latest rating wins, so no device loses a rating it recorded.
function mergeRatings(remote) {
  const local = getRatings();
  const out = {};
  const titles = new Set([...Object.keys(local), ...Object.keys(remote || {})]);
  titles.forEach((t) => {
    const a = local[t], b = (remote || {})[t];
    if (a && b) {
      const byAt = {};
      [...(a.history || []), ...(b.history || [])].forEach((h) => { if (h && h.at) byAt[h.at] = h; });
      const hist = Object.values(byAt).sort((x, y) => (x.at < y.at ? -1 : 1));
      const latest = hist[hist.length - 1] || {};
      out[t] = {
        title: t,
        type: a.type || b.type,
        rating: latest.rating != null ? latest.rating : (a.rating != null ? a.rating : b.rating),
        at: latest.at || a.at || b.at,
        history: hist,
        count: hist.length,
      };
    } else {
      out[t] = a || b;
    }
  });
  return out;
}

// Adopt remote schedule overrides when this device has none (fresh device); if both
// have cells, this device's local cells win on conflict. Only for the current plan.
function mergeOverrides(remote) {
  if (!remote || remote.plan !== (PLAN ? PLAN.title : null)) return;
  const local = getOverrides();
  const cells = Object.keys(local.cells).length
    ? Object.assign({}, remote.cells || {}, local.cells)
    : (remote.cells || {});
  localStorage.setItem(LS_OVERRIDES, JSON.stringify({ plan: PLAN.title, cells }));
}

async function hydrateFromRepo() {
  if (!ghReady()) return;
  const g = getGH();
  try {
    const [rj, oj] = await Promise.all([
      ghGetJSON(g.path || "ratings.json").catch(() => null),
      ghGetJSON("overrides.json").catch(() => null),
    ]);
    let changed = false;
    if (rj && rj.ratings) { saveRatings(mergeRatings(rj.ratings)); changed = true; }
    if (oj) { mergeOverrides(oj); changed = true; }
    if (changed) render();
  } catch (e) { /* offline or not configured — keep local */ }
}

/* ---------- cooking mode: keep the screen awake while a recipe is open ---------- */
let wakeLock = null;
let cookingActive = false;
async function requestWake() {
  try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { /* denied/unsupported */ }
}
async function releaseWake() {
  try { if (wakeLock) { await wakeLock.release(); wakeLock = null; } } catch (e) {}
}

/* ---------- views ---------- */
function render() {
  // Leaving the recipe screen ends cooking mode and lets the screen sleep again.
  if (view !== "detail" && cookingActive) { cookingActive = false; releaseWake(); }
  if (view === "settings") return renderSettings();
  if (view === "detail") return renderDetail();
  if (view === "week") return renderWeek();
  if (view === "groceries") return renderGroceries();
  if (view === "ratings") return renderRatings();
  if (view === "generate") return renderGenerate();
  return renderDay();
}

function header() {
  return `
    <div class="app-header">
      <span class="app-title">${esc(PLAN.title)}</span>
      <button class="icon-btn" id="gearBtn" aria-label="Settings">⚙</button>
    </div>`;
}

// Fixed bottom navigation shown on the three main tabs.
function tabBar(active) {
  const tab = (id, label, icon) => `
    <button class="tab ${active === id ? "active" : ""}" data-tab="${id}">
      <span class="tab-icon">${icon}</span>
      <span class="tab-label">${label}</span>
    </button>`;
  return `
    <nav class="tab-bar">
      ${tab("day", "Today", "🍽️")}
      ${tab("week", "Week", "🗓️")}
      ${tab("groceries", "Groceries", "🛒")}
      ${tab("ratings", "Ratings", "⭐")}
    </nav>`;
}
function wireTabs() {
  document.querySelectorAll(".tab").forEach((b) => {
    b.onclick = () => { view = b.dataset.tab; render(); };
  });
}
// Shared ‹ › week stepper for Week and Groceries.
function weekNav(subtitle) {
  const first = planFirstSunday(), last = planLastSunday();
  const start = parseDate(weekAnchor), end = parseDate(addDays(weekAnchor, 6));
  const range = `${MON[start.getMonth()]} ${start.getDate()} – ${MON[end.getMonth()]} ${end.getDate()}`;
  return `
    <div class="week-nav">
      <button class="nav-arrow" id="prevWeek" ${weekAnchor <= first ? "disabled" : ""}>‹</button>
      <div class="week-center">
        <div class="week-range">${range}</div>
        ${subtitle ? `<div class="week-sub">${subtitle}</div>` : ""}
      </div>
      <button class="nav-arrow" id="nextWeek" ${weekAnchor >= last ? "disabled" : ""}>›</button>
    </div>`;
}
function wireWeekNav() {
  const first = planFirstSunday(), last = planLastSunday();
  const prev = document.getElementById("prevWeek");
  const next = document.getElementById("nextWeek");
  if (prev) prev.onclick = () => { if (weekAnchor > first) { weekAnchor = addDays(weekAnchor, -7); render(); } };
  if (next) next.onclick = () => { if (weekAnchor < last) { weekAnchor = addDays(weekAnchor, 7); render(); } };
}

function starsMiniVal(v) {
  let s = "";
  for (let i = 1; i <= 5; i++) s += `<span class="${i <= v ? "on" : "off"}">★</span>`;
  return `<span class="mini-stars">${s}</span>`;
}
function starsMini(title) {
  const v = ratingFor(title);
  if (!v) return `<span class="mini-unrated">Not rated yet</span>`;
  return starsMiniVal(v);
}
// First place a meal title appears in the current plan, for tap-through.
function findInPlan(title) {
  for (let i = 0; i < PLAN.days.length; i++) {
    for (const slot of ["dinner", "lunch"]) {
      const m = PLAN.days[i][slot];
      if (m && m.title === title) return { dayIndex: i, slot };
    }
  }
  return null;
}

function renderDay() {
  const day = PLAN.days[dayIndex];
  const d = parseDate(day.date);
  const isToday = day.date === todayStr();
  const dateSub = `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

  const card = (slot) => {
    const meal = resolveMeal(dayIndex, slot);
    const label = slot === "dinner" ? "Dinner" : "Lunch";
    if (meal.skipped) {
      return `
        <div class="meal-card skipped" data-slot="${slot}">
          <div class="meal-label ${slot}">${label}</div>
          <div class="meal-name struck">${esc(meal.title)}</div>
          <div class="meal-foot">
            <span class="skip-badge">Skipped</span>
            <span class="chev">›</span>
          </div>
        </div>`;
    }
    const movedBadge = meal.movedFrom ? `<span class="moved-badge">↺ from ${shortDay(meal.movedFrom)}</span>` : "";
    return `
      <div class="meal-card" data-slot="${slot}">
        <div class="meal-label ${slot}">${label}</div>
        <div class="meal-name">${esc(meal.title)}</div>
        <div class="meal-foot">
          <span class="foot-left">${starsMini(meal.title)}${movedBadge}</span>
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
    ${tabBar("day")}
  `;

  document.getElementById("gearBtn").onclick = () => { view = "settings"; render(); };
  const prev = document.getElementById("prevDay");
  const next = document.getElementById("nextDay");
  if (prev) prev.onclick = () => { if (dayIndex > 0) { dayIndex--; render(); } };
  if (next) next.onclick = () => { if (dayIndex < PLAN.days.length - 1) { dayIndex++; render(); } };
  app.querySelectorAll(".meal-card").forEach((el) => {
    el.onclick = () => { detailCtx = { dayIndex, slot: el.dataset.slot }; detailReturn = "day"; view = "detail"; render(); };
  });
  wireTabs();
}

/* ---------- week view ---------- */
function renderWeek() {
  const dates = weekDates(weekAnchor);
  const today = todayStr();

  const rows = dates.map((date) => {
    const di = dayIndexByDate(date);
    const d = parseDate(date);
    const isToday = date === today;
    const dowFull = DOW[d.getDay()];
    const dateLabel = `${MON[d.getMonth()]} ${d.getDate()}`;

    if (di < 0) {
      return `
        <div class="week-day empty">
          <div class="wd-side">
            <div class="wd-dow">${dowFull.slice(0, 3)}</div>
            <div class="wd-date">${dateLabel}</div>
          </div>
          <div class="wd-meals"><div class="wd-empty">No meal planned</div></div>
        </div>`;
    }

    const line = (slot) => {
      const meal = resolveMeal(di, slot);
      const label = slot === "dinner" ? "Dinner" : "Lunch";
      const cls = meal.skipped ? "wd-meal skipped" : "wd-meal";
      const name = meal.skipped
        ? `<span class="wd-name struck">${esc(meal.title)}</span>`
        : `<span class="wd-name">${esc(meal.title)}</span>`;
      const stars = (!meal.skipped && ratingFor(meal.title)) ? starsMini(meal.title) : "";
      return `
        <button class="${cls}" data-i="${di}" data-slot="${slot}">
          <span class="wd-slot ${slot}">${label}</span>
          ${name}
          ${stars ? `<span class="wd-stars">${stars}</span>` : ""}
        </button>`;
    };

    return `
      <div class="week-day ${isToday ? "is-today" : ""}">
        <div class="wd-side">
          <div class="wd-dow">${dowFull.slice(0, 3)}</div>
          <div class="wd-date">${dateLabel}</div>
          ${isToday ? `<span class="wd-today">Today</span>` : ""}
        </div>
        <div class="wd-meals">
          ${line("dinner")}
          ${line("lunch")}
        </div>
      </div>`;
  }).join("");

  app.innerHTML = `
    ${header()}
    ${weekNav("Tap a meal for the recipe")}
    <div class="week-list">${rows}</div>
    ${tabBar("week")}
  `;

  document.getElementById("gearBtn").onclick = () => { view = "settings"; render(); };
  wireWeekNav();
  app.querySelectorAll(".wd-meal").forEach((el) => {
    el.onclick = () => {
      detailCtx = { dayIndex: Number(el.dataset.i), slot: el.dataset.slot };
      detailReturn = "week";
      view = "detail";
      render();
    };
  });
  wireTabs();
}

/* ---------- groceries view ---------- */
function renderGroceries() {
  const all = groceryItems(weekAnchor);
  const shopping = all.filter((it) => !it.staple);
  const staples = all.filter((it) => it.staple);
  const total = shopping.length;
  const done = shopping.filter((it) => isChecked(weekAnchor, it.norm)).length;

  const addForm = `
    <form class="g-add" id="addForm">
      <input id="addInput" class="g-add-input" type="text" placeholder="Add an item…" autocapitalize="none" autocorrect="off" enterkeyhint="done">
      <button type="submit" class="g-add-btn">Add</button>
    </form>`;

  let listHtml = "";
  if (!total && !staples.length) {
    listHtml = `<div class="grocery-empty">Nothing to buy for this week.<br><span>Add your own items above, or check another week.</span></div>`;
  } else {
    let curKey = null;
    shopping.forEach((it) => {
      if (it.cat.key !== curKey) {
        if (curKey !== null) listHtml += `</div>`;
        curKey = it.cat.key;
        listHtml += `<div class="grocery-cat"><div class="cat-head"><span class="cat-icon">${it.cat.icon}</span>${it.cat.label}</div>`;
      }
      const checked = isChecked(weekAnchor, it.norm);
      const qty = it.count > 1 ? `<span class="g-qty">×${it.count}</span>` : "";
      const side = it.source === "extra"
        ? `<button class="g-side" data-act="delete" data-norm="${esc(it.norm)}" aria-label="Remove item">✕</button>`
        : `<button class="g-side" data-act="staple" data-norm="${esc(it.norm)}" aria-label="Mark as always have">📌</button>`;
      listHtml += `
        <div class="g-item ${checked ? "checked" : ""}">
          <button class="g-check" data-norm="${esc(it.norm)}">
            <span class="g-box">${checked ? "✓" : ""}</span>
            <span class="g-text">${esc(it.text)}</span>
            ${qty}
          </button>
          ${side}
        </div>`;
    });
    if (curKey !== null) listHtml += `</div>`;
  }

  let staplesHtml = "";
  if (staples.length) {
    staplesHtml = `<div class="section-head">Always have <span class="rt-count">${staples.length}</span></div><div class="grocery-cat">`;
    staples.forEach((it) => {
      staplesHtml += `
        <div class="g-item staple">
          <span class="g-text dim">${esc(it.text)}</span>
          <button class="g-side" data-act="unstaple" data-norm="${esc(it.norm)}" aria-label="Add back to list">↩</button>
        </div>`;
    });
    staplesHtml += `</div>`;
  }

  const progress = total ? `
    <div class="grocery-progress">
      <div class="gp-track"><div class="gp-fill" style="width:${Math.round((done / total) * 100)}%"></div></div>
      <div class="gp-label">${done} of ${total} gathered</div>
    </div>` : "";

  const actions = (total || staples.length) ? `
    <div class="g-actions">
      <button class="btn-ghost" id="copyList">Copy / share list</button>
      ${total ? `<button class="btn-ghost g-clear" id="clearChecks">Uncheck all</button>` : ""}
    </div>` : "";

  app.innerHTML = `
    ${header()}
    ${weekNav("Dinner ingredients, Sun–Sat")}
    ${addForm}
    ${progress}
    ${listHtml}
    ${staplesHtml}
    ${actions}
    ${tabBar("groceries")}
  `;

  document.getElementById("gearBtn").onclick = () => { view = "settings"; render(); };
  wireWeekNav();

  document.getElementById("addForm").onsubmit = (e) => {
    e.preventDefault();
    const v = document.getElementById("addInput").value;
    if (v.trim()) { addExtra(weekAnchor, v); render(); }
  };
  app.querySelectorAll(".g-check").forEach((el) => {
    el.onclick = () => { toggleChecked(weekAnchor, el.dataset.norm); render(); };
  });
  app.querySelectorAll(".g-side").forEach((el) => {
    el.onclick = () => {
      const norm = el.dataset.norm;
      if (el.dataset.act === "delete") removeExtra(weekAnchor, norm);
      else toggleStaple(norm); // staple <-> unstaple
      render();
    };
  });
  const clr = document.getElementById("clearChecks");
  if (clr) clr.onclick = () => { clearWeekChecks(weekAnchor); render(); };
  const copyBtn = document.getElementById("copyList");
  if (copyBtn) copyBtn.onclick = () => shareGroceryList(weekAnchor);
  wireTabs();
}

// Build a plain-text list (shopping items only) and share or copy it.
function shareGroceryList(anchor) {
  const items = groceryItems(anchor).filter((it) => !it.staple);
  if (!items.length) { toast("Nothing to share"); return; }
  const start = parseDate(anchor), end = parseDate(addDays(anchor, 6));
  let text = `Groceries · ${MON[start.getMonth()]} ${start.getDate()}–${MON[end.getMonth()]} ${end.getDate()}\n`;
  GROCERY_CATS.map((c) => c.key).concat("other").forEach((key) => {
    const inCat = items.filter((it) => it.cat.key === key);
    if (!inCat.length) return;
    text += `\n${inCat[0].cat.label}\n`;
    inCat.forEach((it) => { text += `- ${it.text}${it.count > 1 ? ` (×${it.count})` : ""}\n`; });
  });
  if (navigator.share) {
    navigator.share({ title: "Groceries", text }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast("List copied")).catch(() => toast("Couldn't copy"));
  } else {
    toast("Sharing not supported");
  }
}

/* ---------- ratings view ---------- */
function renderRatings() {
  const r = getRatings();
  const entries = Object.values(r).filter((e) => e && e.rating);
  const total = entries.length;
  const avg = total ? entries.reduce((s, e) => s + e.rating, 0) / total : 0;
  const cooked = entries.reduce((s, e) => s + (e.count || 1), 0);

  const row = (e) => {
    const inPlan = findInPlan(e.title);
    const hist = e.history || [];
    const last = hist.length ? hist[hist.length - 1].date : null;
    return `
      <div class="rt-row ${inPlan ? "tappable" : ""}" ${inPlan ? `data-i="${inPlan.dayIndex}" data-slot="${inPlan.slot}"` : ""}>
        <div class="rt-main">
          <div class="rt-title">${esc(e.title)}</div>
          <div class="rt-meta">${starsMiniVal(e.rating)}<span class="rt-sub">cooked ${e.count || 1}×${last ? ` · last ${shortDay(last)}` : ""}</span></div>
        </div>
        ${inPlan ? `<span class="chev">›</span>` : ""}
      </div>`;
  };
  const sortTier = (list) => list.slice().sort((a, b) =>
    (b.rating - a.rating) || ((b.count || 0) - (a.count || 0)) || a.title.localeCompare(b.title));
  const tier = (label, list) => list.length
    ? `<div class="section-head">${label} <span class="rt-count">${list.length}</span></div><div class="card">${sortTier(list).map(row).join("")}</div>`
    : "";

  const fav = entries.filter((e) => e.rating >= 4);
  const ok = entries.filter((e) => e.rating === 3);
  const bad = entries.filter((e) => e.rating <= 2);

  // Meals in the current plan you haven't rated yet.
  const seen = new Set(Object.keys(r));
  const added = new Set();
  const unrated = [];
  PLAN.days.forEach((d, i) => {
    ["dinner", "lunch"].forEach((slot) => {
      const m = d[slot];
      if (m && m.title && !seen.has(m.title) && !added.has(m.title)) {
        added.add(m.title);
        unrated.push(`
          <div class="rt-row tappable" data-i="${i}" data-slot="${slot}">
            <div class="rt-main">
              <div class="rt-title">${esc(m.title)}</div>
              <div class="rt-meta"><span class="mini-unrated">Not rated yet</span></div>
            </div>
            <span class="chev">›</span>
          </div>`);
      }
    });
  });

  app.innerHTML = `
    ${header()}
    <div class="detail-title" style="font-size:24px;margin-bottom:16px;">Your ratings</div>
    <button class="btn-primary gen-cta" id="genBtn">✨ Plan a new month from your ratings</button>
    ${total ? `
      <div class="rt-summary">
        <div class="rt-tile"><div class="rt-num">${total}</div><div class="rt-lbl">rated</div></div>
        <div class="rt-tile"><div class="rt-num">${avg.toFixed(1)}</div><div class="rt-lbl">avg ★</div></div>
        <div class="rt-tile"><div class="rt-num">${cooked}</div><div class="rt-lbl">cooked</div></div>
      </div>` : `<div class="note-box">No ratings yet. After you cook a meal, open it and tap the stars — your favorites and duds will collect here.</div>`}
    ${tier("Favorites", fav)}
    ${tier("Just okay", ok)}
    ${tier("Not again", bad)}
    ${unrated.length ? `<div class="section-head">Unrated in this plan <span class="rt-count">${unrated.length}</span></div><div class="card">${unrated.join("")}</div>` : ""}
    ${tabBar("ratings")}
  `;

  document.getElementById("gearBtn").onclick = () => { view = "settings"; render(); };
  document.getElementById("genBtn").onclick = () => { view = "generate"; render(); };
  app.querySelectorAll(".rt-row.tappable").forEach((el) => {
    el.onclick = () => {
      detailCtx = { dayIndex: Number(el.dataset.i), slot: el.dataset.slot };
      detailReturn = "ratings";
      view = "detail";
      render();
    };
  });
  wireTabs();
}

/* ---------- AI plan generator ----------
   Calls the Anthropic Messages API directly from the browser (the user supplies
   their own key, stored on-device) and forces a schema-valid meals.json via
   output_config.format. Dates are assigned in code so they're always correct. */
const MEALS_SCHEMA = {
  type: "object",
  properties: {
    days: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dinner: {
            type: "object",
            properties: {
              title: { type: "string" },
              ingredients: { type: "array", items: { type: "string" } },
              steps: { type: "array", items: { type: "string" } },
            },
            required: ["title", "ingredients", "steps"],
            additionalProperties: false,
          },
          lunch: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
        },
        required: ["dinner", "lunch"],
        additionalProperties: false,
      },
    },
  },
  required: ["days"],
  additionalProperties: false,
};

function buildGenPrompt(startDate, numDays, notes) {
  const r = getRatings();
  const entries = Object.values(r).filter((e) => e && e.rating);
  const list = (arr) => arr.length ? arr.join("; ") : "(none yet)";
  const faves = list(entries.filter((e) => e.rating >= 4).map((e) => `${e.title} (${e.rating}★, cooked ${e.count || 1}×)`));
  const duds = list(entries.filter((e) => e.rating <= 2).map((e) => `${e.title} (${e.rating}★)`));
  const okay = list(entries.filter((e) => e.rating === 3).map((e) => e.title));
  const d0 = parseDate(startDate);
  const dowStart = DOW[d0.getDay()];
  return `You are planning ${numDays} days of family dinners, starting on a ${dowStart}.

The family's taste so far, from their ratings:
- Loved (bring some of these back, and lean toward this style): ${faves}
- Just okay: ${okay}
- Disliked (do NOT include these; avoid similar): ${duds}

Extra notes from the cook: ${notes || "(none)"}

Rules:
- Exactly ${numDays} days, in order. Do not include dates — the app assigns them.
- Each day has a dinner (title, ingredients with quantities, and 3–6 concise steps) and a lunch (title only).
- Realistic, family-friendly weeknight cooking. Keep weekday dinners simpler; weekends can be more involved.
- Strong variety: don't repeat a dinner, and vary proteins and cuisines across each week.
- Lunches should be simple (sandwiches, wraps) or leftovers that reference the correct prior night's dinner.
- Favor the loved meals and their flavors; never include a disliked meal.
Return only the structured data.`;
}

async function generatePlan(startDate, numDays, notes, model, statusEl) {
  const key = getAnthropicKey();
  if (!key) { setGenStatus(statusEl, "Add your Anthropic API key first.", "err"); return; }
  setGenStatus(statusEl, "Generating… this can take up to a minute.", "");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: model || "claude-opus-4-8",
        max_tokens: 16000,
        output_config: { format: { type: "json_schema", schema: MEALS_SCHEMA } },
        messages: [{ role: "user", content: buildGenPrompt(startDate, numDays, notes) }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
    if (data.stop_reason === "refusal") throw new Error("The request was declined.");
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) throw new Error("No content returned.");
    const parsed = JSON.parse(textBlock.text);
    const days = (parsed.days || []).slice(0, numDays).map((day, i) => ({
      date: addDays(startDate, i),
      dinner: day.dinner,
      lunch: day.lunch,
    }));
    if (!days.length) throw new Error("The plan came back empty.");
    const s = parseDate(days[0].date), e = parseDate(days[days.length - 1].date);
    genPlan = {
      title: `${MON[s.getMonth()]} ${s.getFullYear()} Meal Plan`,
      subtitle: `${MON[s.getMonth()]} ${s.getDate()} – ${MON[e.getMonth()]} ${e.getDate()}`,
      days,
    };
    if (data.stop_reason === "max_tokens") {
      setGenStatus(statusEl, `Generated ${days.length} days (hit the length limit — try fewer days for full recipes).`, "err");
    } else {
      setGenStatus(statusEl, `Generated ${days.length} days ✓`, "ok");
    }
    render();
  } catch (err) {
    setGenStatus(statusEl, "Failed: " + err.message, "err");
  }
}

function setGenStatus(el, msg, cls) {
  if (el) { el.textContent = msg; el.className = "status-line " + (cls || ""); }
}

async function commitMealsJson(plan, statusEl) {
  if (!ghReady()) { setGenStatus(statusEl, "Turn on GitHub sync in ⚙ to publish the plan.", "err"); return; }
  const g = getGH();
  const branch = g.branch || "main";
  const api = `https://api.github.com/repos/${g.owner}/${g.repo}/contents/meals.json`;
  const headers = {
    "Authorization": `Bearer ${g.token}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
  };
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(plan, null, 2))));
  try {
    setGenStatus(statusEl, "Publishing to GitHub…", "");
    let sha;
    const getRes = await fetch(`${api}?ref=${encodeURIComponent(branch)}`, { headers });
    if (getRes.ok) sha = (await getRes.json()).sha;
    else if (getRes.status !== 404) throw new Error(`read ${getRes.status}`);
    const putRes = await fetch(api, {
      method: "PUT",
      headers,
      body: JSON.stringify({ message: `New plan: ${plan.title}`, content, branch, ...(sha ? { sha } : {}) }),
    });
    if (!putRes.ok) throw new Error(`${putRes.status} ${(await putRes.text()).slice(0, 120)}`);
    // Adopt it as the live plan on this device immediately.
    PLAN = plan;
    dayIndex = pickStartDay();
    let anchor = sundayOf(todayStr());
    if (anchor < planFirstSunday()) anchor = planFirstSunday();
    if (anchor > planLastSunday()) anchor = planLastSunday();
    weekAnchor = anchor;
    genPlan = null;
    view = "day";
    render();
    toast("New plan is live");
  } catch (err) {
    setGenStatus(statusEl, "Publish failed: " + err.message, "err");
  }
}

function downloadPlan(plan) {
  const blob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "meals.json";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function renderGenerate() {
  const key = getAnthropicKey();
  const defaultStart = PLAN ? addDays(PLAN.days[PLAN.days.length - 1].date, 1) : todayStr();

  const preview = genPlan ? `
    <div class="section-head">Preview <span class="rt-count">${genPlan.days.length} days</span></div>
    <div class="gen-sub">${esc(genPlan.title)} · ${esc(genPlan.subtitle)}</div>
    <div class="card">
      ${genPlan.days.map((d) => {
        const dd = parseDate(d.date);
        return `<div class="gen-row"><span class="gen-day">${DOW[dd.getDay()].slice(0, 3)} ${MON[dd.getMonth()]} ${dd.getDate()}</span><span class="gen-meal">${esc(d.dinner.title)}</span></div>`;
      }).join("")}
    </div>
    <button class="btn-primary" id="makeLiveBtn">Make this the live plan</button>
    <button class="btn-ghost" id="downloadBtn">Download meals.json</button>
    <button class="btn-ghost" id="discardBtn">Discard</button>
    <div class="status-line" id="applyStatus"></div>
  ` : "";

  app.innerHTML = `
    ${header()}
    <button class="detail-back" id="backBtn">‹ Ratings</button>
    <div class="detail-title" style="font-size:24px;margin-bottom:6px;">Plan a new month</div>
    <div class="explain">Generates a fresh plan with the Claude API, weighted toward your favorites and away from your duds. Your API key is stored only on this device.</div>
    <div class="settings-wrap">
      <div class="field">
        <label>Anthropic API key</label>
        <input id="g-key" type="password" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(key)}" placeholder="sk-ant-…">
        <div class="hint">From console.anthropic.com. Stored on this device only, never committed.</div>
      </div>
      <div class="field">
        <label>Start date</label>
        <input id="g-start" type="date" value="${esc(defaultStart)}">
      </div>
      <div class="field">
        <label>How many days</label>
        <input id="g-days" type="number" min="1" max="31" value="28">
      </div>
      <div class="field">
        <label>Notes for the chef (optional)</label>
        <input id="g-notes" type="text" placeholder="e.g. more chicken, one fish night, quick weekdays">
      </div>
      <button class="btn-primary" id="generateBtn">Generate plan</button>
      <div class="status-line" id="genStatus"></div>
    </div>
    ${preview}
  `;

  document.getElementById("gearBtn").onclick = () => { view = "settings"; render(); };
  document.getElementById("backBtn").onclick = () => { genPlan = null; view = "ratings"; render(); };
  document.getElementById("g-key").onchange = (e) => saveAnthropicKey(e.target.value.trim());

  document.getElementById("generateBtn").onclick = () => {
    saveAnthropicKey(document.getElementById("g-key").value.trim());
    const start = document.getElementById("g-start").value || defaultStart;
    const numDays = Math.max(1, Math.min(31, Number(document.getElementById("g-days").value) || 28));
    const notes = document.getElementById("g-notes").value.trim();
    generatePlan(start, numDays, notes, "claude-opus-4-8", document.getElementById("genStatus"));
  };

  const makeLive = document.getElementById("makeLiveBtn");
  if (makeLive) makeLive.onclick = () => {
    if (confirm("Replace your live plan with this generated one? Your ratings are kept.")) {
      commitMealsJson(genPlan, document.getElementById("applyStatus"));
    }
  };
  const dl = document.getElementById("downloadBtn");
  if (dl) dl.onclick = () => downloadPlan(genPlan);
  const discard = document.getElementById("discardBtn");
  if (discard) discard.onclick = () => { genPlan = null; render(); };
}

function renderDetail() {
  const day = PLAN.days[detailCtx.dayIndex];
  const slot = detailCtx.slot;
  const meal = resolveMeal(detailCtx.dayIndex, slot);
  const d = parseDate(day.date);
  const dateLine = `${DOW[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}`;
  const hasRecipe = !meal.skipped && meal.ingredients && meal.ingredients.length;

  let body = "";
  if (hasRecipe) {
    body += `<div class="section-head">Ingredients</div><div class="cook-hint">Tap items to check them off — the screen stays awake while you cook.</div><div class="card">`;
    meal.ingredients.forEach((ing) => {
      body += `<div class="ingredient check"><span class="dot"></span><span>${esc(ing)}</span></div>`;
    });
    body += `</div>`;

    body += `<div class="section-head">Recipe</div><div class="card">`;
    meal.steps.forEach((st, i) => {
      const linkified = esc(st).replace(
        /((?:https?:\/\/)?[\w.-]+\.[a-z]{2,}\/[\w./-]+)/gi,
        (m) => `<a class="recipe-link" href="${m.startsWith("http") ? m : "https://" + m}" target="_blank" rel="noopener">${m}</a>`
      );
      body += `<div class="step check"><span class="num">${i + 1}</span><span>${linkified}</span></div>`;
    });
    body += `</div>`;
  } else if (meal.skipped) {
    body += `<div class="note-box skipped-note">This ${slot} is skipped for ${DOW[d.getDay()]}. Use “Skip or move” above to restore it, or to move another day's meal here.</div>`;
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
    <button class="detail-back" id="backBtn">‹ ${detailReturn === "week" ? "Week" : detailReturn === "ratings" ? "Ratings" : DOW[d.getDay()]}</button>
    <div class="detail-kicker ${slot === "dinner" ? "" : ""}" style="color:var(--${slot})">${slot === "dinner" ? "Dinner" : "Lunch"}</div>
    <div class="detail-title">${esc(meal.title)}</div>
    <div class="detail-date">${dateLine}</div>
    <div class="detail-actions">
      <button class="action-chip" id="skipMoveBtn">⤴ Skip or move</button>
      ${meal.movedFrom ? `<span class="status-chip moved">↺ Moved from ${shortDay(meal.movedFrom)}</span>` : ""}
      ${meal.skipped ? `<span class="status-chip skip">Skipped</span>` : ""}
    </div>
    ${body}
    ${meal.skipped ? "" : `
    <div class="rate-block">
      <div class="rate-prompt">${current ? "Your rating" : "How was it? Tap to rate"}</div>
      <div class="stars" id="stars">${starRow}</div>
      <div class="rate-status" id="rateStatus"></div>
    </div>`}
  `;

  document.getElementById("gearBtn").onclick = () => { view = "settings"; render(); };
  document.getElementById("backBtn").onclick = () => { view = detailReturn; render(); };
  const smBtn = document.getElementById("skipMoveBtn");
  if (smBtn) smBtn.onclick = () => openMealActions(detailCtx.dayIndex, slot);

  // Cooking check-off: tap an ingredient/step to strike it through (ignore link taps).
  app.querySelectorAll(".ingredient.check, .step.check").forEach((el) => {
    el.onclick = (e) => { if (e.target.closest("a")) return; el.classList.toggle("done"); };
  });
  // Keep the screen awake while an actual recipe is open.
  if (hasRecipe) { cookingActive = true; requestWake(); } else { cookingActive = false; releaseWake(); }

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
      ${hasChanges() ? `<button class="btn-ghost danger-ghost" id="resetSched">Reset all skips &amp; moves to plan</button>` : ""}
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
  const resetSchedBtn = document.getElementById("resetSched");
  if (resetSchedBtn) resetSchedBtn.onclick = () => {
    resetAllSchedule();
    statusEl.textContent = "All skips & moves cleared.";
    statusEl.className = "status-line ok";
    resetSchedBtn.remove();
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
    // Week/Groceries default to the calendar week containing today, clamped to the plan.
    let anchor = sundayOf(todayStr());
    if (anchor < planFirstSunday()) anchor = planFirstSunday();
    if (anchor > planLastSunday()) anchor = planLastSunday();
    weekAnchor = anchor;
    render();
    // Pull ratings/overrides back from the repo so a fresh device or reinstall isn't
    // blank, and this device stays consistent with the widget and other devices.
    hydrateFromRepo();
  })
  .catch((e) => {
    app.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-dim)">Couldn't load meals.json<br><small>${esc(e.message)}</small></div>`;
  });

// iOS drops the wake lock when the app is backgrounded; re-acquire it on return
// if a recipe is still open.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && cookingActive) requestWake();
});

/* PWA */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
