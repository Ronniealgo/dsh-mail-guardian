/**
 * dsh-mail-guardian -- IMAP4rev1 client (work order A).
 *
 * Zero runtime dependencies: node:net / node:tls only. ESM, Node >= 20.
 *
 * Public contract (frozen -- integrators call exactly this):
 *
 *   export class ImapError extends Error
 *     new ImapError(message, kind, options?)      // kind: 'network' | 'auth' | 'protocol' | 'timeout'
 *
 *   export function encodeMailboxName(name)       // UTF-8 -> RFC 3501 modified UTF-7
 *   export function decodeMailboxName(token)      // RFC 3501 modified UTF-7 -> UTF-8
 *
 *   export class ImapClient
 *     new ImapClient({ host, port, secure = true, servername, timeoutMs = 30000, logger })
 *     await connect()                                    // greeting + CAPABILITY -> this.capabilities (Set of lowercase names)
 *     await login(user, pass)                            // NO/BAD -> ImapError(kind = 'auth')
 *     await listMailboxes()                              // [{ name, delimiter }]
 *     await select(mailbox)                              // { uidValidity, uidNext, exists, readOnly }
 *     await uidFetch({ fromUid, toUid, items })          // [{ uid, flags, size, raw }] sorted by uid
 *     await uidSearch({ uidFrom, unseen, before, since }) // number[] sorted ascending
 *     await uidStore(uids, { addFlags, removeFlags })    // void
 *     await uidMove(uids, destMailbox)                   // void
 *     await noop()                                       // void
 *     await logout()                                     // void, idempotent
 *     destroy()                                          // void, never throws
 *
 * Parsing covers tagged and untagged responses, literals ({n}CRLF + n bytes, byte counted so
 * multi-byte UTF-8 is exact), quoted strings with backslash escapes, parenthesised lists, NIL,
 * several FETCH responses per command, and literals that appear in the middle of a response.
 *
 * Mailbox names are RFC 3501 modified UTF-7 on the wire: every name handed to SELECT, to the
 * LIST reference/pattern or to a UID MOVE/UID COPY destination is encoded first, and every name
 * parsed out of a response (LIST) is decoded back to a UTF-8 string. Pure ASCII names pass through
 * unchanged. UID MOVE is only replaced by the COPY + STORE \Deleted + EXPUNGE fallback when the
 * server does not advertise MOVE or answers BAD (unknown command); a NO answer (for example
 * [TRYCREATE] for a missing destination) is reported as ImapError(kind = 'protocol').
 *
 * Commands are strictly serialised: at most one is in flight, tags increase monotonically.
 * Every command runs under a timeout timer (timeoutMs), socket failures surface as
 * ImapError(kind = 'network') and malformed responses as ImapError(kind = 'protocol').
 *
 * Security: the password is registered as a redaction secret for the lifetime of the LOGIN
 * command. Every logger call and every ImapError message passes through redaction, so the
 * password can never appear in a log line or in an error message. The password is never
 * stored on the instance.
 */

import net from "node:net";
import tls from "node:tls";

const LF = 0x0a;
const CR = 0x0d;
const SP = 0x20;
const TAB = 0x09;
const DQUOTE = 0x22;
const LPAREN = 0x28;
const RPAREN = 0x29;
const LBRACE = 0x7b;
const BACKSLASH = 0x5c;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PORT_IMAPS = 993;
const DEFAULT_PORT_IMAP = 143;

/** Failure of any IMAP operation. kind is one of 'network' | 'auth' | 'protocol' | 'timeout'. */
export class ImapError extends Error {
  constructor(message, kind, options) {
    super(message, options);
    this.name = "ImapError";
    this.kind = kind;
  }
}

/** Internal syntax failure while decoding a server response; mapped to ImapError(kind='protocol'). */
class ResponseSyntaxError extends Error {}

/** Raw octets of an IMAP literal, kept as bytes so UTF-8 payloads survive untouched. */
class ImapLiteral {
  constructor(data) {
    this.data = data;
  }

  get length() {
    return this.data.length;
  }

  get text() {
    return this.data.toString("utf8");
  }

  toString(encoding = "utf8") {
    return this.data.toString(encoding);
  }
}

/* ------------------------------------------------------------------------------------------- *
 * Response tokenizer
 * ------------------------------------------------------------------------------------------- */

function pushToken(state, token) {
  const target =
    state.stack.length > 0 ? state.stack[state.stack.length - 1] : state.root;
  target.push(token);
}

function readQuoted(line, start) {
  const bytes = [];
  let i = start + 1;
  while (i < line.length) {
    const byte = line[i];
    if (byte === BACKSLASH) {
      if (i + 1 >= line.length) break;
      bytes.push(line[i + 1]);
      i += 2;
      continue;
    }
    if (byte === DQUOTE) {
      return { value: Buffer.from(bytes).toString("utf8"), next: i + 1 };
    }
    bytes.push(byte);
    i += 1;
  }
  throw new ResponseSyntaxError("unterminated quoted string");
}

function isAtomStop(byte) {
  return (
    byte === SP ||
    byte === TAB ||
    byte === LPAREN ||
    byte === RPAREN ||
    byte === DQUOTE
  );
}

/**
 * Tokenize one physical response line into the running token state.
 * '(' opens a nested array, ')' closes it, NIL becomes null, quoted strings are unescaped,
 * and a trailing {n} marks a literal whose bytes follow the CRLF.
 */
function feedLine(state, line) {
  let i = 0;
  while (i < line.length) {
    const byte = line[i];
    if (byte === SP || byte === TAB) {
      i += 1;
      continue;
    }
    if (byte === LPAREN) {
      const nested = [];
      pushToken(state, nested);
      state.stack.push(nested);
      i += 1;
      continue;
    }
    if (byte === RPAREN) {
      if (state.stack.length === 0)
        throw new ResponseSyntaxError('unbalanced ")"');
      state.stack.pop();
      i += 1;
      continue;
    }
    if (byte === DQUOTE) {
      const quoted = readQuoted(line, i);
      pushToken(state, quoted.value);
      i = quoted.next;
      continue;
    }
    if (byte === LBRACE) {
      const rest = line.toString("latin1", i);
      const marker = /^\{(\d+)\+?\}$/.exec(rest);
      if (marker) {
        state.literal = Number(marker[1]);
        return;
      }
    }
    let end = i;
    while (end < line.length && !isAtomStop(line[end])) end += 1;
    const atom = line.toString("utf8", i, end);
    pushToken(state, atom.toUpperCase() === "NIL" ? null : atom);
    i = end;
  }
}

/* ------------------------------------------------------------------------------------------- *
 * Small protocol helpers
 * ------------------------------------------------------------------------------------------- */

function quoteString(value) {
  if (/[\r\n\0]/.test(String(value)))
    throw new TypeError("Protocol arguments cannot contain control characters");
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function toPositiveInteger(value, label) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new TypeError(label + " must be a positive integer");
  }
  return number;
}

function toUidSet(fromUid, toUid) {
  const from = toPositiveInteger(fromUid, "fromUid");
  const to = toPositiveInteger(toUid, "toUid");
  if (from !== null && to !== null) return from + ":" + to;
  if (from !== null) return from + ":*";
  if (to !== null) return "1:" + to;
  return "1:*";
}

function toUidList(uids) {
  const list = Number.isInteger(uids) ? [uids] : uids;
  if (list === undefined || list === null) return "";
  if (!Array.isArray(list))
    throw new TypeError("uids must be an array of positive integers");
  const normalized = list.map((uid) => toPositiveInteger(uid, "uid"));
  if (normalized.length === 0) return "";
  return normalized.join(",");
}

function toFlagList(flags, label) {
  if (flags === undefined || flags === null) return [];
  if (!Array.isArray(flags))
    throw new TypeError(label + " must be an array of strings");
  return flags.map((flag) => String(flag)).filter((flag) => flag.length > 0);
}

function toSearchDate(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()))
      throw new TypeError(label + " must be a valid date");
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) throw new TypeError(label + " must be YYYY-MM-DD");
    const [, y, m, d] = match;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (date.toISOString().slice(0, 10) !== value.trim())
      throw new TypeError("invalid calendar date");
    return (
      Number(d) +
      "-" +
      [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ][Number(m) - 1] +
      "-" +
      y
    );
  }
  throw new TypeError(label + " must be a YYYY-MM-DD string or a Date");
}

function toFetchItems(items) {
  const requested =
    Array.isArray(items) && items.length > 0
      ? items.map((item) => String(item))
      : ["UID", "FLAGS", "RFC822"];
  const list = requested.slice();
  if (!list.some((item) => item.toUpperCase() === "UID")) list.push("UID");
  return list;
}

function matchNumber(text, pattern) {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : null;
}

function parseFetchTokens(tokens) {
  if (String(tokens[0]) !== "*") return null;
  if (
    String(tokens[2] === undefined ? "" : tokens[2]).toUpperCase() !== "FETCH"
  )
    return null;
  const list = tokens[3];
  if (!Array.isArray(list)) return null;
  const message = {
    uid: null,
    flags: [],
    size: null,
    raw: null,
    internalDate: null,
  };
  for (let i = 0; i + 1 < list.length; i += 2) {
    const key = String(list[i]).toUpperCase();
    const value = list[i + 1];
    if (key === "UID") {
      const uid = Number(value);
      message.uid = Number.isInteger(uid) ? uid : null;
    } else if (key === "FLAGS") {
      message.flags = Array.isArray(value)
        ? value.map((flag) => String(flag))
        : [];
    } else if (key === "INTERNALDATE") {
      const d = new Date(String(value));
      message.internalDate = Number.isNaN(+d) ? null : d.toISOString();
    } else if (key === "RFC822.SIZE") {
      const size = Number(value);
      message.size = Number.isInteger(size) ? size : null;
    } else if (
      key === "RFC822" ||
      key === "RFC822.TEXT" ||
      key === "RFC822.HEADER" ||
      key === "BODY[]" ||
      key === "BODY.PEEK[]" ||
      key === "BODY[HEADER]" ||
      key.startsWith("BODY[")
    ) {
      if (value instanceof ImapLiteral) message.raw = value.data;
      else if (typeof value === "string")
        message.raw = Buffer.from(value, "utf8");
    }
  }
  if (message.size === null && message.raw) message.size = message.raw.length;
  return message;
}

/* ------------------------------------------------------------------------------------------- *
 * RFC 3501 modified UTF-7 mailbox names
 *
 * Printable ASCII (0x20-0x7e) is sent as itself, "&" is sent as "&-", and every other code unit
 * (UTF-16BE, so surrogate pairs survive) is base64 encoded over the alphabet "A-Za-z0-9+," ("," in
 * place of "/", no padding) between "&" and "-". Malformed input is never dropped silently: an
 * undecodable "&" section is returned verbatim.
 * ------------------------------------------------------------------------------------------- */

const MUTF7_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,";
const MUTF7_VALUES = new Map(
  Array.from(MUTF7_ALPHABET, (char, value) => [char, value]),
);

function encodeModifiedBase64(bytes) {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const chunk = (first << 16) | (second << 8) | third;
    out += MUTF7_ALPHABET[(chunk >> 18) & 0x3f];
    out += MUTF7_ALPHABET[(chunk >> 12) & 0x3f];
    if (index + 1 < bytes.length) out += MUTF7_ALPHABET[(chunk >> 6) & 0x3f];
    if (index + 2 < bytes.length) out += MUTF7_ALPHABET[chunk & 0x3f];
  }
  return out;
}

/** Decode a modified-BASE64 run; null when it is not a well formed UTF-16BE byte sequence. */
function decodeModifiedBase64(text) {
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const value = MUTF7_VALUES.get(char);
    if (value === undefined) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  // every UTF-16 code unit is two bytes: an empty or odd byte run cannot have been encoded here
  if (bytes.length === 0 || bytes.length % 2 !== 0) return null;
  return Buffer.from(bytes);
}

/** Encode a UTF-8 mailbox name into the RFC 3501 modified UTF-7 wire form. */
export function encodeMailboxName(name) {
  const value =
    typeof name === "string"
      ? name
      : String(name === undefined || name === null ? "" : name);
  let out = "";
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code >= 0x20 && code <= 0x7e) {
      out += code === 0x26 ? "&-" : value[index];
      index += 1;
      continue;
    }
    const start = index;
    while (index < value.length) {
      const inner = value.charCodeAt(index);
      if (inner >= 0x20 && inner <= 0x7e) break;
      index += 1;
    }
    const bytes = Buffer.alloc((index - start) * 2);
    for (let offset = 0; offset < index - start; offset += 1) {
      bytes.writeUInt16BE(value.charCodeAt(start + offset), offset * 2);
    }
    out += "&" + encodeModifiedBase64(bytes) + "-";
  }
  return out;
}

/** Decode an RFC 3501 modified UTF-7 mailbox name (or ImapLiteral text) back into UTF-8. */
export function decodeMailboxName(token) {
  const value =
    typeof token === "string"
      ? token
      : String(token === undefined || token === null ? "" : token);
  let out = "";
  let index = 0;
  while (index < value.length) {
    const marker = value.indexOf("&", index);
    if (marker === -1) {
      out += value.slice(index);
      break;
    }
    out += value.slice(index, marker);
    const end = value.indexOf("-", marker + 1);
    if (end === -1) {
      out += value.slice(marker);
      break;
    }
    const encoded = value.slice(marker + 1, end);
    if (encoded === "") {
      out += "&";
      index = end + 1;
      continue;
    }
    const bytes = decodeModifiedBase64(encoded);
    if (bytes === null) {
      out += value.slice(marker, end + 1); // not modified UTF-7: keep the original text
      index = end + 1;
      continue;
    }
    for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
      out += String.fromCharCode((bytes[offset] << 8) | bytes[offset + 1]);
    }
    index = end + 1;
  }
  return out;
}

/* ------------------------------------------------------------------------------------------- *
 * Client
 * ------------------------------------------------------------------------------------------- */

export class ImapClient {
  constructor({
    host,
    port,
    secure = true,
    servername,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    logger,
    tlsOptions,
  } = {}) {
    if (typeof host !== "string" || host.length === 0)
      throw new TypeError("ImapClient: host is required");
    this.host = host;
    this.secure = secure !== false;
    this.port =
      port === undefined || port === null
        ? this.secure
          ? DEFAULT_PORT_IMAPS
          : DEFAULT_PORT_IMAP
        : Number(port);
    this.servername =
      servername === undefined
        ? net.isIP(host)
          ? undefined
          : host
        : servername;
    this.timeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : DEFAULT_TIMEOUT_MS;
    this.logger = logger === undefined ? null : logger;
    this.tlsOptions = tlsOptions === undefined ? null : tlsOptions;

    /** Lowercase capability names advertised by the greeting and by CAPABILITY. */
    this.capabilities = new Set();

    this._socket = null;
    this._buf = Buffer.alloc(0);
    this._waiters = [];
    this._tag = 0;
    this._chain = Promise.resolve();
    this._connected = false;
    this._closed = false;
    this._streamError = null;
    this._secrets = new Set();
    this._authenticated = false;
    this._loggedOut = false;
  }

  /* ----------------------------------------------------------------------------------------- *
   * Logging and redaction
   * ----------------------------------------------------------------------------------------- */

  _redact(text) {
    let out =
      typeof text === "string"
        ? text
        : String(text === undefined || text === null ? "" : text);
    for (const secret of this._secrets) {
      if (secret && out.includes(secret)) out = out.split(secret).join("***");
    }
    return out;
  }

  _imapError(message, kind, options) {
    return new ImapError(this._redact(message), kind, options);
  }

  _log(level, message) {
    const logger = this.logger;
    if (!logger) return;
    let fn = typeof logger[level] === "function" ? logger[level] : null;
    if (!fn && typeof logger.log === "function") fn = logger.log;
    if (!fn) return;
    try {
      fn.call(logger, this._redact(message));
    } catch {
      /* a broken logger must never break the client */
    }
  }

  /* ----------------------------------------------------------------------------------------- *
   * Socket plumbing
   * ----------------------------------------------------------------------------------------- */

  _openSocket() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = this.secure
        ? tls.connect(
            Object.assign(
              { host: this.host, port: this.port, servername: this.servername },
              this.tlsOptions || {},
            ),
          )
        : net.connect({ host: this.host, port: this.port });
      this._socket = socket;
      if (typeof socket.setNoDelay === "function") socket.setNoDelay(true);

      socket.on("data", (chunk) => this._onData(chunk));
      socket.on("error", (error) => {
        this._onSocketError(error);
        if (!settled) {
          settled = true;
          reject(
            this._streamError ||
              this._imapError(
                "socket error on " + this.host + ":" + this.port,
                "network",
                { cause: error },
              ),
          );
        }
      });
      socket.on("close", () => {
        this._onSocketClose();
        if (!settled) {
          settled = true;
          reject(
            this._streamError ||
              this._imapError(
                "connection to " +
                  this.host +
                  ":" +
                  this.port +
                  " closed before it was established",
                "network",
              ),
          );
        }
      });

      socket.once(this.secure ? "secureConnect" : "connect", () => {
        if (settled) return;
        settled = true;
        this._connected = true;
        this._closed = false;
        resolve();
      });
    });
  }

  _onData(chunk) {
    if (!chunk || chunk.length === 0) return;
    this._buf =
      this._buf.length === 0 ? chunk : Buffer.concat([this._buf, chunk]);
    if (this._waiters.length === 0) return;
    const waiters = this._waiters;
    this._waiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  _onSocketError(error) {
    const wrapped = this._imapError(
      "socket error on " +
        this.host +
        ":" +
        this.port +
        ": " +
        (error && error.message ? error.message : String(error)),
      "network",
      { cause: error },
    );
    this._fail(wrapped);
  }

  _onSocketClose() {
    this._connected = false;
    if (!this._closed)
      this._fail(
        this._imapError(
          "connection to " +
            this.host +
            ":" +
            this.port +
            " closed by the remote host",
          "network",
        ),
      );
  }

  /** Mark the stream unusable and reject everyone waiting for bytes. */
  _fail(error) {
    if (!this._streamError) this._streamError = error;
    this._closed = true;
    this._connected = false;
    if (this._waiters.length === 0) return;
    const waiters = this._waiters;
    this._waiters = [];
    for (const waiter of waiters) waiter.reject(this._streamError);
  }

  /** Tear the socket down without ever throwing and without leaking events into a next connect(). */
  _destroySocket() {
    const socket = this._socket;
    this._socket = null;
    this._connected = false;
    this._closed = true;
    this._fail(
      this._imapError(
        "connection to " + this.host + ":" + this.port + " is closed",
        "network",
      ),
    );
    if (!socket) return;
    try {
      socket.removeAllListeners("data");
      socket.removeAllListeners("close");
      socket.removeAllListeners("end");
      socket.removeAllListeners("error");
      socket.on("error", () => {});
      socket.destroy();
    } catch {
      /* destroying a dead socket is not an error */
    }
  }

  async _needData() {
    if (this._closed || !this._socket) {
      throw (
        this._streamError ||
        this._imapError(
          "not connected to " + this.host + ":" + this.port,
          "network",
        )
      );
    }
    await new Promise((resolve, reject) => {
      this._waiters.push({ resolve, reject });
    });
  }

  async _nextLine() {
    for (;;) {
      const index = this._buf.indexOf(LF);
      if (index >= 0) {
        let end = index;
        if (end > 0 && this._buf[end - 1] === CR) end -= 1;
        const line = Buffer.from(this._buf.subarray(0, end));
        this._buf = this._buf.subarray(index + 1);
        return line;
      }
      await this._needData();
    }
  }

  async _readBytes(count) {
    while (this._buf.length < count) await this._needData();
    const bytes = Buffer.from(this._buf.subarray(0, count));
    this._buf = this._buf.subarray(count);
    return bytes;
  }

  /** Read exactly one logical response (one or more physical lines joined by literals). */
  async _readResponse() {
    const state = { root: [], stack: [], literal: null, lines: [] };
    for (;;) {
      const line = await this._nextLine();
      state.lines.push(line.toString("latin1"));
      try {
        feedLine(state, line);
      } catch (error) {
        if (error instanceof ResponseSyntaxError) {
          throw this._imapError(
            "malformed response from " +
              this.host +
              ": " +
              error.message +
              ' in "' +
              abbreviate(state.lines.join(" ")) +
              '"',
            "protocol",
          );
        }
        throw error;
      }
      if (state.literal !== null) {
        const count = state.literal;
        state.literal = null;
        pushToken(state, new ImapLiteral(await this._readBytes(count)));
        continue;
      }
      break;
    }
    if (state.stack.length > 0) {
      throw this._imapError(
        "malformed response from " +
          this.host +
          ': unbalanced parentheses in "' +
          abbreviate(state.lines.join(" ")) +
          '"',
        "protocol",
      );
    }
    return {
      tokens: state.root,
      text: state.lines.length > 0 ? state.lines[0] : "",
      lines: state.lines,
    };
  }

  _write(text) {
    return new Promise((resolve, reject) => {
      const socket = this._socket;
      if (!socket || socket.destroyed) {
        reject(
          this._streamError ||
            this._imapError(
              "not connected to " + this.host + ":" + this.port,
              "network",
            ),
        );
        return;
      }
      try {
        socket.write(text, "utf8", (error) => {
          if (error)
            reject(
              this._imapError(
                "cannot send data to " +
                  this.host +
                  ":" +
                  this.port +
                  ": " +
                  error.message,
                "network",
                { cause: error },
              ),
            );
          else resolve();
        });
      } catch (error) {
        reject(
          this._imapError(
            "cannot send data to " +
              this.host +
              ":" +
              this.port +
              ": " +
              error.message,
            "network",
            { cause: error },
          ),
        );
      }
    });
  }

  /* ----------------------------------------------------------------------------------------- *
   * Command execution (serialised, tagged, timed)
   * ----------------------------------------------------------------------------------------- */

  _enqueue(task) {
    const result = this._chain.then(task);
    this._chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  _withTimeout(promise, label) {
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            this._imapError(
              label +
                " timed out after " +
                this.timeoutMs +
                "ms on " +
                this.host +
                ":" +
                this.port,
              "timeout",
            ),
          ),
        this.timeoutMs,
      );
      if (timer && typeof timer.unref === "function") timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  _execute(commandLine, options = {}) {
    const label =
      options.name || String(commandLine).split(/\s+/)[0].toUpperCase();
    return this._enqueue(() =>
      this._runCommand(commandLine, {
        label,
        sensitive: options.sensitive === true,
        onUntagged: options.onUntagged || null,
        timeoutMs:
          Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
            ? options.timeoutMs
            : this.timeoutMs,
      }),
    );
  }

  async _runCommand(commandLine, { label, sensitive, onUntagged, timeoutMs }) {
    if (!this._connected || this._closed || !this._socket) {
      throw (
        this._streamError ||
        this._imapError(
          "not connected to " + this.host + ":" + this.port,
          "network",
        )
      );
    }
    const tag = "A" + ++this._tag;
    this._log(
      "debug",
      ">> " +
        (sensitive
          ? tag + " " + label + " [credentials redacted]"
          : tag + " " + commandLine),
    );

    const work = (async () => {
      await this._write(tag + " " + commandLine + "\r\n");
      for (;;) {
        const response = await this._readResponse();
        const status = String(
          response.tokens[1] === undefined ? "" : response.tokens[1],
        ).toUpperCase();
        if (
          typeof response.tokens[0] === "string" &&
          response.tokens[0].toUpperCase() === tag.toUpperCase()
        ) {
          return {
            status,
            tokens: response.tokens,
            text: response.text,
            lines: response.lines,
          };
        }
        if (response.tokens[0] === "+") {
          throw this._imapError(
            label + ": unexpected continuation request from " + this.host,
            "protocol",
          );
        }
        this._log("debug", "<< " + abbreviate(response.text));
        if (onUntagged) onUntagged(response);
      }
    })();
    work.catch(() => {}); // the timeout below may abandon this reader

    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          this._imapError(
            label +
              " timed out after " +
              timeoutMs +
              "ms on " +
              this.host +
              ":" +
              this.port,
            "timeout",
          ),
        );
      }, timeoutMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    });

    try {
      const result = await Promise.race([work, timeout]);
      if (!["OK", "NO", "BAD", "BYE"].includes(result.status)) {
        throw this._imapError(
          label +
            ': unexpected status "' +
            result.status +
            '" from ' +
            this.host,
          "protocol",
        );
      }
      this._log("debug", "<< " + abbreviate(result.text));
      return result;
    } catch (error) {
      if (error instanceof ImapError && error.kind === "timeout") {
        this._log(
          "warn",
          label +
            " timed out after " +
            timeoutMs +
            "ms; closing the connection to " +
            this.host +
            ":" +
            this.port,
        );
        this._destroySocket(); // the response stream is desynchronised now
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  _ok(result, label, kind = "protocol") {
    const status = String(
      result && result.status ? result.status : "",
    ).toUpperCase();
    if (status === "OK") return result;
    const detail =
      result && result.text ? " (" + abbreviate(result.text) + ")" : "";
    throw this._imapError(
      label +
        " failed on " +
        this.host +
        ":" +
        this.port +
        ": " +
        status +
        detail,
      kind,
    );
  }

  /* ----------------------------------------------------------------------------------------- *
   * Capabilities
   * ----------------------------------------------------------------------------------------- */

  _addCapability(name) {
    const value = String(name === undefined || name === null ? "" : name)
      .trim()
      .toLowerCase();
    if (value) this.capabilities.add(value);
  }

  _absorbCapabilityResponse(response) {
    const tokens = response.tokens;
    if (String(tokens[0]) !== "*") return;
    if (
      String(tokens[1] === undefined ? "" : tokens[1]).toUpperCase() !==
      "CAPABILITY"
    )
      return;
    for (const token of tokens.slice(2)) {
      if (typeof token === "string") this._addCapability(token);
    }
  }

  _absorbCapabilitiesFromText(text) {
    const match = /\[CAPABILITY\s+([^\]]*)\]/i.exec(
      String(text === undefined || text === null ? "" : text),
    );
    if (!match) return;
    for (const part of match[1].trim().split(/\s+/)) this._addCapability(part);
  }

  /* ----------------------------------------------------------------------------------------- *
   * Public API
   * ----------------------------------------------------------------------------------------- */

  async connect() {
    if (this._connected) return;
    this._destroySocket();
    this._buf = Buffer.alloc(0);
    this._waiters = [];
    this._closed = false;
    this._streamError = null;
    this._authenticated = false;
    this._loggedOut = false;
    this.capabilities.clear();

    this._log(
      "debug",
      "connecting to " +
        this.host +
        ":" +
        this.port +
        " (" +
        (this.secure ? "tls" : "tcp") +
        ")",
    );
    try {
      await this._openSocket();
      const greeting = await this._withTimeout(
        this._readResponse(),
        "greeting from " + this.host + ":" + this.port,
      );
      const status = String(
        greeting.tokens[1] === undefined ? "" : greeting.tokens[1],
      ).toUpperCase();
      if (status === "BYE") {
        throw this._imapError(
          "server " +
            this.host +
            ":" +
            this.port +
            " refused the connection: " +
            abbreviate(greeting.text),
          "network",
        );
      }
      if (status !== "OK" && status !== "PREAUTH") {
        throw this._imapError(
          "unexpected greeting from " +
            this.host +
            ":" +
            this.port +
            ": " +
            abbreviate(greeting.text),
          "protocol",
        );
      }
      this._log("debug", "<< " + abbreviate(greeting.text));
      this._absorbCapabilitiesFromText(greeting.text);
      if (status === "PREAUTH") this._authenticated = true;

      const capability = await this._execute("CAPABILITY", {
        name: "CAPABILITY",
        onUntagged: (response) => this._absorbCapabilityResponse(response),
      });
      this._ok(capability, "CAPABILITY");
      this._log(
        "info",
        "connected to " +
          this.host +
          ":" +
          this.port +
          "; capabilities: " +
          Array.from(this.capabilities).join(" "),
      );
    } catch (error) {
      this._destroySocket();
      throw error;
    }
  }

  async login(user, pass) {
    if (typeof user !== "string" || typeof pass !== "string")
      throw new TypeError("login(user, pass): both arguments must be strings");
    const secrets = [pass, quoteString(pass)];
    for (const secret of secrets) this._secrets.add(secret);
    try {
      const result = await this._execute(
        "LOGIN " + quoteString(user) + " " + quoteString(pass),
        { name: "LOGIN", sensitive: true },
      );
      this._ok(result, "LOGIN", "auth");
      this._authenticated = true;
      this._log(
        "info",
        "authenticated as " + user + " on " + this.host + ":" + this.port,
      );
    } finally {
      for (const secret of secrets) this._secrets.delete(secret);
    }
  }

  async listMailboxes() {
    const mailboxes = [];
    // the reference name and the pattern travel in modified UTF-7 like any other mailbox name
    const reference = quoteString(encodeMailboxName(""));
    const pattern = quoteString(encodeMailboxName("*"));
    const result = await this._execute("LIST " + reference + " " + pattern, {
      name: "LIST",
      onUntagged: (response) => {
        const tokens = response.tokens;
        if (
          String(tokens[0]) !== "*" ||
          String(tokens[1] === undefined ? "" : tokens[1]).toUpperCase() !==
            "LIST"
        )
          return;
        const nameToken = tokens[4];
        if (nameToken === undefined || nameToken === null) return;
        const rawName =
          nameToken instanceof ImapLiteral
            ? nameToken.toString("utf8")
            : String(nameToken);
        const name = decodeMailboxName(rawName);
        const delimiterToken = tokens[3];
        const delimiter =
          delimiterToken === undefined || delimiterToken === null
            ? null
            : String(delimiterToken);
        mailboxes.push({ name, delimiter });
      },
    });
    this._ok(result, "LIST");
    return mailboxes;
  }

  async select(mailbox) {
    if (typeof mailbox !== "string" || mailbox.length === 0)
      throw new TypeError(
        "select(mailbox): mailbox must be a non-empty string",
      );
    const texts = [];
    let exists = null;
    const result = await this._execute(
      "SELECT " + quoteString(encodeMailboxName(mailbox)),
      {
        name: "SELECT",
        onUntagged: (response) => {
          texts.push(response.text);
          const tokens = response.tokens;
          if (String(tokens[0]) !== "*") return;
          if (
            typeof tokens[1] === "string" &&
            /^\d+$/.test(tokens[1]) &&
            String(tokens[2] === undefined ? "" : tokens[2]).toUpperCase() ===
              "EXISTS"
          ) {
            exists = Number(tokens[1]);
          }
        },
      },
    );
    this._ok(result, "SELECT");
    texts.push(result.text);
    const joined = texts.join("\n");
    return {
      uidValidity: matchNumber(joined, /\[UIDVALIDITY\s+(\d+)\]/i),
      uidNext: matchNumber(joined, /\[UIDNEXT\s+(\d+)\]/i),
      exists,
      readOnly: /\[READ-ONLY\]/i.test(joined),
    };
  }

  async uidFetch({
    fromUid,
    toUid,
    uids,
    items = ["UID", "FLAGS", "RFC822"],
  } = {}) {
    const set = uids ? toUidList(uids) : toUidSet(fromUid, toUid);
    const requestItems = toFetchItems(items);
    const messages = [];
    const result = await this._execute(
      "UID FETCH " + set + " (" + requestItems.join(" ") + ")",
      {
        name: "UID FETCH",
        onUntagged: (response) => {
          const parsed = parseFetchTokens(response.tokens);
          if (parsed && parsed.uid !== null) messages.push(parsed);
        },
      },
    );
    this._ok(result, "UID FETCH");
    messages.sort((left, right) => left.uid - right.uid);
    return messages.map((message) => ({
      uid: message.uid,
      flags: message.flags,
      size: message.size,
      raw: message.raw,
      ...(requestItems.some((i) => i === "INTERNALDATE")
        ? { internalDate: message.internalDate }
        : {}),
    }));
  }

  async uidSearch({ uidFrom, unseen = false, before, since } = {}) {
    const criteria = [];
    const from = toPositiveInteger(uidFrom, "uidFrom");
    if (from !== null) criteria.push("UID " + from + ":*");
    if (unseen) criteria.push("UNSEEN");
    const sinceDate = toSearchDate(since, "since");
    if (sinceDate) criteria.push("SINCE " + sinceDate);
    const beforeDate = toSearchDate(before, "before");
    if (beforeDate) criteria.push("BEFORE " + beforeDate);
    if (criteria.length === 0) criteria.push("ALL");

    const uids = [];
    const result = await this._execute("UID SEARCH " + criteria.join(" "), {
      name: "UID SEARCH",
      onUntagged: (response) => {
        const tokens = response.tokens;
        if (
          String(tokens[0]) !== "*" ||
          String(tokens[1] === undefined ? "" : tokens[1]).toUpperCase() !==
            "SEARCH"
        )
          return;
        for (const token of tokens.slice(2)) {
          const uid = Number(token);
          if (Number.isInteger(uid) && uid > 0) uids.push(uid);
        }
      },
    });
    this._ok(result, "UID SEARCH");
    return Array.from(new Set(uids))
      .filter((uid) => from === null || uid >= from)
      .sort((left, right) => left - right);
  }

  async uidStore(uids, { addFlags = [], removeFlags = [] } = {}) {
    const set = toUidList(uids);
    if (!set) return;
    const add = toFlagList(addFlags, "addFlags");
    const remove = toFlagList(removeFlags, "removeFlags");
    if (add.length > 0)
      this._ok(
        await this._execute(
          "UID STORE " + set + " +FLAGS (" + add.join(" ") + ")",
          { name: "UID STORE" },
        ),
        "UID STORE",
      );
    if (remove.length > 0)
      this._ok(
        await this._execute(
          "UID STORE " + set + " -FLAGS (" + remove.join(" ") + ")",
          { name: "UID STORE" },
        ),
        "UID STORE",
      );
  }

  async uidMove(uids, destMailbox) {
    const set = toUidList(uids);
    if (!set) return;
    if (typeof destMailbox !== "string" || destMailbox.length === 0)
      throw new TypeError(
        "uidMove(uids, destMailbox): destMailbox must be a non-empty string",
      );
    const destination = quoteString(encodeMailboxName(destMailbox));

    if (this.capabilities.has("move")) {
      const result = await this._execute(
        "UID MOVE " + set + " " + destination,
        { name: "UID MOVE" },
      );
      const status = String(
        result.status === undefined || result.status === null
          ? ""
          : result.status,
      ).toUpperCase();
      if (status === "OK") return;
      if (status !== "BAD") {
        // The server advertised MOVE and still refused this move (NO/BYE): that is a real answer
        // about this command (a missing destination, a policy block), so surface it instead of
        // masking it behind a COPY. Only "unknown command" (BAD) means the extension is unusable.
        this._ok(result, "UID MOVE");
      }
      this._log(
        "warn",
        "UID MOVE was rejected with BAD by " +
          this.host +
          "; falling back to COPY + STORE \\Deleted + EXPUNGE",
      );
    } else {
      this._log(
        "debug",
        this.host +
          " does not advertise MOVE; using COPY + STORE \\Deleted + EXPUNGE",
      );
    }

    // Gmail's native labels are reversible and require no EXPUNGE at all.
    if (!this.capabilities.has("uidplus") && this.capabilities.has("x-gm-ext-1")) {
      const leaf = destMailbox.split('/').at(-1).toLowerCase();
      const slash = String.fromCharCode(92);
      const systemLabel = ['spam','junk','垃圾邮件'].includes(leaf) ? slash + 'Spam'
        : ['trash','bin','已删除邮件'].includes(leaf) ? slash + 'Trash' : null;
      const archive = ['all mail','所有邮件'].includes(leaf);
      if (!systemLabel && !archive) throw this._imapError('Unsupported Gmail label destination', 'protocol');
      if (systemLabel) this._ok(await this._execute('UID STORE ' + set + ' +X-GM-LABELS (' + quoteString(systemLabel) + ')', { name: 'UID STORE' }), 'UID STORE');
      this._ok(await this._execute('UID STORE ' + set + ' -X-GM-LABELS (' + quoteString(slash + 'Inbox') + ')', { name: 'UID STORE' }), 'UID STORE');
      return;
    }
    if (!this.capabilities.has("uidplus"))
      throw this._imapError(
        "Safe move requires MOVE or UIDPLUS; global EXPUNGE is forbidden",
        "protocol",
      );
    this._ok(
      await this._execute("UID COPY " + set + " " + destination, {
        name: "UID COPY",
      }),
      "UID COPY",
    );
    this._ok(
      await this._execute("UID STORE " + set + " +FLAGS (\\Deleted)", {
        name: "UID STORE",
      }),
      "UID STORE",
    );
    this._ok(
      await this._execute("UID EXPUNGE " + set, { name: "UID EXPUNGE" }),
      "UID EXPUNGE",
    );
  }

  async noop() {
    this._ok(await this._execute("NOOP", { name: "NOOP" }), "NOOP");
  }

  /** LOGOUT is best effort and idempotent: it never throws and it always closes the socket. */
  async logout() {
    if (this._loggedOut || !this._connected || this._closed) {
      this._loggedOut = true;
      this._authenticated = false;
      this._destroySocket();
      return;
    }
    this._loggedOut = true;
    try {
      await this._execute("LOGOUT", { name: "LOGOUT" });
    } catch (error) {
      this._log(
        "warn",
        "LOGOUT on " +
          this.host +
          ":" +
          this.port +
          " failed: " +
          (error && error.message ? error.message : String(error)),
      );
    }
    this._authenticated = false;
    this._destroySocket();
  }

  /** Destroy the socket immediately; never throws. */
  destroy() {
    try {
      this._loggedOut = true;
      this._authenticated = false;
      this._destroySocket();
    } catch {
      /* destroying must never throw */
    }
  }
}

function abbreviate(text, limit = 200) {
  const value = String(text === undefined || text === null ? "" : text).replace(
    /[\r\n]+/g,
    " ",
  );
  return value.length > limit ? value.slice(0, limit) + "..." : value;
}
