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
  // Life categories
  "Medical",
  "Computer tasks",
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

/** Visible build tag — shown in ⚙ App version so we can confirm the live build. */
const APP_VERSION = "v7 · computer tasks";

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector(selector) as T;

// ---- capture ---------------------------------------------------------------

const TAG_PATTERN = /(?:^|\s)#([\w-]+)/;

/**
 * Capture undo/redo (Cmd+Z / Cmd+Y): undoing removes the captured task and
 * puts the original text back in the input for correction; redo re-captures.
 */
interface CaptureEntry {
  text: string;
  taskId: string;
}
const undoStack: CaptureEntry[] = [];
const redoStack: CaptureEntry[] = [];

/** Add a single task from one line of capture text (no newlines expected). */
function captureOne(raw: string): void {
  const tagMatch = TAG_PATTERN.exec(raw);
  const title = raw.replace(TAG_PATTERN, " ").replace(/\s+/g, " ").trim();
  if (!title) return;

  let task;
  if (tagMatch) {
    const tag = tagMatch[1]!;
    if (!repo.listBuckets().includes(tag)) repo.createBucket(tag);
    task = repo.addTask(title, tag);
  } else {
    task = repo.addTask(title);
  }
  undoStack.push({ text: raw, taskId: task.id });
}

/**
 * Capture one OR many tasks: pasting a list (e.g. copied from Google Keep)
 * adds one task per non-empty line, each auto-tagged on its own, instead of
 * mashing the whole list into a single item.
 */
function submitCapture(raw: string): void {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return;
  for (const line of lines) captureOne(line);
  render();
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
  redoStack.length = 0; // a fresh capture invalidates the redo history
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

function undoCapture(): void {
  const entry = undoStack.pop();
  if (!entry) return;
  try {
    repo.deleteTask(entry.taskId);
  } catch {
    /* already gone (deleted or synced away) — restoring the text still helps */
  }
  redoStack.push(entry);
  const input = $<HTMLTextAreaElement>("#capture-input");
  input.value = entry.text;
  render();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  autosizeCapture();
}

function redoCapture(): void {
  const entry = redoStack.pop();
  if (!entry) return;
  submitCapture(entry.text);
  $<HTMLTextAreaElement>("#capture-input").value = "";
  autosizeCapture();
}

function handleUndoKeys(event: KeyboardEvent): void {
  if (!(event.metaKey || event.ctrlKey)) return;
  // Don't hijack undo while the user is editing a task title or a form field
  // other than the capture box — let the browser's native text undo work.
  const active = document.activeElement;
  if (
    ((active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
      active.id !== "capture-input")
  ) {
    return;
  }
  const key = event.key.toLowerCase();
  if (key === "z" && !event.shiftKey) {
    event.preventDefault();
    undoCapture();
  } else if (key === "y" || (key === "z" && event.shiftKey)) {
    event.preventDefault();
    redoCapture();
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
      if (create && name) repo.createBucket(name);
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
    repo.setDone(task.id, !task.done);
    render();
  });

  const body = document.createElement("div");
  body.className = "row-body";
  const title = document.createElement("div");
  title.className = "row-title";
  title.textContent = task.title;
  title.title = "Click to edit";
  title.addEventListener("click", () => beginTitleEdit(title, task));
  body.append(title);

  row.append(check, body);
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
    row.append(tag);
  }
  if (!task.done) {
    // Manual filing = the training signal. Same picker as the tag chip.
    const assign = iconButton("row-assign", "+", "Add to a tag — teaches the app", () => {
      openTagMenu(assign, task);
    });
    row.append(assign);
  }
  row.append(
    iconButton("row-delete", "×", "Delete", () => {
      repo.deleteTask(task.id);
      render();
    }),
  );
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
    const panel = $("#settings");
    panel.hidden = !panel.hidden;
  });

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

// ---- boot ------------------------------------------------------------------

function render(): void {
  closeTagMenu();
  renderPills();
  renderList();
  renderFooter();
  renderSyncUi();
}

async function main(): Promise<void> {
  repo = await Repository.open(new WebStoragePersistence(window.localStorage));
  repo.applyStoreSetup(MY_PILLS, GENERIC_REMAP);
  repo.retagUntagged();
  $("#capture").addEventListener("submit", handleCapture as EventListener);
  $("#capture-input").addEventListener("keydown", handleCaptureKeydown as EventListener);
  $("#capture-input").addEventListener("input", autosizeCapture);
  window.addEventListener("keydown", handleUndoKeys);
  initSyncControls();
  render();
  $<HTMLTextAreaElement>("#capture-input").focus();

  // Offline support when hosted (skipped during local development). Reload
  // once when a new service worker takes control, so updated code lands
  // promptly instead of a launch behind.
  if ("serviceWorker" in navigator && location.hostname !== "localhost") {
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
}

void main();
