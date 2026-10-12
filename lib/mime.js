/**
 * dsh-mail-guardian / lib/mime.js
 *
 * Zero-dependency RFC 5322 / MIME parsing layer: raw message -> normalized MailRecord.
 *
 * Security contract enforced by this module (never relaxed):
 *   - performs NO network I/O (no remote images, no link unfurling, no DNS)
 *   - writes NO files
 *   - never evaluates or executes message content
 *   - every input is treated as untrusted data; malformed input degrades gracefully
 *
 * Public contract (frozen for integrators):
 *   parseMessage(raw, { account, mailbox, uid }) -> MailRecord
 *   htmlToText(html) -> string
 *   decodeHeaderWord(value) -> string
 */

import { TextDecoder } from "node:util";

/* ------------------------------------------------------------------------- *
 * Static tables
 * ------------------------------------------------------------------------- */

// Hosts treated as link shorteners: exact match or ".<host>" suffix match.
const SHORTENER_HOSTS = new Set([
  "bit.ly",
  "t.cn",
  "dwz.cn",
  "tinyurl.com",
  "goo.gl",
  "t.co",
  "is.gd",
  "ow.ly",
  "s.id",
  "rebrand.ly",
  "cutt.ly",
  "shorturl.at",
  "rb.gy",
  "u.nu",
  "tiny.cc",
]);

// Attachment extensions that are dangerous to open (case-insensitive).
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

// MIME/legacy charset label -> WHATWG TextDecoder label.
const CHARSET_ALIASES = Object.freeze({
  "utf-8": "utf-8",
  utf8: "utf-8",
  utf_8: "utf-8",
  "unicode-1-1-utf-8": "utf-8",
  unicode: "utf-8",
  "x-utf-8": "utf-8",
  gbk: "gbk",
  gb2312: "gbk",
  "gb-2312": "gbk",
  gb_2312: "gbk",
  "gb_2312-80": "gbk",
  csgb2312: "gbk",
  csgb231280: "gbk",
  "x-gbk": "gbk",
  chinese: "gbk",
  "csgb2312-80": "gbk",
  gb18030: "gb18030",
  "gb-18030": "gb18030",
  gb_18030: "gb18030",
  big5: "big5",
  "big-5": "big5",
  csbig5: "big5",
  "big5-hkscs": "big5",
  "x-x-big5": "big5",
  "cn-big5": "big5",
  shift_jis: "shift_jis",
  "shift-jis": "shift_jis",
  shiftjis: "shift_jis",
  sjis: "shift_jis",
  "x-sjis": "shift_jis",
  ms_kanji: "shift_jis",
  cp932: "shift_jis",
  "windows-31j": "shift_jis",
  csshiftjis: "shift_jis",
  "iso-8859-1": "iso-8859-1",
  "iso8859-1": "iso-8859-1",
  "iso_8859-1": "iso-8859-1",
  iso88591: "iso-8859-1",
  latin1: "iso-8859-1",
  "latin-1": "iso-8859-1",
  l1: "iso-8859-1",
  cp819: "iso-8859-1",
  "iso-ir-100": "iso-8859-1",
  "windows-1252": "windows-1252",
  cp1252: "windows-1252",
  "x-cp1252": "windows-1252",
  "us-ascii": "utf-8",
  ascii: "utf-8",
  usascii: "utf-8",
  "ansi_x3.4-1968": "utf-8",
  ansi: "windows-1252",
  default: "utf-8",
  unknown: "utf-8",
  "x-unknown": "utf-8",
});

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

// Obsolete RFC 822 zone names (hours offset from UTC).
const OBSOLETE_ZONES = {
  ut: 0,
  utc: 0,
  gmt: 0,
  z: 0,
  est: -5,
  edt: -4,
  cst: -6,
  cdt: -5,
  mst: -7,
  mdt: -6,
  pst: -8,
  pdt: -7,
  bst: 1,
  cet: 1,
  cest: 2,
  eet: 2,
  eest: 3,
  jst: 9,
  kst: 9,
  ist: 5.5,
  nzst: 12,
};

// Common named HTML entities (the ones that actually show up in mail).
const NAMED_ENTITIES = (function buildEntities() {
  const spec =
    "amp:& lt:< gt:> quot:\" apos:' nbsp:\u00a0 iexcl:\u00a1 cent:\u00a2 pound:\u00a3" +
    " curren:\u00a4 yen:\u00a5 brvbar:\u00a6 sect:\u00a7 uml:\u00a8 copy:\u00a9 ordf:\u00aa" +
    " laquo:\u00ab not:\u00ac shy:\u00ad reg:\u00ae macr:\u00af deg:\u00b0 plusmn:\u00b1" +
    " sup2:\u00b2 sup3:\u00b3 acute:\u00b4 micro:\u00b5 para:\u00b6 middot:\u00b7 cedil:\u00b8" +
    " sup1:\u00b9 ordm:\u00ba raquo:\u00bb frac14:\u00bc frac12:\u00bd frac34:\u00be iquest:\u00bf" +
    " Agrave:\u00c0 Aacute:\u00c1 Acirc:\u00c2 Atilde:\u00c3 Auml:\u00c4 Aring:\u00c5 AElig:\u00c6" +
    " Ccedil:\u00c7 Egrave:\u00c8 Eacute:\u00c9 Ecirc:\u00ca Euml:\u00cb Igrave:\u00cc Iacute:\u00cd" +
    " Icirc:\u00ce Iuml:\u00cf ETH:\u00d0 Ntilde:\u00d1 Ograve:\u00d2 Oacute:\u00d3 Ocirc:\u00d4" +
    " Otilde:\u00d5 Ouml:\u00d6 times:\u00d7 Oslash:\u00d8 Ugrave:\u00d9 Uacute:\u00da Ucirc:\u00db" +
    " Uuml:\u00dc Yacute:\u00dd THORN:\u00de szlig:\u00df agrave:\u00e0 aacute:\u00e1 acirc:\u00e2" +
    " atilde:\u00e3 auml:\u00e4 aring:\u00e5 aelig:\u00e6 ccedil:\u00e7 egrave:\u00e8 eacute:\u00e9" +
    " ecirc:\u00ea euml:\u00eb igrave:\u00ec iacute:\u00ed icirc:\u00ee iuml:\u00ef eth:\u00f0" +
    " ntilde:\u00f1 ograve:\u00f2 oacute:\u00f3 ocirc:\u00f4 otilde:\u00f5 ouml:\u00f6 divide:\u00f7" +
    " oslash:\u00f8 ugrave:\u00f9 uacute:\u00fa ucirc:\u00fb uuml:\u00fc yacute:\u00fd thorn:\u00fe" +
    " yuml:\u00ff OElig:\u0152 oelig:\u0153 Scaron:\u0160 scaron:\u0161 Yuml:\u0178 fnof:\u0192" +
    " circ:\u02c6 tilde:\u02dc ensp:\u2002 emsp:\u2003 thinsp:\u2009 zwnj:\u200c zwj:\u200d" +
    " lrm:\u200e rlm:\u200f ndash:\u2013 mdash:\u2014 lsquo:\u2018 rsquo:\u2019 sbquo:\u201a" +
    " ldquo:\u201c rdquo:\u201d bdquo:\u201e dagger:\u2020 Dagger:\u2021 bull:\u2022 hellip:\u2026" +
    " permil:\u2030 prime:\u2032 Prime:\u2033 lsaquo:\u2039 rsaquo:\u203a oline:\u203e frasl:\u2044" +
    " euro:\u20ac trade:\u2122 alefsym:\u2135 larr:\u2190 uarr:\u2191 rarr:\u2192 darr:\u2193" +
    " harr:\u2194 crarr:\u21b5 lArr:\u21d0 uArr:\u21d1 rArr:\u21d2 dArr:\u21d3 hArr:\u21d4" +
    " forall:\u2200 part:\u2202 exist:\u2203 empty:\u2205 nabla:\u2207 isin:\u2208 notin:\u2209" +
    " ni:\u220b prod:\u220f sum:\u2211 minus:\u2212 lowast:\u2217 radic:\u221a prop:\u221d" +
    " infin:\u221e ang:\u2220 and:\u2227 or:\u2228 cap:\u2229 cup:\u222a int:\u222b there4:\u2234" +
    " sim:\u223c cong:\u2245 asymp:\u2248 ne:\u2260 equiv:\u2261 le:\u2264 ge:\u2265 sub:\u2282" +
    " sup:\u2283 nsub:\u2284 sube:\u2286 supe:\u2287 oplus:\u2295 otimes:\u2297 perp:\u22a5" +
    " sdot:\u22c5 lceil:\u2308 rceil:\u2309 lfloor:\u230a rfloor:\u230b lang:\u2329 rang:\u232a" +
    " loz:\u25ca spades:\u2660 clubs:\u2663 hearts:\u2665 diams:\u2666";
  const map = new Map();
  for (const item of spec.split(" ")) {
    const i = item.indexOf(":");
    if (i > 0) {
      const name = item.slice(0, i);
      if (!map.has(name)) map.set(name, item.slice(i + 1));
    }
  }
  return map;
})();

const EMPTY_META = { account: "", mailbox: "", uid: null };

/* ------------------------------------------------------------------------- *
 * Small helpers
 * ------------------------------------------------------------------------- */

function toLatin1Text(raw) {
  if (raw === null || raw === undefined) return "";
  if (Buffer.isBuffer(raw)) return raw.toString("latin1");
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString("latin1");
  const s = String(raw);
  // A string holding code points above 0xFF is already decoded text: re-encode it
  // so every downstream stage keeps working on raw bytes. Pure byte strings (all
  // code points <= 0xFF) are used verbatim.
  if (/[^\x00-\xff]/.test(s)) return Buffer.from(s, "utf8").toString("latin1");
  return s;
}

function splitHeaderBody(text) {
  const m = /\r\n\r\n|\n\n|\r\r/.exec(text);
  if (m)
    return {
      headerText: text.slice(0, m.index),
      body: text.slice(m.index + m[0].length),
    };
  const m2 = /\r\n\n|\n\r\n/.exec(text);
  if (m2)
    return {
      headerText: text.slice(0, m2.index),
      body: text.slice(m2.index + m2[0].length),
    };
  return { headerText: text, body: "" };
}

function parseHeaderBlock(text) {
  const lines = String(text).split(/\r\n|\n|\r/);
  const headers = [];
  for (const line of lines) {
    if (!line) continue;
    if (/^[ \t]/.test(line)) {
      if (headers.length)
        headers[headers.length - 1].value += " " + line.trim();
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) continue; // not a header line: ignore (never throw)
    headers.push({
      name: line.slice(0, idx).trim().toLowerCase(),
      value: line.slice(idx + 1).trim(),
    });
  }
  return headers;
}

function parseEntity(text) {
  // Drop a leading mbox "From " separator line.
  let t = String(text);
  const firstBreak = t.search(/\r\n|\n|\r/);
  const firstLine = firstBreak === -1 ? t : t.slice(0, firstBreak);
  if (/^From\s+\S+/.test(firstLine) && firstLine.indexOf(":") === -1) {
    t =
      firstBreak === -1
        ? ""
        : t.slice(
            firstBreak +
              (t[firstBreak] === "\r" && t[firstBreak + 1] === "\n" ? 2 : 1),
          );
  }
  const split = splitHeaderBody(t);
  // A "header block" without any colon is really body content (headerless part).
  if (split.body === "" && split.headerText.indexOf(":") === -1) {
    return { headers: [], body: split.headerText };
  }
  return { headers: parseHeaderBlock(split.headerText), body: split.body };
}

function headerValues(headers, name) {
  const wanted = String(name).toLowerCase();
  const out = [];
  for (const h of headers) if (h.name === wanted) out.push(h.value);
  return out;
}

function headerValue(headers, name) {
  const values = headerValues(headers, name);
  return values.length ? values[0] : null;
}

// Interpret raw 8-bit header bytes as UTF-8 when they are valid UTF-8 (some
// clients emit non-encoded UTF-8 headers); otherwise keep the byte string.
function normalizeRawBytes(s) {
  if (!s || !/[\x80-\xff]/.test(s)) return s;
  const bytes = Buffer.from(s, "latin1");
  const asUtf8 = bytes.toString("utf8");
  if (asUtf8.indexOf("\ufffd") !== -1) return s;
  return Buffer.from(asUtf8, "utf8").equals(bytes) ? asUtf8 : s;
}

/* ------------------------------------------------------------------------- *
 * Charset decoding
 * ------------------------------------------------------------------------- */

const decoderCache = new Map();

function getDecoder(charset) {
  const raw = String(charset === null || charset === undefined ? "" : charset)
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, "");
  const label = Object.prototype.hasOwnProperty.call(CHARSET_ALIASES, raw)
    ? CHARSET_ALIASES[raw]
    : raw || "utf-8";
  if (decoderCache.has(label)) return decoderCache.get(label);
  let decoder = null;
  try {
    decoder = new TextDecoder(label, { fatal: false });
  } catch (err) {
    decoder = null;
  }
  if (!decoder) {
    try {
      decoder = new TextDecoder("utf-8", { fatal: false });
    } catch (err) {
      decoder = null;
    }
  }
  decoderCache.set(label, decoder);
  return decoder;
}

function decodeBytes(buf, charset) {
  if (!buf || buf.length === 0) return "";
  const decoder = getDecoder(charset);
  if (!decoder) return buf.toString("latin1");
  try {
    return decoder.decode(buf);
  } catch (err) {
    try {
      return buf.toString("utf8");
    } catch (err2) {
      return buf.toString("latin1");
    }
  }
}

/* ------------------------------------------------------------------------- *
 * RFC 2047 encoded words
 * ------------------------------------------------------------------------- */

const ENCODED_WORD_SRC = "=\\?([^?\\s]*)\\?([bBqQ])\\?([^?]*)\\?=";

function decodeEncodedWord(charsetRaw, encoding, text) {
  let charset = String(charsetRaw || "").trim();
  const star = charset.indexOf("*"); // RFC 2231 style charset*language
  if (star >= 0) charset = charset.slice(0, star);
  try {
    if (String(encoding).toLowerCase() === "b") {
      const buf = Buffer.from(
        String(text).replace(/[^A-Za-z0-9+/=]/g, ""),
        "base64",
      );
      return decodeBytes(buf, charset);
    }
    const bytes = [];
    const src = String(text);
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === "_") {
        bytes.push(0x20);
        continue;
      } // RFC 2047 Q: "_" means space
      if (c === "=") {
        const hex = src.substr(i + 1, 2);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 2;
          continue;
        }
        bytes.push(0x3d);
        continue;
      }
      bytes.push(src.charCodeAt(i) & 0xff);
    }
    return decodeBytes(Buffer.from(bytes), charset);
  } catch (err) {
    return String(text);
  }
}

/**
 * Decode RFC 2047 encoded-words ("=?charset?B|Q?text?=") inside a header value.
 * Whitespace between two adjacent encoded-words is removed, as the RFC requires.
 * Unknown charsets and malformed words degrade to the original text.
 */
export function decodeHeaderWord(value) {
  if (value === null || value === undefined) return "";
  const s = normalizeRawBytes(String(value));
  if (s.indexOf("=?") === -1) return s;
  const re = new RegExp(ENCODED_WORD_SRC, "g");
  let out = "";
  let last = 0;
  let prevEnd = -1;
  let m;
  while ((m = re.exec(s)) !== null) {
    const between = s.slice(last, m.index);
    if (!(prevEnd >= 0 && /^[ \t\r\n]*$/.test(between))) out += between;
    out += decodeEncodedWord(m[1], m[2], m[3]);
    last = m.index + m[0].length;
    prevEnd = last;
    if (re.lastIndex <= m.index) re.lastIndex = m.index + 1; // never loop forever
  }
  out += s.slice(last);
  return out;
}

/* ------------------------------------------------------------------------- *
 * MIME header parameters (RFC 2045 + RFC 2231)
 * ------------------------------------------------------------------------- */

function tokenizeParamString(s) {
  const segments = [];
  let cur = "";
  let inQuote = false;
  let depth = 0;
  const src = String(s);
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuote) {
      if (c === "\\" && i + 1 < src.length) {
        cur += src[++i];
        continue;
      }
      if (c === '"') {
        inQuote = false;
        continue;
      }
      cur += c;
      continue;
    }
    if (depth > 0) {
      if (c === "\\" && i + 1 < src.length) {
        i++;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") depth--;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      continue;
    }
    if (c === "(") {
      depth++;
      continue;
    }
    if (c === ";") {
      segments.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  segments.push(cur);
  return segments;
}

function parseHeaderValueWithParams(raw) {
  const segments = tokenizeParamString(
    raw === null || raw === undefined ? "" : raw,
  );
  const main = (segments.shift() || "").trim();
  const params = new Map();
  for (const seg of segments) {
    const eq = seg.indexOf("=");
    if (eq <= 0) continue;
    const key = seg.slice(0, eq).trim().toLowerCase();
    if (!key) continue;
    let val = seg.slice(eq + 1).trim();
    if (/^".*"$/.test(val)) val = val.slice(1, -1);
    if (!params.has(key)) params.set(key, val);
  }
  return { value: main, params: params };
}

function percentDecodeToBuffer(str) {
  const bytes = [];
  const src = String(str);
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "%") {
      const hex = src.substr(i + 1, 2);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
      bytes.push(0x25);
      continue;
    }
    const code = src.charCodeAt(i);
    if (code <= 0xff) bytes.push(code);
    else {
      const b = Buffer.from(c, "utf8");
      for (let j = 0; j < b.length; j++) bytes.push(b[j]);
    }
  }
  return Buffer.from(bytes);
}

function decodeExtendedValue(value) {
  const v = String(value);
  const m = /^([^']*)'([^']*)'([\s\S]*)$/.exec(v);
  const charset = m ? m[1] : "";
  const encoded = m ? m[3] : v;
  const buf = percentDecodeToBuffer(encoded);
  return charset ? decodeBytes(buf, charset) : buf.toString("latin1");
}

// Resolve a parameter, honouring RFC 2231 continuations (name*0*, name*1, ...).
function getParam(params, name) {
  if (!params || !params.size) return undefined;
  const n = String(name).toLowerCase();
  const single = params.get(n + "*");
  if (single !== undefined) return decodeExtendedValue(single);
  let joined = null;
  let charset = "";
  for (let i = 0; ; i++) {
    const ext = params.get(n + "*" + i + "*");
    const plain = params.get(n + "*" + i);
    if (ext === undefined && plain === undefined) break;
    const seg = ext !== undefined ? ext : plain;
    if (i === 0 && ext !== undefined) {
      const m = /^([^']*)'([^']*)'([\s\S]*)$/.exec(seg);
      if (m) {
        charset = m[1];
        joined = (joined || "") + m[3];
      } else joined = (joined || "") + seg;
    } else {
      joined = (joined || "") + seg;
    }
  }
  if (joined !== null) {
    const buf = percentDecodeToBuffer(joined);
    return charset ? decodeBytes(buf, charset) : buf.toString("latin1");
  }
  const plain = params.get(n);
  if (plain === undefined) return undefined;
  return plain.indexOf("=?") === -1 ? plain : decodeHeaderWord(plain);
}

function splitMediaType(value) {
  const s = String(value === null || value === undefined ? "" : value)
    .trim()
    .toLowerCase();
  const m = /^([a-z0-9!#$&^_.+-]+)\s*\/\s*([a-z0-9!#$&^_.+-]+)/.exec(s);
  if (m) return [m[1], m[2]];
  return ["text", "plain"];
}

function normalizeToken(value) {
  return String(value === null || value === undefined ? "" : value)
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, "")
    .split(/[\s;(]/)[0];
}

/* ------------------------------------------------------------------------- *
 * Content-Transfer-Encoding
 * ------------------------------------------------------------------------- */

function decodeQuotedPrintable(s) {
  const bytes = [];
  const src = String(s);
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c !== "=") {
      bytes.push(src.charCodeAt(i) & 0xff);
      continue;
    }
    const n1 = src[i + 1];
    const n2 = src[i + 2];
    if (n1 === "\r" && n2 === "\n") {
      i += 2;
      continue;
    } // soft line break
    if (n1 === "\n" || n1 === "\r") {
      i += 1;
      continue;
    }
    const hex = src.substr(i + 1, 2);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
      continue;
    }
    bytes.push(0x3d); // malformed escape: keep the literal "="
  }
  return Buffer.from(bytes);
}

function decodeTransferEncoding(body, encoding) {
  const s = body === null || body === undefined ? "" : String(body);
  switch (normalizeToken(encoding)) {
    case "base64":
      return Buffer.from(s.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
    case "quoted-printable":
      return decodeQuotedPrintable(s);
    default: // 7bit / 8bit / binary / unknown -> raw bytes
      return Buffer.from(s, "latin1");
  }
}

/* ------------------------------------------------------------------------- *
 * MIME structure
 * ------------------------------------------------------------------------- */

function buildPart(headers, body, defaultType) {
  const ctRaw =
    headerValue(headers, "content-type") || defaultType || "text/plain";
  const ct = parseHeaderValueWithParams(ctRaw);
  const media = splitMediaType(ct.value || defaultType || "text/plain");
  const cd = parseHeaderValueWithParams(
    headerValue(headers, "content-disposition") || "",
  );
  let filename = getParam(cd.params, "filename");
  if (filename === undefined) filename = getParam(ct.params, "name");
  let charset = getParam(ct.params, "charset");
  if (charset === undefined) charset = "";
  return {
    headers: headers,
    type: media[0],
    subtype: media[1],
    ctParams: ct.params,
    cdParams: cd.params,
    encoding: normalizeToken(
      headerValue(headers, "content-transfer-encoding") || "",
    ),
    dispType: normalizeToken(cd.value),
    filename: String(
      filename === undefined || filename === null ? "" : filename,
    ).trim(),
    charset: String(charset).trim(),
    body: body,
  };
}

function splitMultipart(body, boundary) {
  const delim = "--" + boundary;
  const close = delim + "--";
  const lines = String(body).split(/\r\n|\n|\r/);
  const parts = [];
  let current = null;
  let found = false;
  for (const line of lines) {
    const trimmed = line.replace(/[ \t]+$/, "");
    if (trimmed === close) {
      if (current) parts.push(current.join("\r\n"));
      current = null;
      found = true;
      break; // epilogue is ignored
    }
    if (trimmed === delim) {
      if (current) parts.push(current.join("\r\n"));
      current = [];
      found = true;
      continue;
    }
    if (current) current.push(line);
  }
  if (current) parts.push(current.join("\r\n")); // missing close delimiter: keep what we have
  return found ? parts : null;
}

function isAttachmentPart(part) {
  if (part.dispType === "attachment") return true;
  if (part.filename) return true;
  if (
    part.type === "text" &&
    (part.subtype === "plain" || part.subtype === "html")
  )
    return false;
  if (part.type === "multipart") return false;
  return true; // application/*, image/*, message/*, text/calendar, ...
}

function riskExtension(filename) {
  const name = String(filename || "");
  const idx = name.lastIndexOf(".");
  if (idx < 0 || idx === name.length - 1) return false;
  return RISKY_EXTENSIONS.has(name.slice(idx + 1).toLowerCase());
}

function makeAttachment(part, size) {
  return {
    filename: part.filename,
    size: size,
    contentType: part.type + "/" + part.subtype,
    riskyExt: riskExtension(part.filename),
  };
}

function walkPart(part, depth) {
  const acc = { plain: null, html: null, attachments: [] };
  if (depth > 16) return acc;

  if (part.type === "multipart") {
    let children = null;
    const boundary = part.ctParams.get("boundary");
    if (boundary) children = splitMultipart(part.body, boundary);
    if (!children) {
      // Damaged headers: try the first "--xxx" line of the body as the boundary.
      const guess = /^(--[^\r\n]{0,180})\r?\n/.exec(String(part.body));
      if (guess) children = splitMultipart(part.body, guess[1].slice(2));
    }
    if (!children) {
      // Still unparseable: degrade to plain text instead of throwing.
      acc.plain = decodeBytes(
        decodeTransferEncoding(part.body, part.encoding),
        part.charset,
      );
      return acc;
    }
    const childDefault = part.subtype === "digest" ? "message/rfc822" : null;
    for (const childText of children) {
      const childEntity = parseEntity(childText);
      const child = buildPart(
        childEntity.headers,
        childEntity.body,
        childDefault,
      );
      const r = walkPart(child, depth + 1);
      if (acc.plain === null && r.plain !== null) acc.plain = r.plain;
      if (acc.html === null && r.html !== null) acc.html = r.html;
      for (const a of r.attachments) acc.attachments.push(a);
    }
    return acc;
  }

  if (part.type === "message" && part.subtype === "rfc822") {
    const bytes = decodeTransferEncoding(part.body, part.encoding);
    // Parse the encapsulated message (proves the nested entity is well formed);
    // its body is NOT merged into the outer record - it stays an attachment.
    if (depth <= 10) {
      try {
        parseMessageInternal(bytes.toString("latin1"), EMPTY_META, depth + 1);
      } catch (err) {
        /* ignore */
      }
    }
    acc.attachments.push(makeAttachment(part, bytes.length));
    return acc;
  }

  if (isAttachmentPart(part)) {
    const bytes = decodeTransferEncoding(part.body, part.encoding);
    acc.attachments.push(makeAttachment(part, bytes.length));
    return acc;
  }

  const text = decodeBytes(
    decodeTransferEncoding(part.body, part.encoding),
    part.charset,
  );
  if (part.type === "text" && part.subtype === "html") acc.html = text;
  else acc.plain = text;
  return acc;
}

/* ------------------------------------------------------------------------- *
 * HTML -> text (pure string transformation: nothing is fetched or executed)
 * ------------------------------------------------------------------------- */

function decodeEntities(input) {
  let s = String(input);
  if (s.indexOf("&") === -1) return s;
  s = s.replace(/&#[xX]([0-9A-Fa-f]{1,6});?/g, function (m, hex) {
    try {
      return String.fromCodePoint(parseInt(hex, 16));
    } catch (err) {
      return m;
    }
  });
  s = s.replace(/&#([0-9]{1,7});?/g, function (m, dec) {
    try {
      return String.fromCodePoint(parseInt(dec, 10));
    } catch (err) {
      return m;
    }
  });
  s = s.replace(/&([A-Za-z][A-Za-z0-9]{1,31});/g, function (m, name) {
    const v = NAMED_ENTITIES.get(name);
    return v === undefined ? m : v;
  });
  return s;
}

function attrValue(attrs, name) {
  const re = new RegExp(
    "(?:^|[\\s;])" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))",
    "i",
  );
  const m = re.exec(String(attrs));
  if (!m) return "";
  const v = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
  return v === undefined ? "" : v;
}

function stripTags(html) {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<\/?[a-zA-Z][^>]*>|<![^>]*>/g, " ");
  return s;
}

/**
 * Convert an HTML mail body into readable plain text.
 * Pure transformation: no network, no DOM, no script execution.
 */
export function htmlToText(html) {
  if (html === null || html === undefined) return "";
  let s = String(html);
  if (!s) return "";
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  s = s.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<!\s*DOCTYPE[^>]*>/gi, " ");

  // Anchors first: "text (href)".
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, function (m, attrs, inner) {
    const href = attrValue(attrs, "href").trim();
    const label = decodeEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
    if (!href) return label ? " " + label + " " : " ";
    return (label ? label + " " : "") + "(" + href + ")";
  });
  // Images: keep the alt text, never the source.
  s = s.replace(/<img\b([^>]*)\/?>/gi, function (m, attrs) {
    const alt = attrValue(attrs, "alt").replace(/\s+/g, " ").trim();
    return alt ? " " + alt + " " : " ";
  });
  // Explicit line breaks are marked so a single <br> differs from a blank line.
  s = s.replace(/<br\b[^>]*\/?>/gi, "\u0000");
  // Block level markup becomes a line break.
  s = s.replace(
    /<\s*\/?\s*(p|div|tr|li|ul|ol|table|thead|tbody|tfoot|h[1-6]|blockquote|pre|section|article|header|footer|hr|dd|dt|dl|figure|figcaption|form|fieldset|address|main|nav|aside)\b[^>]*>/gi,
    "\n",
  );
  s = s.replace(/<\s*\/?\s*(td|th)\b[^>]*>/gi, " ");
  s = s.replace(/<\/?[a-zA-Z][^>]*>|<![^>]*>/g, " ");

  s = s.replace(/\r\n?/g, "\n");
  s = decodeEntities(s);
  s = s.replace(/[\t\f\v\u00a0\u2007\u202f]+/g, " ");
  s = s.replace(/ {2,}/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{2,}/g, "\n");
  s = s.replace(/ *\u0000 */g, "\u0000");
  s = s.replace(/\u0000{2,}/g, "\n\n");
  s = s.replace(/\u0000/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/* ------------------------------------------------------------------------- *
 * Links
 * ------------------------------------------------------------------------- */

function isShortenerHost(host) {
  const h = String(host || "").toLowerCase();
  if (!h) return false;
  if (SHORTENER_HOSTS.has(h)) return true;
  for (const s of SHORTENER_HOSTS) {
    if (h.length > s.length + 1 && h.endsWith("." + s)) return true;
  }
  return false;
}

function countChar(s, ch) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

function trimUrlTail(url) {
  let s = String(url);
  s = s.replace(/[.,;:!?'"]+$/, "");
  s = s.replace(
    /[\u3002\uff0c\uff1b\uff1a\uff01\uff1f\u3001\u2026\u2014\uff0d\uff09\u3011\u300b\u300d\u300f\u201d\u2019]+$/,
    "",
  );
  const pairs = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ];
  for (const pair of pairs) {
    while (s.endsWith(pair[1]) && countChar(s, pair[1]) > countChar(s, pair[0]))
      s = s.slice(0, -1);
  }
  return s;
}

function normalizeHref(href) {
  let h = String(href === null || href === undefined ? "" : href).trim();
  if (!h) return null;
  h = decodeEntities(h).replace(/[\r\n\t]+/g, "");
  h = h
    .replace(/^[<"']+/, "")
    .replace(/[>"']+$/, "")
    .trim();
  if (/^www\./i.test(h)) h = "http://" + h;
  else if (h.slice(0, 2) === "//") h = "https:" + h;
  if (!/^https?:\/\//i.test(h)) return null;
  try {
    new URL(h);
  } catch (err) {
    try {
      h = encodeURI(h);
      new URL(h);
    } catch (err2) {
      return null;
    }
  }
  return h;
}

function extractLinks(html, text) {
  const out = [];
  const seen = new Set();
  const add = function (href, label) {
    const norm = normalizeHref(href);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    let host = "";
    try {
      host = new URL(norm).hostname.toLowerCase().replace(/\.$/, "");
    } catch (err) {
      host = "";
    }
    out.push({
      href: norm,
      text: label || "",
      host: host,
      isShortener: isShortenerHost(host),
    });
  };
  if (html) {
    const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const href = attrValue(m[1], "href");
      if (!href) continue;
      const label = decodeEntities(stripTags(m[2])).replace(/\s+/g, " ").trim();
      add(href, label);
    }
  }
  if (text) {
    const re2 = /\b(?:https?:\/\/|www\.)[^\s<>"'()\[\]{}\x60]+/gi;
    let m2;
    while ((m2 = re2.exec(text)) !== null) add(trimUrlTail(m2[0]), "");
  }
  return out;
}

function hasRemoteImages(html) {
  if (!html) return false;
  const imgRe = /<img\b[^>]*>/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const src = attrValue(m[0], "src");
    if (src && /^\s*(?:https?:)?\/\//i.test(src)) return true;
  }
  if (/url\(\s*["']?\s*(?:https?:)?\/\//i.test(html)) return true;
  return false;
}

/* ------------------------------------------------------------------------- *
 * Addresses
 * ------------------------------------------------------------------------- */

function splitAddressItems(s) {
  const parts = [];
  let cur = "";
  let inQuote = false;
  let depth = 0;
  const src = String(s);
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuote) {
      cur += c;
      if (c === "\\" && i + 1 < src.length) {
        cur += src[++i];
        continue;
      }
      if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      cur += c;
      continue;
    }
    if (c === "<" || c === "(") {
      depth++;
      cur += c;
      continue;
    }
    if (c === ">" || c === ")") {
      if (depth > 0) depth--;
      cur += c;
      continue;
    }
    if ((c === "," || c === ";") && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  const out = [];
  for (const p of parts) {
    const t = p.trim();
    if (t) out.push(t);
  }
  return out;
}

function indexOfOutsideQuotes(s, ch) {
  let inQuote = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      continue;
    }
    if (c === "<" || c === "(") {
      depth++;
      continue;
    }
    if (c === ">" || c === ")") {
      if (depth > 0) depth--;
      continue;
    }
    if (c === ch && depth === 0) return i;
  }
  return -1;
}

function cleanDisplayName(name) {
  let s = String(name === null || name === undefined ? "" : name);
  s = s.replace(/\([^()]*\)/g, " "); // drop RFC 822 comments
  s = s.trim();
  if (/^".*"$/.test(s)) s = s.slice(1, -1).replace(/\\(.)/g, "$1");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function cleanAddress(addr) {
  let s = String(addr === null || addr === undefined ? "" : addr).trim();
  s = s.replace(/[\s\r\n]+/g, "");
  const gt = s.lastIndexOf(">");
  if (gt !== -1) s = s.slice(gt + 1);
  const lt = s.lastIndexOf("<");
  if (lt !== -1) s = s.slice(lt + 1).replace(/>/g, "");
  const colon = s.lastIndexOf(":");
  if (colon !== -1 && s.indexOf("@") > colon) s = s.slice(colon + 1); // obsolete route
  s = s.replace(/^[<"']+/, "").replace(/[>"']+$/, "");
  if (s.indexOf("@") === -1) return "";
  return s;
}

// Remove RFC 822 comments, but never touch text inside a quoted string.
function stripComments(s) {
  const comments = [];
  let out = "";
  let cur = "";
  let inQuote = false;
  let depth = 0;
  const src = String(s);
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (depth > 0) {
      if (c === "\\" && i + 1 < src.length) {
        cur += src[++i];
        continue;
      }
      if (c === "(") {
        depth++;
        cur += c;
        continue;
      }
      if (c === ")") {
        depth--;
        if (depth === 0) {
          comments.push(cur);
          cur = "";
        } else cur += c;
        continue;
      }
      cur += c;
      continue;
    }
    if (inQuote) {
      out += c;
      if (c === "\\" && i + 1 < src.length) {
        out += src[++i];
        continue;
      }
      if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      out += c;
      continue;
    }
    if (c === "(") {
      depth = 1;
      cur = "";
      continue;
    }
    out += c;
  }
  return { text: out, comments: comments };
}

function parseSingleAddress(item) {
  const decomposed = stripComments(String(item).trim());
  let body = decomposed.text.trim();
  if (!body) return null;
  const colon = indexOfOutsideQuotes(body, ":");
  if (colon >= 0) body = body.slice(colon + 1).trim(); // strip a group label
  if (!body) return null;
  let name = "";
  let address = "";
  const m = /^([\s\S]*?)<([^>]*)>\s*$/.exec(body);
  if (m) {
    name = decodeHeaderWord(m[1]);
    address = m[2];
  } else {
    address = body;
  }
  name = cleanDisplayName(name);
  if (!name && decomposed.comments.length) {
    name = cleanDisplayName(decodeHeaderWord(decomposed.comments.join(" ")));
  }
  const clean = cleanAddress(address);
  if (!clean) return null;
  const at = clean.lastIndexOf("@");
  const local = clean.slice(0, at);
  const domain = clean.slice(at + 1).toLowerCase();
  if (!local || !domain) return null;
  const normalized = local + "@" + domain;
  if (name.toLowerCase() === normalized.toLowerCase()) name = "";
  return { name: name, address: normalized, domain: domain };
}

function parseAddressList(value) {
  if (value === null || value === undefined) return [];
  const out = [];
  for (const item of splitAddressItems(String(value))) {
    let parsed = null;
    try {
      parsed = parseSingleAddress(item);
    } catch (err) {
      parsed = null;
    }
    if (parsed) out.push(parsed);
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * Date
 * ------------------------------------------------------------------------- */

function parseDate(value) {
  if (!value) return null;
  const cleaned = String(value)
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const m =
    /^(?:[A-Za-z]{3},?\s+)?(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+([+-]\d{4}|[A-Za-z]+))?/.exec(
      cleaned,
    );
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month !== undefined) {
      let year = parseInt(m[3], 10);
      if (m[3].length <= 2) year += year < 50 ? 2000 : 1900;
      let offsetMinutes = 0;
      if (m[7]) {
        const zone = m[7];
        if (/^[+-]\d{4}$/.test(zone)) {
          const sign = zone[0] === "-" ? -1 : 1;
          offsetMinutes =
            sign *
            (parseInt(zone.slice(1, 3), 10) * 60 + parseInt(zone.slice(3), 10));
        } else {
          const known = OBSOLETE_ZONES[zone.toLowerCase()];
          if (known !== undefined) offsetMinutes = Math.round(known * 60);
        }
      }
      const t =
        Date.UTC(
          year,
          month,
          parseInt(m[1], 10),
          parseInt(m[4], 10),
          parseInt(m[5], 10),
          m[6] ? parseInt(m[6], 10) : 0,
        ) -
        offsetMinutes * 60000;
      const d = new Date(t);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  const fallback = Date.parse(cleaned);
  if (Number.isFinite(fallback)) return new Date(fallback).toISOString();
  return null;
}

/* ------------------------------------------------------------------------- *
 * Authentication-Results
 * ------------------------------------------------------------------------- */

const AUTH_VALUES = new Set(["pass", "fail", "softfail", "neutral", "none"]);

function mapAuthValue(v) {
  const s = String(v || "").toLowerCase();
  return AUTH_VALUES.has(s) ? s : "none";
}

function parseAuth(headers) {
  const auth = { spf: "none", dkim: "none", dmarc: "none" };
  const seen = new Set();
  const scan = function (text) {
    const re = /\b(spf|dkim|dmarc)\s*=\s*([A-Za-z]+)/g;
    let m;
    while ((m = re.exec(String(text))) !== null) {
      const key = m[1].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      auth[key] = mapAuthValue(m[2]);
    }
  };
  for (const v of headerValues(headers, "authentication-results")) scan(v);
  for (const v of headerValues(headers, "arc-authentication-results")) scan(v);
  if (!seen.has("spf")) {
    const receivedSpf = headerValue(headers, "received-spf");
    if (receivedSpf) {
      const m = /^\s*([A-Za-z]+)/.exec(receivedSpf);
      if (m) auth.spf = mapAuthValue(m[1]);
    }
  }
  return auth;
}

/* ------------------------------------------------------------------------- *
 * Record assembly
 * ------------------------------------------------------------------------- */

function textHeader(headers, name) {
  const raw = headerValue(headers, name);
  if (raw === null || raw === undefined) return null;
  return decodeHeaderWord(raw);
}

function cleanText(value) {
  if (value === null || value === undefined) return null;
  const t = String(value).trim();
  return t ? t : null;
}

function joinedText(headers, name) {
  const values = headerValues(headers, name);
  if (!values.length) return null;
  const out = [];
  for (const v of values) {
    const t = decodeHeaderWord(v).trim();
    if (t) out.push(t);
  }
  return out.length ? out.join(", ") : null;
}

function addressList(headers, name) {
  return parseAddressList(textHeader(headers, name)).map(function (a) {
    return { name: a.name, address: a.address };
  });
}

function emptyRecord(meta) {
  return {
    account: meta.account,
    mailbox: meta.mailbox,
    uid: meta.uid,
    from: { name: "", address: "", domain: "" },
    to: [],
    cc: [],
    replyTo: [],
    subject: "",
    date: null,
    textBody: "",
    htmlBody: null,
    links: [],
    attachments: [],
    hasRemoteImages: false,
    auth: { spf: "none", dkim: "none", dmarc: "none" },
    headers: {
      messageId: null,
      listUnsubscribe: null,
      returnPath: null,
      receivedCount: 0,
      precedence: null,
    },
  };
}

function parseMessageInternal(text, meta, depth) {
  const root = parseEntity(text);
  const rootPart = buildPart(root.headers, root.body, null);

  // A message that only encapsulates another message: unwrap it.
  if (
    rootPart.type === "message" &&
    rootPart.subtype === "rfc822" &&
    depth < 8
  ) {
    const inner = decodeTransferEncoding(
      rootPart.body,
      rootPart.encoding,
    ).toString("latin1");
    return parseMessageInternal(inner, meta, depth + 1);
  }

  const collected = walkPart(rootPart, depth);
  const htmlBody = collected.html === null ? null : collected.html.trim();
  let textBody =
    collected.plain === null
      ? ""
      : collected.plain.replace(/\r\n?/g, "\n").trim();
  if (!textBody && htmlBody) textBody = htmlToText(htmlBody);

  const fromList = parseAddressList(textHeader(root.headers, "from"));
  const fromFirst = fromList.length ? fromList[0] : null;

  return {
    account: meta.account,
    mailbox: meta.mailbox,
    uid: meta.uid,
    from: fromFirst
      ? {
          name: fromFirst.name,
          address: fromFirst.address,
          domain: fromFirst.domain,
        }
      : { name: "", address: "", domain: "" },
    to: addressList(root.headers, "to"),
    cc: addressList(root.headers, "cc"),
    replyTo: addressList(root.headers, "reply-to"),
    subject: (textHeader(root.headers, "subject") || "").trim(),
    date: parseDate(textHeader(root.headers, "date")),
    textBody: textBody,
    htmlBody: htmlBody,
    links: extractLinks(htmlBody, textBody),
    attachments: collected.attachments,
    hasRemoteImages: hasRemoteImages(htmlBody),
    auth: parseAuth(root.headers),
    headers: {
      messageId: cleanText(textHeader(root.headers, "message-id")),
      listUnsubscribe: joinedText(root.headers, "list-unsubscribe"),
      returnPath: cleanText(textHeader(root.headers, "return-path")),
      receivedCount: headerValues(root.headers, "received").length,
      precedence: cleanText(textHeader(root.headers, "precedence")),
    },
  };
}

/**
 * Parse a raw RFC 822 / MIME message into a normalized MailRecord.
 *
 * @param {Buffer|string} raw raw message bytes (Buffer preferred)
 * @param {{account?: string, mailbox?: string, uid?: (string|number|null)}} [options]
 * @returns {object} MailRecord
 */
export function parseMessage(raw, options = {}) {
  const opts = options === null || options === undefined ? {} : options;
  const account = opts.account === undefined ? "" : opts.account;
  const mailbox = opts.mailbox === undefined ? "" : opts.mailbox;
  const uid = opts.uid === undefined ? null : opts.uid;
  const meta = { account: account, mailbox: mailbox, uid: uid };
  let record;
  try {
    record = parseMessageInternal(toLatin1Text(raw), meta, 0);
  } catch (err) {
    record = emptyRecord(meta);
  }
  return record;
}
