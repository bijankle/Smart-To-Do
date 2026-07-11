# Smart To-Do

A local, cross-platform smart to-do list. Tasks are categorized **entirely on-device** with zero-dependency, client-side algorithms — no AI API calls, no network required.

- **Deterministic regex** extracts due dates (and, next, priorities) from natural-language capture text.
- **Multinomial Naive Bayes** (Laplace-smoothed, trained on the user's own corrections) auto-buckets tasks into user-defined categories.
- **PWA-first** delivery: one HTML/CSS/TS codebase installable on Android (Chrome → Add to Home Screen), macOS, and Windows.
- **Sync-ready storage**: a single JSON document (tasks + classifier model) designed to later sync through a cloud bucket/drive (e.g. Google Drive API).

## Architecture

```
┌─────────────────────────────────────────────┐
│ 4. Sync Adapter (cloud remote, pluggable)   │  Phase 4
├─────────────────────────────────────────────┤
│ 3. UI Shell (installable PWA, Blurprint UI) │  Phase 3
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
- Default classifier confidence threshold: `0.55` (below it → Inbox).

Parsing-engine constants (dormant while the date UI is off): `"friday"`-style words resolve to the soonest occurrence (today included), `"next friday"` adds 7 days, weeks start Monday, dates serialize as local `YYYY-MM-DD`.

### UI theme (Phase 3 prep)

The UI follows the **Blurprint** design guide (Discord's geometry on a white, print-friendly canvas). All tokens live in `src/ui/theme.css`; components must consume the CSS variables rather than raw hex values.

## Development

```bash
npm install     # dev-only deps: typescript, @types/node
npm test        # compile + run the node:test suites
```
