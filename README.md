# Smart To-Do

A local, cross-platform smart to-do list. Tasks are categorized **entirely on-device** with zero-dependency, client-side algorithms — no AI API calls, no network required.

- **Deterministic regex** extracts due dates (and, next, priorities) from natural-language capture text.
- **Multinomial Naive Bayes** (Laplace-smoothed, trained on the user's own corrections) auto-buckets tasks into user-defined categories.
- **PWA-first** delivery: one HTML/CSS/TS codebase installable on Android (Chrome → Add to Home Screen), macOS, and Windows.
- **Sync-ready storage**: a single JSON document (tasks + classifier model) designed to later sync through a cloud bucket/drive (e.g. Google Drive API).

## Architecture

```
┌─────────────────────────────────────────────┐
│ 4. Sync Adapter (Google Drive appData)      │  Phase 4  ✅
├─────────────────────────────────────────────┤
│ 3. UI Shell (installable PWA, Blurprint UI) │  Phase 3  ✅
├─────────────────────────────────────────────┤
│ 2. Storage + Classifier Training Store      │  Phase 2  ✅
├─────────────────────────────────────────────┤
│ 1. Parsing Engine (pure fns, zero deps)     │  Phase 1  ✅
└─────────────────────────────────────────────┘
```

Every layer below the UI is plain ESM TypeScript with **zero runtime dependencies**, so it runs identically in the browser, in a future Capacitor/Tauri wrapper, and under `node --test`.

### Phase 1 — Parsing Engine (done)

| Module | Purpose |
| --- | --- |
| `src/engine/dates.ts` | Relative-date extraction (`tomorrow`, `next friday`, `in 3 days`, `eow`, `eom`, …) resolved against an explicit `now` for determinism. |
| `src/engine/tokenize.ts` | Shared tokenizer (lowercase, stopword/number filtering). |
| `src/engine/classify.ts` | Naive Bayes model: `train` / `untrain` / `classify`, JSON-serializable so the model syncs with the tasks. |
| `src/engine/parse.ts` | `parseTask(text)` → `{ title, due, bucket, confidence }`; low-confidence suggestions fall back to the Inbox. |

### Phase 2 — Storage & Training Store (done)

| Module | Purpose |
| --- | --- |
| `src/storage/doc.ts` | The single sync-ready JSON document: tasks + buckets + classifier model, with tombstone deletes and per-record `modifiedAt` for deterministic last-write-wins merging (`mergeDocs`). |
| `src/storage/persistence.ts` | Two-method `Persistence` interface (`load`/`save`) with in-memory and Web Storage adapters; OPFS/native-file/cloud adapters slot in behind the same interface. |
| `src/storage/repo.ts` | `Repository` — the API the UI talks to: capture with auto-bucketing, pill filters (`all` / `inbox` / bucket), manual ordering (`moveToTop`, `moveAfter`), and correction-driven training. |

Product decisions locked in:

- **No priority tags.** Importance is expressed by position: new tasks enter at the top, and `moveToTop`/drag-reorder are first-class operations persisted in the task's `order` field.
- **No due-date UI.** The relative-date engine from Phase 1 remains in the codebase but is off by default; capture text is classified whole.
- **Pill-bar navigation.** The UI is a row of Blurprint role-pills at the top — `All`, plus one pill per user bucket (and Inbox for untagged tasks) — filtering a single list below.
- **Training only on explicit signals.** The classifier learns when a task is captured into, or moved to, a bucket by the user — never from its own predictions. A background pseudo-class keeps unfamiliar text in the Inbox instead of force-filing it.
- **Built-in common sense via a seed lexicon** (`src/engine/lexicon.ts`). Buckets whose names match a known concept (groceries, hardware, work, health, finance, home, travel, car, pets, errands — by name or alias like "food"/"tools") are pre-trained with that concept's vocabulary, so "celery and onions" files into a brand-new `groceries` bucket with zero training. Seeds are lightly weighted; user corrections dominate quickly.
- **Conservative auto-creation.** A capture matching ≥2 distinct words of a concept with no corresponding bucket auto-creates it. One everyday word is never enough, and a bucket the user deleted is never resurrected.
- Default classifier confidence threshold: `0.55` (below it → Inbox).

Parsing-engine constants (dormant while the date UI is off): `"friday"`-style words resolve to the soonest occurrence (today included), `"next friday"` adds 7 days, weeks start Monday, dates serialize as local `YYYY-MM-DD`.

### Phase 3/4 additions

- **Auto vs user buckets.** Auto-generated buckets render as dashed pills with a hollow dot and sort after user buckets; filing a task into one adopts it (solid pill, user ordering).
- **Completed tasks vanish** from the list. A footer toggle reveals them (most recently completed first) alongside a "Clear completed" action.
- **Google Drive sync** (`src/sync/drive.ts`): the whole store syncs as one JSON file in Drive's hidden `appDataFolder` (scope `drive.appdata` — the app can only see its own file, nothing else in Drive). Download → last-write-wins merge → upload; conflict-safe in any order.

### Google Drive sync setup (one-time, free)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in.
2. Create a project (name it anything, e.g. "Smart To-Do").
3. **APIs & Services → Library** → search "Google Drive API" → **Enable**.
4. **APIs & Services → OAuth consent screen**: choose **External**, fill in the app name and your email, and add your own Gmail address as a **test user**.
5. **APIs & Services → Credentials → Create credentials → OAuth client ID**: application type **Web application**, and under **Authorized JavaScript origins** add `http://localhost:4173`.
6. Copy the generated **Client ID** (ends in `.apps.googleusercontent.com`).
7. In the app: click **⚙** → paste the Client ID → **Save & connect** → approve the Google popup.

Repeat step 7 on each device (same Client ID). The Sync button pulls, merges, and pushes; the app also syncs silently on startup once authorized.

### UI theme (Phase 3 prep)

The UI follows the **Blurprint** design guide (Discord's geometry on a white, print-friendly canvas). All tokens live in `src/ui/theme.css`; components must consume the CSS variables rather than raw hex values.

## Running the app

Requires [Node.js](https://nodejs.org) (LTS).

**Easiest (macOS):** get the project once with git, then double-click `Start Smart To-Do.command` any time — it pulls the latest version, rebuilds, starts the server, and opens the app in your browser.

```bash
# one-time setup
git clone -b claude/smart-todo-list-arch-dpf2wq https://github.com/bijankle/Smart-To-Do.git
```

**Manual alternative** — from the project folder:

```bash
npm install     # one-time setup (dev-only deps: typescript, @types/node)
npm start       # builds and serves the app
```

…and open **http://localhost:4173** in your browser. Your tasks are saved in the browser's local storage on that machine (cloud sync arrives in Phase 4). Stop the server with `Ctrl+C`.

Try it out:

- Type `buy milk #groceries` — the `#tag` files the task *and* teaches the classifier (new tags are created automatically).
- After a few tagged examples, type `buy eggs` with no tag — it auto-files into `groceries`.
- Tasks the classifier isn't confident about land in the **Inbox** pill; click a task's tag chip to move it, which trains the model.
- The `↑` button moves a task to the top — importance is position, not priority tags.

## Development

```bash
npm test        # compile + run the node:test suites
```
