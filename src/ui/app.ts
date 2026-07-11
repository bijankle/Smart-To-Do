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

const CLIENT_ID_KEY = "smart-to-do/drive-client-id";
const LAST_SYNC_KEY = "smart-to-do/last-sync";

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector(selector) as T;

// ---- capture ---------------------------------------------------------------

const TAG_PATTERN = /(?:^|\s)#([\w-]+)/;

function handleCapture(event: SubmitEvent): void {
  event.preventDefault();
  const input = $<HTMLInputElement>("#capture-input");
  const raw = input.value.trim();
  if (!raw) return;

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
  input.value = "";
  render();
}

// ---- pill bar --------------------------------------------------------------

function pill(
  label: string,
  count: number,
  options: { active: boolean; auto?: boolean },
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
  button.addEventListener("click", onClick);
  return button;
}

function renderPills(): void {
  const nav = $("#pills");
  nav.replaceChildren();

  nav.append(
    pill("All", repo.listTasks("all").length, { active: filter === "all" }, () => setFilter("all")),
    pill("Inbox", repo.listTasks("inbox").length, { active: filter === "inbox" }, () =>
      setFilter("inbox"),
    ),
  );
  for (const bucket of repo.listBucketDetails()) {
    nav.append(
      pill(
        bucket.name,
        repo.listTasks(bucket.name).length,
        { active: filter === bucket.name, auto: bucket.auto },
        () => setFilter(bucket.name),
      ),
    );
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
  body.append(title);

  const tag = document.createElement("button");
  tag.type = "button";
  tag.className = task.bucket ? "row-tag" : "row-tag row-tag-inbox";
  tag.textContent = task.bucket ?? "inbox";
  tag.title = "Move to another tag (teaches the classifier)";
  tag.addEventListener("click", (e) => {
    e.stopPropagation();
    openTagMenu(tag, task);
  });

  row.append(check, body, tag);
  if (!task.done) {
    row.append(
      iconButton("row-top", "↑", "Move to top", () => {
        repo.moveToTop(task.id);
        render();
      }),
    );
  }
  row.append(
    iconButton("row-delete", "×", "Delete", () => {
      repo.deleteTask(task.id);
      render();
    }),
  );
  return row;
}

function openTagMenu(anchor: HTMLElement, task: TaskRecord): void {
  closeTagMenu();
  const menu = document.createElement("div");
  menu.className = "tag-menu";
  menu.id = "tag-menu";

  const option = (label: string, selected: boolean, onPick: () => void) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = selected ? "tag-menu-item tag-menu-active" : "tag-menu-item";
    item.textContent = label;
    item.addEventListener("click", () => {
      onPick();
      render();
    });
    return item;
  };

  menu.append(option("inbox", task.bucket === null, () => repo.setBucket(task.id, null)));
  for (const bucket of repo.listBuckets()) {
    menu.append(option(bucket, task.bucket === bucket, () => repo.setBucket(task.id, bucket)));
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

function renderList(): void {
  const list = $("#list");
  list.replaceChildren();
  const open = repo.listTasks(filter);
  const completed = showCompleted ? repo.listCompleted(filter) : [];

  if (open.length === 0 && completed.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent =
      filter === "all"
        ? "Nothing here yet — add your first task above."
        : filter === "inbox"
          ? "Inbox zero. New tasks the classifier isn't sure about land here."
          : `No tasks tagged “${filter}” yet.`;
    list.append(empty);
    return;
  }

  for (const task of open) list.append(renderRow(task));

  if (completed.length > 0) {
    const divider = document.createElement("div");
    divider.className = "list-divider";
    divider.textContent = "Completed";
    list.append(divider);
    for (const task of completed) list.append(renderRow(task));
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

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "btn-ghost";
  toggle.textContent = showCompleted
    ? "Hide completed"
    : `Show ${completed.length} completed`;
  toggle.addEventListener("click", () => {
    showCompleted = !showCompleted;
    render();
  });
  footer.append(toggle);

  if (showCompleted) {
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
  $("#capture").addEventListener("submit", handleCapture as EventListener);
  initSyncControls();
  render();
  $<HTMLInputElement>("#capture-input").focus();
}

void main();
