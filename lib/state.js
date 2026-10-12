import { randomUUID } from "node:crypto";
import { readJson, atomicJson } from "./persistence.js";
export function emptyState() {
  return {
    version: 2,
    accounts: {},
    rules: [],
    contacts: [],
    history: {},
    pending: [],
    reported: [],
    decisions: {},
    brief: { lastAt: null, lastText: null },
  };
}
export class MailState {
  constructor({ statePath }) {
    if (!statePath) throw new TypeError("MailState needs a statePath");
    this.statePath = statePath;
    this.batching = false;
    this.reload();
  }
  reload() {
    const r = readJson(this.statePath, emptyState());
    this.loadError = r.error;
    const v = r.value;
    this.data = {
      ...emptyState(),
      ...(v && typeof v === "object" && !Array.isArray(v) ? v : {}),
    };
    for (const k of ["rules", "contacts", "pending", "reported"])
      if (!Array.isArray(this.data[k])) this.data[k] = [];
    return this.data;
  }
  commit() {
    atomicJson(this.statePath, this.data);
  }
  beginBatch() {
    this.batching = true;
  }
  endBatch() {
    this.batching = false;
    this.save();
  }
  save() {
    if (!this.batching) atomicJson(this.statePath, this.data);
  }
  checkpoint(id) {
    return (
      this.data.accounts[id] ?? {
        lastUid: 0,
        uidValidity: null,
        lastFetchAt: null,
        lastError: null,
        initialized: false,
        remainingUids: [],
      }
    );
  }
  setCheckpoint(id, patch) {
    this.data.accounts[id] = { ...this.checkpoint(id), ...patch };
    this.save();
    return this.data.accounts[id];
  }
  listRules() {
    return [...this.data.rules];
  }
  addRule({ kind, value, action, note = "" }) {
    if (!["address", "domain", "name", "keyword"].includes(kind))
      throw new TypeError("invalid rule kind");
    if (!["keep", "drop", "block"].includes(action))
      throw new TypeError("invalid rule action");
    const text = String(value ?? "").trim();
    if (!text) throw new TypeError("rule value must be non-empty");
    const found = this.data.rules.find(
      (r) =>
        r.kind === kind &&
        r.value.toLowerCase() === text.toLowerCase() &&
        r.action === action,
    );
    if (found) return found;
    const rule = {
      id: randomUUID(),
      kind,
      value: text,
      action,
      note: String(note).slice(0, 200),
      createdAt: new Date().toISOString(),
    };
    this.data.rules.push(rule);
    this.save();
    return rule;
  }
  removeRule(id) {
    const n = this.data.rules.length;
    this.data.rules = this.data.rules.filter(
      (r) => r.id !== id && r.value !== id,
    );
    this.save();
    return n - this.data.rules.length;
  }
  noteInteraction(record, kind) {
    const k = String(record?.from?.address ?? "")
      .trim()
      .toLowerCase();
    if (!k) return null;
    const e = this.data.history[k] ?? {
      sent: 0,
      replied: 0,
      read: 0,
      lastSeen: null,
    };
    if (["sent", "replied", "read"].includes(kind)) e[kind]++;
    e.lastSeen = new Date().toISOString();
    this.data.history[k] = e;
    this.save();
    return e;
  }
  enqueuePending(item) {
    const existing = this.data.pending.find(
      (p) =>
        p.account === item.account &&
        p.mailbox === item.mailbox &&
        p.uid === item.uid &&
        String(p.uidValidity ?? "") === String(item.uidValidity ?? ""),
    );
    if (existing) return existing;
    const e = {
      ...item,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.data.pending.push(e);
    this.data.pending = this.data.pending.slice(-1000);
    this.save();
    return e;
  }
  listPending() {
    return [...this.data.pending];
  }
  resolvePending(id, answer = "keep") {
    const found = this.data.pending.find(
      (p) => p.id === id || p.messageId === id,
    );
    if (found)
      this.data.decisions[
        found.account + ":" + String(found.uidValidity ?? "") + ":" + found.uid
      ] = { answer, at: new Date().toISOString() };
    const n = this.data.pending.length;
    this.data.pending = this.data.pending.filter(
      (p) => p.id !== id && p.messageId !== id,
    );
    this.save();
    return n - this.data.pending.length;
  }
  shouldReport(id) {
    const k = String(id ?? "").trim();
    if (!k) return true;
    if (this.data.reported.includes(k)) return false;
    this.data.reported.push(k);
    this.data.reported = this.data.reported.slice(-2000);
    this.save();
    return true;
  }
  markBrief(text) {
    this.data.brief = {
      lastAt: new Date().toISOString(),
      lastText: String(text).slice(0, 10000),
    };
    this.save();
  }
}
