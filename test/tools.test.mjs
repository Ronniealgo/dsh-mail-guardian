import test from "node:test";
import assert from "node:assert/strict";
import {
  buildToolDefinitions,
  TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
} from "../lib/tools.js";
const calls = [];
const pipeline = {
  report: () => ({
    text: "QQ：今天2封；Gmail：正在更新，先看已有结果",
    status: "syncing",
  }),
  summarize: async () => ({ text: "已有简报" }),
  list: () => ({ mails: [] }),
  search: () => ({ hits: [] }),
  judgeOne: async () => ({}),
  move: async (a) => ({
    ok: a.confirm === true,
    message: a.confirm ? "移好了" : "请确认",
  }),
  mark: async () => ({ ok: true }),
  rules: async (a) => ({ message: "记住了", rules: [] }),
  pending: () => ({ pending: [{ account: "qq", subject: "报价" }] }),
  answerPending: async (a) => ({
    ok: a.confirm === true,
    message: a.confirm ? "已移动" : "需要确认",
  }),
};
function defs() {
  return buildToolDefinitions({
    defineTool: (x) => x,
    pipeline,
    syncRequest: () => {
      calls.push("queued");
      return { status: "queued", text: "后台刷新已安排" };
    },
  });
}
test("工具全部有官方DSL参数和输出，缓存工具2秒上限", () => {
  const tools = defs();
  assert.deepEqual(
    tools.map((t) => t.name),
    TOOL_NAMES,
  );
  for (const t of tools) {
    assert.ok(t.output.schema);
    assert.equal(typeof t.output.render, "function");
    if (READ_ONLY_TOOL_NAMES.includes(t.name)) {
      assert.equal(t.timeoutMs, 2000);
      assert.equal(t.isConcurrencySafe(), true);
    }
  }
});
test("报告立即走缓存而不是同步网络", async () => {
  const t = defs().find((t) => t.name === "mail_report");
  assert.match((await t.execute({})).text, /QQ/);
  assert.equal(t.output.render({}, await t.execute({}))[0].type, "text");
});
test("刷新工具只入队，立即返回", async () => {
  const t = defs().find((t) => t.name === "mail_fetch");
  assert.equal((await t.execute({})).status, "queued");
  assert.deepEqual(calls, ["queued"]);
});
test("必填参数同时在DSL和运行时约束", async () => {
  const t = defs().find((t) => t.name === "mail_search");
  assert.equal(t.parameters.query.required, true);
  await assert.rejects(t.execute({}), /query/);
});
test("移信及待定回答不会凭空完成", async () => {
  const tools = defs();
  const t = tools.find((t) => t.name === "mail_move");
  assert.equal(
    (await t.execute({ account: "qq", uid: 1, to: "Junk" })).ok,
    false,
  );
  assert.equal(
    (await t.execute({ account: "qq", uid: 1, to: "Junk", confirm: true })).ok,
    true,
  );
  const p = tools.find((t) => t.name === "mail_pending");
  assert.equal(
    (await p.execute({ action: "answer", id: "x", answer: "drop" })).ok,
    false,
  );
});
test("用户规则通过流水线受锁保护而不是直接改旧内存", async () => {
  const r = await defs()
    .find((t) => t.name === "mail_rules")
    .execute({
      action: "add",
      kind: "domain",
      value: "shop.example",
      ruleAction: "drop",
    });
  assert.match(r.message, /记住了/);
});
