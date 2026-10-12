// dsh-mail-guardian — lib/judge.js
//
// The three-layer judgment pipeline (hard rules → heuristic score → optional
// model arbitration) and the disposition mapping. This module is the plugin's
// brain: it is SDK-free and pure, so every verdict can be tested offline.
//
// Safety invariants (do not weaken):
//  * a whitelisted sender is NEVER blocked;
//  * an uncertain ("gray") mail is NEVER moved — it goes to "pending" and the
//    user is asked in plain language;
//  * nothing here deletes mail; the caller only ever files it away reversibly.

const SPAM_KEYWORDS = [
  ["免费领取", 6],
  ["中奖", 8],
  ["一等奖", 8],
  ["点击领取", 6],
  ["限时优惠", 5],
  ["代开发票", 10],
  ["发票代开", 10],
  ["贷款", 6],
  ["额度已批", 8],
  ["兼职刷单", 10],
  ["高薪诚聘", 6],
  ["安全验证", 6],
  ["账户异常", 8],
  ["即将冻结", 8],
  ["验证码", 8],
  ["重置密码", 6],
  ["verify your account", 8],
  ["urgent", 5],
  ["winner", 8],
  ["claim now", 8],
];

const PHISH_TRIGGERS = [
  /请.{0,6}(提供|告知|回复).{0,8}(密码|验证码|口令|动态码)/,
  /(转账|汇款|打款).{0,10}(尽快|立即|马上|着急)/,
  /(点击|点开).{0,12}(链接|下方|附件).{0,12}(登录|验证|认证|更新)/,
  /(verify|update|confirm).{0,20}(account|password|billing)/i,
  /账户(将被|即将)(冻结|停用|关闭)/,
];

const URGENT_WORDS =
  /(紧急|立即处理|尽快|最后通牒|24小时内|马上|urgent|immediately)/i;

// 服务通知（GitHub/CI/npm/阿里云这类自动邮件）不是广告：即使"群发痕迹+没退订"
// 也绝不按垃圾处理，最多留在收件箱。真实收信验收抓出来的误拦就是它。
const NOTIFICATION_SUBJECT =
  /(验证码|授权码|一次性密码|\bOTP\b|run failed|workflow|\bci\b|build|deploy|staged|suspended|expiring|token created|token deleted|enabled|verified|\[提交插件\]|\[pull request\]|\[issue\]|discussion|security alert|two-factor|安全提醒|登录提醒|登录通知|修改成功|验证成功|即将到期)/i;
const NOTIFICATION_DOMAINS = [
  "github.com",
  "npmjs.com",
  "githubusercontent.com",
  "aliyun.com",
  "cloudflare.com",
  "google.com",
  "openai.com",
  "chatgpt.com",
  "vercel.com",
  "qq.com",
  "weixin.qq.com",
];
const MARKETING_TONE =
  /(优惠|领取|促销|推广|限时|折扣|福利|免费|清仓|秒杀|sale|offer|deal|unsubscribe|退订)/i;

function isTransactional(record) {
  // 只有"身份没被戳穿"的通知才享受豁免：认证失败的冒充信一样照拦
  const auth = record.auth ?? {};
  const authClean =
    auth.spf !== "fail" &&
    auth.spf !== "softfail" &&
    auth.dkim !== "fail" &&
    auth.dmarc !== "fail";
  if (!authClean) return false;
  if (PHISH_TRIGGERS.some((pattern) => pattern.test(bodyText(record))))
    return false;
  const domain = String(record.from?.domain ?? "").toLowerCase();
  const domainTrusted = NOTIFICATION_DOMAINS.some(
    (d) => domain === d || domain.endsWith("." + d),
  );
  if (domainTrusted) return true;
  return NOTIFICATION_SUBJECT.test(String(record.subject ?? ""));
}

const RISKY_EXTENSIONS = new Set([
  "exe",
  "scr",
  "js",
  "jse",
  "vbs",
  "vbe",
  "bat",
  "cmd",
  "com",
  "pif",
  "lnk",
  "hta",
  "html",
  "htm",
  "docm",
  "xlsm",
  "pptm",
  "msi",
  "reg",
  "ps1",
]);

const SCORE_BANDS = { spamHigh: 80, lowMid: 55, grayMid: 25 };

export function isRiskyExtension(filename) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(filename ?? ""));
  return match ? RISKY_EXTENSIONS.has(match[1].toLowerCase()) : false;
}

function normalizeAddress(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function ruleMatches(entry, record) {
  const value = String(entry.value ?? "")
    .trim()
    .toLowerCase();
  if (!value) return false;
  switch (entry.kind) {
    case "address":
      return normalizeAddress(record.from?.address) === value;
    case "domain":
      return (
        String(record.from?.domain ?? "").toLowerCase() === value ||
        String(record.from?.domain ?? "")
          .toLowerCase()
          .endsWith("." + value)
      );
    case "name":
      return String(record.from?.name ?? "")
        .toLowerCase()
        .includes(value);
    case "keyword":
      return (
        String(record.subject ?? "")
          .toLowerCase()
          .includes(value) ||
        String(record.textBody ?? "")
          .toLowerCase()
          .includes(value)
      );
    default:
      return false;
  }
}

function firstMatchingRule(state, actions, record) {
  const entries = Array.isArray(state?.rules) ? state.rules : [];
  return (
    entries.find(
      (entry) => actions.includes(entry.action) && ruleMatches(entry, record),
    ) || null
  );
}

function interactionOf(state, record) {
  const history = state?.history ?? {};
  const key = normalizeAddress(record.from?.address);
  return history[key] ?? { sent: 0, replied: 0, read: 0, lastSeen: null };
}

function bodyText(record) {
  return [record.subject ?? "", record.textBody ?? ""].join("\n");
}

function collectPhishSignals(record) {
  const signals = [];
  const body = bodyText(record);
  for (const pattern of PHISH_TRIGGERS) {
    if (pattern.test(body)) {
      signals.push("索要密码/验证码或催促转账");
      break;
    }
  }
  const links = Array.isArray(record.links) ? record.links : [];
  const hostMismatch = links.some((link) => {
    const href = String(link?.href ?? "").toLowerCase();
    const text = String(link?.text ?? "").toLowerCase();
    const host = String(link?.host ?? "").toLowerCase();
    return (
      host &&
      text.includes(".") &&
      !text.includes(host) &&
      !href.startsWith("mailto:")
    );
  });
  if (hostMismatch) signals.push("链接文字和实际网址对不上");
  if (
    links.some((link) =>
      /^https?:\/\/\d{1,3}(\.\d{1,3}){3}/.test(String(link?.href ?? "")),
    )
  ) {
    signals.push("链接直接指向数字地址");
  }
  if (record.hasRemoteImages && URGENT_WORDS.test(body))
    signals.push("催促语气配合远程图片");
  return signals;
}

function collectMarketingSignals(record) {
  const raw = [
    record.headers?.listUnsubscribe,
    record.headers?.precedence,
    record.headers?.returnPath,
  ]
    .map((value) => String(value ?? "").toLowerCase())
    .join(" ");
  const bulk =
    /list-unsubscribe|unsubscribe/.test(raw) || /bulk|junk|list/.test(raw);
  const hasUnsubscribe =
    /list-unsubscribe/.test(
      String(record.headers?.listUnsubscribe ?? "").toLowerCase(),
    ) || /退订/.test(bodyText(record));
  return { bulk, hasUnsubscribe };
}

/**
 * Score spam-likeness 0..100 from the cheap heuristics.
 * @returns {{ score: number, reasons: string[], signals: object }}
 */
export function scoreMail(record, state) {
  let score = 0;
  const reasons = [];
  const auth = record.auth ?? {};
  const authFails = ["spf", "dkim", "dmarc"].filter(
    (key) => auth[key] === "fail" || auth[key] === "softfail",
  );
  if (authFails.length > 0) {
    score += 8 + 6 * authFails.length;
    reasons.push(
      `${authFails.map((k) => k.toUpperCase()).join("/")} 没通过，发件人身份存疑`,
    );
  }

  const links = Array.isArray(record.links) ? record.links : [];
  const shorteners = links.filter((link) => link?.isShortener).length;
  if (shorteners > 0) {
    score += 10;
    reasons.push("用了短链接，看不清真实去向");
  }
  if (links.length > 10) {
    score += 10;
    reasons.push("正文塞满链接");
  }

  const attachments = Array.isArray(record.attachments)
    ? record.attachments
    : [];
  const risky = attachments.filter(
    (a) => a?.riskyExt || isRiskyExtension(a?.filename),
  );
  if (risky.length > 0) {
    score += 15;
    reasons.push(`带了危险附件（${risky[0].filename}）`);
  }

  const body = bodyText(record).toLowerCase();
  let keywordScore = 0;
  for (const [keyword, weight] of SPAM_KEYWORDS) {
    if (body.includes(keyword.toLowerCase())) keywordScore += weight;
  }
  if (keywordScore > 0) {
    score += Math.min(keywordScore, 22);
    reasons.push("用词很像广告或诈骗套路");
  }

  const marketing = collectMarketingSignals(record);
  if (marketing.bulk) score += 12;
  if (marketing.bulk && !marketing.hasUnsubscribe) {
    score += 18;
    reasons.push("群发的营销邮件，还找不到退订方式");
  }

  const interaction = interactionOf(state, record);
  if (interaction.replied > 0) {
    score -= 25;
  } else if (interaction.read > 2) {
    score -= 15;
  } else if (interaction.sent === 0 && interaction.replied === 0) {
    score += 12;
  }

  if (URGENT_WORDS.test(bodyText(record)) && links.length > 0) {
    score += 8;
    reasons.push("语气很急还带着链接");
  }
  if (record.replyToMismatch) score += 8;

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
    signals: {
      marketing,
      riskyAttachments: risky.length,
      linkCount: links.length,
    },
  };
}

function humanVerdictReason(verdict, reasons, ruleNote) {
  if (ruleNote) return ruleNote;
  if (reasons.length > 0) return reasons.slice(0, 2).join("；");
  switch (verdict) {
    case "important":
      return "像是要紧的来信";
    case "normal":
      return "正常的往来邮件";
    case "low":
      return "批量订阅或广告";
    case "spam":
      return "垃圾邮件特征明显";
    default:
      return "拿不准，等你定夺";
  }
}

/**
 * Run the three layers and return a verdict with plain-language reasons.
 *
 * @param {object} record MailRecord from lib/mime.js
 * @param {object} deps { settings, state, modelJudge? }
 *   modelJudge — optional async (record, context) => ({ verdict, reason })
 *   used ONLY for gray-zone mails when settings.modelJudge.enabled is true.
 * @returns {Promise<object>} judgment
 */
export async function judgeMail(record, deps = {}) {
  const {
    settings,
    state = { rules: [], history: {} },
    modelJudge = null,
  } = deps;
  const base = {
    score: 0,
    layer: "rules",
    flags: {
      phishing: false,
      impersonation: false,
      marketing: false,
      bulk: false,
      riskyAttachment: false,
    },
    reasons: [],
    modelReason: null,
  };

  // ---- Layer 0: user rules always win ----
  const keepRule = firstMatchingRule(state, ["keep"], record);
  if (keepRule) {
    return finish({
      ...base,
      verdict: "important",
      reasons: ["你交代过这个发件人的信要留"],
      reason: keepRule.note || "白名单发件人，永不禁拦",
    });
  }
  const dropRule = firstMatchingRule(state, ["drop", "block"], record);
  if (dropRule) {
    return finish({
      ...base,
      verdict: "spam",
      reasons: [dropRule.note || "你说过这类以后直接扔"],
      reason: dropRule.note || "按你定的规则直接归档到垃圾箱",
      flags: { ...base.flags },
    });
  }

  // ---- Layer 1: hard rules ----
  const phishSignals = collectPhishSignals(record);
  const marketing = collectMarketingSignals(record);
  const impersonation = detectImpersonation(record, state);
  const riskyAttachments = (record.attachments ?? []).some(
    (a) => a?.riskyExt || isRiskyExtension(a?.filename),
  );
  const flags = {
    phishing: phishSignals.length >= 2,
    impersonation,
    marketing: marketing.bulk,
    bulk: marketing.bulk,
    riskyAttachment: riskyAttachments,
  };

  if (
    !flags.phishing &&
    phishSignals.length === 1 &&
    (impersonation || flags.riskyAttachment)
  ) {
    flags.phishing = true;
  }

  if (flags.phishing) {
    return finish({
      ...base,
      verdict: "spam",
      flags,
      reasons: [
        ...phishSignals,
        impersonation ? "冒充熟人，但发件域名对不上" : "",
      ].filter(Boolean),
      reason: "疑似钓鱼诈骗，建议隔离；是否移动以实际处置结果为准",
    });
  }
  if (impersonation) {
    return finish({
      ...base,
      verdict: "spam",
      flags,
      reasons: ["显示名冒充熟人，发件域名却对不上"],
      reason: "疑似冒充熟人，建议隔离；是否移动以实际处置结果为准",
    });
  }
  const transactional = isTransactional(record);
  const marketingTone =
    MARKETING_TONE.test(bodyText(record)) ||
    SPAM_KEYWORDS.some(([k]) =>
      bodyText(record).toLowerCase().includes(k.toLowerCase()),
    );
  if (
    marketing.bulk &&
    !marketing.hasUnsubscribe &&
    marketingTone &&
    !transactional
  ) {
    return finish({
      ...base,
      verdict: "spam",
      flags,
      reasons: ["群发营销且没有退订方式"],
      reason: "没法退订的群发营销，建议归垃圾类（分类不等于已移动）",
    });
  }

  // ---- Layer 2: heuristic score ----
  const { score, reasons, signals } = scoreMail(record, state);
  base.score = score;
  base.reasons = reasons;
  base.flags = {
    ...flags,
    marketing: flags.marketing || signals.marketing.bulk,
  };

  const interaction = interactionOf(state, record);
  const personal =
    interaction.replied > 0 ||
    interaction.read > 2 ||
    firstMatchingRule(state, ["keep"], record) !== null;

  // Baseline verdict by score band. 群发订阅即使分数不高也不留在收件箱中央：
  // 归"低优先"（规格：广告一句话带过）；灰区只有一个出口：pending。
  let verdict;
  if (score >= SCORE_BANDS.spamHigh) {
    verdict = "spam";
  } else if (score >= SCORE_BANDS.lowMid) {
    verdict = signals.marketing.bulk ? "low" : "pending";
  } else if (score > SCORE_BANDS.grayMid) {
    verdict = "pending";
  } else {
    verdict = personal
      ? "important"
      : signals.marketing.bulk
        ? "low"
        : "normal";
  }

  // 服务通知类邮件永远不按广告/垃圾/待定处理（真实验收抓出的误拦教训）
  if (transactional && verdict !== "important") {
    verdict = "normal";
    reasons.length = 0;
    reasons.push("像是服务通知，不按广告处理");
  }

  // ---- Layer 3: model arbitration for the gray zone only ----
  const gray = verdict === "pending";
  if (
    gray &&
    settings?.modelJudge?.enabled &&
    typeof modelJudge === "function"
  ) {
    let arbitrated = null;
    try {
      arbitrated = await modelJudge(record, { score, reasons });
    } catch {
      arbitrated = null;
    }
    const allowed = new Set(["spam", "low", "normal", "important", "pending"]);
    if (arbitrated && allowed.has(arbitrated.verdict)) {
      return finish({
        ...base,
        verdict: arbitrated.verdict,
        layer: "model",
        score,
        reasons,
        modelReason: String(arbitrated.reason ?? "").slice(0, 200) || null,
        reason:
          String(arbitrated.reason ?? "").slice(0, 200) ||
          humanVerdictReason(arbitrated.verdict, reasons),
      });
    }
  }
  if (gray && !settings?.modelJudge?.enabled) {
    verdict = "pending"; // 关闭仲裁时灰区一律进待定（规格要求）
    base.layer = "score";
  }

  return finish({
    ...base,
    verdict,
    layer: "score",
    score,
    reasons,
    reason: humanVerdictReason(verdict, reasons),
  });
}

function detectImpersonation(record, state) {
  const name = String(record.from?.name ?? "")
    .trim()
    .toLowerCase();
  const domain = String(record.from?.domain ?? "").toLowerCase();
  if (!name || !domain) return false;
  const contacts = Array.isArray(state?.contacts) ? state.contacts : [];
  return contacts.some((contact) => {
    const contactName = String(contact?.name ?? "")
      .trim()
      .toLowerCase();
    const contactDomain = String(contact?.domain ?? "")
      .trim()
      .toLowerCase();
    if (!contactName || !contactDomain) return false;
    return (
      name.includes(contactName) &&
      domain !== contactDomain &&
      !domain.endsWith(`.${contactDomain}`)
    );
  });
}

function finish(judgment) {
  const reasons = (judgment.reasons ?? []).filter(Boolean).slice(0, 3);
  return {
    verdict: judgment.verdict,
    score: judgment.score ?? 0,
    layer: judgment.layer ?? "rules",
    flags: judgment.flags ?? {
      phishing: false,
      impersonation: false,
      marketing: false,
      bulk: false,
      riskyAttachment: false,
    },
    reasons,
    modelReason: judgment.modelReason ?? null,
    reason: judgment.reason || humanVerdictReason(judgment.verdict, reasons),
    action: ACTION_BY_VERDICT[judgment.verdict] ?? "none",
  };
}

/** What the pipeline does with each verdict. Never destructive. */
export const ACTION_BY_VERDICT = Object.freeze({
  important: "notify",
  normal: "notify",
  low: "file-low",
  spam: "file-spam",
  pending: "ask",
  none: "none",
});
