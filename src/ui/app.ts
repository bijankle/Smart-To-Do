/**
 * Phase 3 — Blurprint UI shell.
 *
 * Vanilla DOM, no framework: state lives in the Repository, and every
 * mutation triggers a full re-render of the pill bar + list (cheap at this
 * scale). All user text goes through textContent, never innerHTML.
 *
 * Interactions:
 *  - Capture box adds to the top; a #tag anywhere files AND trains the bucket
 *    (creating it if new). Without a tag the classifier suggests one, or the
 *    task stays in the Inbox.
 *  - Pill bar filters: All / Inbox / one pill per bucket / "+" to add one.
 *  - Row actions: check off, re-tag (the correction that trains the model),
 *    move to top (importance without priority tags), delete.
 */

import { Repository, type TaskFilter } from "../storage/repo.js";
import { WebStoragePersistence } from "../storage/persistence.js";
import type { TaskRecord } from "../storage/doc.js";

let repo: Repository;
let filter: TaskFilter = "all";

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

function pill(label: string, count: number, active: boolean, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = active ? "pill pill-active" : "pill";
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

  const open = (t: TaskRecord) => !t.done;
  nav.append(
    pill("All", repo.listTasks("all").filter(open).length, filter === "all", () => setFilter("all")),
    pill("Inbox", repo.listTasks("inbox").filter(open).length, filter === "inbox", () => setFilter("inbox")),
  );
  for (const bucket of repo.listBuckets()) {
    nav.append(
      pill(bucket, repo.listTasks(bucket).filter(open).length, filter === bucket, () => setFilter(bucket)),
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
    const commit = () => {
      const name = input.value.trim();
      if (name) repo.createBucket(name);
      render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") render();
    });
    input.addEventListener("blur", commit);
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

  row.append(
    check,
    body,
    tag,
    iconButton("row-top", "↑", "Move to top", () => {
      repo.moveToTop(task.id);
      render();
    }),
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
  const tasks = repo.listTasks(filter);

  if (tasks.length === 0) {
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
  for (const task of tasks) list.append(renderRow(task));
}

function renderFooter(): void {
  const footer = $("#footer");
  footer.replaceChildren();
  const done = repo.listTasks(filter).filter((t) => t.done);
  if (done.length === 0) return;
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "btn-ghost";
  clear.textContent = `Clear ${done.length} completed`;
  clear.addEventListener("click", () => {
    for (const task of done) repo.deleteTask(task.id);
    render();
  });
  footer.append(clear);
}

// ---- boot ------------------------------------------------------------------

function render(): void {
  closeTagMenu();
  renderPills();
  renderList();
  renderFooter();
}

async function main(): Promise<void> {
  repo = await Repository.open(new WebStoragePersistence(window.localStorage));
  $("#capture").addEventListener("submit", handleCapture as EventListener);
  render();
  $<HTMLInputElement>("#capture-input").focus();
}

void main();
