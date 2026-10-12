import path from "node:path";
import { judgeMail, ruleMatches } from "./judge.js";
import { foldersFor } from "./config.js";
import { acquireLock } from "./persistence.js";
import { buildCachedReport, dayKey } from "./report.js";

export function humanError(e, what = "收信") {
  if (["network", "timeout"].includes(e?.kind))
    return "网络没通，" + what + "没完成，先显示已有结果";
  if (e?.kind === "auth") return "邮箱账号或授权码不对，收信没成功";
  if (e?.kind === "credentials") return "邮箱凭据尚未配置，不能收信";
  return what + "未完成，请查看本机诊断（没有把错误当作空邮箱）";
}
export function createPipeline({
  settings,
  state,
  index,
  resolveSecret,
  ImapClient,
  parseMessage,
  logger = {},
  modelJudge = null,
  now = () => new Date(),
}) {
  if (
    !settings ||
    !state ||
    !index ||
    typeof resolveSecret !== "function" ||
    typeof ImapClient !== "function" ||
    typeof parseMessage !== "function"
  )
    throw new TypeError("invalid pipeline dependencies");
  const lockFile = path.join(path.dirname(state.statePath), "sync.lock");
  const accountById = (id) => {
    const a = settings.accounts.find((a) => a.id === id);
    if (!a) throw new TypeError("unknown mail account");
    return a;
  };
  const validateUid = (u) => {
    if (!Number.isInteger(u) || u < 1)
      throw new TypeError("uid must be a positive integer");
    return u;
  };
  const report = (args) =>
    buildCachedReport({
      settings,
      state,
      index,
      ...args,
      now: args?.now ?? now(),
    });
  async function runAccount(
    account,
    maxMessages,
    readOnly = false,
    signal = null,
  ) {
    const start = Date.now();
    const expires = start + settings.sync.accountBudgetMs;
    const result = {
      account: account.id,
      label: account.label,
      ok: false,
      networkDown: false,
      fetched: 0,
      moved: 0,
      pending: 0,
      reports: [],
      actionErrors: [],
      error: null,
      status: "syncing",
      remaining: 0,
    };
    let client = null;
    let deadline;
    const cancel = () => client?.destroy();
    signal?.addEventListener("abort", cancel, { once: true });
    const timed = new Promise((_, reject) => {
      deadline = setTimeout(() => {
        client?.destroy();
        const e = new Error("deadline");
        e.kind = "timeout";
        reject(e);
      }, settings.sync.accountBudgetMs);
    });
    const step = async (p) => {
      if (signal?.aborted) {
        client?.destroy();
        throw new Error("cancelled");
      }
      const value = await Promise.race([p, timed]);
      if (Date.now() >= expires) {
        const e = new Error("deadline");
        e.kind = "timeout";
        throw e;
      }
      return value;
    };
    try {
      const secret = await step(resolveSecret(account.credentialRef));
      if (!secret) {
        const e = new Error("credential missing");
        e.kind = "credentials";
        throw e;
      }
      client = new ImapClient({
        host: account.host,
        port: account.port,
        secure: account.secure,
        servername: account.servername,
        timeoutMs: settings.sync.commandTimeoutMs,
      });
      await step(client.connect());
      await step(client.login(account.username, secret));
      const selected = await step(client.select(account.mailbox));
      let cp = state.checkpoint(account.id);
      const validity = String(selected.uidValidity ?? "");
      if (!validity) throw new Error("no UIDVALIDITY");
      const reset =
        cp.uidValidity != null && String(cp.uidValidity) !== validity;
      if (reset) {
        cp = { lastUid: 0, initialized: false, remainingUids: [] };
        state.data.pending = state.data.pending.filter(
          (p) => p.account !== account.id,
        );
      }
      const cutoff = dayKey(
        new Date(+now() - settings.sync.lookbackDays * 86400000),
        settings.timeZone,
      );
      // Always reconcile recent arrivals: old versions had advanced through ancient
      // history, so trusting their high-water mark alone could hide today's mail.
      const recent = await step(client.uidSearch({ since: cutoff }));
      let incoming = [];
      const high = Math.max(0, (selected.uidNext ?? 1) - 1);
      if (cp.initialized && high > Number(cp.lastUid ?? 0))
        incoming = await step(
          client.uidSearch({ uidFrom: Number(cp.lastUid ?? 0) + 1 }),
        );
      const cached = new Map(
        index.entries
          .filter(
            (e) =>
              e.account === account.id &&
              e.mailbox === account.mailbox &&
              String(e.uidValidity ?? "") === validity,
          )
          .map((e) => [e.uid, e]),
      );
      const candidates = [
        ...new Set([...recent, ...incoming, ...(cp.remainingUids ?? [])]),
      ]
        .filter(
          (u) => Number.isInteger(u) && u > 0 && u <= high && !cached.has(u),
        )
        .sort((a, b) => b - a);
      let remaining = candidates.slice();
      state.setCheckpoint(account.id, {
        uidValidity: validity,
        lastUid: high,
        initialized: true,
        remainingUids: remaining,
        lastAttemptAt: now().toISOString(),
        status: "syncing",
      });
      const selectedUids = candidates.slice(0, maxMessages);
      for (let offset = 0; offset < selectedUids.length; offset += 5) {
        const batch = selectedUids.slice(offset, offset + 5);
        const messages = await step(
          client.uidFetch({
            uids: batch,
            fromUid: batch[batch.length - 1],
            toUid: batch[0],
            items: [
              "UID",
              "FLAGS",
              "INTERNALDATE",
              "RFC822.SIZE",
              "BODY.PEEK[]<0." + settings.sync.maxPreviewBytes + ">",
            ],
          }),
        );
        for (const uid of batch) {
          const message = messages.find((m) => m.uid === uid);
          if (message && !message.raw)
            throw new Error("message preview missing");
          if (message?.raw) {
            const r = parseMessage(message.raw, {
              account: account.id,
              mailbox: account.mailbox,
              uid,
            });
            r.uidValidity = validity;
            r.receivedAt = message.internalDate ?? r.date;
            r.read = (message.flags ?? []).includes("\\Seen");
            r.bodyTruncated = Number(message.size) > message.raw.length;
            let j = await judgeMail(r, {
              settings,
              state: state.data,
              modelJudge,
            });
            if (
              r.bodyTruncated &&
              !j.flags.phishing &&
              j.layer !== "rules" &&
              j.verdict === "spam"
            )
              j = {
                ...j,
                verdict: "pending",
                action: "ask",
                reason: "正文预览不完整，先问你",
              };
            const e = index.add(r, j);
            result.fetched++;
            const ruleMove =
              j.verdict === "spam" &&
              j.layer === "rules" &&
              state
                .listRules()
                .some(
                  (rule) =>
                    ["drop", "block"].includes(rule.action) &&
                    ruleMatches(rule, r),
                );
            const permitted =
              !readOnly &&
              (ruleMove
                ? settings.automation.moveRules
                : settings.automation.moveHeuristics);
            const destination =
              j.action === "file-spam"
                ? foldersFor(settings, account).trash
                : j.action === "file-low"
                  ? foldersFor(settings, account).lowPriority
                  : null;
            if (destination && destination !== account.mailbox && permitted) {
              try {
                await step(client.uidMove([uid], destination));
                result.moved++;
                e.judgment.action = "moved";
                e.judgment.target = destination;
              } catch (err) {
                result.actionErrors.push("一封邮件未能移动，原文保留在邮箱里");
                e.judgment.action = "move-failed";
                e.judgment.target = null;
              }
            }
            if (j.verdict === "pending") {
              state.enqueuePending({
                account: account.id,
                mailbox: account.mailbox,
                uid,
                uidValidity: validity,
                messageId: r.headers.messageId,
                from: r.from.name || r.from.address,
                address: r.from.address,
                subject: r.subject,
                date: r.receivedAt,
                reason: j.reason,
                question:
                  "[" +
                  account.label +
                  "] " +
                  (r.from.name || r.from.address) +
                  "《" +
                  r.subject +
                  "》：留还是扔？",
              });
              result.pending++;
            }
            if (state.shouldReport(account.id + ":" + validity + ":" + uid))
              result.reports.push({
                account: account.id,
                from: r.from.name || r.from.address,
                subject: r.subject,
                verdict: j.verdict,
                reason: j.reason,
                moved: e.judgment.action === "moved",
              });
          }
          remaining = remaining.filter((u) => u !== uid);
          state.setCheckpoint(account.id, { remainingUids: remaining });
          // Commit in this order: cached message before the resume frontier.
          index.commit();
          state.commit();
        }
      }
      result.remaining = remaining.length;
      result.ok = true;
      result.status = remaining.length ? "partial" : "ready";
      state.setCheckpoint(account.id, {
        remainingUids: remaining,
        partial: !!remaining.length,
        status: result.status,
        lastSuccessAt: now().toISOString(),
        lastFetchAt: now().toISOString(),
        lastError: null,
      });
    } catch (e) {
      result.networkDown = ["network", "timeout"].includes(e?.kind);
      result.error = humanError(e);
      result.status = "error";
      result.ok = false;
      state.setCheckpoint(account.id, {
        status: "error",
        lastAttemptAt: now().toISOString(),
        lastError: result.error,
        partial: result.fetched > 0,
      });
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", cancel);
      client?.destroy();
      result.elapsedMs = Date.now() - start;
    }
    return result;
  }
  async function locked(fn) {
    const release = acquireLock(lockFile);
    if (!release)
      return {
        ok: false,
        status: "busy",
        message: "后台正在收信，已有报告可以立即查看",
      };
    try {
      state.reload();
      index.reload();
      if (state.loadError || index.loadError)
        return {
          ok: false,
          status: "cache-error",
          accounts: settings.accounts.map((a) => ({
            account: a.id,
            label: a.label,
            ok: false,
            error: "本机缓存无法读取，已停止同步以保护现有规则",
          })),
        };
      return await fn();
    } finally {
      release();
    }
  }
  async function remote(account, fn) {
    let c = null;
    try {
      const secret = await resolveSecret(account.credentialRef);
      if (!secret) {
        const e = new Error("credential missing");
        e.kind = "credentials";
        throw e;
      }
      c = new ImapClient({
        host: account.host,
        port: account.port,
        secure: account.secure,
        servername: account.servername,
        timeoutMs: settings.sync.commandTimeoutMs,
      });
      await c.connect();
      await c.login(account.username, secret);
      const selected = await c.select(account.mailbox);
      return await fn(c, selected);
    } finally {
      c?.destroy();
    }
  }
  return {
    settings,
    report,
    async fetch({
      accountIds = null,
      maxPerAccount = settings.sync.maxMessages,
      readOnly = false,
      signal = null,
    } = {}) {
      const wanted = accountIds
        ? accountIds.map(accountById)
        : settings.accounts;
      return locked(async () => {
        if (!wanted.length) return { accounts: [], hint: "还没有配置邮箱" };
        state.beginBatch();
        index.beginBatch();
        const accounts = [];
        try {
          for (let offset = 0; offset < wanted.length; offset += 2) {
            accounts.push(
              ...(await Promise.all(
                wanted
                  .slice(offset, offset + 2)
                  .map((a) =>
                    runAccount(
                      a,
                      Math.max(1, Math.min(200, maxPerAccount)),
                      readOnly,
                      signal,
                    ),
                  ),
              )),
            );
          }
        } finally {
          index.endBatch();
          state.endBatch();
        }
        return {
          accounts,
          fetchedAt: now().toISOString(),
          status: accounts.every((a) => a.status === "ready")
            ? "ready"
            : "incomplete",
        };
      });
    },
    async selfCheck() {
      const result = await this.fetch({ maxPerAccount: 5, readOnly: true });
      if (result.status === "busy")
        return { results: [], message: result.message };
      return {
        results: (result.accounts ?? []).map((a) => ({
          account: a.account,
          label: a.label,
          ok: a.ok,
          readable: a.fetched,
          message: a.ok
            ? "账号已连通、最近 " + a.fetched + " 封可读取"
            : a.error,
        })),
        checkedAt: now().toISOString(),
      };
    },
    async judgeOne({ account, uid }) {
      validateUid(uid);
      return locked(() =>
        remote(accountById(account), async (c, s) => {
          const [m] = await c.uidFetch({
            fromUid: uid,
            toUid: uid,
            items: [
              "UID",
              "FLAGS",
              "BODY.PEEK[]<0." + settings.sync.maxPreviewBytes + ">",
            ],
          });
          if (!m?.raw) throw new Error("没有找到这封邮件");
          const r = parseMessage(m.raw, {
            account,
            mailbox: accountById(account).mailbox,
            uid,
          });
          return {
            record: {
              from: r.from,
              subject: r.subject,
              date: r.date,
              attachments: r.attachments,
            },
            judgment: await judgeMail(r, {
              settings,
              state: state.data,
              modelJudge,
            }),
          };
        }),
      );
    },
    async move({ account, uid, to, confirm = false, uidValidity = null }) {
      validateUid(uid);
      const a = accountById(account);
      const dest = String(to ?? "").trim();
      if (!dest) throw new TypeError("missing destination");
      if (confirm !== true)
        return {
          ok: false,
          moved: false,
          message: "移动邮件前需要你明确确认，原邮件还没动",
        };
      return locked(async () => {
        try {
          return await remote(a, async (c, s) => {
            if (
              uidValidity != null &&
              String(s.uidValidity) !== String(uidValidity)
            )
              return {
                ok: false,
                moved: false,
                message: "邮箱已重建，旧邮件编号不能再用，请重新确认",
              };
            await c.uidMove([uid], dest);
            for (const e of index.entries.filter(
              (e) => e.account === account && e.uid === uid,
            )) {
              if (e.judgment) {
                e.judgment.action = "moved";
                e.judgment.target = dest;
              }
            }
            index.save();
            return {
              ok: true,
              moved: true,
              message:
                "已移到「" +
                dest +
                "」，原文仍可在邮箱中找回；保留时间由邮箱服务商决定",
            };
          });
        } catch (e) {
          return { ok: false, moved: false, message: humanError(e, "移动") };
        }
      });
    },
    async mark({ account, uid, read = null, flag = null }) {
      validateUid(uid);
      const addFlags = [],
        removeFlags = [];
      if (read === true) addFlags.push("\\Seen");
      if (read === false) removeFlags.push("\\Seen");
      if (flag === true) addFlags.push("\\Flagged");
      if (flag === false) removeFlags.push("\\Flagged");
      if (!addFlags.length && !removeFlags.length)
        throw new TypeError("no mark requested");
      return locked(async () => {
        try {
          await remote(accountById(account), (c) =>
            c.uidStore([uid], { addFlags, removeFlags }),
          );
          return { ok: true, message: "标记好了" };
        } catch (e) {
          return { ok: false, message: humanError(e, "标记") };
        }
      });
    },
    list(args = {}) {
      state.reload();
      index.reload();
      return {
        mails: index.list(args),
        filter: args.filter ?? "all",
        status: report({ account: args.account }).status,
      };
    },
    search(args) {
      state.reload();
      index.reload();
      const hits = index.search(args);
      return {
        hits: hits.map((e) => ({
          account: e.account,
          accountLabel: accountById(e.account).label,
          from: e.from.name || e.from.address,
          address: e.from.address,
          subject: e.subject,
          date: e.receivedAt ?? e.date,
          where: e.judgment?.target ?? e.mailbox,
          verdict: e.judgment?.verdict ?? "normal",
        })),
        total: hits.length,
        status: report({ account: args.account }).status,
      };
    },
    async summarize(args = {}) {
      return report(args);
    },
    async rules(args) {
      if (args.action === "list") {
        state.reload();
        return { rules: state.listRules() };
      }
      return locked(() => {
        if (args.action === "add")
          return {
            rule: state.addRule({
              kind: args.kind,
              value: args.value,
              action: args.ruleAction,
              note: args.note,
            }),
            message: "记住了，以后按你定的规则处理",
          };
        if (args.action === "remove")
          return { removed: state.removeRule(args.id ?? args.value) };
        throw new TypeError("invalid rule action");
      });
    },
    pending() {
      state.reload();
      return { pending: state.listPending() };
    },
    async answerPending({ id, answer, confirm = false }) {
      if (!["keep", "drop", "low"].includes(answer))
        throw new TypeError("invalid answer");
      state.reload();
      const p = state.listPending().find((p) => p.id === id);
      if (!p) return { ok: false, message: "没有找到这条待定邮件" };
      if (answer === "keep")
        return locked(() => ({
          ok: true,
          removed: state.resolvePending(id, "keep"),
          message: "这封留下，原邮件未动",
        }));
      const dest = foldersFor(settings, accountById(p.account))[
        answer === "drop" ? "trash" : "lowPriority"
      ];
      const result = await this.move({
        account: p.account,
        uid: p.uid,
        to: dest,
        confirm,
        uidValidity: p.uidValidity,
      });
      if (result.ok) await locked(() => state.resolvePending(id, answer));
      return result;
    },
  };
}
