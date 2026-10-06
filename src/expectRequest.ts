const USAGE = "error: usage: expect-request <METHOD> <path-or-url> <status> [<field> <expected>]";
const q = (s: string) => JSON.stringify(s);

function parseUrl(s: string): URL | null {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** Static check of an expect-request action's args; an error string, or null if well formed. */
export function checkRequestArgs(args: string[]): string | null {
  if (args.length !== 3 && args.length !== 5) return USAGE;
  const [, target, status, field] = args;
  if (!/^[1-5]\d\d$/.test(status)) {
    return `error: expect-request status must be a three-digit code, got ${q(status)}`;
  }
  if (target.includes("?") || target.includes("#")) {
    return "error: expect-request url must not include a query or fragment";
  }
  if (!target.startsWith("/") && parseUrl(target) === null) {
    return "error: expect-request url must be a path starting with / or an http(s) URL";
  }
  if (field !== undefined && field.split(".").some((seg) => seg === "")) {
    return "error: expect-request field must be dot-separated keys, e.g. data.items.0.id";
  }
  return null;
}

function accessor(seg: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(seg)) return `?.${seg}`;
  if (/^\d+$/.test(seg)) return `?.[${seg}]`;
  return `?.[${q(seg)}]`;
}

/**
 * Playwright code for a verified expect-request: `arm` must run before the request is made,
 * `check` after. Expects checkRequestArgs(args) to be null.
 */
export function renderRequestExpect(args: string[], n: number): { arm: string; check: string[] } {
  const [method, target, status, field, expected] = args;
  const url = parseUrl(target);
  const urlTest = url === null
    ? `new URL(r.url()).pathname === ${q(target)}`
    : `(u => u.origin + u.pathname)(new URL(r.url())) === ${q(url.origin + url.pathname)}`;
  const res = `apiResponse${n}`;
  const check = [`expect((await ${res}).status()).toBe(${status});`];
  if (field !== undefined) {
    const body = `apiBody${n}`;
    check.push(
      `const ${body} = await (await ${res}).json();`,
      `expect(String(${body}${field.split(".").map(accessor).join("")})).toBe(${q(expected)});`,
    );
  }
  return {
    arm: `const ${res} = page.waitForResponse((r) => r.request().method() === ${q(method.toUpperCase())} && ${urlTest});`,
    check,
  };
}
