// dsh-mail-guardian — test/brief.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildBrief, explainAction } from "../lib/brief.js";
import { resolveSettings } from "../lib/config.js";

const settings = resolveSettings({ timeZone: "Asia/Shanghai" });

function item(from, subject, verdict, reason = "") {
  return {
    record: {
      from: { name: from, address: "", domain: "" },
      subject,
      date: "2026-10-11T09:00:00+08:00",
    },
    judgment: { verdict, reason, action: "notify" },
  };
}

test("简报：重要的排最前，广告一句话带过", () => {
  const { text, counts } = buildBrief({
    items: [
      item("特价商城", "限时优惠", "spam"),
      item("妈妈", "生日提醒", "important", "像是要紧的来信"),
      item("周刊", "本周精选", "low"),
    ],
    pending: [],
    settings,
    now: new Date("2026-10-11T08:05:00+08:00"),
  });
  const firstLine = text.split("\n").find((l) => l.includes("值得看"));
  assert.ok(firstLine, text);
  assert.ok(text.indexOf("值得看") < text.indexOf("另外"), "重要的要在前");
  assert.ok(text.includes("妈妈") && text.includes("生日提醒"), text);
  assert.ok(!text.includes("限时优惠"), "普通广告只报数字，不占篇幅");
  assert.equal(counts.important, 1);
  assert.equal(counts.low, 1);
  assert.equal(counts.spam, 1);
  assert.ok(text.includes("垃圾"), text);
});

test("简报：被拦的钓鱼/冒充信点名说明为什么", () => {
  const { text } = buildBrief({
    items: [
      item(
        "妈妈",
        "帮我转 2000 块",
        "spam",
        "显示名冒充熟人，发件域名却对不上",
      ),
    ],
    pending: [],
    settings,
    now: new Date("2026-10-11T08:05:00+08:00"),
  });
  const flaggedItem = {
    record: {
      from: { name: "妈妈", address: "", domain: "" },
      subject: "帮我转 2000 块",
      date: "2026-10-11T09:00:00+08:00",
    },
    judgment: {
      verdict: "spam",
      reason: "显示名冒充熟人，发件域名却对不上",
      action: "file-spam",
      flags: { impersonation: true },
    },
  };
  const brief2 = buildBrief({
    items: [flaggedItem],
    pending: [],
    settings,
    now: new Date("2026-10-11T08:05:00+08:00"),
  });
  assert.ok(brief2.text.includes("特别提醒"), brief2.text);
  assert.ok(brief2.text.includes("冒充"), brief2.text);
  assert.ok(text.length > 0);
});

test("简报：待定邮件用人话提问", () => {
  const { text } = buildBrief({
    items: [],
    pending: [
      {
        from: "某公司",
        subject: "合作方案",
        question: "某公司那封《合作方案》看着像广告又像正事，留还是扔？",
        reason: "拿不准",
      },
    ],
    settings,
    now: new Date("2026-10-11T08:00:00+08:00"),
  });
  assert.ok(text.includes("留还是扔"), text);
});

test("简报：没邮件就说没邮件", () => {
  const { text } = buildBrief({
    items: [],
    pending: [],
    settings,
    now: new Date("2026-10-11T08:00:00+08:00"),
  });
  assert.ok(text.includes("没有新邮件"), text);
});

test("语气可配置，问候随时间段变化", () => {
  const morning = buildBrief({
    items: [],
    pending: [],
    settings,
    now: new Date("2026-10-11T08:00:00+08:00"),
  });
  assert.ok(morning.text.startsWith("早上好"), morning.text);
  const formal = buildBrief({
    items: [],
    pending: [],
    settings: { ...settings, style: "formal" },
    now: new Date("2026-10-11T08:00:00+08:00"),
  });
  assert.ok(formal.text.startsWith("您好"), formal.text);
});

test("自动处置解释是一句人话，不含状态码", () => {
  const line = explainAction(
    { action: "file-spam", reason: "看手法像钓鱼诈骗" },
    "垃圾箱",
  );
  assert.ok(line.includes("垃圾箱"));
  assert.ok(line.includes("因为"));
  assert.ok(!/\b(200|404|ERR_|Error)\b/.test(line));
});
