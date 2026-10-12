// dsh-mail-guardian — test/product-v2.test.mjs
//
// product v2 regression suite (task_id=v2-regressions). Independent from the legacy suites:
// it pins the shipped v2 contract at the product level —
//   1. a fresh report reads ONLY local files (never resolveSecret, never connects), labels every
//      account with freshness/error wording, and never claims "no new mail" without proof;
//      server INTERNALDATE wins over the header Date, including the +08:00 midnight boundary,
//      and two accounts may hold the same Message-ID.
//   2. a second caller sees what the first caller wrote to disk; reports never write state or
//      drop rules; the lock lets one sync run at a time, reclaims dead locks, keeps live ones.
//   3. first sync searches a recent SINCE window (not the whole mailbox), fetches newest first,
//      resets on UIDVALIDITY change, keeps the retry frontier after a lost preview, and never
//      reports ok=true after a failure that followed partial progress.
//   4. previews are bounded BODY.PEEK[]<0.N> (RFC822.SIZE stays the full size), no automatic
//      \Seen, no full-attachment download, and no global EXPUNGE without MOVE/UIDPLUS.
//   5. automation.moveRules only permits explicit sender-domain drop rules by default,
//      heuristics moves stay off, manual move needs confirm, and pending answers are validated.
//
// Everything runs against the in-memory IMAP stub on 127.0.0.1: no network, no credentials.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { startStubServer } from "./helpers/imap-stub-server.mjs";
import { ImapClient, ImapError } from "../lib/imap-client.js";
import { parseMessage } from "../lib/mime.js";
import { createPipeline } from "../lib/pipeline.js";
import { MailState } from "../lib/state.js";
import { MailIndex } from "../lib/mail-index.js";
import { resolveSettings } from "../lib/config.js";
import { acquireLock, lockActive } from "../lib/persistence.js";

const PASS = "v2-suite-pass-not-a-real-credential";
const FOLDERS = ["INBOX", "低优先", "垃圾箱"];
const TZ = "Asia/Shanghai";
const DAY = "Mon, 12 Oct 2026 09:00:00 +0800"; // 2026-10-12 01:00Z
const NOW12 = new Date("2026-10-12T02:00:00Z"); // 2026-10-12 10:00 +08:00

/* ----------------------------------------------------------------------------------------- *
 * Stub bookkeeping: every started server is closed by t.after, so an assertion failure can
 * never leave a socket (or a pending slow-reply timer) hanging the suite.
 * ----------------------------------------------------------------------------------------- */

const liveStubs = new Set();

async function startStub(t, options) {
  const stub = await startStubServer(options);
  liveStubs.add(stub);
  t.after(async () => {
    liveStubs.delete(stub);
    await stub.close();
  });
  return stub;
}

after(async () => {
  for (const stub of [...liveStubs]) {
    liveStubs.delete(stub);
    try {
      await stub.close();
    } catch {
      /* already closed */
    }
  }
});

/* ----------------------------------------------------------------------------------------- *
 * Small builders
 * ----------------------------------------------------------------------------------------- */

function tmpDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function eml({
  fromName = "",
  fromAddr,
  date,
  subject,
  messageId,
  body = "正文",
  extraHeaders = [],
}) {
  const headers = [
    `From: ${fromName ? fromName + " " : ""}<${fromAddr}>`,
    "To: me@example.net",
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    ...extraHeaders,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
  ];
  return Buffer.from(headers.join("\r\n") + "\r\n\r\n" + body + "\r\n", "utf8");
}

/** Append a message to the stub INBOX with the next UID (stub state is plain data by design). */
function addStubMessage(stub, raw, date = new Date()) {
  const box = stub.state.mailboxes.get("INBOX");
  const message = {
    uid: box.uidNext,
    flags: [],
    raw: Buffer.from(raw),
    date: new Date(date),
  };
  box.uidNext += 1;
  box.messages.push(message);
  return message;
}

function settingsFor(port, extra = {}, accounts = null) {
  return resolveSettings({
    timeZone: TZ,
    accounts: accounts ?? [
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
    ...extra,
  });
}

function buildPipeline({
  port,
  stateDir,
  settings,
  now,
  resolveSecret,
  ImapClient: ImapImpl,
}) {
  const state = new MailState({ statePath: path.join(stateDir, "state.json") });
  const index = new MailIndex({ path: path.join(stateDir, "index.json") });
  const pipeline = createPipeline({
    settings: settings ?? settingsFor(port),
    state,
    index,
    resolveSecret: resolveSecret ?? (async () => PASS),
    ImapClient: ImapImpl ?? ImapClient,
    parseMessage,
    now: now ?? (() => new Date()),
  });
  return { pipeline, state, index };
}

const personalMail = (
  messageId,
  subject,
  date = DAY,
  fromAddr = "mom@example.com",
) =>
  eml({ fromAddr, date, subject, messageId, body: "这周日回家吃饭，别忘了。" });

/* ----------------------------------------------------------------------------------------- *
 * 1. Reports are local-only, honest about freshness, and use server dates / per-account keys
 * ----------------------------------------------------------------------------------------- */

test("v2/1 报告只用本机缓存：后台卡住时也不 resolveSecret、不连 IMAP", async (t) => {
  const stub = await startStub(t, {
    users: { alice: PASS },
    messages: [personalMail("<a1@e>", "问候")],
    mailboxes: FOLDERS,
  });
  const dir = tmpDir("mguard-v2-hunglock-");
  const lockFile = path.join(dir, "sync.lock");
  const release = acquireLock(lockFile);
  assert.equal(
    typeof release,
    "function",
    "测试需要先造一把活锁（后台正在收信）",
  );
  try {
    let secretCalls = 0;
    let clientCalls = 0;
    const { pipeline, state } = buildPipeline({
      port: stub.port,
      stateDir: dir,
      now: () => new Date(NOW12),
      resolveSecret: async () => {
        secretCalls += 1;
        throw new Error("报告不得读凭据");
      },
      ImapClient: class {
        constructor() {
          clientCalls += 1;
          throw new Error("报告不得连 IMAP");
        }
      },
    });
    state.setCheckpoint("test", {
      uidValidity: "1",
      lastUid: 1,
      initialized: true,
      lastSuccessAt: NOW12.toISOString(),
      lastFetchAt: NOW12.toISOString(),
    });

    const report = await pipeline.summarize({ range: "today" });
    assert.equal(report.version, 2);
    assert.equal(report.accounts.length, 1);
    assert.equal(report.accounts[0].status, "syncing", "后台有活锁 = 正在同步");
    assert.match(report.text, /正在后台更新/);
    assert.ok(
      !report.text.includes("已核实：今天没有新邮件"),
      "后台卡住时不许断言没有新邮件",
    );
    assert.ok(report.text.includes("测试邮箱（alice）："), report.text);
    assert.ok(!JSON.stringify(report).includes(PASS), "凭据不得出现在报告里");
    assert.equal(secretCalls, 0, "报告不得调用 resolveSecret");
    assert.equal(clientCalls, 0, "报告不得构造 IMAP 客户端");
    assert.equal(stub.state.connections, 0, "报告期间不得有任何 IMAP 连接");
    assert.equal(lockActive(lockFile), true, "报告不得动后台的锁");
  } finally {
    release();
  }
});

test("v2/1 每个账号都有标签与新鲜度；未初始化/过期/失败/部分/缓存损坏都不说「没有新邮件」", async () => {
  let secretCalls = 0;
  let clientCalls = 0;
  const deps = {
    resolveSecret: async () => {
      secretCalls += 1;
      throw new Error("报告不得读凭据");
    },
    ImapClient: class {
      constructor() {
        clientCalls += 1;
        throw new Error("报告不得连 IMAP");
      }
    },
  };
  const cases = [];

  {
    const dir = tmpDir("mguard-v2-fresh-");
    const { pipeline } = buildPipeline({
      port: 1,
      stateDir: dir,
      now: () => new Date(NOW12),
      ...deps,
    });
    const report = await pipeline.summarize({ range: "today" });
    assert.equal(report.accounts[0].lastSyncedAt, null);
    assert.equal(report.accounts[0].error, null);
    cases.push({
      name: "未初始化",
      report,
      status: "uninitialized",
      expect: /还没收取成功/,
    });
  }
  {
    const dir = tmpDir("mguard-v2-stale-");
    const { pipeline, state } = buildPipeline({
      port: 1,
      stateDir: dir,
      now: () => new Date(NOW12),
      ...deps,
    });
    const old = new Date(NOW12.getTime() - 2 * 3600 * 1000).toISOString();
    state.setCheckpoint("test", {
      uidValidity: "1",
      lastUid: 1,
      initialized: true,
      lastFetchAt: old,
      lastSuccessAt: old,
    });
    const report = await pipeline.summarize({ range: "today" });
    assert.equal(report.accounts[0].lastSyncedAt, old);
    cases.push({
      name: "结果过期",
      report,
      status: "stale",
      expect: /结果较旧/,
    });
  }
  {
    const dir = tmpDir("mguard-v2-failed-");
    const { pipeline, state } = buildPipeline({
      port: 1,
      stateDir: dir,
      now: () => new Date(NOW12),
      ...deps,
    });
    state.setCheckpoint("test", {
      lastError: "邮箱账号或授权码不对，收信没成功",
      status: "error",
    });
    const report = await pipeline.summarize({ range: "today" });
    assert.equal(report.accounts[0].error, "邮箱账号或授权码不对，收信没成功");
    cases.push({
      name: "收信失败",
      report,
      status: "error",
      expect: /授权码不对/,
    });
  }
  {
    const dir = tmpDir("mguard-v2-partial-");
    const { pipeline, state } = buildPipeline({
      port: 1,
      stateDir: dir,
      now: () => new Date(NOW12),
      ...deps,
    });
    state.setCheckpoint("test", {
      uidValidity: "1",
      lastUid: 7,
      initialized: true,
      lastSuccessAt: NOW12.toISOString(),
      lastFetchAt: NOW12.toISOString(),
      remainingUids: [7],
      partial: true,
    });
    const report = await pipeline.summarize({ range: "today" });
    assert.equal(report.accounts[0].remaining, 1);
    cases.push({
      name: "没收完",
      report,
      status: "partial",
      expect: /还在补收/,
    });
  }
  {
    const dir = tmpDir("mguard-v2-cache-");
    writeFileSync(path.join(dir, "state.json"), "{ 这不是 JSON");
    const { pipeline } = buildPipeline({
      port: 1,
      stateDir: dir,
      now: () => new Date(NOW12),
      ...deps,
    });
    const report = await pipeline.summarize({ range: "today" });
    assert.equal(report.accounts[0].error, "本机邮件缓存损坏或无法读取");
    cases.push({
      name: "缓存损坏",
      report,
      status: "cache-error",
      expect: /缓存读取失败/,
    });
  }
  {
    const dir = tmpDir("mguard-v2-ready-");
    const { pipeline, state } = buildPipeline({
      port: 1,
      stateDir: dir,
      now: () => new Date(NOW12),
      ...deps,
    });
    state.setCheckpoint("test", {
      uidValidity: "1",
      lastUid: 0,
      initialized: true,
      lastSuccessAt: NOW12.toISOString(),
      lastFetchAt: NOW12.toISOString(),
    });
    const report = await pipeline.summarize({ range: "today" });
    cases.push({ name: "正常", report, status: "ready", expect: /已更新/ });
  }

  assert.equal(cases.length, 6);
  for (const item of cases) {
    const account = item.report.accounts[0];
    assert.equal(account.status, item.status, item.name + " 的状态");
    assert.equal(account.label, "测试邮箱");
    assert.equal(account.address, "alice");
    assert.ok(
      item.report.text.includes("测试邮箱（alice）："),
      item.name + " 要按账号给标签：" + item.report.text,
    );
    assert.match(item.report.text, item.expect, item.name + " 的人话说明");
    if (item.status === "ready") {
      assert.ok(
        item.report.text.includes("已核实：今天没有新邮件"),
        "只有真的核实过才允许这么说",
      );
    } else {
      assert.notEqual(
        item.report.status,
        "ready",
        item.name + " 顶层状态不得是 ready",
      );
      assert.ok(
        !item.report.text.includes("已核实：今天没有新邮件"),
        item.name + " 不许说「没有新邮件」：" + item.report.text,
      );
    }
  }
  assert.equal(secretCalls, 0);
  assert.equal(clientCalls, 0);
});

test("v2/1 INTERNALDATE 优先于头部 Date：跨 +08:00 午夜的信用服务器时间归日", async (t) => {
  const afterMidnight = personalMail(
    "<mid-today@e>",
    "凌晨来信",
    "Sun, 12 Oct 2026 00:30:00 +0800",
  ); // 10-11 16:30Z
  const beforeMidnight = personalMail(
    "<mid-late@e>",
    "睡前来信",
    "Sat, 11 Oct 2026 23:30:00 +0800",
  ); // 10-11 15:30Z
  const stub = await startStub(t, {
    users: { alice: PASS },
    messages: [afterMidnight, beforeMidnight],
    mailboxes: FOLDERS,
  });
  const dir = tmpDir("mguard-v2-midnight-");
  const { pipeline, index } = buildPipeline({
    port: stub.port,
    stateDir: dir,
    now: () => new Date(NOW12),
  });

  const result = await pipeline.fetch({});
  assert.equal(result.accounts[0].ok, true, JSON.stringify(result.accounts[0]));
  assert.equal(
    result.accounts[0].fetched,
    2,
    "两封都已经收下——差别只能在归日上",
  );

  const entry = index.entries.find((e) => e.messageId === "<mid-today@e>");
  assert.ok(entry);
  assert.equal(
    entry.receivedAt,
    "2026-10-11T16:30:00.000Z",
    "receivedAt 要用服务器 INTERNALDATE",
  );
  assert.equal(entry.dateSource, "server", "日期来源要标成服务器时间");

  // 低层复核：INTERNALDATE 确实走了请求/应答，而不是被 header Date 顶替
  const client = new ImapClient({
    host: "127.0.0.1",
    port: stub.port,
    secure: false,
    timeoutMs: 3000,
  });
  try {
    await client.connect();
    await client.login("alice", PASS);
    await client.select("INBOX");
    const [message] = await client.uidFetch({
      uids: [1],
      items: ["UID", "INTERNALDATE", "RFC822.SIZE"],
    });
    assert.equal(message.internalDate, "2026-10-11T16:30:00.000Z");
  } finally {
    client.destroy();
  }

  const report = await pipeline.summarize({ range: "today", now: NOW12 });
  assert.equal(report.day, "2026-10-12");
  assert.equal(
    report.mails.length,
    1,
    "今天只有凌晨那封；23:30 那封本地是昨天（UTC 里两封都算 10-11，拿 UTC 算就会多出来）",
  );
  assert.equal(report.mails[0].messageId, "<mid-today@e>");
  assert.equal(report.mails[0].dateSource, "server");
  assert.ok(report.text.includes("凌晨来信"), report.text);
});

test("v2/1 两个账号同一 Message-ID 不互相覆盖，报告分别标注账号", async (t) => {
  const SAME = "<same-id@forward.example>";
  const stubWork = await startStub(t, {
    users: { alice: PASS },
    messages: [
      eml({
        fromAddr: "boss@corp.example",
        date: DAY,
        subject: "周会安排",
        messageId: SAME,
      }),
    ],
    mailboxes: FOLDERS,
  });
  const stubLife = await startStub(t, {
    users: { alice: PASS },
    messages: [
      eml({
        fromAddr: "friend@home.example",
        date: DAY,
        subject: "周末见",
        messageId: SAME,
      }),
    ],
    mailboxes: FOLDERS,
  });
  const dir = tmpDir("mguard-v2-dupe-");
  const accounts = [
    {
      id: "work",
      label: "工作",
      host: "127.0.0.1",
      port: stubWork.port,
      secure: false,
      username: "alice",
      credentialRef: "MAIL_WORK",
    },
    {
      id: "life",
      label: "生活",
      host: "127.0.0.1",
      port: stubLife.port,
      secure: false,
      username: "alice",
      credentialRef: "MAIL_LIFE",
    },
  ];
  const { pipeline, index } = buildPipeline({
    port: stubWork.port,
    stateDir: dir,
    settings: settingsFor(null, {}, accounts),
    now: () => new Date(NOW12),
  });

  const result = await pipeline.fetch({});
  assert.ok(
    result.accounts.every((a) => a.ok),
    JSON.stringify(result.accounts),
  );
  const dupes = index.entries.filter((e) => e.messageId === SAME);
  assert.equal(dupes.length, 2, "同一个 Message-ID 必须按账号各存一份");
  assert.deepEqual(dupes.map((e) => e.account).sort(), ["life", "work"]);

  const report = await pipeline.summarize({ range: "today", now: NOW12 });
  assert.equal(report.mails.length, 2);
  assert.ok(report.text.includes("工作（alice）："), report.text);
  assert.ok(report.text.includes("生活（alice）："), report.text);
  assert.equal(new Set(report.mails.map((m) => m.accountLabel)).size, 2);
});

/* ----------------------------------------------------------------------------------------- *
 * 2. Disk visibility across callers, report purity, and lock semantics
 * ----------------------------------------------------------------------------------------- */

test("v2/2 第二个调用方看到磁盘更新；报告不写盘、不吞规则", async (t) => {
  const stub = await startStub(t, {
    users: { alice: PASS },
    messages: [personalMail("<b1@e>", "第一封")],
    mailboxes: FOLDERS,
  });
  const dir = tmpDir("mguard-v2-callers-");
  const stateFile = path.join(dir, "state.json");
  const indexFile = path.join(dir, "index.json");
  const clock = () => new Date(NOW12);

  const first = buildPipeline({ port: stub.port, stateDir: dir, now: clock });
  const fetched = await first.pipeline.fetch({});
  assert.equal(
    fetched.accounts[0].ok,
    true,
    JSON.stringify(fetched.accounts[0]),
  );
  const reportA1 = await first.pipeline.summarize({
    range: "today",
    now: NOW12,
  });
  assert.equal(reportA1.mails.length, 1, "第一个调用方的第一份报告");

  // 第二个调用方是全新实例：先看到磁盘上的缓存，再落一条规则
  const second = buildPipeline({ port: stub.port, stateDir: dir, now: clock });
  const reportB1 = await second.pipeline.summarize({
    range: "today",
    now: NOW12,
  });
  assert.equal(
    reportB1.mails.length,
    1,
    "第二个调用方要看到第一个调用方落盘的缓存",
  );
  const rule = second.state.addRule({
    kind: "domain",
    value: "promo.example.com",
    action: "drop",
    note: "这类以后直接扔",
  });

  // 第一个调用方的下一次报告必须重新读盘：看到新规则，而不是拿内存里的旧状态
  const reportA2 = await first.pipeline.summarize({
    range: "today",
    now: NOW12,
  });
  assert.equal(reportA2.mails.length, 1);
  assert.ok(
    first.state.listRules().some((r) => r.id === rule.id),
    "报告前要重读磁盘，否则会丢规则",
  );

  // 第二个调用方收新信之后，第一个调用方的下一次报告要能看到
  addStubMessage(
    stub,
    personalMail("<b2@e>", "第二封", DAY, "friend@example.net"),
    new Date("2026-10-12T01:10:00Z"),
  );
  const secondFetch = await second.pipeline.fetch({});
  assert.equal(secondFetch.accounts[0].fetched, 1);
  const reportA3 = await first.pipeline.summarize({
    range: "today",
    now: NOW12,
  });
  assert.equal(
    reportA3.mails.length,
    2,
    "第二个调用方的写入，第一个调用方下一次报告就要能看到",
  );
  assert.ok(reportA3.mails.some((m) => m.messageId === "<b2@e>"));
  assert.equal(
    reportA3.accounts[0].lastSyncedAt,
    second.state.checkpoint("test").lastSuccessAt,
    "新鲜度也要跟磁盘走",
  );

  // 报告本身绝不能写盘（字节级不变），也不能把规则写丢
  const stateBytes = readFileSync(stateFile);
  const indexBytes = readFileSync(indexFile);
  await first.pipeline.summarize({ range: "today", now: NOW12 });
  await second.pipeline.summarize({ range: "today", now: NOW12 });
  assert.ok(
    readFileSync(stateFile).equals(stateBytes),
    "summary 不得改写 state.json",
  );
  assert.ok(
    readFileSync(indexFile).equals(indexBytes),
    "summary 不得改写 index.json",
  );
  assert.ok(
    JSON.parse(String(stateBytes)).rules.some((r) => r.id === rule.id),
    "规则必须留在磁盘上",
  );
  const listed = await first.pipeline.rules({ action: "list" });
  assert.deepEqual(
    listed.rules.map((r) => r.id),
    [rule.id],
  );
});

test("v2/2 锁语义：活锁不被抢、死进程的锁可回收、过期空锁可回收", () => {
  const dir = tmpDir("mguard-v2-locks-");
  const lockFile = path.join(dir, "sync.lock");
  assert.equal(lockActive(lockFile), false, "没有锁时状态是空闲");

  const release = acquireLock(lockFile);
  assert.equal(typeof release, "function");
  assert.equal(lockActive(lockFile), true);
  assert.equal(acquireLock(lockFile), null, "活着的持锁人不能被抢锁");
  assert.ok(existsSync(lockFile), "抢锁失败不能删掉对方的锁");

  release();
  assert.equal(lockActive(lockFile), false);
  assert.ok(!existsSync(lockFile), "释放后锁文件要清掉");
  const again = acquireLock(lockFile);
  assert.equal(typeof again, "function", "释放之后可以再拿");
  again();

  // 死进程留下的锁：必须回收（pid 不存在 = ESRCH，按死锁处理）
  writeFileSync(
    lockFile,
    JSON.stringify({
      pid: 2147483647,
      token: "dead-owner",
      startedAt: new Date(0).toISOString(),
    }),
  );
  const reclaimed = acquireLock(lockFile);
  assert.equal(typeof reclaimed, "function", "死进程的锁必须能回收");
  assert.equal(lockActive(lockFile), true, "回收后归新主人");
  reclaimed();

  // 空的、老过 60 秒的锁文件：也能回收
  writeFileSync(lockFile, "");
  const old = new Date(Date.now() - 120000);
  utimesSync(lockFile, old, old);
  const reclaimedOld = acquireLock(lockFile);
  assert.equal(typeof reclaimedOld, "function", "空且过期的锁必须回收");
  reclaimedOld();
  assert.ok(!existsSync(lockFile));
});

test("v2/2 两个同步任务不能并发：第二个直接拿到 busy，不连服务器", async (t) => {
  const stub = await startStub(t, {
    users: { alice: PASS },
    messages: [personalMail("<busy@e>", "慢一点")],
    mailboxes: FOLDERS,
    simulate: "slow",
    slowCommands: ["UID SEARCH"],
    slowMs: 3000,
  });
  const dir = tmpDir("mguard-v2-busy-");
  const lockFile = path.join(dir, "sync.lock");
  const { pipeline } = buildPipeline({
    port: stub.port,
    stateDir: dir,
    settings: settingsFor(stub.port, {
      sync: { commandTimeoutMs: 250, accountBudgetMs: 1000 },
    }),
    now: () => new Date(NOW12),
  });

  const first = pipeline.fetch({});
  for (let i = 0; i < 200 && !existsSync(lockFile); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(existsSync(lockFile), "第一个任务开始后应立刻持锁");
  for (let i = 0; i < 400 && stub.state.logins.length === 0; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stub.state.connections, 1, "第一个任务先连上来");
  assert.equal(stub.state.logins.length, 1);

  const busy = await pipeline.fetch({});
  assert.equal(busy.ok, false);
  assert.equal(busy.status, "busy");
  assert.match(busy.message, /后台正在收信/);
  assert.equal(stub.state.connections, 1, "第二个任务不许连服务器");
  assert.equal(stub.state.logins.length, 1, "第二个任务不许登录");

  const firstResult = await first;
  assert.equal(firstResult.accounts[0].ok, false, "命令超时不能报成功");
  assert.equal(firstResult.accounts[0].networkDown, true);
  assert.match(firstResult.accounts[0].error, /网络没通/);
  assert.ok(!existsSync(lockFile), "结束后锁必须释放");
});

/* ----------------------------------------------------------------------------------------- *
 * 3. Incremental fetch: recent window, newest first, UIDVALIDITY reset, retry frontier
 * ----------------------------------------------------------------------------------------- */

test("v2/3 首次同步只查最近窗口（SINCE），新信先收；不扫整个历史邮箱", async (t) => {
  const old = eml({
    fromAddr: "museum@example.com",
    date: "Wed, 03 Jan 2024 09:00:00 +0800",
    subject: "很久以前",
    messageId: "<c-old@e>",
  });
  const recentA = eml({
    fromAddr: "mom@example.com",
    date: "Mon, 12 Oct 2026 08:00:00 +0800",
    subject: "今天第一封",
    messageId: "<c-1@e>",
  });
  const recentB = eml({
    fromAddr: "dad@example.com",
    date: "Mon, 12 Oct 2026 09:00:00 +0800",
    subject: "今天第二封",
    messageId: "<c-2@e>",
  });
  const stub = await startStub(t, {
    users: { alice: PASS },
    messages: [old, recentA, recentB],
    mailboxes: FOLDERS,
  });
  const dir = tmpDir("mguard-v2-firstsync-");
  const { pipeline, state, index } = buildPipeline({
    port: stub.port,
    stateDir: dir,
    now: () => new Date(NOW12),
  });

  const result = await pipeline.fetch({});
  const outcome = result.accounts[0];
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.fetched, 2);

  const searches = stub.state.commandLog.filter((line) =>
    line.startsWith("UID SEARCH"),
  );
  assert.deepEqual(
    searches,
    ["UID SEARCH SINCE 9-Oct-2026"],
    "首次同步查最近窗口，不做全量扫描",
  );
  assert.ok(
    !searches.some((line) => /ALL/.test(line)),
    "不许发 UID SEARCH ALL",
  );

  const fetches = stub.state.commandLog.filter((line) =>
    line.startsWith("UID FETCH"),
  );
  assert.equal(fetches.length, 1, "一次成批拉取最近的新信");
  assert.equal(
    fetches[0],
    "UID FETCH 3,2 (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[]<0." +
      pipeline.settings.sync.maxPreviewBytes +
      ">)",
    "新信先收：uid 集合按新→旧排列，2024 年的历史邮件不下载正文",
  );

  const checkpoint = state.checkpoint("test");
  assert.equal(checkpoint.initialized, true);
  assert.equal(checkpoint.lastUid, 3);
  assert.deepEqual(checkpoint.remainingUids, []);
  assert.deepEqual(
    index.entries.map((e) => e.uid).sort((a, b) => a - b),
    [2, 3],
  );
});

test("v2/3 UIDVALIDITY 复位：重置断点、清掉旧待定、按新编号重收", async (t) => {
  const m1 = eml({
    fromAddr: "mom@example.com",
    date: "Mon, 12 Oct 2026 08:00:00 +0800",
    subject: "重建前",
    messageId: "<c2-1@e>",
  });
  const m2 = eml({
    fromAddr: "dad@example.com",
    date: "Mon, 12 Oct 2026 09:00:00 +0800",
    subject: "重建后",
    messageId: "<c2-2@e>",
  });
  const stub = await startStub(t, {
    users: { alice: PASS },
    messages: [m1],
    mailboxes: FOLDERS,
    uidValidity: 111,
  });
  const dir = tmpDir("mguard-v2-uidvalidity-");
  const { pipeline, state, index } = buildPipeline({
    port: stub.port,
    stateDir: dir,
    now: () => new Date(NOW12),
  });

  const first = await pipeline.fetch({});
  assert.equal(first.accounts[0].ok, true, JSON.stringify(first.accounts[0]));
  assert.equal(state.checkpoint("test").uidValidity, "111");
  state.enqueuePending({
    account: "test",
    mailbox: "INBOX",
    uid: 999,
    uidValidity: "111",
    messageId: "<stale@e>",
    from: "旧待定",
    address: "old@example.net",
    subject: "重建前的待定",
    date: NOW12.toISOString(),
    reason: "旧",
    question: "旧问题：留还是扔？",
  });
  assert.equal(state.listPending().length, 1);

  // 服务器重建邮箱：UIDVALIDITY 变了，编号从头开始
  stub.state.mailboxes.get("INBOX").uidValidity = 222;
  addStubMessage(stub, m2, new Date("2026-10-12T01:00:00Z"));

  const second = await pipeline.fetch({});
  assert.equal(second.accounts[0].ok, true, JSON.stringify(second.accounts[0]));
  assert.equal(
    state.checkpoint("test").uidValidity,
    "222",
    "断点要跟着新 UIDVALIDITY 走",
  );
  assert.equal(state.checkpoint("test").lastUid, 2);
  assert.deepEqual(
    state.listPending(),
    [],
    "断点归零要把旧 UIDVALIDITY 下的待定清干净",
  );
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")).pending,
    [],
    "磁盘上的待定也要清掉",
  );
  const entries = index.entries.filter((e) => e.mailbox === "INBOX");
  assert.ok(
    entries.every((e) => e.uidValidity === "222"),
    "重建后的索引要标新的 UIDVALIDITY",
  );
  assert.ok(
    entries.some((e) => e.messageId === "<c2-2@e>"),
    "重建后的新信要收下来",
  );
});

test("v2/3 中断保留重试前沿；部分成功后失败不得报 ok=true", async (t) => {
  const m1 = eml({
    fromAddr: "mom@example.com",
    date: "Mon, 12 Oct 2026 08:00:00 +0800",
    subject: "第一封",
    messageId: "<c3-1@e>",
  });
  const m2 = eml({
    fromAddr: "dad@example.com",
    date: "Mon, 12 Oct 2026 09:00:00 +0800",
    subject: "第二封",
    messageId: "<c3-2@e>",
  });

  // (a) 真实掉线：预览没拿到 -> 候选留在重试前沿，绝不报成功
  {
    const stub = await startStub(t, {
      users: { alice: PASS },
      messages: [m1, m2],
      mailboxes: FOLDERS,
      simulate: "drop-mid-fetch",
    });
    const dir = tmpDir("mguard-v2-drop-");
    const { pipeline, state } = buildPipeline({
      port: stub.port,
      stateDir: dir,
      now: () => new Date(NOW12),
    });
    const result = await pipeline.fetch({});
    const outcome = result.accounts[0];
    assert.equal(outcome.ok, false, "掉线绝对不能报成功");
    assert.equal(outcome.networkDown, true);
    assert.equal(outcome.status, "error");
    assert.equal(outcome.fetched, 0, "一封都没拿到，更不能报成功");
    const checkpoint = state.checkpoint("test");
    assert.equal(checkpoint.status, "error");
    assert.deepEqual(
      [...checkpoint.remainingUids].sort((a, b) => a - b),
      [1, 2],
      "没拿到原文的候选要留在重试前沿里",
    );
    const onDisk = JSON.parse(
      readFileSync(path.join(dir, "state.json"), "utf8"),
    );
    assert.deepEqual(
      [...onDisk.accounts.test.remainingUids].sort((a, b) => a - b),
      [1, 2],
      "重试前沿要落盘",
    );
  }

  // (b) 第一批收下、第二批断线 -> fetched=5 但 ok 必须还是 false，后半批留在前沿
  {
    const dir = tmpDir("mguard-v2-partial-");
    const previews = [];
    const rawOf = (uid) =>
      eml({
        fromAddr: "mom@example.com",
        date: DAY,
        subject: "第" + uid + "封",
        messageId: "<c3b-" + uid + "@e>",
      });
    class ScriptedImap {
      async connect() {}
      async login(user, secret) {
        assert.equal(secret, PASS);
      }
      async select() {
        return { uidValidity: 1, uidNext: 8, exists: 7, readOnly: false };
      }
      async uidSearch() {
        return [1, 2, 3, 4, 5, 6, 7];
      }
      async uidFetch({ uids, items }) {
        previews.push(uids.join(",") + " :: " + items.join(" "));
        if (uids[0] === 7) {
          return uids.map((uid) => ({
            uid,
            flags: [],
            size: rawOf(uid).length,
            raw: rawOf(uid),
            internalDate: "2026-10-12T01:00:00.000Z",
          }));
        }
        throw Object.assign(new Error("测试脚本：第二批读取时断线"), {
          kind: "network",
        });
      }
      async uidMove() {
        throw Object.assign(new Error("unexpected move"), { kind: "protocol" });
      }
      destroy() {}
    }
    const { pipeline, state, index } = buildPipeline({
      port: 1,
      stateDir: dir,
      ImapClient: ScriptedImap,
      now: () => new Date(NOW12),
    });
    const result = await pipeline.fetch({});
    const outcome = result.accounts[0];
    assert.equal(outcome.ok, false, "收了一半之后失败也不许 ok=true");
    assert.equal(outcome.networkDown, true);
    assert.equal(outcome.fetched, 5, "第一批 5 封已经收下");
    assert.equal(outcome.status, "error");
    assert.equal(index.entries.length, 5, "已经收下的那批仍在缓存里");
    assert.deepEqual(
      [...state.checkpoint("test").remainingUids].sort((a, b) => a - b),
      [1, 2],
      "没拿到的后半批留在前沿",
    );
    const onDisk = JSON.parse(
      readFileSync(path.join(dir, "state.json"), "utf8"),
    );
    assert.deepEqual(
      [...onDisk.accounts.test.remainingUids].sort((a, b) => a - b),
      [1, 2],
      "前沿要落盘",
    );
    assert.equal(onDisk.accounts.test.status, "error");
    assert.ok(
      previews.every((line) => /BODY\.PEEK\[\]<0\.\d+>/.test(line)),
      "预览请求必须是有界 BODY.PEEK：" + previews.join(" | "),
    );
  }

  // (c) 批里拿到了 UID 却没有原文预览 -> 已经收下的留住，缺预览的留在前沿，绝不 ok=true
  {
    const dir = tmpDir("mguard-v2-missingraw-");
    class ScriptedImap {
      async connect() {}
      async login(user, secret) {
        assert.equal(secret, PASS);
      }
      async select() {
        return { uidValidity: 1, uidNext: 4, exists: 2, readOnly: false };
      }
      async uidSearch() {
        return [2, 3];
      }
      async uidFetch({ uids }) {
        assert.deepEqual(uids, [3, 2], "一批拉取，新信在前");
        return [
          {
            uid: 3,
            flags: [],
            size: m2.length,
            raw: m2,
            internalDate: "2026-10-12T01:00:00.000Z",
          },
          {
            uid: 2,
            flags: [],
            size: m1.length,
            raw: null,
            internalDate: "2026-10-12T00:00:00.000Z",
          },
        ];
      }
      async uidMove() {
        throw Object.assign(new Error("unexpected move"), { kind: "protocol" });
      }
      destroy() {}
    }
    const { pipeline, state, index } = buildPipeline({
      port: 1,
      stateDir: dir,
      ImapClient: ScriptedImap,
      now: () => new Date(NOW12),
    });
    const result = await pipeline.fetch({});
    const outcome = result.accounts[0];
    assert.equal(outcome.ok, false, "拿到了 UID 却没有原文预览：不许报成功");
    assert.equal(outcome.fetched, 1, "同一批里已经收下的那封要留住");
    assert.equal(outcome.status, "error");
    assert.ok(!outcome.error.includes("没有新邮件"), outcome.error);
    assert.ok(
      index.entries.some((e) => e.uid === 3),
      "已经收下的那封仍在缓存里",
    );
    assert.deepEqual(
      state.checkpoint("test").remainingUids,
      [2],
      "没拿到预览的那封留在前沿，下一轮重试",
    );
    assert.equal(
      JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")).accounts
        .test.status,
      "error",
    );
  }
});

/* ----------------------------------------------------------------------------------------- *
 * 4. Bounded previews, no Seen flag, no unsafe EXPUNGE
 * ----------------------------------------------------------------------------------------- */

test("v2/4 有界预览：BODY.PEEK[]<0.N> 只取前 N 字节，RFC822.SIZE/INTERNALDATE 是全量；不落 \\Seen", async (t) => {
  const big = eml({
    fromAddr: "news@promo.example.com",
    date: "Mon, 12 Oct 2026 09:00:00 +0800",
    subject: "很大的邮件",
    messageId: "<d1@e>",
    body: "x".repeat(200000),
  });
  const stub = await startStub(t, {
    users: { alice: PASS },
    messages: [big],
    mailboxes: FOLDERS,
  });
  const dir = tmpDir("mguard-v2-preview-");

  // 低层：预览长度被截断，原文大小照样是全量
  const client = new ImapClient({
    host: "127.0.0.1",
    port: stub.port,
    secure: false,
    timeoutMs: 3000,
  });
  try {
    await client.connect();
    await client.login("alice", PASS);
    await client.select("INBOX");
    const [preview] = await client.uidFetch({
      uids: [1],
      items: [
        "UID",
        "FLAGS",
        "INTERNALDATE",
        "RFC822.SIZE",
        "BODY.PEEK[]<0.1000>",
      ],
    });
    assert.equal(
      preview.raw.length,
      1000,
      "预览就是要求的 1000 字节，不是整封",
    );
    assert.equal(preview.size, big.length, "RFC822.SIZE 仍是原始大小");
    assert.equal(preview.internalDate, "2026-10-12T01:00:00.000Z");
  } finally {
    client.destroy();
  }

  // 产品层：默认上限 65536 字节
  const { pipeline, index } = buildPipeline({
    port: stub.port,
    stateDir: dir,
    now: () => new Date(NOW12),
  });
  const result = await pipeline.fetch({});
  assert.equal(result.accounts[0].ok, true, JSON.stringify(result.accounts[0]));
  const entry = index.entries.find((e) => e.messageId === "<d1@e>");
  assert.equal(entry.bodyTruncated, true, "200KB 的信只拿了预览，要标出来");
  assert.equal(entry.read, false, "收信不能把信标成已读");

  const fetchLines = stub.state.commandLog.filter((line) =>
    line.startsWith("UID FETCH"),
  );
  assert.equal(fetchLines.length, 2);
  assert.ok(
    fetchLines.every((line) => /BODY\.PEEK\[\]<0\.\d+>/.test(line)),
    "每封都只取有界预览：" + fetchLines.join(" | "),
  );
  assert.ok(fetchLines[1].includes("BODY.PEEK[]<0.65536>"), fetchLines[1]);
  assert.ok(
    !fetchLines.some((line) => /RFC822(?!\.SIZE)/.test(line)),
    "不许 RFC822 整包下载",
  );
  assert.ok(
    !fetchLines.some((line) => /BODY\[\]/.test(line)),
    "不许整封 BODY[] 下载",
  );
  assert.equal(
    stub.state.commandLog.filter((line) => /\bSTORE\b/.test(line)).length,
    0,
    "收信流程不许改 FLAGS",
  );
  assert.deepEqual(
    stub.state.flagsOf("INBOX", 1),
    [],
    "服务器端 FLAGS 原样未动",
  );
});

test("v2/4 服务器没有 MOVE/UIDPLUS 时绝不发全局 EXPUNGE；移动失败如实记账", async (t) => {
  const spam = eml({
    fromAddr: "deal@promo.example.com",
    date: DAY,
    subject: "限时优惠最后一天",
    messageId: "<d3@e>",
    body: "限时优惠，最后一天，错过不再。",
    extraHeaders: ["Precedence: bulk"],
  });
  const stub = await startStub(t, {
    users: { alice: PASS },
    messages: [spam],
    mailboxes: FOLDERS,
    capabilities: ["imap4rev1"],
  });
  const dir = tmpDir("mguard-v2-noexpunge-");
  const { pipeline, state, index } = buildPipeline({
    port: stub.port,
    stateDir: dir,
    settings: settingsFor(stub.port, { automation: { moveRules: true } }),
    now: () => new Date(NOW12),
  });
  state.addRule({
    kind: "domain",
    value: "promo.example.com",
    action: "drop",
    note: "这类以后直接扔",
  });

  const result = await pipeline.fetch({});
  const outcome = result.accounts[0];
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.moved, 0);
  assert.equal(outcome.actionErrors.length, 1);
  assert.match(outcome.actionErrors[0], /未能移动/);
  const entry = index.entries.find((e) => e.messageId === "<d3@e>");
  assert.equal(entry.judgment.action, "move-failed", "移不动要如实记账");
  assert.equal(entry.judgment.target, null);
  assert.ok(stub.state.uidsOf("INBOX").includes(1), "移动失败原文必须留在原处");
  assert.equal(
    stub.state.commandLog.filter((line) =>
      /EXPUNGE|UID COPY|\bSTORE\b/.test(line),
    ).length,
    0,
    "没有 MOVE/UIDPLUS 时不许退回 COPY+EXPUNGE：" +
      stub.state.commandLog.join(" | "),
  );

  // 低层复核：客户端直接拒绝"不安全的移动"，一个命令都不发
  const client = new ImapClient({
    host: "127.0.0.1",
    port: stub.port,
    secure: false,
    timeoutMs: 3000,
  });
  try {
    await client.connect();
    await client.login("alice", PASS);
    await client.select("INBOX");
    const before = stub.state.commandLog.length;
    await assert.rejects(
      client.uidMove([1], "垃圾箱"),
      (error) =>
        error instanceof ImapError &&
        error.kind === "protocol" &&
        /MOVE or UIDPLUS/.test(error.message),
    );
    assert.equal(
      stub.state.commandLog.length,
      before,
      "拒绝移动时应一个命令都不发",
    );
  } finally {
    client.destroy();
  }
});

/* ----------------------------------------------------------------------------------------- *
 * 5. Automation defaults, manual move confirmation, pending answers
 * ----------------------------------------------------------------------------------------- */

test("v2/5 自动移动默认关闭：只有显式发件域 drop 规则才放行（启发式独立开关）", async (t) => {
  const spam1 = eml({
    fromAddr: "deal@promo.example.com",
    date: "Mon, 12 Oct 2026 08:00:00 +0800",
    subject: "限时优惠最后一天",
    messageId: "<e1-1@e>",
    body: "限时优惠，最后一天，错过不再。",
    extraHeaders: ["Precedence: bulk"],
  });
  const spam2 = eml({
    fromAddr: "deal@promo.example.com",
    date: "Mon, 12 Oct 2026 08:30:00 +0800",
    subject: "限时优惠再来一天",
    messageId: "<e1-2@e>",
    body: "限时优惠，最后一天，错过不再。",
    extraHeaders: ["Precedence: bulk"],
  });
  const spam3 = eml({
    fromAddr: "deal@promo2.example.com",
    date: "Mon, 12 Oct 2026 09:00:00 +0800",
    subject: "限时优惠还剩一天",
    messageId: "<e1-3@e>",
    body: "限时优惠，最后一天，错过不再。",
    extraHeaders: ["Precedence: bulk"],
  });
  const stub = await startStub(t, {
    users: { alice: PASS },
    messages: [spam1],
    mailboxes: FOLDERS,
  });
  const dir = tmpDir("mguard-v2-automation-");
  const clock = () => new Date(NOW12);

  assert.equal(
    settingsFor(stub.port).automation.moveRules,
    false,
    "规则移动默认必须是关的",
  );
  assert.equal(
    settingsFor(stub.port).automation.moveHeuristics,
    false,
    "启发式移动默认必须是关的",
  );

  const first = buildPipeline({
    port: stub.port,
    stateDir: dir,
    settings: settingsFor(stub.port, { automation: { moveRules: true } }),
    now: clock,
  });
  const firstFetch = await first.pipeline.fetch({});
  assert.equal(
    firstFetch.accounts[0].ok,
    true,
    JSON.stringify(firstFetch.accounts[0]),
  );
  assert.equal(
    firstFetch.accounts[0].moved,
    0,
    "moveRules 开着也不许对启发式垃圾动手",
  );
  assert.equal(
    stub.state.commandLog.filter((line) => /UID MOVE|UID COPY/.test(line))
      .length,
    0,
  );
  assert.ok(stub.state.uidsOf("INBOX").includes(1), "原文必须还在收件箱");
  const judgment1 = first.index.entries.find(
    (e) => e.messageId === "<e1-1@e>",
  ).judgment;
  assert.equal(judgment1.verdict, "spam");
  assert.equal(judgment1.action, "none", "没有显式规则时只能分类，不许移动");

  // 显式"这类以后直接扔"（发件域 drop 规则）+ 同域名新信 -> 才放行自动移动
  first.state.addRule({
    kind: "domain",
    value: "promo.example.com",
    action: "drop",
    note: "这类以后直接扔",
  });
  addStubMessage(stub, spam2, new Date("2026-10-12T00:30:00Z"));
  const second = await first.pipeline.fetch({});
  assert.equal(
    second.accounts[0].moved,
    1,
    "显式域名 drop 规则 + moveRules:true 才允许自动移动",
  );
  assert.ok(!stub.state.uidsOf("INBOX").includes(2));
  assert.equal(stub.state.messagesOf("垃圾箱").length, 1);
  assert.ok(
    String(stub.state.messagesOf("垃圾箱")[0].raw).includes("<e1-2@e>"),
  );
  const judgment2 = first.index.entries.find(
    (e) => e.messageId === "<e1-2@e>",
  ).judgment;
  assert.equal(judgment2.action, "moved");
  assert.equal(judgment2.target, "垃圾箱");
  const moveLine = stub.state.commandLog.find((line) => /UID MOVE/.test(line));
  assert.ok(moveLine, "应发出 UID MOVE");
  assert.ok(
    !/垃圾箱/.test(moveLine),
    "目标文件夹要走 modified UTF-7：" + moveLine,
  );

  // 启发式移动是独立开关：打开以后，没有规则的启发式垃圾也才允许移动
  addStubMessage(stub, spam3, new Date("2026-10-12T01:00:00Z"));
  const heuristicPipeline = buildPipeline({
    port: stub.port,
    stateDir: dir,
    settings: settingsFor(stub.port, {
      automation: { moveRules: true, moveHeuristics: true },
    }),
    now: clock,
  });
  const third = await heuristicPipeline.pipeline.fetch({});
  assert.equal(
    third.accounts[0].moved,
    1,
    "moveHeuristics:true 时才允许启发式移动",
  );
  assert.ok(!stub.state.uidsOf("INBOX").includes(3));
});

test("v2/5 手工移动必须带 confirm:true；没确认之前一个命令都不发", async (t) => {
  const stub = await startStub(t, {
    users: { alice: PASS },
    messages: [personalMail("<e2@e>", "正经信")],
    mailboxes: FOLDERS,
  });
  const dir = tmpDir("mguard-v2-move-");
  const { pipeline } = buildPipeline({
    port: stub.port,
    stateDir: dir,
    now: () => new Date(NOW12),
  });

  const refused = await pipeline.move({
    account: "test",
    uid: 1,
    to: "垃圾箱",
    confirm: false,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.moved, false);
  assert.match(refused.message, /确认/);
  assert.equal(stub.state.connections, 0, "没确认时不该连服务器");
  assert.equal(stub.state.commandLog.length, 0, "没确认时不该发任何命令");

  const done = await pipeline.move({
    account: "test",
    uid: 1,
    to: "垃圾箱",
    confirm: true,
  });
  assert.equal(done.ok, true, done.message);
  assert.match(done.message, /找回/, "移动是可找回的，不能是删除");
  assert.ok(stub.state.commandLog.some((line) => /^UID MOVE/.test(line)));
  assert.ok(!stub.state.uidsOf("INBOX").includes(1));
  assert.equal(stub.state.messagesOf("垃圾箱").length, 1);
});

test("v2/5 待定回收：answer 取值校验；没确认不动原文也不销条目", async (t) => {
  const stub = await startStub(t, {
    users: { alice: PASS },
    messages: [
      eml({
        fromAddr: "sales@vendor.example.net",
        date: DAY,
        subject: "中奖通知",
        messageId: "<e3-1@e>",
      }),
    ],
    mailboxes: FOLDERS,
  });
  const dir = tmpDir("mguard-v2-pending-");
  const { pipeline, state } = buildPipeline({
    port: stub.port,
    stateDir: dir,
    now: () => new Date(NOW12),
  });
  const item = state.enqueuePending({
    account: "test",
    mailbox: "INBOX",
    uid: 1,
    uidValidity: "1",
    messageId: "<e3-1@e>",
    from: "某公司",
    address: "sales@vendor.example.net",
    subject: "中奖通知",
    date: NOW12.toISOString(),
    reason: "拿不准",
    question: "[测试邮箱] 某公司《中奖通知》：留还是扔？",
  });

  await assert.rejects(
    pipeline.answerPending({ id: item.id, answer: "delete" }),
    /invalid answer/,
  );
  assert.equal(pipeline.pending().pending.length, 1, "取值非法时条目不能动");

  const unprepared = await pipeline.answerPending({
    id: item.id,
    answer: "drop",
    confirm: false,
  });
  assert.equal(unprepared.ok, false);
  assert.equal(pipeline.pending().pending.length, 1, "没确认时条目不能销");
  assert.equal(
    stub.state.commandLog.filter((line) => /UID MOVE|UID COPY/.test(line))
      .length,
    0,
    "没确认时原文不能动",
  );
  assert.ok(stub.state.uidsOf("INBOX").includes(1));

  const dropped = await pipeline.answerPending({
    id: item.id,
    answer: "drop",
    confirm: true,
  });
  assert.equal(dropped.ok, true, dropped.message);
  assert.equal(pipeline.pending().pending.length, 0);
  assert.equal(stub.state.messagesOf("垃圾箱").length, 1);
  assert.ok(!stub.state.uidsOf("INBOX").includes(1));

  // keep = 只在本机销条目，不碰邮箱
  const item2 = state.enqueuePending({
    account: "test",
    mailbox: "INBOX",
    uid: 2,
    uidValidity: "1",
    messageId: "<e3-2@e>",
    from: "某公司",
    address: "sales@vendor.example.net",
    subject: "再来一封",
    date: NOW12.toISOString(),
    reason: "拿不准",
    question: "[测试邮箱] 某公司《再来一封》：留还是扔？",
  });
  const connectionsBefore = stub.state.connections;
  const kept = await pipeline.answerPending({ id: item2.id, answer: "keep" });
  assert.equal(kept.ok, true);
  assert.match(kept.message, /原邮件未动/);
  assert.equal(pipeline.pending().pending.length, 0);
  assert.equal(
    stub.state.connections,
    connectionsBefore,
    "keep 不需要连服务器",
  );
});
