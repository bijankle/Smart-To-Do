/**
 * Phase 4 — Google Drive sync adapter.
 *
 * The whole store (tasks + buckets + classifier model) is one JSON document
 * with per-record last-write-wins merging, so sync is deliberately simple:
 *
 *   download remote copy → merge into local → upload merged result
 *
 * The file lives in Drive's hidden per-app `appDataFolder`, which is free,
 * invisible in the user's Drive UI, and scoped so this app can see ONLY its
 * own file (scope: drive.appdata) — not the rest of their Drive.
 *
 * Auth uses Google Identity Services (the script Google requires for OAuth
 * in browsers; the categorization engine remains fully local). The user
 * supplies their own OAuth Client ID once — see README for the setup steps.
 */

import { deserializeDoc } from "../storage/doc.js";
import type { Repository } from "../storage/repo.js";

const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const FILE_NAME = "smart-to-do.json";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

/* Minimal typings for the Google Identity Services token client. */
interface TokenResponse {
  access_token?: string;
  error?: string;
}
interface TokenClient {
  requestAccessToken(options?: { prompt?: string }): void;
}
interface GoogleGlobal {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (response: TokenResponse) => void;
        error_callback?: (error: unknown) => void;
      }): TokenClient;
    };
  };
}

let gisLoading: Promise<void> | null = null;

function loadGis(): Promise<void> {
  if ((window as { google?: GoogleGlobal }).google?.accounts?.oauth2) {
    return Promise.resolve();
  }
  if (!gisLoading) {
    gisLoading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        gisLoading = null;
        reject(new Error("Couldn't load Google sign-in (are you offline?)"));
      };
      document.head.append(script);
    });
  }
  return gisLoading;
}

export class DriveSync {
  private accessToken: string | null = null;

  constructor(private readonly clientId: string) {}

  get connected(): boolean {
    return this.accessToken !== null;
  }

  /**
   * Acquire an access token. interactive=false attempts a silent grant
   * (works when the user has authorized before and is signed in to Google);
   * interactive=true may open Google's consent popup.
   */
  async connect(interactive: boolean): Promise<boolean> {
    await loadGis();
    const google = (window as unknown as { google: GoogleGlobal }).google;
    return new Promise((resolve) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: SCOPE,
        callback: (response) => {
          if (response.access_token) {
            this.accessToken = response.access_token;
            resolve(true);
          } else {
            resolve(false);
          }
        },
        error_callback: () => resolve(false),
      });
      client.requestAccessToken({ prompt: interactive ? "" : "none" });
    });
  }

  /** Pull the remote doc (if any), merge it into the repo, push the result. */
  async sync(repo: Repository): Promise<"first-upload" | "synced"> {
    if (!this.accessToken) throw new Error("Not connected to Google Drive");

    const fileId = await this.findFileId();
    if (fileId) {
      const response = await this.request(`${API}/files/${fileId}?alt=media`);
      const text = await response.text();
      if (text.trim()) repo.mergeRemote(deserializeDoc(text));
    }
    await repo.flush();
    const body = repo.exportDoc();

    if (fileId) {
      await this.request(`${UPLOAD}/files/${fileId}?uploadType=media`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return "synced";
    }

    const boundary = "smart-to-do-multipart-boundary";
    const metadata = JSON.stringify({ name: FILE_NAME, parents: ["appDataFolder"] });
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    await this.request(`${UPLOAD}/files?uploadType=multipart`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: multipart,
    });
    return "first-upload";
  }

  private async findFileId(): Promise<string | null> {
    const query = encodeURIComponent(`name='${FILE_NAME}'`);
    const response = await this.request(
      `${API}/files?spaces=appDataFolder&q=${query}&fields=files(id,name)`,
    );
    const data = (await response.json()) as { files?: Array<{ id: string }> };
    return data.files?.[0]?.id ?? null;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${this.accessToken}` },
    });
    if (response.status === 401) {
      this.accessToken = null; // token expired — the UI will reconnect
      throw new Error("Google Drive session expired — press Sync to reconnect.");
    }
    if (!response.ok) {
      throw new Error(`Google Drive error ${response.status}`);
    }
    return response;
  }
}
