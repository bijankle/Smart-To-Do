/**
 * Phase 2 — Persistence adapters.
 *
 * The repository only ever sees this two-method interface, so swapping
 * localStorage for OPFS, a native file (Capacitor/Tauri), or layering a cloud
 * remote on top in Phase 4 never touches domain logic.
 */

export interface Persistence {
  load(): Promise<string | null>;
  save(data: string): Promise<void>;
}

/** In-memory adapter for tests and ephemeral sessions. */
export class MemoryPersistence implements Persistence {
  private data: string | null = null;

  async load(): Promise<string | null> {
    return this.data;
  }

  async save(data: string): Promise<void> {
    this.data = data;
  }
}

/** Minimal structural type so this file has no DOM lib dependency. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Adapter over any Web Storage–shaped backend (localStorage in the PWA).
 * localStorage is synchronous and ~5MB, which comfortably fits years of tasks;
 * an OPFS adapter can replace it later behind the same interface.
 */
export class WebStoragePersistence implements Persistence {
  constructor(
    private readonly storage: StorageLike,
    private readonly key: string = "smart-to-do/doc",
  ) {}

  async load(): Promise<string | null> {
    return this.storage.getItem(this.key);
  }

  async save(data: string): Promise<void> {
    this.storage.setItem(this.key, data);
  }
}
