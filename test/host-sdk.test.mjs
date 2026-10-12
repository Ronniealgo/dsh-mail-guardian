import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
test("真实SDK工具定义、命令及认证缓存路由可完整注册，读报告不触发授权或联网", async (t) => {
    let apply;
    try { ({apply}=await import("../lib/index.js")); } catch(e) { if(process.env.DSH_MAIL_GUARDIAN_REQUIRE_SDK === "1") throw e; t.skip("Official SDK peers not installed; require-sdk release validation runs separately"); return; }
  const tools = [],
    commands = [],
    routes = [],
    disposers = [];
  let credentials = 0;
  const ctx = {
    credentials: {
      resolve: async () => {
        credentials++;
        throw new Error("report must not read credentials");
      },
    },
    tools: {
      register: (t) => {
        tools.push(t);
        return () => {};
      },
    },
    commands: {
      register: (c) => {
        assert.ok(c.input === undefined || typeof c.input.hint === "string");
        commands.push(c);
        return () => {};
      },
    },
    connection: {
      fetch: {
        register: (r) => {
          routes.push(r);
          return () => {};
        },
      },
    },
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
    },
    inject: (_deps, fn) => fn(ctx),
  };
  apply(ctx, { accounts: [], stateDir: mkdtempSync(path.join(os.tmpdir(), "mail-guardian-sdk-")) });
  assert.equal(tools.length, 12);
  assert.equal(commands.length, 2);
  assert.equal(routes.length, 1);
  const def = tools.find((t) => t.name === "mail_report");
  const start = performance.now();
  const r = await def.execute({}, {});
  assert.equal(r.version, 2);
  assert.equal(credentials, 0);
  assert.ok(performance.now() - start < 200);
  const response = await routes[0].fetch(
    new Request("http://localhost/api/dsh-mail-guardian/report"),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ready");
  assert.equal(credentials, 0);
  for (const fn of disposers) await fn();
});
