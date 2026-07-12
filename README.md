# Meal Plan

A local, installable (PWA) meal-plan app for iPhone/iPad Safari. Opens to **today's
meals** (dinner + lunch), tap a meal to see the recipe — **ingredients at the top,
steps below** — and give it a **1–5 star rating**. Ratings save on the device and,
when connected, commit an `ratings.json` file to this GitHub repo so the meal-plan
generator can use them to build the next plan.

## Files
- `index.html`, `styles.css`, `app.js` — the app
- `meals.json` — the plan data (days → dinner/lunch, with ingredients + steps)
- `ratings.json` — written by the app once GitHub sync is on (this is the file to point the meal planner at)
- `overrides.json` — written by the app when you skip/move meals (so the widget shows the effective plan)
- `manifest.webmanifest`, `sw.js`, `icons/` — PWA install + offline

## Run locally (on your Mac, to test)
```bash
cd ~/Desktop/meal-plan-app
python3 -m http.server 8747
# open http://localhost:8747
```

## Put it on your iPhone/iPad (GitHub Pages — same as the workout app)
Repo: `hunterberryhill85/Monthly-Meal-Plan` (remote already configured).
1. Authenticate once, then push:
   ```bash
   cd ~/Desktop/meal-plan-app
   gh auth login            # HTTPS + GitHub.com, authenticate in browser
   git push -u origin main
   ```
2. On GitHub: **Settings → Pages → Build from branch → `main` / root → Save.**
3. Open the Pages URL (`https://hunterberryhill85.github.io/Monthly-Meal-Plan/`) in
   Safari, then **Share → Add to Home Screen**. It launches full-screen like a native app.

## Turn on ratings sync (write ratings.json back to the repo)
The app is static, so it commits ratings via the GitHub API using a token you create:
1. GitHub → **Settings → Developer settings → Fine-grained tokens → Generate new token.**
2. **Repository access:** Only select repositories → this repo.
   **Permissions:** Repository → **Contents: Read and write.**
3. Copy the token (`github_pat_…`).
4. In the app, tap **⚙**, fill in your **username**, **repo name**, leave branch `main`
   and file `ratings.json`, paste the **token**, and tap **Save & test sync now**.

The token is stored only on that device (in the browser) — it is never committed to
the repo. After that, every star tap writes an updated `ratings.json` to the repo.

## How ratings.json looks (what the meal planner reads)
```json
{
  "updated": "2026-07-12T03:21:15.745Z",
  "plan": "July Meal Plan",
  "ratings": {
    "Backyard cookout — burgers, hot dogs, grilled chicken sausage": {
      "title": "Backyard cookout — burgers, hot dogs, grilled chicken sausage",
      "type": "dinner",
      "rating": 4,
      "count": 1,
      "history": [ { "date": "2026-07-11", "rating": 4, "at": "2026-07-12T03:21:15.745Z" } ]
    }
  }
}
```
`rating` is the latest score; `history` keeps every rating so the planner can see
trends and how often a meal came up.

## iPhone widget (Scriptable)
iOS won't let a web app place a home-screen widget, but the free
[Scriptable](https://apps.apple.com/app/scriptable/id1405459188) app can — and it
reads the same live `meals.json`, so the widget always matches the plan.

`widget/MealPlanWidget.js` is the script. To install:
1. Open **Scriptable** → **＋** (new script) → paste in the contents of
   `widget/MealPlanWidget.js` → name it **Meal Plan** → Done.
2. Long-press the home screen → **＋** → search **Scriptable** → pick a size → **Add**.
3. Long-press the new widget → **Edit Widget** → set **Script: Meal Plan**
   (leave *When Interacting* as *Run Script* or *Open URL*).

It shows today's **dinner** (plus **lunch** on medium/large), the star rating if
you've rated it, and on the large size a few ingredients. Works on the lock screen
too (rectangular / inline / circular). Tapping it opens the web app. It refreshes
itself after midnight and caches the last fetch so it still shows offline.

Skips/moves you make in the app are synced up to `overrides.json` (whenever GitHub
sync is on) and the widget applies them, so it shows the *effective* meal for today
— including "Skipped tonight" and "moved from …". Note iOS refreshes widgets on its
own schedule, so a change can take a few minutes (or force it by removing and
re-adding the widget).

## Updating the plan each month
Replace `meals.json` with the new month's data (same shape), then **bump `VERSION`
in `sw.js`** (e.g. `meal-v1` → `meal-v2`) so devices pick up the new files instead of
the cached ones. Commit and push; Pages redeploys automatically.

## meals.json shape
```json
{
  "title": "July Meal Plan",
  "subtitle": "July 6 – 31",
  "days": [
    {
      "date": "2026-07-06",
      "dinner": { "title": "...", "ingredients": ["..."], "steps": ["..."] },
      "lunch":  { "title": "..." }
    }
  ]
}
```
A meal with an empty `ingredients` array (or a `note`) renders as a simple note card
instead of a full recipe (used for leftover nights).
