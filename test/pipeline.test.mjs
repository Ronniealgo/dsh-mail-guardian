// dsh-mail-guardian — test/pipeline.test.mjs
//
// End-to-end acceptance: real ImapClient + in-memory IMAP stub + real MIME
// parser + the judge — the whole "收信 → 筛选 → 处置 → 汇报" chain.
// Covers the spec's acceptance items 1/3/4/6 without touching any real server.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startStubServer } from "./helpers/imap-stub-server.mjs";
import { ImapClient } from "../lib/imap-client.js";
import { parseMessage } from "../lib/mime.js";
import { createPipeline } from "../lib/pipeline.js";
import { MailState } from "../lib/state.js";
import { MailIndex } from "../lib/mail-index.js";
import { resolveSettings } from "../lib/config.js";

const SENTINEL = "S3NTINEL-pass-do-not-leak";
const FOLDERS = ["INBOX", "低优先", "垃圾箱"];

function makeEml({
  fromName,
  fromAddr,
  subject,
  body,
  extraHeaders = [],
  messageId,
}) {
  const headers = [
    `From: ${fromName ? fromName + " " : ""}<${fromAddr}>`,
    "To: me@example.net",
    `Subject: ${subject}`,
    "Date: Sat, 11 Oct 2026 09:00:00 +0800",
    `Message-ID: ${messageId}`,
    ...extraHeaders,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
  ];
  return Buffer.from(headers.join("\r\n") + "\r\n\r\n" + body + "\r\n", "utf8");
}

const MAIL_NORMAL = makeEml({
  fromName: "妈妈",
  fromAddr: "mom@example.com",
  subject: "生日提醒",
  body: "这周日回家吃饭，别忘了。",
  messageId: "<n1@example.com>",
});
const MAIL_MARKETING = makeEml({
  fromName: "周刊",
  fromAddr: "news@letter.example.com",
  subject: "本周精选内容",
  body: "本周精选内容，退订请回信。",
  messageId: "<m1@letter.example.com>",
  extraHeaders: [
    "List-Unsubscribe: <mailto:unsub@letter.example.com>",
    "Precedence: bulk",
  ],
});
const MAIL_PHISH = makeEml({
  fromName: "妈妈",
  fromAddr: "attacker@example.org",
  subject: "帮我个忙",
  body: "手机坏了，先转我 2000 块，尽快。",
  messageId: "<p1@evil.example.org>",
});
const MAIL_GRAY = makeEml({
  fromName: "某公司",
  fromAddr: "sales@vendor.example.net",
  subject: "中奖通知，点击领取",
  body: "恭喜中奖，请尽快点击领取：https://vendor.example.net/claim",
  messageId: "<g1@vendor.example.net>",
});

function buildPipeline({ port, stateDir, logs = [], history = {} }) {
  const settings = resolveSettings({
    accounts: [
      {
        id: "test",
        label: "测试邮箱",
        host: "127.0.0.1",
        port,
        secure: false,
        username: "alice",
        credentialRef: "MAIL_TEST",
      },
    ],
    automation: { moveRules: true, moveHeuristics: true },
  });
  const state = new MailState({ statePath: path.join(stateDir, "state.json") });
  state.data.contacts = [{ name: "妈妈", domain: "example.com" }];
  state.data.history = history;
  state.save();
  const index = new MailIndex({ path: path.join(stateDir, "index.json") });
  const pipeline = createPipeline({
    settings,
    state,
    index,
    resolveSecret: async (ref) => (ref === "MAIL_TEST" ? SENTINEL : null),
    ImapClient,
    parseMessage,
    logger: {
      debug: (m) => logs.push(String(m)),
      info: (m) => logs.push(String(m)),
      warn: (m) => logs.push(String(m)),
      error: (m) => logs.push(String(m)),
    },
  });
  return { pipeline, state, index, settings };
}

test("灌样本一轮收信：钓鱼全拦、正常零误拦、灰区全待定且不动原文", async (t) => {
  const stub = await startStubServer({
    users: { alice: SENTINEL },
    messages: [MAIL_NORMAL, MAIL_MARKETING, MAIL_PHISH, MAIL_GRAY],
    mailboxes: FOLDERS,
  });
  t.after(() => stub.close());
  const stateDir = mkdtempSync(path.join(tmpdir(), "mail-guardian-e2e-"));
  const logs = [];
  const { pipeline, state, index } = buildPipeline({
    port: stub.port,
    stateDir,
    logs,
    history: {
      "mom@example.com": { sent: 1, replied: 2, read: 5, lastSeen: null },
    },
  });

  const result = await pipeline.fetch({});
  const outcome = result.accounts[0];

  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.fetched, 4);
  assert.equal(outcome.moved, 2, "钓鱼进垃圾箱 + 广告进低优先 = 2");
  assert.equal(outcome.pending, 1, "灰区一封进待定");
  assert.equal(
    (outcome.actionErrors ?? []).length,
    0,
    "处置不能有失败：" + (outcome.actionErrors ?? []).join(" | "),
  );

  const verdicts = Object.fromEntries(
    index.entries.map((e) => [e.messageId, e.judgment.verdict]),
  );
  assert.equal(verdicts["<n1@example.com>"], "important", "正常往来零误拦");
  assert.equal(verdicts["<m1@letter.example.com>"], "low");
  assert.equal(
    verdicts["<p1@evil.example.org>"],
    "spam",
    "伪造发件人的钓鱼全拦",
  );
  assert.equal(verdicts["<g1@vendor.example.net>"], "pending", "灰区进待定");

  const pending = state.listPending();
  assert.equal(pending.length, 1);
  assert.ok(pending[0].question.includes("留还是扔"), pending[0].question);
  assert.equal(pending[0].messageId, "<g1@vendor.example.net>");

  // 灰区原文一个字都没动：只有两封被移动，且都是自动处置的那两封
  const moveCommands = stub.state.commandLog.filter((c) =>
    /UID MOVE|UID COPY/i.test(c),
  );
  assert.equal(
    moveCommands.length,
    2,
    "只有两封被移动：" + moveCommands.join(" | "),
  );

  // 中文文件夹名要走 modified UTF-7，不能把乱码发出去
  assert.ok(
    !moveCommands.some((c) => /ä|å|Ã/.test(c)),
    "命令里不应出现 UTF-8 直发的乱码文件夹名",
  );

  // 汇报里说清拦了什么、为什么；凭据（哨兵）绝不出现在任何输出
  const phishReport = outcome.reports.find((r) => r.verdict === "spam");
  assert.ok(phishReport && phishReport.reason.length > 0);
  const everything = JSON.stringify({ result, logs });
  assert.ok(!everything.includes(SENTINEL), "凭据值绝不出现在输出/日志里");
});

test("自检：账号已连通、最近 N 封可读取，且不漏凭据", async (t) => {
  const stub = await startStubServer({
    users: { alice: SENTINEL },
    messages: [MAIL_NORMAL, MAIL_MARKETING],
    mailboxes: FOLDERS,
  });
  t.after(() => stub.close());
  const stateDir = mkdtempSync(path.join(tmpdir(), "mail-guardian-check-"));
  const logs = [];
  const { pipeline } = buildPipeline({ port: stub.port, stateDir, logs });
  const check = await pipeline.selfCheck();
  assert.equal(check.results.length, 1);
  assert.equal(check.results[0].ok, true);
  assert.match(check.results[0].message, /账号已连通、最近 \d+ 封可读取/);
  assert.ok(!JSON.stringify(check).includes(SENTINEL));
});

test("断网：明说「网络没通」，绝不说「没有邮件」", async () => {
  const stub = await startStubServer({
    users: { alice: SENTINEL },
    messages: [MAIL_NORMAL],
    mailboxes: FOLDERS,
  });
  const port = stub.port;
  await stub.close(); // 端口已关 = 连不上
  const stateDir = mkdtempSync(path.join(tmpdir(), "mail-guardian-offline-"));
  const { pipeline } = buildPipeline({ port, stateDir });
  const outcome = (await pipeline.fetch({})).accounts[0];
  assert.equal(outcome.ok, false);
  assert.equal(outcome.networkDown, true);
  assert.ok(outcome.error.includes("网络没通"), outcome.error);
  assert.ok(!outcome.error.includes("没有邮件"), outcome.error);
  assert.ok(!outcome.error.includes("没有新邮件"), outcome.error);
});

test("密码错：说的是账号/授权码不对，不是网络问题", async (t) => {
  const stub = await startStubServer({
    users: { alice: "another-password" },
    messages: [],
    mailboxes: FOLDERS,
  });
  t.after(() => stub.close());
  const stateDir = mkdtempSync(path.join(tmpdir(), "mail-guardian-badauth-"));
  const { pipeline } = buildPipeline({ port: stub.port, stateDir });
  const outcome = (await pipeline.fetch({})).accounts[0];
  assert.equal(outcome.ok, false);
  assert.equal(outcome.networkDown, false);
  assert.ok(outcome.error.includes("授权码"), outcome.error);
  assert.ok(!outcome.error.includes("another-password"));
});

test("移进垃圾箱必须人工确认；确认后可找回（只是移动）", async (t) => {
  const stub = await startStubServer({
    users: { alice: SENTINEL },
    messages: [MAIL_NORMAL, MAIL_PHISH],
    mailboxes: FOLDERS,
  });
  t.after(() => stub.close());
  const stateDir = mkdtempSync(path.join(tmpdir(), "mail-guardian-move-"));
  const { pipeline, settings } = buildPipeline({ port: stub.port, stateDir });
  const refused = await pipeline.move({
    account: "test",
    uid: 2,
    to: settings.folders.trash,
    confirm: false,
  });
  assert.equal(refused.ok, false);
  assert.ok(refused.message.includes("确认"));
  assert.ok(refused.message.includes("原邮件还没动"));

  const done = await pipeline.move({
    account: "test",
    uid: 2,
    to: settings.folders.trash,
    confirm: true,
  });
  assert.equal(done.ok, true);
  assert.ok(done.message.includes("找回"));

  // 网络/协议失败时返回人话结果，不往上抛异常
  await stub.close();
  const afterDown = await pipeline.move({
    account: "test",
    uid: 1,
    to: settings.folders.trash,
    confirm: true,
  });
  assert.equal(afterDown.ok, false);
  assert.ok(afterDown.message.includes("网络没通"), afterDown.message);
});

test("规则学习：说「这类以后直接扔」后，同类信自动归档且只汇报一次", async (t) => {
  const stub1 = await startStubServer({
    users: { alice: SENTINEL },
    messages: [MAIL_MARKETING],
    mailboxes: FOLDERS,
  });
  const stateDir = mkdtempSync(path.join(tmpdir(), "mail-guardian-learn-"));
  const { pipeline, state } = buildPipeline({ port: stub1.port, stateDir });
  await pipeline.fetch({});
  state.addRule({
    kind: "domain",
    value: "letter.example.com",
    action: "drop",
    note: "这类以后直接扔",
  });
  await stub1.close();

  const stub2 = await startStubServer({
    uidValidity: 2,
    users: { alice: SENTINEL },
    mailboxes: FOLDERS,
    messages: [
      makeEml({
        fromName: "周刊",
        fromAddr: "news@letter.example.com",
        subject: "又一期精选",
        body: "本期精选。",
        messageId: "<m2@letter.example.com>",
      }),
    ],
  });
  t.after(() => stub2.close());
  const {
    pipeline: pipeline2,
    index: index2,
    state: state2,
  } = buildPipeline({ port: stub2.port, stateDir });
  // 新桩是一台"新服务器"：UID 断点要重置（真实场景由 UIDVALIDITY 变化触发）
  state2.setCheckpoint("test", { lastUid: 0, uidValidity: null });
  const result = await pipeline2.fetch({});
  const outcome = result.accounts[0];
  const entry = index2.entries.find(
    (e) => e.messageId === "<m2@letter.example.com>",
  );
  assert.equal(entry.judgment.verdict, "spam");
  assert.ok(entry.judgment.reason.includes("这类以后直接扔"));
  assert.equal(outcome.moved, 1, "同类信被自动归档");
  assert.equal(outcome.reports.length, 1, "只汇报一次");

  // 同封信再来一遍（断点重置强制重收）：不再重复汇报
  const { state: state3 } = buildPipeline({ port: stub2.port, stateDir });
  state3.setCheckpoint("test", { lastUid: 0 });
  const again = await pipeline2.fetch({});
  assert.equal(again.accounts[0].reports.length, 0, "同一封信不重复汇报");
});
