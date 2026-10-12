// dsh-mail-guardian — test/state.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MailState } from "../lib/state.js";

function freshState() {
  const dir = mkdtempSync(path.join(tmpdir(), "mail-guardian-state-"));
  return new MailState({ statePath: path.join(dir, "state.json") });
}

test("UID 断点：读写与持久化", () => {
  const state = freshState();
  assert.equal(state.checkpoint("qq").lastUid, 0);
  state.setCheckpoint("qq", { lastUid: 42, uidValidity: "1700000000" });
  const again = new MailState({ statePath: state.statePath });
  assert.equal(again.checkpoint("qq").lastUid, 42);
  assert.equal(again.checkpoint("qq").uidValidity, "1700000000");
});

test("规则增删：同类同值不重复", () => {
  const state = freshState();
  const rule = state.addRule({
    kind: "domain",
    value: "shop.example.net",
    action: "drop",
    note: "这类以后直接扔",
  });
  const dup = state.addRule({
    kind: "domain",
    value: "SHOP.example.net",
    action: "drop",
  });
  assert.equal(dup.id, rule.id);
  assert.equal(state.listRules().length, 1);
  assert.throws(
    () => state.addRule({ kind: "url", value: "x", action: "drop" }),
    /kind/,
  );
  assert.throws(
    () => state.addRule({ kind: "domain", value: "  ", action: "drop" }),
    /value/,
  );
  assert.equal(state.removeRule(rule.id), 1);
  assert.equal(state.listRules().length, 0);
});

test("待定队列：同封信不重复入队，可回收", () => {
  const state = freshState();
  const item = {
    account: "qq",
    uid: 7,
    messageId: "<m1@example.com>",
    from: "某公司",
    subject: "报价",
    question: "留还是扔？",
  };
  const first = state.enqueuePending(item);
  const dup = state.enqueuePending(item);
  assert.equal(dup.id, first.id);
  assert.equal(state.listPending().length, 1);
  assert.equal(state.resolvePending(first.id), 1);
  assert.equal(state.listPending().length, 0);
});

test("同一件事只汇报一次", () => {
  const state = freshState();
  assert.equal(state.shouldReport("<m1@example.com>"), true);
  assert.equal(state.shouldReport("<m1@example.com>"), false);
  assert.equal(state.shouldReport(""), true);
});

test("状态文件损坏时优雅恢复，不炸插件", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mail-guardian-corrupt-"));
  const statePath = path.join(dir, "state.json");
  writeFileSync(statePath, "{ 这不是 json", "utf8");
  const state = new MailState({ statePath });
  assert.equal(state.listRules().length, 0);
  state.save();
  assert.equal(existsSync(statePath), true);
});
