export type RecordData = Record<string, unknown>;
export type Result = {
  available: boolean;
  data: unknown;
  message?: string;
  code?: string;
};
export type AuthState = {
  authenticated: boolean;
  role?: 'admin' | 'operator' | 'viewer';
  configured: boolean;
  setup_allowed?: boolean;
  csrf?: string;
  pairing_id?: string;
};
let csrf = "";
export class APIError extends Error {
  constructor(
    message: string,
    public status = 0,
    public code = "NETWORK_ERROR",
  ) {
    super(message);
  }
}
export type Sample = { time: number; down: number | null; up: number | null };
export type LogEntry = { time: number; message: string; source: string };
export type Snapshot = {
  info?: Result;
  wan?: Result;
  stats?: Result;
  rate?: { down: number | null; up: number | null };
  history?: Sample[];
  events?: LogEntry[];
  updated?: number;
};
export type Session = { connected: boolean; name?: string; url?: string };
export type Profile = { name: string; url: string; username: string };

export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), path === '/read/logs' || path === '/changes/confirm' || path.startsWith('/network/') || path.startsWith('/control/') || path.startsWith('/servers/') ? 90000 : path === '/shares/login' ? 45000 : 35000);
  try {
    const response = await fetch(`/api${path}`, {
      method: method || (body === undefined ? "GET" : "POST"),
      credentials: "same-origin",
      headers: {
        ...(body === undefined
          ? {}
          : {
              "Content-Type":
                body instanceof Blob ? body.type : "application/json",
            }),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      body:
        body === undefined
          ? undefined
          : body instanceof Blob
            ? body
            : JSON.stringify(body),
      signal: externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal,
    });
    const data = await response.json().catch(() => {
      throw new APIError(
        `Le serveur a renvoyé une réponse illisible (HTTP ${response.status}). Vérifiez le proxy et les journaux.`,
        response.status,
        "INVALID_RESPONSE",
      );
    });
    if (!response.ok) {
      const detail = typeof data.detail === "object" ? data.detail : {};
      const code = data.code || detail.code || "API_ERROR";
      if (["APP_AUTH_REQUIRED", "LIVEBOX_SESSION_EXPIRED"].includes(code))
        window.dispatchEvent(
          new CustomEvent("orange-session-expired", { detail: code }),
        );
      throw new APIError(
        typeof data.detail === "string"
          ? data.detail
          : detail.message || `La requête a échoué (HTTP ${response.status}).`,
        response.status,
        code,
      );
    }
    if (data.csrf) csrf = data.csrf;
    return data;
  } catch (error) {
    if (externalSignal?.aborted) throw error;
    if (error instanceof APIError) throw error;
    console.warn(
      "Livebox OS API indisponible",
      path.split("/profiles/")[0],
      controller.signal.aborted ? "TIMEOUT" : "NETWORK",
    );
    throw new APIError(
      controller.signal.aborted
        ? "Délai dépassé. Le serveur ne répond pas ; actualisez ou consultez le diagnostic."
        : "Impossible de joindre Livebox OS. Vérifiez que le serveur est démarré, que le port est accessible et que Tailscale est connecté.",
    );
  } finally {
    clearTimeout(timer);
  }
}
export async function loadServerWallpaper(): Promise<Blob | undefined> {
  try {
    const response = await fetch("/api/wallpaper", {
      credentials: "same-origin",
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) return undefined;
    if (!response.ok)
      throw new Error("Le fond d’écran enregistré est indisponible.");
    return await response.blob();
  } catch {
    return undefined;
  }
}
export const rec = (value: unknown): RecordData =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordData)
    : {};
export const text = (value: unknown): string =>
  value === null || value === undefined || value === ""
    ? "Non disponible"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
export function rows(value: unknown): RecordData[] {
  if (Array.isArray(value)) return value.map(rec);
  return Object.entries(rec(value)).map(([key, v]) => ({ id: key, ...rec(v) }));
}
export const rate = (value: number | null | undefined) =>
  value == null
    ? "—"
    : value.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
export const duration = (value: unknown) =>
  typeof value === "number"
    ? `${Math.floor(value / 86400)} j ${Math.floor((value % 86400) / 3600)} h ${Math.floor((value % 3600) / 60)} min`
    : "Non disponible";
export function internetConnected(snapshot: Snapshot) {
  const wan = rec(snapshot.wan?.data);
  return (
    snapshot.wan?.available === true &&
    String(wan.LinkState).toLowerCase() !== "down" &&
    ["bound", "connected"].includes(String(wan.ConnectionState).toLowerCase())
  );
}

export function connectionType(value: unknown): string {
  const name = typeof value === "string" ? value.toLowerCase() : "";
  if (/^(wl|wifi)/.test(name)) return `Wi-Fi · ${value}`;
  if (/^(eth|lan)/.test(name)) return `Ethernet · ${value}`;
  return text(value);
}

export async function wallpaperFile(
  value?: Blob | null,
): Promise<Blob | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("orange-os", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("wallpaper");
    open.onerror = () =>
      reject(new Error("Stockage du fond d’écran indisponible."));
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(
        "wallpaper",
        value === undefined ? "readonly" : "readwrite",
      );
      const store = tx.objectStore("wallpaper");
      const request =
        value === undefined
          ? store.get("custom")
          : value === null
            ? store.delete("custom")
            : store.put(value, "custom");
      tx.oncomplete = () => {
        db.close();
        resolve(value === undefined ? request.result : value || undefined);
      };
      tx.onerror = () => {
        db.close();
        reject(new Error("Impossible d’enregistrer cette image."));
      };
    };
  });
}
