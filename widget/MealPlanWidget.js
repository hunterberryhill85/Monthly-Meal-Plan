// Meal Plan — Scriptable home/lock-screen widget for iPhone/iPad.
// Shows today's dinner (and lunch) pulled live from your GitHub Pages meals.json,
// with the star rating if you've rated it. Works on all widget sizes and on the
// lock screen. Caches the last good fetch so it still shows something offline.
//
// Setup: paste this whole file into a new script in the Scriptable app, then add a
// Scriptable widget to your home/lock screen and choose this script. See the repo
// README section "iPhone widget (Scriptable)" for step-by-step instructions.

// ---------- config ----------
const PAGES = "https://hunterberryhill85.github.io/Monthly-Meal-Plan/";
const MEALS_URL = PAGES + "meals.json";
const RATINGS_URL = PAGES + "ratings.json";
const OPEN_URL = PAGES; // tapping the widget opens the web app

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Food-forward palette, auto light/dark (matches the app).
const C = {
  bg: Color.dynamic(new Color("#f6f4ea"), new Color("#14170e")),
  text: Color.dynamic(new Color("#23291d"), new Color("#eef0e2")),
  dim: Color.dynamic(new Color("#6f7663"), new Color("#9aa189")),
  dinner: Color.dynamic(new Color("#c0562e"), new Color("#e2895f")),
  lunch: Color.dynamic(new Color("#c68a1c"), new Color("#e3b452")),
  accent: Color.dynamic(new Color("#3f7d54"), new Color("#7bb98a")),
  star: Color.dynamic(new Color("#e3a531"), new Color("#f0c04a")),
  starOff: Color.dynamic(new Color("#d2d5c2"), new Color("#464e34")),
};

// ---------- helpers ----------
function pad(n) { return String(n).padStart(2, "0"); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Fetch JSON, caching the last good copy to disk for offline use.
async function loadJSON(url, cacheName) {
  const fm = FileManager.local();
  const path = fm.joinPath(fm.cacheDirectory(), cacheName);
  try {
    const req = new Request(url);
    req.timeoutInterval = 12;
    const data = await req.loadJSON();
    fm.writeString(path, JSON.stringify(data));
    return data;
  } catch (e) {
    if (fm.fileExists(path)) return JSON.parse(fm.readString(path));
    throw e;
  }
}

function ratingFor(ratings, title) {
  if (!ratings || !ratings.ratings || !ratings.ratings[title]) return 0;
  return ratings.ratings[title].rating || 0;
}

// ---------- data ----------
let plan, ratings;
try {
  plan = await loadJSON(MEALS_URL, "mealplan_meals.json");
} catch (e) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  const t = w.addText("Couldn't load the meal plan.");
  t.textColor = C.text; t.font = Font.mediumSystemFont(14);
  const s = w.addText("Check your connection and try again.");
  s.textColor = C.dim; s.font = Font.systemFont(11);
  return finish(w);
}
try { ratings = await loadJSON(RATINGS_URL, "mealplan_ratings.json"); } catch (e) { ratings = null; }

const today = todayStr();
const day = plan.days.find((d) => d.date === today);
const family = config.widgetFamily; // null when run inside the app

// ---------- build ----------
let widget;
if (family === "accessoryInline") widget = buildInline(day);
else if (family === "accessoryCircular") widget = buildCircular(day);
else if (family === "accessoryRectangular") widget = buildRectangular(day);
else widget = buildStandard(day, family || "medium");

return finish(widget);

function finish(w) {
  w.url = OPEN_URL;
  // Roll over shortly after local midnight.
  const mid = new Date();
  mid.setHours(24, 0, 20, 0);
  w.refreshAfterDate = mid;
  if (config.runsInWidget) {
    Script.setWidget(w);
  } else {
    // Preview when run inside the Scriptable app.
    if (family === "accessoryInline" || family === "accessoryCircular" || family === "accessoryRectangular") w.presentAccessoryRectangular ? w.presentAccessoryRectangular() : w.presentSmall();
    else if (family === "large") w.presentLarge();
    else if (family === "small") w.presentSmall();
    else w.presentMedium();
  }
  Script.complete();
  return w;
}

// Star string for a rating (1–5), or null if unrated.
function starText(v) {
  if (!v) return null;
  let s = "";
  for (let i = 1; i <= 5; i++) s += i <= v ? "★" : "☆";
  return s;
}

// ---------- home-screen sizes: small / medium / large ----------
function buildStandard(day, size) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  const pad = size === "small" ? 14 : 16;
  w.setPadding(pad, pad, pad, pad);

  // Header: weekday + date
  const d = parseDate(today);
  const head = w.addText(`${DOW[d.getDay()].toUpperCase()} · ${MON[d.getMonth()]} ${d.getDate()}`);
  head.textColor = C.accent;
  head.font = Font.heavySystemFont(size === "small" ? 10 : 11);

  if (!day) {
    w.addSpacer(6);
    const none = w.addText("No meal planned for today.");
    none.textColor = C.text; none.font = Font.semiboldSystemFont(size === "small" ? 15 : 18);
    w.addSpacer(4);
    const sub = w.addText(plan.title);
    sub.textColor = C.dim; sub.font = Font.systemFont(12);
    return w;
  }

  w.addSpacer(size === "small" ? 8 : 10);

  // Dinner
  const dinLabel = w.addText("DINNER");
  dinLabel.textColor = C.dinner;
  dinLabel.font = Font.heavySystemFont(9);
  w.addSpacer(3);
  const dinTitle = w.addText(day.dinner.title);
  dinTitle.textColor = C.text;
  dinTitle.font = Font.boldSystemFont(size === "small" ? 15 : size === "large" ? 22 : 18);
  dinTitle.lineLimit = size === "small" ? 3 : size === "large" ? 3 : 2;
  dinTitle.minimumScaleFactor = 0.8;

  // Rating stars (if rated)
  const stars = starText(ratingFor(ratings, day.dinner.title));
  if (stars) {
    w.addSpacer(5);
    const st = w.addText(stars);
    st.textColor = C.star;
    st.font = Font.systemFont(size === "small" ? 12 : 14);
  }

  // Large: show a few ingredients
  if (size === "large" && day.dinner.ingredients && day.dinner.ingredients.length) {
    w.addSpacer(10);
    const ingHead = w.addText("INGREDIENTS");
    ingHead.textColor = C.dim; ingHead.font = Font.heavySystemFont(9);
    w.addSpacer(4);
    const list = day.dinner.ingredients.slice(0, 7).join("  ·  ");
    const ing = w.addText(list);
    ing.textColor = C.dim; ing.font = Font.systemFont(12); ing.lineLimit = 4;
  }

  // Lunch (medium + large)
  if (size !== "small") {
    w.addSpacer(size === "large" ? 12 : 10);
    const lunLabel = w.addText("LUNCH");
    lunLabel.textColor = C.lunch; lunLabel.font = Font.heavySystemFont(9);
    w.addSpacer(3);
    const lunTitle = w.addText(day.lunch.title);
    lunTitle.textColor = C.dim; lunTitle.font = Font.systemFont(13);
    lunTitle.lineLimit = 2; lunTitle.minimumScaleFactor = 0.85;
  }

  w.addSpacer();
  return w;
}

// ---------- lock screen: rectangular ----------
function buildRectangular(day) {
  const w = new ListWidget();
  if (!day) {
    const t = w.addText("No meal today");
    t.font = Font.semiboldSystemFont(13);
    return w;
  }
  const label = w.addText("🍽 Today's dinner");
  label.font = Font.mediumSystemFont(11);
  w.addSpacer(2);
  const title = w.addText(day.dinner.title);
  title.font = Font.semiboldSystemFont(14);
  title.lineLimit = 2; title.minimumScaleFactor = 0.8;
  const stars = starText(ratingFor(ratings, day.dinner.title));
  if (stars) {
    w.addSpacer(1);
    const st = w.addText(stars);
    st.font = Font.systemFont(11);
  } else {
    w.addSpacer(1);
    const lun = w.addText(day.lunch.title);
    lun.font = Font.systemFont(11); lun.textOpacity = 0.7; lun.lineLimit = 1;
  }
  return w;
}

// ---------- lock screen: inline ----------
function buildInline(day) {
  const w = new ListWidget();
  const t = w.addText(day ? `🍽 ${day.dinner.title}` : "🍽 No meal today");
  t.lineLimit = 1;
  return w;
}

// ---------- lock screen: circular ----------
function buildCircular(day) {
  const w = new ListWidget();
  w.addSpacer();
  const row = w.addStack();
  row.addSpacer();
  const t = row.addText("🍽");
  t.font = Font.systemFont(20);
  row.addSpacer();
  w.addSpacer();
  return w;
}
