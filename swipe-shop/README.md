# Swipe Shop 🛍

A Tinder-style shopping **taste trainer**. You swipe through products drawn
from the places people actually shop — Amazon, Instagram ads, Etsy, eBay,
Walmart, ASOS — and every swipe teaches a local algorithm what you feel the
need to buy, what your style is, and what leaves you cold. The app never
sells you anything: when you're ready to buy, each card and every item on
your shortlist deep-links straight to the product on its home platform.

> **This is a completely standalone app.** It lives in this folder only,
> shares no code, styles, or storage with anything else in the repository,
> and has zero dependencies and zero build step.

## Run it

```bash
cd swipe-shop
npm start          # → http://localhost:4180
```

(Any static file server works too — it's just HTML + ES modules.)

## How to use it

| Gesture | Meaning |
| --- | --- |
| Drag right / `→` / ♥ | **Like** — more of this, please |
| Drag left / `←` / ✕ | **Nope** — not my thing |
| Drag up / `↑` / ★ | **Need it** — a super-like, counts double |
| `U` / ↶ | Undo the last swipe |
| `O` / ↗ | Open the current product on its store's site |

The **Discover** feed visibly reorders as you swipe: the algorithm leads
with what it predicts you'll like, but every 4th card is deliberately an
*exploration pick* — the product it knows least about — so your profile
keeps broadening instead of tunnelling into the first thing you liked.

The **My profile** tab shows what the algorithm has learned: your styles
and vibes, categories, brands, price comfort zone, where you like to shop,
what it's learned to avoid — and your **shortlist** of everything you liked
or starred, each with a "Shop on …" link out to the platform itself.

## How the taste engine works

- Every product carries a feature vector: `category`, `brand`, `platform`,
  `price band`, and 3–4 style tags (`cozy`, `retro`, `techy`, …) shared
  across the catalog.
- A swipe is evidence for (like ×1, need-it ×2) or against (nope) each of
  those features. Affinity per feature is Laplace-smoothed —
  `(likes − nopes) / (likes + nopes + 2)` — so one swipe never becomes a
  fanatical conviction.
- A product's predicted appeal is the mean affinity of its features, which
  is what makes the model *generalise*: liking two cozy-minimalist things
  raises every other cozy-minimalist thing, even in categories you haven't
  seen yet.
- Deck order = mostly exploit (best predicted appeal first) + scheduled
  explore (every 4th slot goes to the most-novel product).

## Privacy

Your profile lives in `localStorage` in your browser. No account, no
server, no tracking. The only network activity is the outbound link when
*you* choose to open a product on its shopping site. "Erase my profile"
on the profile tab wipes everything.

## Tests

```bash
cd swipe-shop
npm test
```

Covers the catalog's integrity, the learning math (generalisation,
smoothing, love-counts-double, undo exactness), summary/shortlist logic,
and deck ordering (exploit ranking, exploration slots, determinism, no
repeats).

## Honest limitations

The product feed is a curated offline catalog that *stands in* for live
platform inventory — Amazon and Instagram don't offer public browse APIs,
so shipping a real feed would need a backend with affiliate/API access.
The taste engine, profile, and swipe UX are the real thing and would work
unchanged on top of a live feed.
