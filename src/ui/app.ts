/**
 * Phase 3/4 — Blurprint UI shell + sync controls.
 *
 * Vanilla DOM, no framework: state lives in the Repository, and every
 * mutation triggers a re-render of the pill bar + list (cheap at this
 * scale). All user text goes through textContent, never innerHTML.
 *
 * Interactions:
 *  - Capture box adds to the top; a #tag anywhere files AND trains the bucket
 *    (creating it if new). Without a tag the classifier suggests one, the seed
 *    lexicon fills gaps (auto-creating clear-cut buckets), or the task stays
 *    in the Inbox.
 *  - Pill bar: All / Inbox / user buckets / auto buckets (dashed = auto) / +tag.
 *  - Completed tasks vanish from the list; a footer toggle reveals them,
 *    most recently completed first.
 *  - Google Drive sync (optional): configure once in ⚙ settings.
 */

import { Repository, type TaskFilter } from "../storage/repo.js";
import { WebStoragePersistence } from "../storage/persistence.js";
import type { TaskRecord } from "../storage/doc.js";
import { DriveSync } from "../sync/drive.js";
import { lookupProductConcepts } from "../sync/productlookup.js";
import { buildListPdf, type PdfSection } from "../sync/pdf.js";

let repo: Repository;
let filter: TaskFilter = "all";
let showCompleted = false;
let drive: DriveSync | null = null;

/** Just-ticked items stay visible this long (a shopping run) before tucking away. */
const RECENT_COMPLETED_MS = 5 * 60_000;
let graceTimer: number | undefined;

/**
 * Bespoke setup — this app is tailored to its owner's actual stores.
 * Applied once (recorded in the synced document): creates these pills and
 * folds any generic starter buckets into them.
 */
const MY_PILLS = [
  // Stores
  "Coles",
  "Bunnings",
  "Chemist Warehouse",
  "JB Hi-Fi",
  "Officeworks",
  "Ikea",
  "Kmart",
  "Uniqlo",
  "Outdoor",
  // Non-shopping tasks (admin, computer/online chores, appointments)
  "To-do",
];
const GENERIC_REMAP: Record<string, string> = {
  groceries: "Coles",
  food: "Coles",
  hardware: "Bunnings",
  tools: "Bunnings",
  electronics: "JB Hi-Fi",
  tech: "JB Hi-Fi",
  clothing: "Uniqlo",
};

const CLIENT_ID_KEY = "smart-to-do/drive-client-id";
const LAST_SYNC_KEY = "smart-to-do/last-sync";
const LOOKUP_ENABLED_KEY = "smart-to-do/online-lookup"; // "off" disables it
const LOOKUP_CACHE_KEY = "smart-to-do/lookup-cache";
/** Space network lookups to respect Open Food Facts' 10-requests/minute limit. */
const LOOKUP_MIN_INTERVAL_MS = 6500;

/** Visible build tag — shown in ⚙ App version so we can confirm the live build. */
const APP_VERSION = "v24 · nicer PDF";

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector(selector) as T;

// ---- capture ---------------------------------------------------------------

const TAG_PATTERN = /(?:^|\s)#([\w-]+)/;

/**
 * Snapshot-based undo/redo (buttons + Cmd+Z / Cmd+Y). Each user action records
 * the whole document before it runs, so undo can revert ANYTHING — add, delete,
 * complete, tag change, Clear all — not just captures.
 */
const undoHistory: string[] = [];
const redoHistory: string[] = [];
const HISTORY_LIMIT = 50;

/** Record the current state before a mutating action; call BEFORE the change. */
function snapshot(): void {
  undoHistory.push(repo.exportDoc());
  if (undoHistory.length > HISTORY_LIMIT) undoHistory.shift();
  redoHistory.length = 0; // a fresh action invalidates the redo trail
}

function undo(): void {
  const prev = undoHistory.pop();
  if (prev === undefined) return;
  redoHistory.push(repo.exportDoc());
  repo.restoreSnapshot(prev);
  if (filter !== "all" && !repo.listBuckets().includes(filter)) filter = "all";
  render();
}

function redo(): void {
  const next = redoHistory.pop();
  if (next === undefined) return;
  undoHistory.push(repo.exportDoc());
  repo.restoreSnapshot(next);
  if (filter !== "all" && !repo.listBuckets().includes(filter)) filter = "all";
  render();
}

function updateHistoryButtons(): void {
  ($("#undo-btn") as HTMLButtonElement).disabled = undoHistory.length === 0;
  ($("#redo-btn") as HTMLButtonElement).disabled = redoHistory.length === 0;
}

/** Add a single task from one line of capture text (no newlines expected). */
function captureOne(raw: string): void {
  const tagMatch = TAG_PATTERN.exec(raw);
  const title = raw.replace(TAG_PATTERN, " ").replace(/\s+/g, " ").trim();
  if (!title) return;

  if (tagMatch) {
    const tag = tagMatch[1]!;
    if (!repo.listBuckets().includes(tag)) repo.createBucket(tag);
    repo.addTask(title, tag);
  } else {
    repo.addTask(title);
  }
}

/**
 * Strip pasted-list noise from a line: Markdown table pipes and leading
 * bullets/blockquote/numbering, so pasting a table or bulleted list yields
 * clean task titles instead of "| Bicycle chain lubricant |".
 */
function cleanCaptureLine(raw: string): string {
  return raw
    .replace(/\|/g, " ") // table column separators
    .replace(/^\s*(?:[-*+•>]|\d+[.)])\s+/, "") // bullets, "1." / "1)" numbering
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Capture one OR many tasks: pasting a list (e.g. copied from Google Keep or a
 * Markdown table) adds one task per line, cleaned of pipes/bullets and each
 * auto-tagged on its own, instead of mashing the whole list into one item.
 */
function submitCapture(raw: string): void {
  const lines = raw
    .split(/\r?\n/)
    .map(cleanCaptureLine)
    .filter((line) => /[a-z0-9]/i.test(line)); // drop separator rows like |---|---|
  if (lines.length === 0) return;
  snapshot();
  for (const line of lines) captureOne(line);
  render();
  queueProductLookups();
}

// ---- online product lookup (fallback for items the lexicon can't place) -----

const lookupQueue: string[] = []; // task ids awaiting lookup
const lookupSeen = new Set<string>(); // task ids attempted this session
let lookupRunning = false;
let lastLookupAt = 0;

function lookupEnabled(): boolean {
  return localStorage.getItem(LOOKUP_ENABLED_KEY) !== "off";
}

function loadLookupCache(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(LOOKUP_CACHE_KEY) ?? "{}") as Record<string, string[]>;
  } catch {
    return {};
  }
}

/** Queue every still-untagged, untouched open task for a background lookup. */
function queueProductLookups(): void {
  if (!lookupEnabled()) return;
  for (const task of repo.listTasks("all")) {
    if (task.buckets.length > 0 || task.manualTags || lookupSeen.has(task.id)) continue;
    lookupSeen.add(task.id);
    lookupQueue.push(task.id);
  }
  void runLookupQueue();
}

async function runLookupQueue(): Promise<void> {
  if (lookupRunning) return;
  lookupRunning = true;
  try {
    while (lookupQueue.length > 0) {
      const id = lookupQueue.shift()!;
      const task = repo.getTask(id);
      if (!task || task.buckets.length > 0 || task.manualTags) continue;

      const term = task.title.trim().toLowerCase();
      const cache = loadLookupCache();
      let concepts = cache[term];
      if (concepts === undefined) {
        if (!navigator.onLine || !lookupEnabled()) continue; // try again next session
        const wait = LOOKUP_MIN_INTERVAL_MS - (Date.now() - lastLookupAt);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastLookupAt = Date.now();
        concepts = await lookupProductConcepts(task.title, fetch);
        cache[term] = concepts;
        localStorage.setItem(LOOKUP_CACHE_KEY, JSON.stringify(cache));
      }
      if (concepts.length === 0) continue;
      const buckets = [...new Set(concepts.flatMap((c) => repo.bucketsForConceptName(c)))];
      if (buckets.length > 0 && repo.setSuggestedTags(id, buckets)) render();
    }
  } finally {
    lookupRunning = false;
  }
}

/** Shrink/grow the capture box to fit its content (so a pasted list is visible). */
function autosizeCapture(): void {
  const input = $<HTMLTextAreaElement>("#capture-input");
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

function handleCapture(event: SubmitEvent): void {
  event.preventDefault();
  const input = $<HTMLTextAreaElement>("#capture-input");
  const raw = input.value.trim();
  if (!raw) return;
  submitCapture(raw);
  input.value = "";
  autosizeCapture();
}

/**
 * The capture box is a <textarea>, so a pasted list keeps its line breaks in
 * the value and submitCapture files one task per line — reliably, on every
 * platform, without depending on catching the paste event. Enter submits;
 * Shift+Enter inserts a newline for building a multi-item list by hand.
 */
function handleCaptureKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    ($("#capture") as HTMLFormElement).requestSubmit();
  }
}

function handleUndoKeys(event: KeyboardEvent): void {
  if (!(event.metaKey || event.ctrlKey)) return;
  // Don't hijack undo while the user is editing a task title or a form field
  // other than the capture box — let the browser's native text undo work.
  const active = document.activeElement;
  if (
    (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
    active.id !== "capture-input"
  ) {
    return;
  }
  const key = event.key.toLowerCase();
  if (key === "z" && !event.shiftKey) {
    event.preventDefault();
    undo();
  } else if (key === "y" || (key === "z" && event.shiftKey)) {
    event.preventDefault();
    redo();
  }
}

// ---- pill bar --------------------------------------------------------------

function pill(
  label: string,
  count: number,
  options: { active: boolean; auto?: boolean; onDelete?: () => void },
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pill";
  if (options.active) button.classList.add("pill-active");
  if (options.auto) {
    button.classList.add("pill-generated");
    button.title = "Created automatically — file a task into it to keep it";
  }
  const dot = document.createElement("span");
  dot.className = "pill-dot";
  const text = document.createElement("span");
  text.textContent = label;
  button.append(dot, text);
  if (count > 0) {
    const badge = document.createElement("span");
    badge.className = "pill-count";
    badge.textContent = String(count);
    button.append(badge);
  }
  // The selected pill grows a small × so tags can be deleted in place.
  if (options.active && options.onDelete) {
    const remove = document.createElement("span");
    remove.className = "pill-x";
    remove.textContent = "×";
    remove.title = "Delete this tag";
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      options.onDelete!();
    });
    button.append(remove);
  }
  button.addEventListener("click", onClick);
  return button;
}

/**
 * A bucket earns a pill only while it has open tasks — or while it's the
 * current filter, so selecting an empty one from the drawer doesn't make its
 * pill vanish under you. Everything else (stores set up but never used, or
 * used before and now cleared) lives in the "More" drawer.
 */
function isActiveBucket(name: string): boolean {
  return filter === name || repo.listTasks(name).length > 0;
}

function renderPills(): void {
  const nav = $("#pills");
  nav.replaceChildren();

  nav.append(
    pill("All", repo.listTasks("all").length, { active: filter === "all" }, () => setFilter("all")),
  );

  const details = repo.listBucketDetails();
  const inactive = details.filter((b) => !isActiveBucket(b.name));
  for (const bucket of details.filter((b) => isActiveBucket(b.name))) {
    nav.append(
      pill(
        bucket.name,
        repo.listTasks(bucket.name).length,
        {
          active: filter === bucket.name,
          auto: bucket.auto,
          onDelete: () => {
            const ok = window.confirm(
              `Delete the “${bucket.name}” tag? Tasks keep their other tags.`,
            );
            if (!ok) return;
            snapshot();
            repo.deleteBucket(bucket.name);
            filter = "all";
            render();
          },
        },
        () => setFilter(bucket.name),
      ),
    );
  }

  // Drawer button: reveals every bucket that isn't currently shown.
  if (inactive.length > 0) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "pill pill-more";
    more.title = "Show your other lists";
    const label = document.createElement("span");
    label.textContent = "More";
    const badge = document.createElement("span");
    badge.className = "pill-count";
    badge.textContent = String(inactive.length);
    more.append(label, badge);
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      openInactiveMenu(more, inactive);
    });
    nav.append(more);
  }

  const add = document.createElement("button");
  add.type = "button";
  add.className = "pill pill-add";
  add.textContent = "+ tag";
  add.addEventListener("click", () => {
    const input = document.createElement("input");
    input.className = "pill-input";
    input.placeholder = "tag name";
    input.maxLength = 24;
    add.replaceWith(input);
    input.focus();
    let settled = false; // Enter also fires blur once we re-render — commit only once
    const finish = (create: boolean) => {
      if (settled) return;
      settled = true;
      const name = input.value.trim();
      if (create && name) {
        snapshot();
        repo.createBucket(name);
      }
      render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  });
  nav.append(add);
}

function setFilter(next: TaskFilter): void {
  filter = next;
  render();
}

// ---- task list -------------------------------------------------------------

function iconButton(className: string, symbol: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `row-btn ${className}`;
  button.textContent = symbol;
  button.title = title;
  button.addEventListener("click", onClick);
  return button;
}

function renderRow(task: TaskRecord): HTMLElement {
  const row = document.createElement("div");
  row.className = task.done ? "row row-done" : "row";

  const check = document.createElement("button");
  check.type = "button";
  check.className = "row-check";
  check.title = task.done ? "Mark as not done" : "Mark as done";
  check.textContent = task.done ? "✓" : "";
  check.addEventListener("click", () => {
    snapshot();
    repo.setDone(task.id, !task.done);
    render();
  });

  // Title + tag chips share one wrapping box: the tags flow onto a new line
  // when they'd otherwise squeeze the title, so a many-tag item never shrinks
  // the title to a single character per line.
  const body = document.createElement("div");
  body.className = "row-body";
  const title = document.createElement("div");
  title.className = "row-title";
  title.textContent = task.title;
  title.title = "Click to edit";
  title.addEventListener("click", () => beginTitleEdit(title, task));
  body.append(title);
  for (const bucket of task.buckets) {
    const tag = document.createElement("button");
    tag.type = "button";
    tag.className = "row-tag";
    tag.textContent = bucket;
    tag.title = "Edit this task's tags (teaches the classifier)";
    tag.addEventListener("click", (e) => {
      e.stopPropagation();
      openTagMenu(tag, task);
    });
    body.append(tag);
  }

  // Action buttons stay grouped on the right, out of the title's flex space.
  const actions = document.createElement("div");
  actions.className = "row-actions";
  if (!task.done) {
    // Manual filing = the training signal. Same picker as the tag chip.
    const assign = iconButton("row-assign", "+", "Add to a tag — teaches the app", () => {
      openTagMenu(assign, task);
    });
    actions.append(assign);
  }
  const copy = iconButton("row-copy", "⧉", "Copy this item", () => {
    void navigator.clipboard.writeText(task.title).then(
      () => flashButton(copy, "✓"),
      () => flashButton(copy, "✕"),
    );
  });
  actions.append(copy);
  actions.append(
    iconButton("row-delete", "×", "Delete", () => {
      snapshot();
      repo.deleteTask(task.id);
      render();
    }),
  );

  row.append(check, body, actions);
  return row;
}

/** Click-to-edit: fixing a typo on an untagged task re-runs auto-tagging. */
function beginTitleEdit(el: HTMLElement, task: TaskRecord): void {
  const input = document.createElement("input");
  input.className = "row-edit";
  input.value = task.title;
  input.maxLength = 300;
  el.replaceWith(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  let settled = false;
  const finish = (save: boolean) => {
    if (settled) return;
    settled = true;
    const text = input.value.trim();
    if (save && text && text !== task.title) {
      try {
        snapshot();
        repo.renameTask(task.id, text);
      } catch {
        /* task vanished mid-edit (e.g. synced away) — just re-render */
      }
    }
    render();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

function openTagMenu(anchor: HTMLElement, task: TaskRecord): void {
  closeTagMenu();
  const menu = document.createElement("div");
  menu.className = "tag-menu";
  menu.id = "tag-menu";

  // Toggle-style: a task can belong to several buckets at once.
  for (const bucket of repo.listBuckets()) {
    const member = task.buckets.includes(bucket);
    const item = document.createElement("button");
    item.type = "button";
    item.className = member ? "tag-menu-item tag-menu-active" : "tag-menu-item";
    item.textContent = member ? `✓ ${bucket}` : bucket;
    item.addEventListener("click", () => {
      snapshot();
      repo.toggleBucket(task.id, bucket);
      render();
    });
    menu.append(item);
  }
  if (repo.listBuckets().length === 0) {
    const hint = document.createElement("div");
    hint.className = "tag-menu-hint";
    hint.textContent = "No tags yet — create one with “+ tag”.";
    menu.append(hint);
  }

  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 6}px`;
  menu.style.left = `${Math.max(8, rect.right + window.scrollX - 160)}px`;
  document.body.append(menu);
  setTimeout(() => document.addEventListener("click", closeTagMenu, { once: true }));
}

function closeTagMenu(): void {
  document.getElementById("tag-menu")?.remove();
}

/**
 * The "More" drawer: every bucket not currently shown as a pill — stores set
 * up but never used, and lists used before that are now cleared. Picking one
 * filters to it (its pill reappears while selected); a small count shows how
 * many items were completed there, distinguishing past-used from never-used.
 */
function openInactiveMenu(anchor: HTMLElement, buckets: Array<{ name: string }>): void {
  closeTagMenu();
  const menu = document.createElement("div");
  menu.className = "tag-menu";
  menu.id = "tag-menu";

  const hint = document.createElement("div");
  hint.className = "tag-menu-hint";
  hint.textContent = "Your other lists";
  menu.append(hint);

  for (const bucket of buckets) {
    const done = repo.listCompleted(bucket.name).length;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "tag-menu-item";
    item.textContent = done > 0 ? `${bucket.name} · ${done} done` : bucket.name;
    item.addEventListener("click", () => setFilter(bucket.name));
    menu.append(item);
  }

  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 6}px`;
  menu.style.left = `${Math.max(8, rect.left + window.scrollX)}px`;
  document.body.append(menu);
  setTimeout(() => document.addEventListener("click", closeTagMenu, { once: true }));
}

function completedAtMs(t: TaskRecord): number {
  return Date.parse(t.completedAt ?? t.modifiedAt);
}

/** Two-column Markdown table of the given tasks: item | comma-listed categories. */
function buildListTable(tasks: TaskRecord[]): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  const rows = tasks.map((t) => `| ${cell(t.title)} | ${cell(t.buckets.join(", "))} |`);
  return ["| Item | Categories |", "| --- | --- |", ...rows].join("\n");
}

/** Briefly show confirmation text on a button, then restore its label. */
function flashButton(button: HTMLButtonElement, message: string): void {
  const original = button.textContent;
  button.textContent = message;
  button.disabled = true;
  window.setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1400);
}

function renderList(): void {
  const list = $("#list");
  list.replaceChildren();
  const open = repo.listTasks(filter);
  const completed = repo.listCompleted(filter);
  const cutoff = Date.now() - RECENT_COMPLETED_MS;
  const recent = completed.filter((t) => completedAtMs(t) >= cutoff);
  const shownCompleted = showCompleted ? completed : recent;

  if (open.length === 0 && shownCompleted.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent =
      filter === "all"
        ? "Nothing here yet — add your first task above."
        : `No tasks tagged “${filter}” yet.`;
    list.append(empty);
  } else {
    // Action bar: icon buttons identical to the row's, aligned right so
    // Copy-all sits over the ⧉ column and Clear-all over the × column.
    if (open.length > 0) {
      const bar = document.createElement("div");
      bar.className = "list-actions";

      // Copy-all (⧉) — copies the whole list as an item + categories table.
      const copy = iconButton("row-copy list-icon", "⧉", "Copy the whole list", () => {
        void navigator.clipboard.writeText(buildListTable(open)).then(
          () => flashButton(copy, "✓"),
          () => flashButton(copy, "✕"),
        );
      });

      // Clear-all (×) — same glyph as the per-row delete, applied to the view.
      const clear = iconButton("row-delete list-icon", "×", "Clear the whole list", () => {
        const what = filter === "all" ? "all tasks" : `all items in “${filter}”`;
        if (!window.confirm(`Clear ${what}?`)) return;
        snapshot();
        repo.clearFilter(filter);
        render();
      });

      bar.append(copy, clear);
      list.append(bar);
    }
    for (const task of open) {
      list.append(renderRow(task));
    }
    if (shownCompleted.length > 0) {
      const divider = document.createElement("div");
      divider.className = "list-divider";
      divider.textContent = showCompleted ? "Completed" : "Just completed";
      list.append(divider);
      for (const task of shownCompleted) list.append(renderRow(task));
    }
  }

  // Re-render when the oldest visible "just completed" item ages out.
  window.clearTimeout(graceTimer);
  if (!showCompleted && recent.length > 0) {
    const oldest = Math.min(...recent.map(completedAtMs));
    graceTimer = window.setTimeout(
      render,
      Math.max(1000, oldest + RECENT_COMPLETED_MS - Date.now() + 250),
    );
  }
}

function renderFooter(): void {
  const footer = $("#footer");
  footer.replaceChildren();
  const completed = repo.listCompleted(filter);
  if (completed.length === 0) {
    showCompleted = false;
    return;
  }
  const cutoff = Date.now() - RECENT_COMPLETED_MS;
  const older = completed.filter((t) => completedAtMs(t) < cutoff);

  if (older.length > 0 || showCompleted) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "btn-ghost";
    toggle.textContent = showCompleted
      ? "Hide older completed"
      : `Show ${older.length} older completed`;
    toggle.addEventListener("click", () => {
      showCompleted = !showCompleted;
      render();
    });
    footer.append(toggle);
  }

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "btn-ghost btn-ghost-danger";
  clear.textContent = "Clear completed";
  clear.addEventListener("click", () => {
    snapshot();
    for (const task of completed) repo.deleteTask(task.id);
    render();
  });
  footer.append(clear);
}

// ---- sync ------------------------------------------------------------------

function setSyncStatus(text: string, isError = false): void {
  const status = $("#sync-status");
  status.textContent = text;
  status.classList.toggle("sync-status-error", isError);
}

function renderSyncUi(): void {
  const configured = Boolean(localStorage.getItem(CLIENT_ID_KEY));
  $("#sync-btn").hidden = !configured;
  $("#disconnect-btn").hidden = !configured;
  const indicator = $("#sync-indicator");
  if (!configured) {
    indicator.textContent = "local only";
  } else if (drive?.connected) {
    const last = localStorage.getItem(LAST_SYNC_KEY);
    indicator.textContent = last ? `synced ${new Date(last).toLocaleTimeString()}` : "connected";
  } else {
    indicator.textContent = "sync configured — press Sync";
  }
}

async function doSync(interactive: boolean): Promise<void> {
  if (!drive) return;
  try {
    if (!drive.connected) {
      setSyncStatus("Connecting…");
      const ok = await drive.connect(interactive);
      if (!ok) {
        setSyncStatus(interactive ? "Google sign-in was cancelled." : "", interactive);
        renderSyncUi();
        return;
      }
    }
    setSyncStatus("Syncing…");
    const result = await drive.sync(repo);
    localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
    setSyncStatus(result === "first-upload" ? "First upload complete ✓" : "Synced ✓");
    render();
  } catch (error) {
    setSyncStatus(error instanceof Error ? error.message : "Sync failed", true);
  }
  renderSyncUi();
}

function initSyncControls(): void {
  const saved = localStorage.getItem(CLIENT_ID_KEY);
  if (saved) {
    $<HTMLInputElement>("#client-id").value = saved;
    drive = new DriveSync(saved);
    // Silent reconnect + sync if the user authorized before.
    void doSync(false);
  }

  $("#settings-btn").addEventListener("click", () => {
    if ($("#settings").hidden) openSettings();
    else closeSettings();
  });
  $("#settings-back").addEventListener("click", closeSettings);

  $("#connect-btn").addEventListener("click", () => {
    const clientId = $<HTMLInputElement>("#client-id").value.trim();
    if (!clientId) {
      setSyncStatus("Paste your OAuth Client ID first.", true);
      return;
    }
    localStorage.setItem(CLIENT_ID_KEY, clientId);
    drive = new DriveSync(clientId);
    void doSync(true);
  });

  $("#disconnect-btn").addEventListener("click", () => {
    localStorage.removeItem(CLIENT_ID_KEY);
    localStorage.removeItem(LAST_SYNC_KEY);
    drive = null;
    setSyncStatus("Disconnected. Your data stays on this device.");
    renderSyncUi();
  });

  $("#sync-btn").addEventListener("click", () => void doSync(true));

  $("#app-version").textContent = APP_VERSION;

  const lookupToggle = $<HTMLInputElement>("#lookup-toggle");
  lookupToggle.checked = lookupEnabled();
  lookupToggle.addEventListener("change", () => {
    localStorage.setItem(LOOKUP_ENABLED_KEY, lookupToggle.checked ? "on" : "off");
    if (lookupToggle.checked) queueProductLookups();
  });

  $("#undo-btn").addEventListener("click", undo);
  $("#redo-btn").addEventListener("click", redo);

  $("#share-btn").addEventListener("click", () =>
    void shareListPdf($<HTMLButtonElement>("#share-btn")),
  );

  // Force update: drop the service worker + code caches and reload. Tasks
  // live in localStorage and are untouched; only the cached shell is cleared.
  $("#force-update-btn").addEventListener("click", () => {
    const status = $("#update-status");
    status.textContent = "Updating…";
    status.classList.remove("sync-status-error");
    void (async () => {
      try {
        await repo.flush();
        if ("serviceWorker" in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
        }
        if ("caches" in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }
      } catch {
        /* best effort — reload regardless */
      }
      // Cache-bust the reload so the browser refetches the shell.
      location.replace(location.pathname + "?v=" + String(Date.now()));
    })();
  });

  renderSyncUi();
}

// ---- share as PDF ----------------------------------------------------------

/**
 * Gather the current lists into printable sections: one per bucket (in pill
 * order) that has open tasks, then any untagged items. A task in several
 * buckets is printed under each — exactly how it appears in the app.
 */
function collectPrintSections(): PdfSection[] {
  const sections: PdfSection[] = [];
  for (const bucket of repo.listBucketDetails()) {
    const items = repo.listTasks(bucket.name).map((t) => t.title);
    if (items.length > 0) sections.push({ name: bucket.name, items });
  }
  const untagged = repo
    .listTasks("all")
    .filter((t) => t.buckets.length === 0)
    .map((t) => t.title);
  if (untagged.length > 0) sections.push({ name: "Unfiled", items: untagged });
  return sections;
}

/** Two-digit-padded local date, e.g. "14 Jul 2026", without pulling in a lib. */
function todayLabel(): string {
  const now = new Date();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
}

/**
 * Build a PDF of the lists and hand it off: the native share sheet with the
 * file attached on mobile (so it can go to anyone/anywhere), or a download on
 * desktop. No server, no mirror site — just a printable snapshot.
 */
async function shareListPdf(button: HTMLButtonElement): Promise<void> {
  try {
    const sections = collectPrintSections();
    const total = sections.reduce((n, s) => n + s.items.length, 0);
    const bytes = buildListPdf({
      title: "Smart To-Do",
      subtitle: `${total} item${total === 1 ? "" : "s"} · ${todayLabel()}`,
      sections,
    });
    const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
    const filename = "smart-to-do.pdf";

    const file = new File([blob], filename, { type: "application/pdf" });
    if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Smart To-Do" });
        return;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return; // dismissed
        // otherwise fall through to a download
      }
    }

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    flashButton(button, "✓");
  } catch {
    flashButton(button, "✕");
  }
}

// ---- settings navigation ---------------------------------------------------

/**
 * Settings opens as a history entry, so the phone's back gesture (and the
 * back arrow) pop it and return to the list — without ever leaving the app.
 */
function openSettings(): void {
  if (!$("#settings").hidden) return;
  $("#settings").hidden = false;
  history.pushState({ view: "settings" }, "");
}

function closeSettings(): void {
  // Undo the history entry we pushed; popstate does the actual hiding.
  if (!$("#settings").hidden) history.back();
}

/** The app logo is a Home button: leave settings and reset to the All view. */
function goHome(): void {
  closeSettings();
  setFilter("all");
}

// ---- boot ------------------------------------------------------------------

function render(): void {
  closeTagMenu();
  renderPills();
  renderList();
  renderFooter();
  renderSyncUi();
  updateHistoryButtons();
}

/** Listeners common to both the normal list and a shared-view copy. */
function wireCommonListeners(): void {
  $("#capture").addEventListener("submit", handleCapture as EventListener);
  $("#capture-input").addEventListener("keydown", handleCaptureKeydown as EventListener);
  $("#capture-input").addEventListener("input", autosizeCapture);
  $("#app-logo").addEventListener("click", goHome);
  // Back gesture / browser Back closes the settings screen (never leaves the app).
  window.addEventListener("popstate", () => {
    $("#settings").hidden = true;
  });
  window.addEventListener("keydown", handleUndoKeys);
}

/**
 * Offline support when hosted (skipped during local development). Reload once
 * when a new service worker takes control, so updated code lands promptly
 * instead of a launch behind.
 */
function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator) || location.hostname === "localhost") return;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker
    .register("./sw.js")
    .then((reg) => {
      reg.update();
      setInterval(() => reg.update(), 60 * 60 * 1000);
    })
    .catch(() => {
      /* not fatal — the app still works online */
    });
}

async function main(): Promise<void> {
  repo = await Repository.open(new WebStoragePersistence(window.localStorage));
  repo.applyStoreSetup(MY_PILLS, GENERIC_REMAP);
  repo.stripTitleFormatting();
  repo.retagUntagged();
  wireCommonListeners();
  initSyncControls();
  render();
  queueProductLookups();
  $<HTMLTextAreaElement>("#capture-input").focus();
  registerServiceWorker();
}

void main();
