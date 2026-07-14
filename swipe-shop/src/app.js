/**
 * Swipe Shop UI — the deck, the gestures, and the profile page.
 * All state is local; the only network activity is the outbound link when
 * the user chooses to open a product on its home shopping site.
 */

import {
  CATALOG,
  CATEGORY_LABELS,
  PLATFORM_LABELS,
  PRICE_BAND_LABELS,
  priceBand,
  productUrl,
} from "./catalog.js";
import {
  createProfile,
  recordSwipe,
  undoLastSwipe,
  tasteSummary,
  profileStrength,
  shortlist,
} from "./profile.js";
import { buildDeck } from "./deck.js";
import { loadProfile, saveProfile, clearProfile } from "./store.js";

const $ = (sel) => document.querySelector(sel);
const BY_ID = new Map(CATALOG.map((p) => [p.id, p]));
const SWIPE_X = 100; // px of drag that commits a like/nope
const SWIPE_Y = 110; // px of upward drag that commits a love

let profile = loadProfile();
let deck = buildDeck(CATALOG, profile);
let busy = false; // true while a card is flying out

// ---------------------------------------------------------------- rendering

function heroGradient(p) {
  return `linear-gradient(160deg, hsl(${p.hue} 85% 88%), hsl(${(p.hue + 45) % 360} 80% 76%))`;
}

function cardEl(product, depth) {
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.depth = String(depth);
  card.dataset.id = product.id;
  if (depth === 0) card.classList.add("is-top");

  const tags = product.tags.map((t) => `<span class="chip">${t}</span>`).join("");
  card.innerHTML = `
    <div class="card-hero" style="background:${heroGradient(product)}">
      <span>${product.emoji}</span>
      <span class="card-platform">${PLATFORM_LABELS[product.platform]}</span>
      <span class="card-price">$${product.price}</span>
      <span class="card-stamp stamp-like">LIKE</span>
      <span class="card-stamp stamp-nope">NOPE</span>
      <span class="card-stamp stamp-love">NEED IT</span>
    </div>
    <div class="card-body">
      <div class="card-title-row">
        <h2 class="card-title">${product.title}</h2>
        <span class="card-brand">${product.brand}</span>
      </div>
      <p class="card-blurb">${product.blurb}</p>
      <div class="card-tags">
        <span class="chip chip-cat">${CATEGORY_LABELS[product.category]}</span>
        <span class="chip chip-cat">${PRICE_BAND_LABELS[priceBand(product.price)]}</span>
        ${tags}
      </div>
    </div>`;
  return card;
}

function renderStack() {
  const stack = $("#stack");
  stack.textContent = "";
  const visible = deck.slice(0, 3);
  // Deepest first so the top card is last in DOM (highest paint order).
  for (let i = visible.length - 1; i >= 0; i--) {
    stack.appendChild(cardEl(visible[i], i));
  }
  const empty = deck.length === 0;
  $("#deck-empty").hidden = !empty;
  $("#actions").hidden = empty;
  if (!empty) attachDrag(stack.lastElementChild);
  renderChrome();
}

function renderChrome() {
  const { label, pct } = profileStrength(profile);
  $("#strength-label").textContent = label;
  $("#strength-fill").style.width = `${pct}%`;

  const picks = shortlist(profile, BY_ID);
  const badge = $("#shortlist-count");
  badge.hidden = picks.length === 0;
  badge.textContent = String(picks.length);

  $("#deck-progress").textContent = deck.length
    ? `${deck.length} of ${CATALOG.length} products left in the deck`
    : "";

  $("#act-undo").disabled = profile.swipes.length === 0;
  const top = deck[0];
  const open = $("#act-open");
  if (top) open.href = productUrl(top);
}

// ------------------------------------------------------------------- swiping

function commitSwipe(verdict) {
  const product = deck[0];
  if (!product || busy) return;
  busy = true;

  recordSwipe(profile, product, verdict);
  saveProfile(profile);

  const top = $("#stack .is-top");
  if (top) {
    const fly =
      verdict === "nope" ? "translate(-130%, -6%) rotate(-24deg)"
      : verdict === "love" ? "translate(0, -140%) rotate(4deg)"
      : "translate(130%, -6%) rotate(24deg)";
    top.classList.add("is-flying");
    top.style.transform = fly;
    // Promote the cards underneath immediately so the stack feels alive.
    for (const card of document.querySelectorAll("#stack .card:not(.is-flying)")) {
      const depth = Number(card.dataset.depth) - 1;
      card.dataset.depth = String(Math.max(0, depth));
      card.classList.add("is-restacking");
    }
  }

  setTimeout(() => {
    busy = false;
    deck = buildDeck(CATALOG, profile);
    renderStack();
    const n = profile.swipes.length;
    if (n > 0 && n % 10 === 0) toast(`Profile sharpened — the feed just reordered around your taste (${n} swipes)`);
  }, 300);
}

function undo() {
  if (busy) return;
  const undone = undoLastSwipe(profile, BY_ID);
  if (!undone) return;
  saveProfile(profile);
  deck = buildDeck(CATALOG, profile);
  // Put the undone product back on top so the user sees what they got back.
  const i = deck.findIndex((p) => p.id === undone.productId);
  if (i > 0) deck.unshift(deck.splice(i, 1)[0]);
  renderStack();
}

function attachDrag(card) {
  if (!card) return;
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false, pointerId = null;

  const stamps = {
    like: card.querySelector(".stamp-like"),
    nope: card.querySelector(".stamp-nope"),
    love: card.querySelector(".stamp-love"),
  };

  card.addEventListener("pointerdown", (e) => {
    if (busy || e.button !== 0) return;
    dragging = true;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    card.setPointerCapture(pointerId);
    card.classList.remove("is-settling");
  });

  card.addEventListener("pointermove", (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx * 0.07}deg)`;
    const up = Math.max(0, -dy);
    const loveIntent = up > Math.abs(dx) * 1.2;
    stamps.like.style.opacity = loveIntent ? 0 : Math.min(1, Math.max(0, dx) / SWIPE_X);
    stamps.nope.style.opacity = loveIntent ? 0 : Math.min(1, Math.max(0, -dx) / SWIPE_X);
    stamps.love.style.opacity = loveIntent ? Math.min(1, up / SWIPE_Y) : 0;
  });

  const release = (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    const up = -dy;
    const loveIntent = up > Math.abs(dx) * 1.2 && up > SWIPE_Y;
    if (loveIntent) return commitSwipe("love");
    if (dx > SWIPE_X) return commitSwipe("like");
    if (dx < -SWIPE_X) return commitSwipe("nope");
    // Not far enough — spring back.
    card.classList.add("is-settling");
    card.style.transform = "";
    for (const s of Object.values(stamps)) s.style.opacity = 0;
    dx = dy = 0;
  };
  card.addEventListener("pointerup", release);
  card.addEventListener("pointercancel", release);
}

// ------------------------------------------------------------------- profile

function traitLabel(kind, value) {
  if (kind === "cat") return CATEGORY_LABELS[value] ?? value;
  if (kind === "platform") return PLATFORM_LABELS[value] ?? value;
  if (kind === "price") return PRICE_BAND_LABELS[value] ?? value;
  return value;
}

const TRAIT_GROUPS = [
  ["tag", "Styles & vibes"],
  ["cat", "Categories"],
  ["brand", "Brands"],
  ["price", "Price comfort zone"],
  ["platform", "Where you like to shop"],
];

function traitRows(entries, kind, avoid = false) {
  return entries
    .map(({ value, affinity }) => {
      const pct = Math.round(Math.abs(affinity) * 100);
      return `<div class="trait">
        <span class="trait-name">${traitLabel(kind, value)}</span>
        <span class="trait-bar"><span class="trait-fill${avoid ? " is-avoid" : ""}" style="width:${pct}%"></span></span>
        <span class="trait-pct">${pct}%</span>
      </div>`;
    })
    .join("");
}

function renderProfile() {
  const body = $("#profile-body");
  const summary = tasteSummary(profile);
  const { totals } = summary;
  const picks = shortlist(profile, BY_ID);

  const statsPanel = `<div class="panel">
    <h2>Your shopping profile</h2>
    <p class="panel-sub">Built entirely from your swipes, stored only on this device.
       The more you swipe, the sharper the Discover feed gets.</p>
    <div class="stat-row">
      <div class="stat"><b>${totals.all}</b><span>swipes</span></div>
      <div class="stat"><b>${totals.like}</b><span>liked</span></div>
      <div class="stat"><b>${totals.love}</b><span>need it</span></div>
      <div class="stat"><b>${totals.nope}</b><span>passed</span></div>
    </div>
  </div>`;

  const groups = TRAIT_GROUPS.map(([kind, title]) => {
    const entries = summary.traits[kind];
    if (!entries || entries.length === 0) return "";
    return `<div class="trait-group"><div class="trait-kind">${title}</div>${traitRows(entries, kind)}</div>`;
  }).join("");

  const tastePanel = `<div class="panel">
    <h2>What the algorithm has learned</h2>
    <p class="panel-sub">Confidence per trait — how strongly your swipes point at it.</p>
    ${groups || `<p class="profile-empty">Nothing yet — swipe a few cards and this fills in.</p>`}
  </div>`;

  const avoidPanel = summary.avoid.length
    ? `<div class="panel">
        <h2>Not your thing</h2>
        <p class="panel-sub">The feed pushes these down.</p>
        <div class="avoid-chips">${summary.avoid
          .map((a) => `<span class="chip">${traitLabel(a.kind, a.value)}</span>`)
          .join("")}</div>
      </div>`
    : "";

  const pickRows = picks
    .map(({ product, verdict }) => {
      return `<div class="pick">
        <span class="pick-emoji" style="background:${heroGradient(product)}">${product.emoji}</span>
        <div class="pick-info">
          <p class="pick-title">${verdict === "love" ? `<span class="pick-love">★</span> ` : ""}${product.title}</p>
          <p class="pick-meta">${product.brand} · $${product.price} · ${PLATFORM_LABELS[product.platform]}</p>
        </div>
        <a class="pick-link" href="${productUrl(product)}" target="_blank" rel="noopener noreferrer">
          Shop on ${PLATFORM_LABELS[product.platform].split(" ")[0]} ↗</a>
      </div>`;
    })
    .join("");

  const shortlistPanel = `<div class="panel">
    <h2>Your shortlist</h2>
    <p class="panel-sub">Everything you liked or starred. Buying happens on the store’s own site — this app never checks out.</p>
    ${pickRows || `<p class="profile-empty">Swipe right on something you’d actually buy and it lands here.</p>`}
  </div>`;

  const resetPanel = `<div class="panel">
    <h2>Start over</h2>
    <p class="panel-sub">Wipes every swipe and everything the algorithm has learned. There’s no undo.</p>
    <button type="button" class="btn btn-danger" id="reset-btn">Erase my profile</button>
  </div>`;

  body.innerHTML = statsPanel + tastePanel + avoidPanel + shortlistPanel + resetPanel;
  $("#reset-btn").addEventListener("click", resetProfile);
}

function resetProfile() {
  if (!confirm("Erase your entire shopping profile? This can’t be undone.")) return;
  profile = createProfile();
  clearProfile();
  deck = buildDeck(CATALOG, profile);
  renderStack();
  renderProfile();
  showTab("deck");
  toast("Fresh start — the algorithm knows nothing again");
}

// ---------------------------------------------------------------- tabs & app

function showTab(which) {
  const deckActive = which === "deck";
  $("#view-deck").hidden = !deckActive;
  $("#view-profile").hidden = deckActive;
  $("#tab-deck").classList.toggle("is-active", deckActive);
  $("#tab-profile").classList.toggle("is-active", !deckActive);
  $("#tab-deck").setAttribute("aria-selected", String(deckActive));
  $("#tab-profile").setAttribute("aria-selected", String(!deckActive));
  if (!deckActive) renderProfile();
}

let toastTimer = 0;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function init() {
  renderStack();

  $("#tab-deck").addEventListener("click", () => showTab("deck"));
  $("#tab-profile").addEventListener("click", () => showTab("profile"));
  $("#empty-to-profile").addEventListener("click", () => showTab("profile"));
  $("#empty-reset").addEventListener("click", resetProfile);

  $("#act-nope").addEventListener("click", () => commitSwipe("nope"));
  $("#act-like").addEventListener("click", () => commitSwipe("like"));
  $("#act-love").addEventListener("click", () => commitSwipe("love"));
  $("#act-undo").addEventListener("click", undo);

  document.addEventListener("keydown", (e) => {
    if ($("#view-deck").hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowLeft") commitSwipe("nope");
    else if (e.key === "ArrowRight") commitSwipe("like");
    else if (e.key === "ArrowUp") { e.preventDefault(); commitSwipe("love"); }
    else if (e.key === "u" || e.key === "U") undo();
    else if ((e.key === "o" || e.key === "O") && deck[0]) {
      window.open(productUrl(deck[0]), "_blank", "noopener");
    }
  });
}

init();
