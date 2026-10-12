// dsh-mail-guardian — lib/config.js
//
// Single source of truth for the entry configuration (cordis.patch.yml / plugin
// row). Unknown keys throw on purpose: a silent typo turns a load-time mistake
// into a runtime incident. Secrets never live here — every account names a
// credential *reference*; the value stays in the DSH credential store.

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STYLES = new Set(["caring", "concise", "formal"]);
const MAILBOX_DEFAULT = "INBOX";

function fail(message) {
  throw new TypeError(message);
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
}

function rejectUnknownKeys(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail(`unknown config key "${key}" in ${label}`);
  }
}

function resolveAccount(raw, index, seenIds) {
  assertPlainObject(raw, `accounts[${index}]`);
  rejectUnknownKeys(
    raw,
    new Set([
      "id",
      "label",
      "host",
      "port",
      "secure",
      "username",
      "credentialRef",
      "mailbox",
      "servername",
      "folders",
    ]),
    `accounts[${index}]`,
  );
  const id = String(raw.id ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) fail(`accounts[${index}].id must be a safe identifier`);
  if (seenIds.has(id)) fail(`accounts[${index}].id "${id}" is duplicated`);
  seenIds.add(id);
  const host = String(raw.host ?? "").trim();
  if (!host) fail(`accounts[${index}].host is required`);
  const port = raw.port ?? 993;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    fail(`accounts[${index}].port must be an integer in 1..65535`);
  const username = String(raw.username ?? "").trim();
  if (!username) fail(`accounts[${index}].username is required`);
  const credentialRef = String(raw.credentialRef ?? "").trim();
  if (!IDENT_RE.test(credentialRef)) {
    fail(
      `accounts[${index}].credentialRef must be a plain identifier (the secret lives in the credential store, not in config)`,
    );
  }
  const secure = raw.secure === undefined ? true : raw.secure;
  if (typeof secure !== "boolean")
    fail(`accounts[${index}].secure must be boolean`);
  let folders = Object.freeze({});
  if (raw.folders !== undefined) {
    assertPlainObject(raw.folders, `accounts[${index}].folders`);
    rejectUnknownKeys(
      raw.folders,
      new Set(["trash", "archive", "lowPriority"]),
      `accounts[${index}].folders`,
    );
    const overrides = {};
    for (const key of ["trash", "archive", "lowPriority"]) {
      if (raw.folders[key] !== undefined) {
        const value = String(raw.folders[key]).trim();
        if (!value) fail(`accounts[${index}].folders.${key} must be non-empty`);
        overrides[key] = value;
      }
    }
    folders = Object.freeze(overrides);
  }
  return Object.freeze({
    id,
    label: String(raw.label ?? id).trim() || id,
    host,
    port,
    secure,
    username,
    credentialRef,
    mailbox: String(raw.mailbox ?? MAILBOX_DEFAULT).trim() || MAILBOX_DEFAULT,
    servername: String(raw.servername ?? host).trim() || host,
    folders,
  });
}

/**
 * Per-account folder names: the account's own overrides on top of the global
 * folders block (QQ calls the trash "Junk", Gmail calls it "[Gmail]/垃圾邮件").
 */
export function foldersFor(settings, account) {
  return { ...settings.folders, ...(account?.folders ?? {}) };
}

function resolveTime(value, label) {
  const text = String(value ?? "").trim();
  if (!TIME_RE.test(text)) fail(`${label} must look like "08:00"`);
  return text;
}

function resolveFolders(raw) {
  assertPlainObject(raw ?? {}, "folders");
  rejectUnknownKeys(
    raw ?? {},
    new Set(["trash", "archive", "lowPriority"]),
    "folders",
  );
  const out = {};
  for (const key of ["trash", "archive", "lowPriority"]) {
    const value = String(raw?.[key] ?? "").trim();
    if (!value) fail(`folders.${key} must be a non-empty mailbox name`);
    out[key] = value;
  }
  return Object.freeze(out);
}

function resolveModelJudge(raw) {
  assertPlainObject(raw ?? {}, "modelJudge");
  rejectUnknownKeys(raw ?? {}, new Set(["enabled", "ref"]), "modelJudge");
  const enabled = raw?.enabled === undefined ? false : raw.enabled;
  if (typeof enabled !== "boolean") fail("modelJudge.enabled must be boolean");
  const ref = raw?.ref === undefined ? "" : String(raw.ref).trim();
  if (ref && !IDENT_RE.test(ref))
    fail("modelJudge.ref must be a plain identifier");
  return Object.freeze({ enabled, ref: ref || null });
}

/**
 * Resolve and freeze the entry configuration. Throws TypeError on any mistake.
 * @param {object} [config] raw entry config
 */
export function resolveSettings(config = {}) {
  assertPlainObject(config, "config");
  rejectUnknownKeys(
    config,
    new Set([
      "accounts",
      "briefTime",
      "style",
      "quietHours",
      "modelJudge",
      "trashRetentionDays",
      "folders",
      "stateDir",
      "timeZone",
      "sync",
      "automation",
    ]),
    "config",
  );
  if (config.stateDir !== undefined && typeof config.stateDir !== "string")
    fail("stateDir must be a string");
  const accountsRaw = config.accounts ?? [];
  if (!Array.isArray(accountsRaw)) fail("accounts must be an array");
  const seenIds = new Set();
  const accounts = accountsRaw.map((raw, index) =>
    resolveAccount(raw, index, seenIds),
  );

  const style = String(config.style ?? "caring").trim();
  if (!STYLES.has(style))
    fail('style must be one of "caring" | "concise" | "formal"');

  const quietRaw = config.quietHours ?? { start: "22:00", end: "08:00" };
  assertPlainObject(quietRaw, "quietHours");
  rejectUnknownKeys(quietRaw, new Set(["start", "end"]), "quietHours");
  const quietHours = Object.freeze({
    start: resolveTime(quietRaw.start ?? "22:00", "quietHours.start"),
    end: resolveTime(quietRaw.end ?? "08:00", "quietHours.end"),
  });

  const retention = config.trashRetentionDays ?? 30;
  if (!Number.isInteger(retention) || retention < 1 || retention > 365) {
    fail("trashRetentionDays must be an integer in 1..365");
  }

  const syncRaw = config.sync ?? {};
  assertPlainObject(syncRaw, "sync");
  rejectUnknownKeys(
    syncRaw,
    new Set([
      "lookbackDays",
      "maxMessages",
      "maxPreviewBytes",
      "commandTimeoutMs",
      "accountBudgetMs",
      "pollIntervalMs",
    ]),
    "sync",
  );
  const bounds = {
    lookbackDays: [3, 1, 30],
    maxMessages: [40, 1, 200],
    maxPreviewBytes: [65536, 4096, 262144],
    commandTimeoutMs: [8000, 100, 30000],
    accountBudgetMs: [25000, 500, 120000],
    pollIntervalMs: [300000, 60000, 3600000],
  };
  const sync = {};
  for (const [key, [def, min, max]] of Object.entries(bounds)) {
    const v = syncRaw[key] ?? def;
    if (!Number.isInteger(v) || v < min || v > max)
      fail("sync." + key + " outside allowed range");
    sync[key] = v;
  }
  const auto = config.automation ?? {};
  assertPlainObject(auto, "automation");
  rejectUnknownKeys(
    auto,
    new Set(["moveRules", "moveHeuristics"]),
    "automation",
  );
  for (const k of Object.keys(auto))
    if (typeof auto[k] !== "boolean")
      fail("automation." + k + " must be boolean");
  const timeZone =
    config.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date());
  } catch {
    fail("invalid timeZone");
  }
  return Object.freeze({
    timeZone,
    stateDir: config.stateDir ?? null,
    sync: Object.freeze(sync),
    automation: Object.freeze({
      moveRules: auto.moveRules ?? false,
      moveHeuristics: auto.moveHeuristics ?? false,
    }),
    accounts: Object.freeze(accounts),
    briefTime: resolveTime(config.briefTime ?? "08:00", "briefTime"),
    style,
    quietHours,
    modelJudge: resolveModelJudge(config.modelJudge),
    trashRetentionDays: retention,
    folders: resolveFolders(
      config.folders ?? {
        trash: "垃圾箱",
        archive: "归档",
        lowPriority: "低优先",
      },
    ),
  });
}

/** True when the local clock time (HH:mm) falls inside the quiet window. */
export function isQuietHours(settings, hhmm) {
  const now = resolveTime(hhmm, "hhmm");
  const { start, end } = settings.quietHours;
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}
