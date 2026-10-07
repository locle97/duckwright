// Thin fetch wrappers for the HTTP API. Every call resolves to a Reply and never throws, so the
// UI can show a failure as a toast.
export type Reply = { ok: true; [k: string]: unknown } | { ok: false; error: string; [k: string]: unknown };

async function call(method: string, path: string, body?: unknown): Promise<Reply> {
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) return { ok: false, error: "unauthorized", unauthorized: true };
    const json = (await res.json()) as Reply;
    return json && typeof json === "object" && "ok" in json ? json : { ok: false, error: `unexpected reply (${res.status})` };
  } catch {
    return { ok: false, error: "the server is not reachable" };
  }
}

export const api = {
  get: (path: string) => call("GET", path),
  post: (path: string, body?: unknown) => call("POST", path, body ?? {}),
  put: (path: string, body: unknown) => call("PUT", path, body),
  del: (path: string) => call("DELETE", path),
};
