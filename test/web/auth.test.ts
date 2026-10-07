import assert from "node:assert/strict";
import { test } from "node:test";

import { COOKIE_NAME, authorize, cookieValue, hostOk, newToken, originOk, sameToken } from "../../src/web/auth.ts";

const o = { token: "secret-token", port: 4321 };
const cookie = `${COOKIE_NAME}=${o.token}`;
const get = (headers: Record<string, string>, url = "/api/state") => authorize({ method: "GET", url, headers }, o);
const post = (headers: Record<string, string>) => authorize({ method: "POST", url: "/api/tasks", headers }, o);

test("tokens are random and long enough", () => {
  assert.notEqual(newToken(), newToken());
  assert.ok(newToken().length >= 32);
});

test("sameToken compares in full", () => {
  assert.equal(sameToken("abc", "abc"), true);
  assert.equal(sameToken("abd", "abc"), false);
  assert.equal(sameToken("abcd", "abc"), false);
  assert.equal(sameToken(undefined, "abc"), false);
});

test("cookieValue finds a named cookie among several", () => {
  assert.equal(cookieValue(`a=1; ${COOKIE_NAME}=xyz; b=2`, COOKIE_NAME), "xyz");
  assert.equal(cookieValue("a=1", COOKIE_NAME), undefined);
  assert.equal(cookieValue(undefined, COOKIE_NAME), undefined);
});

test("only loopback Host and Origin on the right port pass", () => {
  assert.equal(hostOk("127.0.0.1:4321", 4321), true);
  assert.equal(hostOk("localhost:4321", 4321), true);
  assert.equal(hostOk("evil.example:4321", 4321), false);
  assert.equal(hostOk("127.0.0.1:9", 4321), false);
  assert.equal(hostOk(undefined, 4321), false);
  assert.equal(originOk("http://127.0.0.1:4321", 4321), true);
  assert.equal(originOk("http://localhost:4321", 4321), true);
  assert.equal(originOk("https://evil.example", 4321), false);
  assert.equal(originOk(undefined, 4321), false);
});

test("a wrong Host is forbidden even with the token", () => {
  assert.deepEqual(get({ host: "evil.example:4321", cookie }), { ok: false, status: 403 });
});

test("no cookie or a wrong cookie is unauthorized", () => {
  assert.deepEqual(get({ host: "127.0.0.1:4321" }), { ok: false, status: 401 });
  assert.deepEqual(get({ host: "127.0.0.1:4321", cookie: `${COOKIE_NAME}=nope` }), { ok: false, status: 401 });
});

test("the cookie lets a GET through", () => {
  assert.deepEqual(get({ host: "127.0.0.1:4321", cookie }), { ok: true, setCookie: null, redirectTo: null });
});

test("a valid ?t= sets the cookie and redirects to the bare URL", () => {
  const r = get({ host: "localhost:4321" }, `/?t=${o.token}`);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.redirectTo, "/");
  assert.ok(r.setCookie!.startsWith(`${COOKIE_NAME}=${o.token};`));
  assert.ok(r.setCookie!.includes("HttpOnly"));
  assert.ok(r.setCookie!.includes("SameSite=Strict"));
});

test("?t= keeps the other query parameters", () => {
  const r = get({ host: "localhost:4321" }, `/x?a=1&t=${o.token}&b=2`);
  assert.equal(r.ok && r.redirectTo, "/x?a=1&b=2");
});

test("a wrong ?t= is unauthorized", () => {
  assert.deepEqual(get({ host: "localhost:4321" }, "/?t=wrong"), { ok: false, status: 401 });
});

test("a mutating request needs a matching Origin", () => {
  assert.deepEqual(post({ host: "127.0.0.1:4321", cookie }), { ok: false, status: 403 });
  assert.deepEqual(post({ host: "127.0.0.1:4321", cookie, origin: "https://evil.example" }), { ok: false, status: 403 });
  assert.deepEqual(post({ host: "127.0.0.1:4321", cookie, origin: "http://127.0.0.1:4321" }), { ok: true, setCookie: null, redirectTo: null });
});
