// dsh-mail-guardian — lib/brief.js
//
// The daily briefing and the one-line explanations. Plain language only:
// no status codes, no log dumps, no jargon. Important mail first, ads in one
// sentence, uncertain mail as a human question.

const GREETINGS = {
  caring: [
    ["早上好", 5, 11],
    ["上午好", 11, 12],
    ["中午好", 12, 14],
    ["下午好", 14, 18],
    ["晚上好", 18, 23],
    ["夜深了", 23, 24],
    ["还没睡呀", 0, 5],
  ],
  concise: [["", 0, 24]],
  formal: [["您好", 0, 24]],
};

function greeting(style, hour) {
  const table = GREETINGS[style] ?? GREETINGS.caring;
  for (const [text, from, to] of table) {
    if (hour >= from && hour < to) return text;
  }
  return "";
}

function senderLine(item) {
  const from = item.record?.from ?? {};
  return from.name || from.address || "未知发件人";
}

function oneLine(text, max = 40) {
  const clean = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Build the daily briefing.
 *
 * @param {object} input
 *   items: [{ record, judgment }] — everything judged since the last brief
 *   pending: pending queue entries
 *   settings: resolved settings
 *   now: Date
 * @returns {{ text: string, counts: object }}
 */
export function buildBrief({
  items = [],
  pending = [],
  settings,
  now = new Date(),
}) {
  const style = settings?.style ?? "caring";
  const hour = settings?.timeZone ? Number(new Intl.DateTimeFormat("en", {timeZone:settings.timeZone,hour:"numeric",hourCycle:"h23"}).format(now)) : now.getHours();
  const hi = greeting(style, hour);

  const groups = { important: [], normal: [], low: [], spam: [], pending: [] };
  for (const item of items) {
    const verdict = item.judgment?.verdict ?? "normal";
    (groups[verdict] ?? groups.normal).push(item);
  }
  for (const entry of pending)
    groups.pending.push({
      record: {
        from: { name: entry.from },
        subject: entry.subject,
        date: entry.date,
      },
      judgment: { verdict: "pending", reason: entry.reason },
    });

  const lines = [];
  const important = groups.important.slice(0, 5);
  const counts = {
    important: groups.important.length,
    normal: groups.normal.length,
    low: groups.low.length,
    spam: groups.spam.length,
    pending: groups.pending.length,
  };

  if (
    counts.important === 0 &&
    counts.normal === 0 &&
    counts.low === 0 &&
    counts.spam === 0 &&
    counts.pending === 0
  ) {
    return {
      text: `${hi ? hi + "。" : ""}今天没有新邮件，安心忙你的。`,
      counts,
    };
  }

  if (important.length > 0) {
    lines.push(`今天有 ${counts.important} 封值得看：`);
    for (const item of important) {
      const why = item.judgment?.reason
        ? `（${oneLine(item.judgment.reason, 24)}）`
        : "";
      lines.push(
        `· ${senderLine(item)}的《${oneLine(item.record?.subject, 30)}》${why}`,
      );
    }
  } else if (counts.normal > 0) {
    lines.push(`今天有 ${counts.normal} 封正常来信，都不是急事。`);
  }

  const extras = [];
  if (counts.normal > 0 && important.length > 0)
    extras.push(`${counts.normal} 封正常来信`);
  if (counts.low > 0) extras.push(`${counts.low} 封广告和订阅，已归进"低优先"`);
  if (counts.spam > 0)
    extras.push(`${counts.spam} 封垃圾邮件，已经拦下（原文都在，想翻随时说）`);
  if (extras.length > 0) lines.push(`另外 ${extras.join("，")}。`);

  // 被拦下的钓鱼/冒充信要说明"拦了什么、为什么"（规格硬要求），普通垃圾只报数字
  const flagged = groups.spam.filter(
    (it) => it.judgment?.flags?.phishing || it.judgment?.flags?.impersonation,
  );
  for (const item of flagged.slice(0, 3)) {
    const kind = item.judgment.flags.impersonation ? "冒充熟人的" : "像钓鱼的";
    lines.push(
      `⚠ 特别提醒：拦下一封${kind}《${oneLine(item.record?.subject, 26)}》，${oneLine(item.judgment?.reason, 26)}。`,
    );
  }

  if (groups.pending.length > 0) {
    const first = groups.pending[0];
    lines.push(
      `还有 ${counts.pending} 封拿不准的，等你一句话：${senderLine(first)}的《${oneLine(first.record?.subject, 26)}》看着像广告又像正事，留还是扔？`,
    );
  }

  const head = hi ? `${hi}。` : "";
  return { text: head + lines.join("\n"), counts };
}

/**
 * One-line explanation of an automatic action ("做了什么、为什么").
 */
export function explainAction(judgment, target) {
  const what =
    {
      "file-spam": "已放进垃圾箱",
      "file-low": "已归进低优先",
      notify: "留在收件箱",
      ask: "原封没动，先问你",
      none: "没动",
    }[judgment?.action ?? "none"] ?? "没动";
  const why = judgment?.reason ? `，因为${judgment.reason}` : "";
  return `${what}${why}${target ? `（在"${target}"里可找回）` : ""}`;
}
