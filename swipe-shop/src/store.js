/**
 * Persistence — the profile lives entirely in this browser (localStorage).
 * Nothing ever leaves the device; there is no account and no server.
 */

import { createProfile } from "./profile.js";

const KEY = "swipe-shop:profile:v1";

/** @returns {import("./profile.js").Profile} */
export function loadProfile(storage = localStorage) {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return createProfile();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.swipes) || typeof parsed.stats !== "object" || parsed.stats === null) {
      return createProfile();
    }
    return { swipes: parsed.swipes, stats: parsed.stats };
  } catch {
    return createProfile();
  }
}

export function saveProfile(profile, storage = localStorage) {
  try {
    storage.setItem(KEY, JSON.stringify(profile));
  } catch {
    // Storage full or blocked (private mode) — the session still works in memory.
  }
}

export function clearProfile(storage = localStorage) {
  try {
    storage.removeItem(KEY);
  } catch {
    // Same as above: non-fatal.
  }
}
