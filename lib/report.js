import { lockActive } from "./persistence.js";
import path from "node:path";
export function dayKey(value, timeZone) {
  const d = new Date(value);
  if (Number.isNaN(+d)) return null;
  const parts = new Intl.DateTimeFormat("en", { timeZone, year:"numeric",month:"2-digit",day:"2-digit" }).formatToParts(d);
  const fields = Object.fromEntries(parts.map(p => [p.type,p.value]));
  return fields.year + "-" + fields.month + "-" + fields.day;
}
export function buildCachedReport({
  settings,
  state,
  index,
  range = "today",
  style = null,
  account = null,
  now = new Date(),
}) {
  if (!["today", "3d", "week"].includes(range))
    throw new TypeError("range must be today | 3d | week");
  state.reload?.();
  index.reload?.();
  const zone =
    settings.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = dayKey(now, zone);
  const days = range === "today" ? 1 : range === "3d" ? 3 : 7;
  const calendar = new Date(today + "T12:00:00Z");
  calendar.setUTCDate(calendar.getUTCDate() - (days - 1));
  const begin = calendar.toISOString().slice(0,10);
  const tone = style ?? settings.style;
  if (!["caring","concise","formal"].includes(tone)) throw new TypeError("invalid report style");
  const wanted = settings.accounts.filter((a) => !account || a.id === account);
  const busy = lockActive(
    path.join(path.dirname(state.statePath), "sync.lock"),
  );
  const accounts = wanted.map((a) => {
    const cp = state.checkpoint(a.id);
    const success = cp.lastSuccessAt ?? (cp.lastError ? null : cp.lastFetchAt);
    const age = success ? +now - Date.parse(success) : Infinity;
    let status = cp.lastError
      ? "error"
      : !success
        ? "uninitialized"
        : age > settings.sync.pollIntervalMs * 2
          ? "stale"
          : "ready";
    if (cp.remainingUids?.length || cp.partial) status = "partial";
    if (busy) status = "syncing";
    if (state.loadError || index.loadError) status = "cache-error";
    return {
      account: a.id,
      label: a.label,
      address: a.username,
      status,
      lastSyncedAt: success ?? null,
      error: cp.lastError ?? state.loadError ?? index.loadError ?? null,
      remaining: cp.remainingUids?.length ?? 0,
    };
  });
  const ids = new Set(wanted.map((a) => a.id));
  const pending = state.listPending().filter((p) => ids.has(p.account));
  const unresolved = new Set(pending.map((p) => p.account + ":" + p.uid));
  const entries = index.entries
    .filter((e) => ids.has(e.account))
    .filter((e) => {
      const key = dayKey(e.receivedAt ?? e.date, zone);
      return key && key >= begin && key <= today;
    })
    .map((e) => {
      const a = wanted.find((a) => a.id === e.account);
      const j = e.judgment ?? { verdict: "normal" };
      return {
        ...e,
        accountLabel: a.label,
        accountAddress: a.username,
        judgment: {
          ...j,
          verdict:
            j.verdict === "pending" && !unresolved.has(e.account + ":" + e.uid)
              ? "normal"
              : j.verdict,
        },
      };
    })
    .sort(
      (a, b) =>
        Date.parse(b.receivedAt ?? b.date) - Date.parse(a.receivedAt ?? a.date),
    );
  const counts = {
    important: 0,
    normal: 0,
    low: 0,
    spam: 0,
    pending: pending.length,
  };
  for (const e of entries)
    if (e.judgment.verdict !== "pending")
      counts[e.judgment.verdict in counts ? e.judgment.verdict : "normal"]++;
  const hour = Number(new Intl.DateTimeFormat("en",{timeZone:zone,hour:"numeric",hourCycle:"h23"}).format(now));
  const greeting = tone === "formal" ? "邮件报告：" : tone === "concise" ? "" : hour<12 ? "早上好。" : hour<18 ? "下午好。" : "晚上好。";
  const lines = greeting ? [greeting] : [];
  for (const a of accounts) {
    const stamp = a.lastSyncedAt
      ? new Intl.DateTimeFormat("zh-CN", {
          timeZone: zone,
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date(a.lastSyncedAt))
      : "尚未成功同步";
    const suffix = {
      ready: "已更新",
      syncing: "正在后台更新，先看已有结果",
      partial: "还在补收，当前结果不完整",
      stale: "结果较旧，不能据此断定今天没有新邮件",
      uninitialized: "还没收取成功，不能说没有新邮件",
      error: a.error ?? "收信失败，先显示已有结果",
      "cache-error": "缓存读取失败，不能判断有没有新邮件",
    }[a.status];
    lines.push(
      a.label + "（" + a.address + "）：" + suffix + "；" + stamp + "。",
    );
  }
  const urgent = entries.filter((e) => e.judgment.verdict === "important");
  const normal = entries.filter((e) => e.judgment.verdict === "normal");
  const show = [...urgent, ...normal].slice(0, 8);
  if (show.length) {
    lines.push((range === "today" ? "今天" : "这几天") + "值得看的来信：");
    for (const e of show) {
      const who = e.from.name || e.from.address || "未知发件人";
      lines.push(
        "· [" +
          e.accountLabel +
          "] " +
          who +
          "《" +
          e.subject +
          "》" +
          (e.judgment.verdict === "important" ? "（建议先看）" : "") +
          "，" +
          dayKey(e.receivedAt ?? e.date, zone) +
          "。",
      );
    }
    if (urgent.length + normal.length > show.length)
      lines.push(
        "还有 " +
          (urgent.length + normal.length - show.length) +
          " 封正常来信。",
      );
  } else if (
    accounts.length &&
    accounts.every((a) => a.status === "ready") &&
    !entries.length
  )
    lines.push("已核实：今天没有新邮件。");
  const spam = entries.filter((e) => e.judgment.verdict === "spam");
  const moved = spam.filter((e) => e.judgment.action === "moved").length;
  if (moved)
    lines.push(moved + " 封已按规则移入垃圾箱，原文仍可在邮箱里找回。");
  if (spam.length > moved)
    lines.push(
      spam.length - moved + " 封看着像垃圾邮件，只做了分类，尚未移动。",
    );
  if (counts.low) lines.push(counts.low + " 封广告或订阅已单独分类。");
  if (pending.length) {
    lines.push("有 " + pending.length + " 封待定，原邮件未动：");
    for (const p of pending.slice(0, 5)) {
      const label = wanted.find((a) => a.id === p.account)?.label ?? p.account;
      lines.push(
        "· [" + label + "] " + p.from + "《" + p.subject + "》：留还是扔？",
      );
    }
  }
  return {
    version: 2,
    generatedAt: now.toISOString(),
    day: today,
    timeZone: zone,
    range,
    status: accounts.every((a) => a.status === "ready")
      ? "ready"
      : busy
        ? "syncing"
        : "incomplete",
    accounts,
    counts,
    mails: entries.slice(0, 200),
    pending,
    text: lines.join("\n") || "还没有配置邮箱。",
  };
}
