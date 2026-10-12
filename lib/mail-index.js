import { readJson, atomicJson } from "./persistence.js";
export class MailIndex {
  constructor({ path }) {
    if (!path) throw new TypeError("MailIndex needs a path");
    this.path = path;
    this.batching = false;
    this.reload();
  }
  reload() {
    const r = readJson(this.path, []);
    this.loadError = r.error;
    this.entries = Array.isArray(r.value) ? r.value : [];
    return this.entries;
  }
  commit() {
    atomicJson(this.path, this.entries);
  }
  beginBatch() {
    this.batching = true;
  }
  endBatch() {
    this.batching = false;
    this.save();
  }
  save() {
    if (!this.batching) atomicJson(this.path, this.entries);
  }
  add(record, judgment) {
    const e = {
      account: record.account ?? "",
      mailbox: record.mailbox ?? "",
      uid: record.uid ?? null,
      uidValidity: record.uidValidity ?? null,
      messageId: record.headers?.messageId ?? null,
      from: {
        name: record.from?.name ?? "",
        address: record.from?.address ?? "",
        domain: record.from?.domain ?? "",
      },
      subject: record.subject ?? "",
      date: record.date ?? null,
      receivedAt: record.receivedAt ?? record.date ?? null,
      dateSource: record.receivedAt ? "server" : "header",
      indexedAt: new Date().toISOString(),
      textBody: String(record.textBody ?? "").slice(0, 6000),
      attachments: (record.attachments ?? []).map((a) => ({
        filename: a.filename,
        size: a.size,
        riskyExt: !!a.riskyExt,
      })),
      hasRemoteImages: !!record.hasRemoteImages,
      bodyTruncated: !!record.bodyTruncated,
      read: !!record.read,
      judgment: judgment
        ? {
            verdict: judgment.verdict,
            score: judgment.score,
            reason: judgment.reason,
            flags: judgment.flags,
            action: "none",
            target: null,
          }
        : null,
    };
    const found = this.entries.find(
      (x) =>
        x.account === e.account &&
        ((e.messageId && x.messageId === e.messageId) ||
          (x.mailbox === e.mailbox &&
            x.uid === e.uid &&
            String(x.uidValidity ?? "") === String(e.uidValidity ?? ""))),
    );
    if (found) Object.assign(found, e);
    else this.entries.push(e);
    this.entries = this.entries.slice(-10000);
    this.save();
    return found ?? e;
  }
  list({ account = null, filter = "all", since = null, limit = 20 } = {}) {
    let out = this.entries;
    if (account) out = out.filter((e) => e.account === account);
    if (["pending", "spam", "low", "important", "normal"].includes(filter))
      out = out.filter((e) => e.judgment?.verdict === filter);
    if (filter === "unread") out = out.filter((e) => !e.read);
    if (since)
      out = out.filter(
        (e) => Date.parse(e.receivedAt ?? e.date) >= Date.parse(since),
      );
    return out
      .slice()
      .sort(
        (a, b) =>
          Date.parse(b.receivedAt ?? b.date ?? 0) -
          Date.parse(a.receivedAt ?? a.date ?? 0),
      )
      .slice(0, Math.max(1, Math.min(200, limit)));
  }
  search({ query, account = null, limit = 20 } = {}) {
    const terms = String(query ?? "")
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (!terms.length) return [];
    return this.list({ account, limit: 10000 })
      .filter((e) =>
        terms.every((t) =>
          [e.from.name, e.from.address, e.subject, e.textBody, e.date]
            .join("\n")
            .toLowerCase()
            .includes(t),
        ),
      )
      .slice(0, Math.min(50, limit));
  }
}
