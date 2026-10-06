import assert from "node:assert/strict";
import { test } from "node:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { captureStep, clearRequests, currentOrigin, networkSummary, parseDuration, parseRequestDetails, parseRequestList, requestId } from "../src/network.ts";
import { PlaywrightCLI } from "../src/pw.ts";
import { AbortedError } from "../src/proc.ts";
import type { ProcResult } from "../src/proc.ts";

const LIST = "### Result\n2. [POST] http://localhost:8765/api/login => [201] Created\n\nNote: 1 static request not shown, run with --static option to see it.\n";
const DETAILS = "### Result\n#2 [POST] http://localhost:8765/api/login\n\n  General\n    status:    [201] Created\n    duration:  2ms\n    type:      fetch\n    mimeType:  application/json\n\n  Request headers\n    authorization: Bearer abc123\n    content-type: application/json\n\n  Response headers\n    content-type: application/json\n\nRun `request-body 2` to read the request body.\nRun `response-body 2` to read the response body.\n";
const FAILED = "### Result\n#4 [GET] http://localhost:1/dead\n\n  General\n    status:    [FAILED] net::ERR_UNSAFE_PORT\n    type:      fetch\n\n  Request headers\n    accept: */*\n";

test("request_id", () => {
  assert.equal(requestId(1), "0001");
  assert.equal(requestId(9999), "9999");
  assert.equal(requestId(10000), "10000");
});

test("list_probe_sample", () => {
  const want = [{ n: 2, method: "POST", url: "http://localhost:8765/api/login", status: 201, statusText: "Created" }];
  assert.deepEqual(parseRequestList(LIST), want);
  assert.deepEqual(parseRequestList(LIST.replace("### Result\n", "")), want);
  assert.deepEqual(parseRequestList(LIST.replace(/\n/g, "\r\n")), want);
});

test("list_failed_load", () => {
  assert.deepEqual(parseRequestList("4. [GET] http://localhost:1/dead => [FAILED] net::ERR_UNSAFE_PORT"), [
    { n: 4, method: "GET", url: "http://localhost:1/dead", status: null, statusText: "net::ERR_UNSAFE_PORT" },
  ]);
});

test("list_other_outcomes", () => {
  const r = parseRequestList("5. [GET] http://h/x => [204]\n6. [GET] http://h/y => pending \n");
  assert.equal(r[0].status, 204);
  assert.equal(r[0].statusText, "");
  assert.equal(r[1].status, null);
  assert.equal(r[1].statusText, "pending");
});

test("list_non_contiguous_and_empty", () => {
  const r = parseRequestList("2. [GET] http://h/a => [200] OK\n5. [GET] http://h/b => [200] OK\n");
  assert.deepEqual(r.map((x) => x.n), [2, 5]);
  assert.deepEqual(parseRequestList(""), []);
  assert.deepEqual(parseRequestList("### Result\n"), []);
});

test("duration_values", () => {
  assert.equal(parseDuration("2ms"), 2);
  assert.equal(parseDuration("1.5ms"), 2);
  assert.equal(parseDuration("0.25s"), 250);
  assert.equal(parseDuration("1.2345s"), 1235);
  assert.equal(parseDuration(" 2ms "), 2);
  for (const v of ["-", "2 ms", "1m", ""]) assert.equal(parseDuration(v), null, v);
});

test("details_probe_sample", () => {
  const d = parseRequestDetails(DETAILS, 2);
  assert.deepEqual(d, {
    type: "fetch",
    mimeType: "application/json",
    durationMs: 2,
    requestHeaders: [
      { name: "authorization", value: "Bearer abc123" },
      { name: "content-type", value: "application/json" },
    ],
    responseHeaders: [{ name: "content-type", value: "application/json" }],
    hasRequestBody: true,
    hasResponseBody: true,
  });
  assert.equal("status" in d, false);
});

test("details_failed_load", () => {
  const d = parseRequestDetails(FAILED, 4);
  assert.equal(d.durationMs, null);
  assert.equal(d.mimeType, null);
  assert.equal(d.type, "fetch");
  assert.deepEqual(d.responseHeaders, []);
  assert.equal(d.hasResponseBody, false);
  assert.equal(d.hasRequestBody, false);
});

test("details_hint_only_from_run_lines", () => {
  const a = "  Response headers\n    x-note: run response-body 3 later\n  Run `response-body 4` to read\n";
  assert.equal(parseRequestDetails(a, 3).hasResponseBody, false);
  assert.equal(parseRequestDetails("Run `response-body 3` to read the response body.\n", 3).hasResponseBody, true);
  const b = parseRequestDetails("Run `request-body 3` to read the request body.\n", 3);
  assert.equal(b.hasRequestBody, true);
  assert.equal(b.hasResponseBody, false);
});

test("details_header_line_shapes", () => {
  const s = "  Request headers\n    :authority: example.com\n    x-foo:\n    x-bar:baz\n    nocolon\n";
  assert.deepEqual(parseRequestDetails(s, 1).requestHeaders, [
    { name: ":authority", value: "example.com" },
    { name: "x-foo", value: "" },
    { name: "x-bar", value: "baz" },
  ]);
});

test("details_missing_sections", () => {
  for (const s of ["", "garbage\n"]) {
    assert.deepEqual(parseRequestDetails(s, 1), {
      type: null, mimeType: null, durationMs: null,
      requestHeaders: [], responseHeaders: [], hasRequestBody: false, hasResponseBody: false,
    });
  }
});

test("details_run_line_ends_section", () => {
  const s = "  Response headers\n    a: 1\nRun `response-body 1` to read.\n    x-after: 1\n";
  assert.deepEqual(parseRequestDetails(s, 1).responseHeaders, [{ name: "a", value: "1" }]);
});

// ---- captureStep / clearRequests ----

type Handler = (cmd: string, args: string[]) => ProcResult | Promise<ProcResult>;
const res = (stdout = "", code = 0, stderr = ""): ProcResult => ({ code, stdout, stderr });

class ScriptPW extends PlaywrightCLI {
  calls: string[][] = [];
  dirExisted: boolean[] = [];
  bodies = new Map<number, Buffer>([[2, Buffer.from('{"token":"rt1","ok":true}')]]);
  overrides = new Map<string, Handler>();
  constructor() {
    super();
  }
  override async run(cmd: string, args: string[]): Promise<ProcResult> {
    this.calls.push([cmd, ...args]);
    const key = [cmd, ...args.filter((a) => !a.startsWith("--filename"))].join(" ");
    const h = this.overrides.get(key);
    if (h) return h(cmd, args);
    return this.def(cmd, args);
  }
  def(cmd: string, args: string[]): ProcResult {
    if (cmd === "requests" && args[0] === "--clear") return res();
    if (cmd === "requests") {
      return res("### Result\n2. [POST] http://app.test/api/login?token=qs1 => [201] Created\n4. [GET] http://localhost:1/dead => [FAILED] net::ERR_UNSAFE_PORT\n");
    }
    if (cmd === "request" && args[0] === "2") {
      return res("### Result\n#2 [POST] http://app.test/api/login?token=qs1\n\n  General\n    status:    [500] Boom\n    duration:  2ms\n    type:      fetch\n    mimeType:  application/json\n\n  Request headers\n    authorization: Bearer hdr1\n    content-type: application/json\n\n  Response headers\n    set-cookie: sid=ck1\n    content-type: application/json\n\nRun `request-body 2` to read the request body.\nRun `response-body 2` to read the response body.\n");
    }
    if (cmd === "request") {
      return res("### Result\n#4 [GET] http://localhost:1/dead\n\n  General\n    status:    [FAILED] net::ERR_UNSAFE_PORT\n    type:      fetch\n\n  Request headers\n    accept: */*\n");
    }
    if (cmd === "request-body") return res('### Result\n{"user":"a","password":"pw1"}\n');
    if (cmd === "response-body") {
      const file = args.find((a) => a.startsWith("--filename="))!.slice("--filename=".length);
      this.dirExisted.push(fs.existsSync(path.dirname(file)));
      fs.writeFileSync(file, this.bodies.get(Number(args[0])) ?? Buffer.alloc(0));
      return res("link");
    }
    return res();
  }
}

function setup(): { pw: ScriptPW; workdir: string } {
  return { pw: new ScriptPW(), workdir: fs.mkdtempSync(path.join(os.tmpdir(), "net-")) };
}
const nd = (w: string, id: string) => path.join(w, "network", id);
const rd = (p: string) => fs.readFileSync(p, "utf8");
function allFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

function assertNoRaw(workdir: string): void {
  assert.deepEqual(allFiles(path.join(workdir, "network")).filter((f) => f.endsWith(".raw")), []);
}

test("capture_command_sequence", async () => {
  const { pw, workdir } = setup();
  await captureStep(pw, workdir, 1, 1);
  assert.deepEqual(pw.calls, [
    ["requests"], ["request", "2"], ["request-body", "2"],
    ["response-body", "2", `--filename=${workdir}/network/0001/response-body.raw`],
    ["request", "4"], ["requests", "--clear"],
  ]);
  assertNoRaw(workdir);
});

test("capture_entries_and_ids", async () => {
  const { pw, workdir } = setup();
  const r = await captureStep(pw, workdir, 1, 7);
  assert.equal(r.nextId, 9);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.entries[0], { id: "0007", method: "POST", url: "http://app.test/api/login?token=[REDACTED]", status: 201, statusText: "Created", type: "fetch", durationMs: 2 });
  assert.equal(r.entries[1].id, "0008");
  assert.equal(r.entries[1].status, null);
  assert.equal(r.entries[1].statusText, "net::ERR_UNSAFE_PORT");
  assertNoRaw(workdir);
});

test("capture_folder_files", async () => {
  const { pw, workdir } = setup();
  await captureStep(pw, workdir, 3, 7);
  assert.deepEqual(fs.readdirSync(nd(workdir, "0007")).sort(), ["request-body.txt", "request.json", "response-body.txt", "response.json"]);
  const req = { id: "0007", step: 3, method: "POST", url: "http://app.test/api/login?token=[REDACTED]", headers: [{ name: "authorization", value: "[REDACTED]" }, { name: "content-type", value: "application/json" }] };
  const resp = { status: 201, statusText: "Created", type: "fetch", mimeType: "application/json", durationMs: 2, headers: [{ name: "set-cookie", value: "[REDACTED]" }, { name: "content-type", value: "application/json" }] };
  assert.equal(rd(path.join(nd(workdir, "0007"), "request.json")), JSON.stringify(req, null, 2));
  assert.equal(rd(path.join(nd(workdir, "0007"), "response.json")), JSON.stringify(resp, null, 2));
  assert.equal(rd(path.join(nd(workdir, "0007"), "request-body.txt")), '{"user":"a","password":"[REDACTED]"}');
  assert.equal(rd(path.join(nd(workdir, "0007"), "response-body.txt")), '{"token":"[REDACTED]","ok":true}');
  assert.deepEqual(fs.readdirSync(nd(workdir, "0008")).sort(), ["request.json", "response.json"]);
  assertNoRaw(workdir);
});

test("capture_no_raw_secret_in_any_file", async () => {
  const { pw, workdir } = setup();
  const r = await captureStep(pw, workdir, 1, 1);
  const all = allFiles(path.join(workdir, "network")).map((f) => rd(f)).join("\n") + JSON.stringify(r.entries);
  for (const secret of ["qs1", "hdr1", "ck1", "pw1", "rt1"]) assert.ok(!all.includes(secret), secret);
  assertNoRaw(workdir);
});

test("capture_status_from_list_line", async () => {
  const { pw, workdir } = setup();
  const r = await captureStep(pw, workdir, 1, 1);
  assert.equal(r.entries[0].status, 201);
  const j = JSON.parse(rd(path.join(nd(workdir, "0001"), "response.json")));
  assert.equal(j.status, 201);
  assert.equal(j.statusText, "Created");
  assertNoRaw(workdir);
});

test("capture_binary_response", async () => {
  for (const bytes of [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), Buffer.from([0xff, 0xfe, 0x41])]) {
    const { pw, workdir } = setup();
    pw.bodies.set(2, bytes);
    await captureStep(pw, workdir, 1, 1);
    const d = nd(workdir, "0001");
    assert.deepEqual(fs.readFileSync(path.join(d, "response-body.bin")), bytes);
    assert.ok(!fs.existsSync(path.join(d, "response-body.txt")));
    assert.ok(!fs.existsSync(path.join(d, "response-body.raw")));
    assertNoRaw(workdir);
  }
});

test("capture_empty_bodies_no_files", async () => {
  const { pw, workdir } = setup();
  pw.bodies.set(2, Buffer.alloc(0));
  pw.overrides.set("request-body 2", () => res("### Result\n"));
  const r = await captureStep(pw, workdir, 1, 1);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(fs.readdirSync(nd(workdir, "0001")).sort(), ["request.json", "response.json"]);
  assertNoRaw(workdir);
});

test("capture_folder_exists_before_response_body", async () => {
  const { pw, workdir } = setup();
  await captureStep(pw, workdir, 1, 1);
  assert.deepEqual(pw.dirExisted, [true]);
  assertNoRaw(workdir);
});

test("capture_mkdir_failure_skips_bodies", async () => {
  const { pw, workdir } = setup();
  fs.mkdirSync(path.join(workdir, "network"));
  fs.writeFileSync(nd(workdir, "0001"), "x");
  const r = await captureStep(pw, workdir, 1, 1);
  assert.ok(!pw.calls.some((c) => c[0] === "request-body" || c[0] === "response-body"));
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].startsWith("write 0001: "));
  assert.equal(r.entries.length, 2);
  assertNoRaw(workdir);
});

test("capture_request_json_write_fails", async () => {
  const { pw, workdir } = setup();
  fs.mkdirSync(path.join(nd(workdir, "0001"), "request.json"), { recursive: true });
  const r = await captureStep(pw, workdir, 1, 1);
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].startsWith("write 0001: "));
  assert.equal(r.entries.length, 2);
  for (const f of ["response.json", "request-body.txt", "response-body.txt"]) assert.ok(fs.existsSync(path.join(nd(workdir, "0001"), f)), f);
  assertNoRaw(workdir);
});

test("capture_response_json_write_fails", async () => {
  const { pw, workdir } = setup();
  fs.mkdirSync(path.join(nd(workdir, "0001"), "response.json"), { recursive: true });
  const r = await captureStep(pw, workdir, 1, 1);
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].startsWith("write 0001: "));
  assert.equal(r.entries.length, 2);
  assert.ok(fs.statSync(path.join(nd(workdir, "0001"), "request.json")).isFile());
  assertNoRaw(workdir);
});

test("capture_raw_read_fails", async () => {
  const { pw, workdir } = setup();
  pw.overrides.set("response-body 2", (_c, args) => {
    fs.mkdirSync(args.find((a) => a.startsWith("--filename="))!.slice(11));
    return res();
  });
  const r = await captureStep(pw, workdir, 1, 1);
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].startsWith("write 0001: "));
  assert.equal(r.entries.length, 2);
  const d = nd(workdir, "0001");
  for (const f of ["response-body.txt", "response-body.bin", "response-body.raw"]) assert.ok(!fs.existsSync(path.join(d, f)), f);
  assertNoRaw(workdir);
});

test("capture_raw_rename_fails", async () => {
  const { pw, workdir } = setup();
  pw.bodies.set(2, Buffer.from([0xff, 0xfe, 0x41]));
  fs.mkdirSync(path.join(nd(workdir, "0001"), "response-body.bin", "x"), { recursive: true });
  const r = await captureStep(pw, workdir, 1, 1);
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].startsWith("write 0001: "));
  assert.ok(!fs.existsSync(path.join(nd(workdir, "0001"), "response-body.raw")));
  assert.equal(r.entries.length, 2);
  assertNoRaw(workdir);
});

test("capture_response_body_no_file_written", async () => {
  const { pw, workdir } = setup();
  pw.overrides.set("response-body 2", () => res());
  const r = await captureStep(pw, workdir, 1, 1);
  assert.deepEqual(r.errors, ["response-body 2: no file written"]);
  assert.deepEqual(fs.readdirSync(nd(workdir, "0001")).sort(), ["request-body.txt", "request.json", "response.json"]);
  assertNoRaw(workdir);
});

test("capture_no_raw_left_behind", async () => {
  const { pw, workdir } = setup();
  pw.bodies.set(2, Buffer.from([0xff, 0xfe, 0x41]));
  await captureStep(pw, workdir, 1, 1);
  assertNoRaw(workdir);
});

test("capture_requests_fails", async () => {
  const { pw, workdir } = setup();
  pw.overrides.set("requests", () => res("", 1, " boom \n"));
  const r = await captureStep(pw, workdir, 1, 1);
  assert.deepEqual(r.entries, []);
  assert.deepEqual(r.errors, ["requests: boom"]);
  assert.deepEqual(pw.calls.at(-1), ["requests", "--clear"]);
  assertNoRaw(workdir);
});

test("capture_request_n_fails", async () => {
  const { pw, workdir } = setup();
  pw.overrides.set("request 2", () => res("oops", 1));
  const r = await captureStep(pw, workdir, 1, 1);
  assert.deepEqual(r.errors, ["request 2: oops"]);
  assert.equal(r.entries[0].type, null);
  assert.equal(r.entries[0].durationMs, null);
  const d = nd(workdir, "0001");
  assert.deepEqual(JSON.parse(rd(path.join(d, "request.json"))).headers, []);
  assert.deepEqual(JSON.parse(rd(path.join(d, "response.json"))), { status: 201, statusText: "Created", type: null, mimeType: null, durationMs: null, headers: [] });
  assert.ok(!pw.calls.some((c) => c[0] === "request-body" || c[0] === "response-body"));
  assertNoRaw(workdir);
});

test("capture_body_commands_fail", async () => {
  const { pw, workdir } = setup();
  pw.overrides.set("request-body 2", () => res("", 1, "rb"));
  pw.overrides.set("response-body 2", () => res("", 1, "sb"));
  const r = await captureStep(pw, workdir, 1, 1);
  assert.deepEqual(r.errors, ["request-body 2: rb", "response-body 2: sb"]);
  assert.deepEqual(fs.readdirSync(nd(workdir, "0001")).sort(), ["request.json", "response.json"]);
  assert.equal(r.entries.length, 2);
  assertNoRaw(workdir);
});

test("capture_timeout_and_throw", async () => {
  const { pw, workdir } = setup();
  pw.overrides.set("request 2", () => res("", -1, "timeout"));
  pw.overrides.set("request 4", () => {
    throw new Error("spawn ENOENT");
  });
  const r = await captureStep(pw, workdir, 1, 1);
  assert.deepEqual(r.errors, ["request 2: timeout", "request 4: spawn ENOENT"]);
  assertNoRaw(workdir);
});

test("capture_message_clipped", async () => {
  const { pw, workdir } = setup();
  pw.overrides.set("request 2", () => res("", 1, "x".repeat(400)));
  const r = await captureStep(pw, workdir, 1, 1);
  assert.equal(r.errors[0], `request 2: ${"x".repeat(300)}`);
  assertNoRaw(workdir);
});

test("capture_clear_fails", async () => {
  const { pw, workdir } = setup();
  pw.overrides.set("requests --clear", () => res("", 1, "nope"));
  const r = await captureStep(pw, workdir, 1, 1);
  assert.equal(r.errors.at(-1), "requests --clear: nope");
  assertNoRaw(workdir);
});

test("capture_aborted_propagates", async () => {
  const { pw, workdir } = setup();
  pw.overrides.set("request 2", () => {
    throw new AbortedError();
  });
  await assert.rejects(captureStep(pw, workdir, 1, 1), AbortedError);
  pw.overrides.set("requests --clear", () => {
    throw new AbortedError();
  });
  await assert.rejects(clearRequests(pw), AbortedError);
});

const writeRawSecret = (args: string[]): void => {
  fs.writeFileSync(args.find((a) => a.startsWith("--filename="))!.slice(11), "SECRET-raw-body");
};

test("capture_raw_removed_on_nonzero_exit", async () => {
  const { pw, workdir } = setup();
  pw.overrides.set("response-body 2", (_c, args) => {
    writeRawSecret(args);
    return res("", 1, "boom");
  });
  const r = await captureStep(pw, workdir, 1, 1);
  assert.deepEqual(r.errors, ["response-body 2: boom"]);
  assertNoRaw(workdir);
  for (const f of allFiles(path.join(workdir, "network"))) assert.ok(!rd(f).includes("SECRET"), f);
});

test("capture_raw_removed_on_timeout", async () => {
  const { pw, workdir } = setup();
  pw.overrides.set("response-body 2", (_c, args) => {
    writeRawSecret(args);
    return res("", -1, "timeout");
  });
  await captureStep(pw, workdir, 1, 1);
  assertNoRaw(workdir);
});

test("capture_raw_removed_on_throw", async () => {
  const { pw, workdir } = setup();
  pw.overrides.set("response-body 2", (_c, args) => {
    writeRawSecret(args);
    throw new Error("spawn died");
  });
  const r = await captureStep(pw, workdir, 1, 1);
  assert.deepEqual(r.errors, ["response-body 2: spawn died"]);
  assertNoRaw(workdir);
});

test("capture_raw_removed_on_abort", async () => {
  const { pw, workdir } = setup();
  pw.overrides.set("response-body 2", (_c, args) => {
    writeRawSecret(args);
    throw new AbortedError();
  });
  await assert.rejects(captureStep(pw, workdir, 1, 1), AbortedError);
  assertNoRaw(workdir);
});

test("clear_requests_result", async () => {
  const { pw } = setup();
  assert.equal(await clearRequests(pw), null);
  pw.overrides.set("requests --clear", () => res("", 1, "x"));
  assert.equal(await clearRequests(pw), "requests --clear: x");
});

const TABS = "### Result\n- 0: (current) [App](http://localhost:8766/)\n- 1: [Other](https://cdn.other.com/)";
const e = (method: string, url: string, status: number | null, statusText: string) =>
  ({ id: "0001", method, url, status, statusText, type: null, durationMs: null });

test("summary_same_and_cross_origin", () => {
  const out = networkSummary([
    e("POST", "http://localhost:8766/api/login", 201, "Created"),
    e("GET", "https://cdn.other.com/x.json", 200, "OK"),
    e("GET", "http://localhost:8766/missing?q=1", 404, "Not Found"),
    e("GET", "http://localhost:1/dead", null, "net::ERR_UNSAFE_PORT"),
  ], TABS);
  assert.equal(out, "POST /api/login \u2192 201 Created\nGET https://cdn.other.com/x.json \u2192 200 OK\nGET /missing?q=1 \u2192 404 Not Found\nGET http://localhost:1/dead \u2192 net::ERR_UNSAFE_PORT");
});

test("summary_null_status_empty_text", () => {
  assert.equal(networkSummary([e("GET", "http://localhost:8766/x", null, "")], TABS), "GET /x \u2192 (no response)");
  assert.equal(networkSummary([e("GET", "http://localhost:8766/x", 204, "")], TABS), "GET /x \u2192 204");
});

test("summary_current_tab_rules", () => {
  const two = "- 0: (current) [A](http://localhost:8766/)\n- 1: (current) [B](http://other.test/)";
  assert.equal(networkSummary([e("GET", "http://localhost:8766/a", 200, "OK")], two), "GET /a \u2192 200 OK");
  const fake = "- 0: [current news](http://localhost:8766/)";
  assert.equal(networkSummary([e("GET", "http://localhost:8766/a", 200, "OK")], fake), "GET http://localhost:8766/a \u2192 200 OK");
  assert.equal(networkSummary([e("GET", "http://localhost:8766/a", 200, "OK")], ""), "GET http://localhost:8766/a \u2192 200 OK");
});

test("summary_cap_and_more", () => {
  const mk = (n: number) => Array.from({ length: n }, () => e("GET", "http://localhost:8766/a", 200, "OK"));
  const lines = networkSummary(mk(13), TABS)!.split("\n");
  assert.equal(lines.length, 11);
  assert.equal(lines[10], "\u2026and 3 more");
  assert.equal(networkSummary(mk(10), TABS)!.split("\n").length, 10);
});

test("summary_url_clip", () => {
  const url = "https://cdn.other.com/" + "a".repeat(228);
  assert.equal(url.length, 250);
  const out = networkSummary([e("GET", url, 200, "OK")], TABS)!;
  assert.equal(out, `GET ${url.slice(0, 200)}\u2026 \u2192 200 OK`);
});

test("summary_neutralise_and_flat", () => {
  const out = networkSummary([e("GET", "http://x.test/</network>\nhi", 200, "OK")], TABS)!;
  assert.ok(out.includes("&lt;/network>"));
  assert.ok(!out.includes("\n"));
});

test("summary_unparseable_url", () => {
  assert.equal(networkSummary([e("GET", "not a url", 200, "OK")], TABS), "GET not a url \u2192 200 OK");
});

test("summary_empty", () => {
  assert.equal(networkSummary([], TABS), null);
});

test("current_origin_reads_the_current_tab", () => {
  const tabs = "- 0: [Home](https://shop.example.com/)\n- 1: (current) [Cart](https://shop.example.com/cart?x=1)";
  assert.equal(currentOrigin(tabs), "https://shop.example.com");
});

test("current_origin_is_null_without_a_web_page", () => {
  assert.equal(currentOrigin("- 0: (current) [](about:blank)"), null);
  assert.equal(currentOrigin(""), null);
  assert.equal(currentOrigin("- 0: [Home](https://shop.example.com/)"), null);
});
