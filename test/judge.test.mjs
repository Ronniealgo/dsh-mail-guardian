// dsh-mail-guardian — test/judge.test.mjs
// The three-layer judgment is the plugin's soul. These tests pin the safety
// rules: whitelisted senders are never blocked, gray mail is never moved.

import test from "node:test";
import assert from "node:assert/strict";
import {
  judgeMail,
  scoreMail,
  ACTION_BY_VERDICT,
  isRiskyExtension,
} from "../lib/judge.js";
import { resolveSettings } from "../lib/config.js";

function makeRecord(overrides = {}) {
  return {
    account: "test",
    mailbox: "INBOX",
    uid: 1,
    from: { name: "", address: "someone@example.com", domain: "example.com" },
    to: [{ name: "", address: "me@example.net" }],
    cc: [],
    replyTo: [],
    subject: "你好",
    date: "2026-10-11T08:00:00+08:00",
    textBody: "这是一封正常的信。",
    htmlBody: null,
    links: [],
    attachments: [],
    hasRemoteImages: false,
    auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
    headers: {
      messageId: "<m@example.com>",
      listUnsubscribe: null,
      returnPath: null,
      receivedCount: 1,
      precedence: null,
    },
    ...overrides,
  };
}

function settings(overrides = {}) {
  return resolveSettings({
    accounts: [
      {
        id: "test",
        host: "imap.example.com",
        username: "me",
        credentialRef: "MAIL_TEST",
      },
    ],
    ...overrides,
  });
}

const baseState = { rules: [], contacts: [], history: {} };

test("正常往来：零误拦，判定为重要/正常且动作为提醒", async () => {
  const record = makeRecord({
    from: { name: "妈妈", address: "mom@example.com", domain: "example.com" },
    subject: "生日提醒",
    textBody: "这周日回家吃饭。",
  });
  const state = {
    ...baseState,
    history: {
      "mom@example.com": { sent: 1, replied: 3, read: 10, lastSeen: null },
    },
  };
  const judgment = await judgeMail(record, { settings: settings(), state });
  assert.ok(
    ["important", "normal"].includes(judgment.verdict),
    `got ${judgment.verdict}`,
  );
  assert.notEqual(judgment.action, "file-spam");
  assert.notEqual(judgment.action, "ask");
});

test("白名单发件人永不禁拦（即使长得像钓鱼）", async () => {
  const record = makeRecord({
    from: {
      name: "银行客服",
      address: "boss@example.com",
      domain: "example.com",
    },
    subject: "请提供验证码",
    textBody: "账户异常，请提供验证码并点击链接登录。",
    links: [
      {
        href: "http://192.0.2.1/login",
        text: "点此登录",
        host: "192.0.2.1",
        isShortener: false,
      },
    ],
  });
  const state = {
    ...baseState,
    rules: [
      {
        kind: "address",
        value: "boss@example.com",
        action: "keep",
        note: "重要客户",
      },
    ],
  };
  const judgment = await judgeMail(record, { settings: settings(), state });
  assert.equal(judgment.verdict, "important");
  assert.equal(judgment.action, "notify");
});

test("伪造发件人（显示名冒充熟人、域名对不上）→ 拦下并标记冒充", async () => {
  const record = makeRecord({
    from: {
      name: "妈妈",
      address: "attacker@example.org",
      domain: "example.org",
    },
    subject: "帮我个忙",
    textBody: "手机坏了，先转我 2000 块。",
  });
  const state = {
    ...baseState,
    contacts: [{ name: "妈妈", domain: "example.com" }],
  };
  const judgment = await judgeMail(record, { settings: settings(), state });
  assert.equal(judgment.verdict, "spam");
  assert.equal(judgment.flags.impersonation, true);
  assert.equal(judgment.action, "file-spam");
  assert.ok(judgment.reason.length > 0);
});

test("钓鱼特征（索要验证码＋链接文字与真网址不符）→ 拦下", async () => {
  const record = makeRecord({
    from: {
      name: "某银行",
      address: "notice@evil.example.net",
      domain: "evil.example.net",
    },
    subject: "账户异常，请尽快处理",
    textBody: "您的账户异常，请点击下方链接登录并提供验证码完成安全验证。",
    links: [
      {
        href: "http://evil.example.net/login",
        text: "https://bank.example.com/login",
        host: "evil.example.net",
        isShortener: false,
      },
    ],
  });
  const judgment = await judgeMail(record, {
    settings: settings(),
    state: baseState,
  });
  assert.equal(judgment.verdict, "spam");
  assert.equal(judgment.flags.phishing, true);
});

test("无可退订方式的群发营销 → 直接归垃圾", async () => {
  const record = makeRecord({
    from: {
      name: "特价商城",
      address: "promo@shop.example.net",
      domain: "shop.example.net",
    },
    subject: "限时优惠最后一天",
    textBody: "免费领取大礼包，点击领取！",
    headers: {
      messageId: "<p1@shop.example.net>",
      listUnsubscribe: null,
      returnPath: null,
      receivedCount: 3,
      precedence: "bulk",
    },
  });
  const judgment = await judgeMail(record, {
    settings: settings(),
    state: baseState,
  });
  assert.equal(judgment.verdict, "spam");
  assert.equal(judgment.flags.marketing, true);
});

test("有退订方式的订阅/广告 → 归低优先，不进垃圾箱", async () => {
  const record = makeRecord({
    from: {
      name: "周刊",
      address: "news@letter.example.com",
      domain: "letter.example.com",
    },
    subject: "本周精选内容",
    textBody: "本周精选，退订请回信。",
    headers: {
      messageId: "<l1@letter.example.com>",
      listUnsubscribe: "<mailto:unsub@letter.example.com>",
      returnPath: null,
      receivedCount: 2,
      precedence: "bulk",
    },
  });
  const judgment = await judgeMail(record, {
    settings: settings(),
    state: baseState,
  });
  assert.equal(judgment.verdict, "low");
  assert.equal(judgment.action, "file-low");
});

test("灰区邮件进待定、一个字都不动，且默认不调模型", async () => {
  const record = makeRecord({
    from: {
      name: "某公司",
      address: "sales@vendor.example.net",
      domain: "vendor.example.net",
    },
    subject: "中奖通知，点击领取",
    textBody: "恭喜中奖，请尽快点击领取。",
    links: [
      {
        href: "https://a.example.net/x",
        text: "领取",
        host: "a.example.net",
        isShortener: false,
      },
    ],
    links2: undefined,
  });
  record.links.push({
    href: "https://b.example.net/y",
    text: "领取",
    host: "b.example.net",
    isShortener: false,
  });
  let modelCalled = false;
  const judgment = await judgeMail(record, {
    settings: settings(),
    state: baseState,
    modelJudge: async () => {
      modelCalled = true;
      return { verdict: "spam", reason: "不该被调用" };
    },
  });
  assert.equal(
    judgment.verdict,
    "pending",
    `score=${judgment.score} verdict=${judgment.verdict}`,
  );
  assert.equal(judgment.action, "ask");
  assert.equal(ACTION_BY_VERDICT.pending, "ask");
  assert.equal(modelCalled, false);
});

test("开启模型仲裁后灰区交给模型，返回一句话理由", async () => {
  const record = makeRecord({
    from: {
      name: "某公司",
      address: "sales@vendor.example.net",
      domain: "vendor.example.net",
    },
    subject: "中奖通知，点击领取",
    textBody: "恭喜中奖，请尽快点击领取。",
  });
  const judgment = await judgeMail(record, {
    settings: settings({ modelJudge: { enabled: true } }),
    state: baseState,
    modelJudge: async () => ({ verdict: "low", reason: "像是订阅推广" }),
  });
  assert.equal(judgment.verdict, "low");
  assert.equal(judgment.layer, "model");
  assert.equal(judgment.modelReason, "像是订阅推广");
});

test("模型仲裁抛错或返回垃圾值时退回待定，绝不硬判", async () => {
  const record = makeRecord({
    from: {
      name: "某公司",
      address: "sales@vendor.example.net",
      domain: "vendor.example.net",
    },
    subject: "中奖通知，点击领取",
    textBody: "恭喜中奖，请尽快点击领取。",
  });
  for (const modelJudge of [
    async () => {
      throw new Error("boom");
    },
    async () => ({ verdict: "destroy", reason: "乱来" }),
  ]) {
    const judgment = await judgeMail(record, {
      settings: settings({ modelJudge: { enabled: true } }),
      state: baseState,
      modelJudge,
    });
    assert.ok(
      ["pending", "low"].includes(judgment.verdict),
      `got ${judgment.verdict}`,
    );
  }
});

test("学到的规则：drop 直接归垃圾并带上人话理由", async () => {
  const record = makeRecord({
    from: {
      name: "促销",
      address: "promo@shop.example.net",
      domain: "shop.example.net",
    },
    subject: "又来了",
  });
  const state = {
    ...baseState,
    rules: [
      {
        kind: "domain",
        value: "shop.example.net",
        action: "drop",
        note: "这类以后直接扔",
      },
    ],
  };
  const judgment = await judgeMail(record, { settings: settings(), state });
  assert.equal(judgment.verdict, "spam");
  assert.ok(judgment.reason.includes("这类以后直接扔"));
});

test("打分：危险附件、短链、认证失败都会推高分数并给出理由", () => {
  const record = makeRecord({
    auth: { spf: "fail", dkim: "fail", dmarc: "fail" },
    links: [
      {
        href: "https://bit.ly/x",
        text: "点我",
        host: "bit.ly",
        isShortener: true,
      },
    ],
    attachments: [
      {
        filename: "invoice.exe",
        size: 100,
        contentType: "application/octet-stream",
        riskyExt: true,
      },
    ],
    textBody: "免费领取，限时优惠",
  });
  const { score, reasons } = scoreMail(record, baseState);
  assert.ok(score >= 55, `score=${score}`);
  assert.ok(reasons.length >= 3);
  assert.ok(isRiskyExtension("a.EXE") && !isRiskyExtension("a.pdf"));
});

test("服务通知（GitHub/CI 回复）永不当垃圾拦：群发痕迹+没退订也不拦", async () => {
  const record = makeRecord({
    from: {
      name: "github-actions[bot]",
      address: "notifications@github.com",
      domain: "github.com",
    },
    subject: "Re: [2BingLing/dsh-market] [提交插件] dsh-find-file (Issue #226)",
    textBody:
      "机器人回复：已收录。详情见页面 https://dsh.market/?plugin=x https://github.com/x/y",
    links: Array.from({ length: 12 }, (_, i) => ({
      href: `https://github.com/x/${i}`,
      text: "link",
      host: "github.com",
      isShortener: false,
    })),
    headers: {
      messageId: "<n@github.com>",
      listUnsubscribe: null,
      returnPath: null,
      receivedCount: 3,
      precedence: "bulk",
    },
  });
  const judgment = await judgeMail(record, {
    settings: settings(),
    state: baseState,
  });
  assert.notEqual(judgment.verdict, "spam", JSON.stringify(judgment));
  assert.notEqual(judgment.verdict, "low", "服务通知也不该进低优先");
  assert.equal(judgment.verdict, "normal");
});

test("CI 失败通知与验证码通知都留在收件箱", async () => {
  for (const [fromAddr, subject] of [
    ["notifications@github.com", "Run failed: ci - main (d9693d3)"],
    ["noreply@aliyun.com", "域名邮箱验证码"],
    ["noreply@npmjs.com", "[npm] Granular access token created"],
  ]) {
    const record = makeRecord({
      from: { name: "通知", address: fromAddr, domain: fromAddr.split("@")[1] },
      subject,
      textBody:
        "这是一条自动通知，正文有一些链接 https://example.com/a https://example.com/b",
      headers: {
        messageId: "<t@example.com>",
        listUnsubscribe: null,
        returnPath: null,
        receivedCount: 2,
        precedence: "bulk",
      },
    });
    const judgment = await judgeMail(record, {
      settings: settings(),
      state: baseState,
    });
    assert.notEqual(judgment.verdict, "spam", subject + " 被误拦了");
  }
});

test("回归保护：没退订的营销广告仍然照拦", async () => {
  const record = makeRecord({
    from: {
      name: "特价商城",
      address: "promo@shop.example.net",
      domain: "shop.example.net",
    },
    subject: "限时优惠最后一天",
    textBody: "免费领取大礼包，点击领取！",
    headers: {
      messageId: "<p2@shop.example.net>",
      listUnsubscribe: null,
      returnPath: null,
      receivedCount: 3,
      precedence: "bulk",
    },
  });
  const judgment = await judgeMail(record, {
    settings: settings(),
    state: baseState,
  });
  assert.equal(judgment.verdict, "spam");
});

test("分数永远夹在 0..100", () => {
  const harsh = scoreMail(
    makeRecord({
      auth: { spf: "fail", dkim: "fail", dmarc: "fail" },
      textBody: "中奖 免费领取 代开发票 贷款 验证码 urgent claim now winner",
      attachments: [
        { filename: "a.exe", size: 1, contentType: "x", riskyExt: true },
      ],
      links: Array.from({ length: 20 }, (_, i) => ({
        href: `https://x${i}.example.net/`,
        text: "x",
        host: `x${i}.example.net`,
        isShortener: true,
      })),
    }),
    baseState,
  );
  assert.ok(harsh.score <= 100 && harsh.score >= 0);
  const gentle = scoreMail(makeRecord(), {
    ...baseState,
    history: {
      "someone@example.com": { sent: 2, replied: 5, read: 20, lastSeen: null },
    },
  });
  assert.ok(gentle.score >= 0 && gentle.score <= 100, `score=${gentle.score}`);
});
