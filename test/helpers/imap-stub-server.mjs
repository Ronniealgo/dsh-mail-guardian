/**
 * dsh-mail-guardian -- in-memory IMAP4rev1 stub server for tests only.
 *
 * node:net only, binds 127.0.0.1 on a random free port, no external dependencies.
 *
 *   const stub = await startStubServer(options);
 *   stub.host / stub.port / stub.state / await stub.close()
 *
 * Options
 *   users         { user: password }              default { alice: 'correct-password' }
 *   messages      Buffer[] of canned raw messages, placed in INBOX with UIDs 1..n
 *   capabilities  string[]                        default ['imap4rev1', 'move', 'uidplus']
 *   simulate      'none' | 'drop-mid-fetch' | 'slow' | 'move-no' | 'move-bad'
 *                   drop-mid-fetch: write half of a FETCH response, then destroy the socket
 *                   slow:           delay commands by slowMs (default 3000) before answering
 *                   move-no:        UID MOVE answers NO (a real refusal, not an unknown command)
 *                   move-bad:       UID MOVE answers BAD (unknown command) even though MOVE is
 *                                   advertised, so the client takes the COPY fallback
 *   mailboxes     string[]  decoded UTF-8 mailbox names, e.g. ['INBOX', '低优先', '垃圾箱'];
 *                           always contains INBOX.       default ['INBOX', 'Archive', 'Trash']
 *   messageFlags  string[][] aligned with messages (default: every message is unseen)
 *   delimiter     mailbox hierarchy delimiter     default '/'
 *   uidValidity   SELECT [UIDVALIDITY n]          default 1
 *   slowMs        delay used by simulate 'slow'   default 3000
 *   slowCommands  only delay these command names, e.g. ['UID FETCH'] (default: all commands)
 *   dropAfterBytes bytes of the literal written before the socket is destroyed (default 24)
 *
 * Commands: CAPABILITY, LOGIN, LOGOUT, NOOP, LIST, SELECT, UID FETCH, UID SEARCH, UID STORE,
 * UID COPY, UID MOVE, EXPUNGE, UID EXPUNGE. Response literals carry the raw message bytes, so
 * multi-byte UTF-8 headers and bodies are returned exactly as supplied.
 *
 * UID FETCH understands RFC 3501 partial requests: "BODY.PEEK[]<0.N>" (or "BODY[]<start.count>")
 * is answered with a "BODY[]<start> {n}" literal carrying exactly that octet range, while
 * RFC822.SIZE still reports the full original size. INTERNALDATE is the message's server date.
 *
 * Mailbox names are RFC 3501 modified UTF-7 on the wire and decoded UTF-8 everywhere in this file:
 * the names accepted by options.mailboxes and stored in state.mailboxes are UTF-8, LIST writes
 * them encoded, and the mailbox argument of SELECT / UID COPY / UID MOVE is decoded before it is
 * looked up. "UID MOVE/UID COPY <set> <mailbox>" answers NO [TRYCREATE] for an unknown mailbox and
 * otherwise copies the messages, dropping them from the selected mailbox for UID MOVE.
 * encodeMailboxName/decodeMailboxName are exported so a test can cross-check the client codec
 * against this independent implementation.
 *
 * state
 *   state.commandLog   string[]  command lines as received (the LOGIN password is always masked)
 *   state.logins       [{ user, ok }]
 *   state.connections  number of accepted TCP connections
 *   state.mailboxes    Map<name, { name, delimiter, uidValidity, uidNext, messages }>
 *                      messages: [{ uid, flags: string[], raw: Buffer, date: Date }]
 *   state.messagesOf(name) / state.uidsOf(name) / state.byUid(name, uid)
 *   state.flagsOf(name, uid) / state.rawOf(name, uid)
 *
 * Message dates come from the Date: header of the canned message; when it is missing or
 * unparseable the stub falls back to 2024-01-01 UTC + one day per message index. SEARCH
 * SINCE/BEFORE compare whole UTC days.
 */

import net from "node:net";

const CRLF = "\r\n";
const SIMULATIONS = new Set([
  "none",
  "drop-mid-fetch",
  "slow",
  "move-no",
  "move-bad",
]);
const MONTHS = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/* ------------------------------------------------------------------------------------------- *
 * RFC 3501 modified UTF-7 -- an implementation independent from lib/imap-client.js so the tests
 * compare two codecs instead of one codec with itself. Printable ASCII passes through, "&" becomes
 * "&-", anything else becomes base64(UTF-16BE) with "A-Za-z0-9+," between "&" and "-".
 * ------------------------------------------------------------------------------------------- */

const MUTF7_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,";
const MUTF7_VALUES = new Map(
  Array.from(MUTF7_ALPHABET, (char, value) => [char, value]),
);

function toModifiedBase64(bytes) {
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

function fromModifiedBase64(text) {
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
  if (bytes.length === 0 || bytes.length % 2 !== 0) return null;
  return Buffer.from(bytes);
}

/** UTF-8 mailbox name -> modified UTF-7 wire form. */
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
    out += "&" + toModifiedBase64(bytes) + "-";
  }
  return out;
}

/** Modified UTF-7 wire form -> UTF-8 mailbox name; malformed sections are kept verbatim. */
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
    const bytes = fromModifiedBase64(encoded);
    if (bytes === null) {
      out += value.slice(marker, end + 1);
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

export async function startStubServer(options = {}) {
  const opts = options || {};
  const users = Object.assign({ alice: "correct-password" }, opts.users || {});
  const canned = Array.isArray(opts.messages) ? opts.messages : [];
  const capabilities = (
    Array.isArray(opts.capabilities)
      ? opts.capabilities
      : ["imap4rev1", "move", "uidplus"]
  ).map((cap) => String(cap));
  const simulate = opts.simulate === undefined ? "none" : String(opts.simulate);
  if (!SIMULATIONS.has(simulate))
    throw new TypeError('startStubServer: unknown simulate "' + simulate + '"');
  const delimiter = opts.delimiter === undefined ? "/" : opts.delimiter;
  const uidValidity = Number.isFinite(opts.uidValidity) ? opts.uidValidity : 1;
  const slowMs = Number.isFinite(opts.slowMs) ? opts.slowMs : 3000;
  const slowCommands = Array.isArray(opts.slowCommands)
    ? opts.slowCommands.map((name) => String(name).toUpperCase())
    : null;
  const dropAfterBytes = Number.isFinite(opts.dropAfterBytes)
    ? opts.dropAfterBytes
    : 24;

  const state = {
    users: Object.assign({}, users),
    capabilities: capabilities.slice(),
    simulate,
    commandLog: [],
    logins: [],
    connections: 0,
    mailboxes: new Map(),
  };

  const names = (
    Array.isArray(opts.mailboxes)
      ? opts.mailboxes
      : ["INBOX", "Archive", "Trash"]
  ).map((name) => String(name));
  if (!names.includes("INBOX")) names.unshift("INBOX");
  for (const name of names) {
    if (!state.mailboxes.has(name))
      state.mailboxes.set(name, {
        name,
        delimiter,
        uidValidity,
        uidNext: 1,
        messages: [],
      });
  }

  const inbox = state.mailboxes.get("INBOX");
  canned.forEach((raw, index) => {
    if (!Buffer.isBuffer(raw))
      throw new TypeError(
        "startStubServer: messages[" + index + "] must be a Buffer",
      );
    const flags =
      Array.isArray(opts.messageFlags) &&
      Array.isArray(opts.messageFlags[index])
        ? opts.messageFlags[index].map(String)
        : [];
    inbox.messages.push({
      uid: inbox.uidNext,
      flags,
      raw: Buffer.from(raw),
      date: headerDate(raw) || fallbackDate(index),
    });
    inbox.uidNext += 1;
  });

  state.messagesOf = (name = "INBOX") =>
    state.mailboxes.get(name) ? state.mailboxes.get(name).messages : [];
  state.uidsOf = (name = "INBOX") =>
    state.messagesOf(name).map((message) => message.uid);
  state.byUid = (name, uid) =>
    state.messagesOf(name).find((message) => message.uid === uid) || null;
  state.flagsOf = (name, uid) => {
    const message = state.byUid(name, uid);
    return message ? message.flags.slice() : null;
  };
  state.rawOf = (name, uid) => {
    const message = state.byUid(name, uid);
    return message ? Buffer.from(message.raw) : null;
  };

  const sockets = new Set();
  const timers = new Set();

  function later(fn, ms) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
    timers.add(timer);
    return timer;
  }

  const hasCapability = (name) =>
    capabilities.some(
      (cap) => cap.toLowerCase() === String(name).toLowerCase(),
    );

  function writeLine(socket, line) {
    if (!socket.destroyed) socket.write(line + CRLF);
  }

  function writeLines(socket, lines) {
    if (!socket.destroyed) socket.write(lines.join(CRLF) + CRLF);
  }

  function selectedBox(conn) {
    const box = state.mailboxes.get(conn.selected || "INBOX");
    if (!box) throw new Error("no mailbox selected");
    return box;
  }

  const maxUidOf = (box) =>
    box.messages.reduce((max, message) => Math.max(max, message.uid), 0);

  function parseUidSet(text, maxUid) {
    const uids = new Set();
    for (const part of String(text === undefined ? "" : text).split(",")) {
      const token = part.trim();
      if (!token) continue;
      const range = /^(\d+):(\d+|\*)$/.exec(token);
      if (range) {
        const start = Number(range[1]);
        const end = range[2] === "*" ? maxUid : Number(range[2]);
        for (let uid = start; uid <= end; uid += 1) uids.add(uid);
        continue;
      }
      if (token === "*") {
        uids.add(maxUid);
        continue;
      }
      if (/^\d+$/.test(token)) uids.add(Number(token));
    }
    return uids;
  }

  /** Tokens between the first '(' and its ')' of a command argument list. */
  function listItems(args) {
    const items = [];
    let inside = false;
    for (const token of args) {
      if (token === "(") {
        inside = true;
        continue;
      }
      if (token === ")") {
        inside = false;
        continue;
      }
      if (inside) items.push(token);
    }
    return items;
  }

  function parseSearchDate(text) {
    const imap = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(text));
    if (imap) {
      const month = MONTHS[imap[2].toLowerCase()];
      if (month === undefined) return null;
      return Date.UTC(Number(imap[3]), month, Number(imap[1]));
    }
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text));
    if (iso)
      return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return null;
  }

  const dayOf = (date) =>
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

  function headerDate(raw) {
    const match = /^date:[ \t]*(.+)$/im.exec(raw.toString("latin1"));
    if (!match) return null;
    const parsed = new Date(match[1].trim());
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function fallbackDate(index) {
    return new Date(Date.UTC(2024, 0, 1) + index * 86400000);
  }

  function copyInto(box, message) {
    const copy = {
      uid: box.uidNext,
      flags: message.flags.slice(),
      raw: Buffer.from(message.raw),
      date: new Date(message.date.getTime()),
    };
    box.uidNext += 1;
    box.messages.push(copy);
    return copy;
  }

  function buildFetch(message, sequence, items) {
    const parts = [];
    for (const item of items) {
      const key = String(item).toUpperCase();
      if (key === "UID") parts.push("UID " + message.uid);
      else if (key === "FLAGS")
        parts.push("FLAGS (" + message.flags.join(" ") + ")");
      else if (key === "RFC822.SIZE")
        parts.push("RFC822.SIZE " + message.raw.length);
      else if (key === "INTERNALDATE")
        parts.push('INTERNALDATE "' + internalDate(message.date) + '"');
      else if (
        key === "RFC822" ||
        key === "RFC822.TEXT" ||
        key === "RFC822.HEADER" ||
        key === "BODY[]" ||
        key === "BODY.PEEK[]" ||
        key === "BODY[HEADER]"
      ) {
        parts.push({
          literal: message.raw,
          marker: key + " {" + message.raw.length + "}",
        });
      } else {
        // RFC 3501 partial fetch: answer "BODY[]<start> {n}" with only the requested octets.
        // RFC822.SIZE above stays the full message size so a client can tell preview from original.
        const partial = /^(BODY(?:\.PEEK)?\[[^\]]*\])<(\d+)\.(\d+)>$/.exec(key);
        if (partial) {
          const start = Number(partial[2]);
          const count = Number(partial[3]);
          const slice = message.raw.subarray(start, start + count);
          // RFC 3501: the response marker drops the .PEEK modifier and names the start octet.
          parts.push({
            literal: slice,
            marker: "BODY[]<" + start + "> {" + slice.length + "}",
          });
        }
      }
    }
    const chunks = [Buffer.from("* " + sequence + " FETCH (", "utf8")];
    parts.forEach((part, index) => {
      if (index > 0) chunks.push(Buffer.from(" ", "utf8"));
      if (typeof part === "string") chunks.push(Buffer.from(part, "utf8"));
      else chunks.push(Buffer.from(part.marker + CRLF, "utf8"), part.literal);
    });
    chunks.push(Buffer.from(")" + CRLF, "utf8"));
    return Buffer.concat(chunks);
  }

  function internalDate(date) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = [
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
    ];
    const pad = (value) => String(value).padStart(2, "0");
    return (
      days[date.getUTCDay()] +
      ", " +
      pad(date.getUTCDate()) +
      " " +
      months[date.getUTCMonth()] +
      " " +
      date.getUTCFullYear() +
      " " +
      pad(date.getUTCHours()) +
      ":" +
      pad(date.getUTCMinutes()) +
      ":" +
      pad(date.getUTCSeconds()) +
      " +0000"
    );
  }

  function tokenizeCommand(text) {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
      const char = text[i];
      if (char === " " || char === "\t" || char === "\r" || char === "\n") {
        i += 1;
        continue;
      }
      if (char === "(" || char === ")") {
        tokens.push(char);
        i += 1;
        continue;
      }
      if (char === '"') {
        let value = "";
        i += 1;
        while (i < text.length) {
          const inner = text[i];
          if (inner === "\\") {
            value += text[i + 1] === undefined ? "" : text[i + 1];
            i += 2;
            continue;
          }
          if (inner === '"') {
            i += 1;
            break;
          }
          value += inner;
          i += 1;
        }
        tokens.push(value);
        continue;
      }
      let end = i;
      while (end < text.length && ' \t\r\n()"'.indexOf(text[end]) === -1)
        end += 1;
      tokens.push(text.slice(i, end));
      i = end;
    }
    return tokens;
  }

  function dropMidFetch(conn, request) {
    const box = selectedBox(conn);
    const message = box.messages[0];
    const socket = conn.socket;
    if (!message) {
      writeLine(socket, request.tag + " OK UID FETCH completed");
      return;
    }
    const head =
      "* 1 FETCH (UID " +
      message.uid +
      " RFC822 {" +
      message.raw.length +
      "}" +
      CRLF;
    const partial = Buffer.concat([
      Buffer.from(head, "utf8"),
      message.raw.subarray(0, Math.min(dropAfterBytes, message.raw.length)),
    ]);
    socket.write(partial, () => {
      later(() => {
        try {
          socket.destroy();
        } catch {
          /* the socket is already gone */
        }
      }, 20);
    });
  }

  function expunge(conn, box, predicate) {
    const socket = conn.socket;
    for (let index = box.messages.length - 1; index >= 0; index -= 1) {
      if (!predicate(box.messages[index])) continue;
      box.messages.splice(index, 1);
      writeLine(socket, "* " + (index + 1) + " EXPUNGE");
    }
  }

  function doSearch(box, args) {
    let selected = box.messages.slice();
    for (let i = 0; i < args.length; i += 1) {
      const criterion = String(args[i]).toUpperCase();
      if (criterion === "UID") {
        const uids = parseUidSet(args[i + 1], maxUidOf(box));
        selected = selected.filter((message) => uids.has(message.uid));
        i += 1;
      } else if (criterion === "UNSEEN") {
        selected = selected.filter(
          (message) => !message.flags.includes("\\Seen"),
        );
      } else if (criterion === "SEEN") {
        selected = selected.filter((message) =>
          message.flags.includes("\\Seen"),
        );
      } else if (criterion === "DELETED") {
        selected = selected.filter((message) =>
          message.flags.includes("\\Deleted"),
        );
      } else if (criterion === "UNDELETED") {
        selected = selected.filter(
          (message) => !message.flags.includes("\\Deleted"),
        );
      } else if (
        criterion === "SINCE" ||
        criterion === "BEFORE" ||
        criterion === "ON"
      ) {
        const day = parseSearchDate(args[i + 1]);
        i += 1;
        if (day === null) continue;
        selected = selected.filter((message) => {
          const value = dayOf(message.date);
          if (criterion === "SINCE") return value >= day;
          if (criterion === "BEFORE") return value < day;
          return value === day;
        });
      }
    }
    return selected;
  }

  function dispatch(conn, request) {
    const socket = conn.socket;
    const tag = request.tag;
    const args = request.args;

    switch (request.name) {
      case "CAPABILITY":
        writeLines(socket, [
          "* CAPABILITY " + capabilities.join(" "),
          tag + " OK CAPABILITY completed",
        ]);
        return;

      case "LOGIN": {
        const user = args[0];
        const password = args[1];
        const expected = Object.prototype.hasOwnProperty.call(users, user)
          ? users[user]
          : undefined;
        const ok = expected !== undefined && expected === password;
        state.logins.push({ user, ok });
        if (ok) {
          conn.authenticated = true;
          conn.user = user;
          writeLine(
            socket,
            tag +
              " OK [CAPABILITY " +
              capabilities.join(" ") +
              "] LOGIN completed",
          );
        } else {
          writeLine(
            socket,
            tag + " NO [AUTHENTICATIONFAILED] Invalid credentials",
          );
        }
        return;
      }

      case "LOGOUT":
        writeLines(socket, [
          "* BYE dsh-mail-guardian stub signing off",
          tag + " OK LOGOUT completed",
        ]);
        socket.end();
        return;

      case "NOOP":
        writeLine(socket, tag + " OK NOOP completed");
        return;

      case "LIST":
        for (const box of state.mailboxes.values()) {
          writeLine(
            socket,
            '* LIST (\\HasNoChildren) "' +
              box.delimiter +
              '" "' +
              encodeMailboxName(box.name) +
              '"',
          );
        }
        writeLine(socket, tag + " OK LIST completed");
        return;

      case "SELECT": {
        const box = state.mailboxes.get(decodeMailboxName(args[0]));
        if (!box) {
          writeLine(socket, tag + " NO [NONEXISTENT] no such mailbox");
          return;
        }
        conn.selected = box.name;
        writeLines(socket, [
          "* " + box.messages.length + " EXISTS",
          "* 0 RECENT",
          "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)",
          "* OK [UIDVALIDITY " + box.uidValidity + "] UIDs valid",
          "* OK [UIDNEXT " + box.uidNext + "] Predicted next UID",
          tag + " OK [READ-WRITE] SELECT completed",
        ]);
        return;
      }

      case "FETCH": {
        if (!request.uid) {
          writeLine(socket, tag + " BAD this stub only implements UID FETCH");
          return;
        }
        if (simulate === "drop-mid-fetch") {
          dropMidFetch(conn, request);
          return;
        }
        const box = selectedBox(conn);
        const uids = parseUidSet(args[0], maxUidOf(box));
        const items = listItems(args.slice(1));
        const chunks = [];
        box.messages.forEach((message, index) => {
          if (!uids.has(message.uid)) return;
          chunks.push(buildFetch(message, index + 1, items));
        });
        if (chunks.length > 0) socket.write(Buffer.concat(chunks));
        writeLine(socket, tag + " OK UID FETCH completed");
        return;
      }

      case "SEARCH": {
        if (!request.uid) {
          writeLine(socket, tag + " BAD this stub only implements UID SEARCH");
          return;
        }
        const box = selectedBox(conn);
        const found = doSearch(box, args).map((message) => message.uid);
        writeLine(
          socket,
          "* SEARCH" + (found.length > 0 ? " " + found.join(" ") : ""),
        );
        writeLine(socket, tag + " OK UID SEARCH completed");
        return;
      }

      case "STORE": {
        if (!request.uid) {
          writeLine(socket, tag + " BAD this stub only implements UID STORE");
          return;
        }
        const box = selectedBox(conn);
        const uids = parseUidSet(args[0], maxUidOf(box));
        const mode = String(args[1] === undefined ? "" : args[1]).toUpperCase();
        const silent = mode.endsWith(".SILENT");
        const base = mode.replace(".SILENT", "");
        const flags = listItems(args.slice(2));
        box.messages.forEach((message, index) => {
          if (!uids.has(message.uid)) return;
          if (base === "+FLAGS") {
            for (const flag of flags)
              if (!message.flags.includes(flag)) message.flags.push(flag);
          } else if (base === "-FLAGS") {
            message.flags = message.flags.filter(
              (flag) => !flags.includes(flag),
            );
          } else if (base === "FLAGS") {
            message.flags = flags.slice();
          }
          if (!silent)
            writeLine(
              socket,
              "* " +
                (index + 1) +
                " FETCH (UID " +
                message.uid +
                " FLAGS (" +
                message.flags.join(" ") +
                "))",
            );
        });
        writeLine(socket, tag + " OK UID STORE completed");
        return;
      }

      case "COPY":
      case "MOVE": {
        if (!request.uid) {
          writeLine(
            socket,
            tag + " BAD this stub only implements UID " + request.name,
          );
          return;
        }
        if (request.name === "MOVE") {
          if (simulate === "move-bad") {
            // a server that advertises MOVE and then calls it unknown: the client must fall back
            writeLine(socket, tag + " BAD Unknown command: UID MOVE");
            return;
          }
          if (simulate === "move-no") {
            writeLine(socket, tag + " NO MOVE is disabled by policy");
            return;
          }
          if (!hasCapability("move")) {
            writeLine(socket, tag + " BAD Unknown command: UID MOVE");
            return;
          }
        }
        const box = selectedBox(conn);
        const mailbox = decodeMailboxName(args[1]);
        const destination = state.mailboxes.get(mailbox);
        if (!destination) {
          writeLine(
            socket,
            tag + ' NO [TRYCREATE] no such mailbox "' + args[1] + '"',
          );
          return;
        }
        const uids = parseUidSet(args[0], maxUidOf(box));
        const copied = [];
        for (const message of box.messages.slice()) {
          if (!uids.has(message.uid)) continue;
          copied.push(copyInto(destination, message));
        }
        if (request.name === "MOVE") {
          box.messages = box.messages.filter(
            (message) => !uids.has(message.uid),
          );
        }
        const code =
          copied.length > 0
            ? " [COPYUID " +
              box.uidValidity +
              " " +
              args[0] +
              " " +
              copied.map((message) => message.uid).join(",") +
              "]"
            : "";
        writeLine(
          socket,
          tag + " OK" + code + " UID " + request.name + " completed",
        );
        return;
      }

      case "EXPUNGE": {
        const box = selectedBox(conn);
        if (request.uid) {
          const uids = parseUidSet(args[0], maxUidOf(box));
          expunge(
            conn,
            box,
            (message) =>
              uids.has(message.uid) && message.flags.includes("\\Deleted"),
          );
          writeLine(socket, tag + " OK UID EXPUNGE completed");
        } else {
          expunge(conn, box, (message) => message.flags.includes("\\Deleted"));
          writeLine(socket, tag + " OK EXPUNGE completed");
        }
        return;
      }

      default:
        writeLine(socket, tag + " BAD Unknown command: " + request.name);
    }
  }

  function handleLine(conn, line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    const match = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
    const tag = match[1];
    const text = match[2].trim();
    const tokens = tokenizeCommand(text);
    const uid = tokens.length > 0 && tokens[0].toUpperCase() === "UID";
    const name =
      (uid ? tokens[1] : tokens[0]) === undefined
        ? ""
        : String(uid ? tokens[1] : tokens[0]).toUpperCase();
    const args = uid ? tokens.slice(2) : tokens.slice(1);

    state.commandLog.push(
      name === "LOGIN"
        ? "LOGIN " + (args[0] === undefined ? "" : args[0]) + ' "***"'
        : text,
    );

    const request = { tag, name, uid, args, text };
    const label = uid ? "UID " + name : name;
    const delayed =
      simulate === "slow" &&
      (slowCommands === null ||
        slowCommands.some((entry) => label.startsWith(entry)));
    if (delayed) {
      later(() => {
        try {
          dispatch(conn, request);
        } catch (error) {
          writeLine(conn.socket, tag + " BAD stub failure: " + error.message);
        }
      }, slowMs);
      return;
    }
    try {
      dispatch(conn, request);
    } catch (error) {
      writeLine(conn.socket, tag + " BAD stub failure: " + error.message);
    }
  }

  function handleConnection(socket) {
    state.connections += 1;
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    const conn = {
      socket,
      buffer: Buffer.alloc(0),
      selected: null,
      authenticated: false,
      user: null,
    };
    writeLine(
      socket,
      "* OK [CAPABILITY " +
        capabilities.join(" ") +
        "] dsh-mail-guardian stub ready",
    );
    socket.on("data", (chunk) => {
      conn.buffer = Buffer.concat([conn.buffer, chunk]);
      let index = conn.buffer.indexOf(0x0a);
      while (index >= 0) {
        const line = conn.buffer.subarray(0, index).toString("utf8");
        conn.buffer = conn.buffer.subarray(index + 1);
        handleLine(conn, line);
        index = conn.buffer.indexOf(0x0a);
      }
    });
  }

  const server = net.createServer(handleConnection);
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  const address = server.address();

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    }
    sockets.clear();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return { host: "127.0.0.1", port: address.port, state, close };
}
