# Smart To-Do

A local, cross-platform smart to-do list. Tasks are categorized **entirely on-device** with zero-dependency, client-side algorithms — no AI API calls, no network required.

- **Deterministic regex** extracts due dates (and, next, priorities) from natural-language capture text.
- **Multinomial Naive Bayes** (Laplace-smoothed, trained on the user's own corrections) auto-buckets tasks into user-defined categories.
- **PWA-first** delivery: one HTML/CSS/TS codebase installable on Android (Chrome → Add to Home Screen), macOS, and Windows.
- **Sync-ready storage**: a single JSON document (tasks + classifier model) designed to later sync through a cloud bucket/drive (e.g. Google Drive API).

## Architecture

```
┌─────────────────────────────────────────────┐
│ 4. Sync Adapter (Google Drive / file-based) │  Phase 4
├─────────────────────────────────────────────┤
│ 3. UI Shell (installable PWA, Blurprint UI) │  Phase 3
├─────────────────────────────────────────────┤
│ 2. Storage + Classifier Training Store      │  Phase 2
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

Decisions locked in so far (change requests welcome — these are constants, not architecture):

- `"friday"` / `"this friday"` / `"on friday"` → soonest occurrence, today included.
- `"next friday"` → soonest occurrence **+ 7 days**.
- Week starts Monday; `"end of week"` → this week's Sunday; `"next week"` → next Monday.
- Dates are stored as local-calendar `YYYY-MM-DD` strings; no time-of-day yet.
- Default classifier confidence threshold: `0.55` (below it → Inbox).

### UI theme (Phase 3 prep)

The UI follows the **Blurprint** design guide (Discord's geometry on a white, print-friendly canvas). All tokens live in `src/ui/theme.css`; components must consume the CSS variables rather than raw hex values.

## Development

```bash
npm install     # dev-only deps: typescript, @types/node
npm test        # compile + run the node:test suites
```
