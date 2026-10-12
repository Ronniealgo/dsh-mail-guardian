/**
 * dsh-mail-guardian / test/mime.test.mjs
 *
 * Contract tests for lib/mime.js (RFC 822 / MIME -> normalized MailRecord).
 * Every fixture in test/fixtures/emails/ is synthetic: all addresses use the
 * reserved example.com / example.org / example.net domains; no real data.
 *
 * Run: node --test test/mime.test.mjs    (fallback: node test/mime.test.mjs)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseMessage, htmlToText, decodeHeaderWord } from "../lib/mime.js";

const CRLF = "\r\n";

function fixture(name) {
  return readFileSync(
    fileURLToPath(new URL("./fixtures/emails/" + name, import.meta.url)),
  );
}

function parseFixture(name, options) {
  return parseMessage(fixture(name), options);
}

// Synthetic in-memory message with CRLF line endings, like real SMTP input.
function message() {
  return Array.prototype.slice.call(arguments).join(CRLF) + CRLF;
}

function parseLines() {
  return parseMessage(message.apply(null, arguments));
}

function attachmentMessage(names, boundary) {
  const b = boundary || "B";
  const lines = [
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="' + b + '"',
    "",
    "--" + b,
    "Content-Type: text/plain; charset=us-ascii",
    "",
    "body text",
    "",
  ];
  for (const n of names) {
    lines.push(
      "--" + b,
      "Content-Type: application/octet-stream",
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="' + n + '"',
      "",
      Buffer.from("payload").toString("base64"),
      "",
    );
  }
  lines.push("--" + b + "--");
  return lines;
}

function link(rec, href) {
  return rec.links.filter(function (l) {
    return l.href === href;
  })[0];
}

const RECORD_KEYS = [
  "account",
  "mailbox",
  "uid",
  "from",
  "to",
  "cc",
  "replyTo",
  "subject",
  "date",
  "textBody",
  "htmlBody",
  "links",
  "attachments",
  "hasRemoteImages",
  "auth",
  "headers",
].sort();
const AUTH_VALUES = ["pass", "fail", "softfail", "neutral", "none"];

const ALL_FIXTURES = [
  "01-plain-rfc2047.eml",
  "02-alt-remote-image.eml",
  "03-attachments-base64.eml",
  "04-phishing-display-name.eml",
  "05-auth-results.eml",
  "06-gbk-body.eml",
  "07-quoted-printable.eml",
  "08-nested-mixed-two-attachments.eml",
  "09-list-unsubscribe.eml",
  "10-shortener-links.eml",
  "11-broken-boundary.eml",
  "12-nested-rfc822.eml",
];

function assertShape(rec, label) {
  assert.deepEqual(
    Object.keys(rec).sort(),
    RECORD_KEYS,
    label + ": MailRecord keys",
  );
  assert.equal(typeof rec.account, "string", label + ": account");
  assert.equal(typeof rec.mailbox, "string", label + ": mailbox");
  assert.ok(
    rec.uid === null ||
      typeof rec.uid === "string" ||
      typeof rec.uid === "number",
    label + ": uid",
  );
  assert.deepEqual(
    Object.keys(rec.from).sort(),
    ["address", "domain", "name"],
    label + ": from keys",
  );
  for (const k of ["name", "address", "domain"])
    assert.equal(typeof rec.from[k], "string", label + ": from." + k);
  for (const list of [rec.to, rec.cc, rec.replyTo]) {
    assert.ok(Array.isArray(list), label + ": address list");
    for (const a of list) {
      assert.deepEqual(
        Object.keys(a).sort(),
        ["address", "name"],
        label + ": address keys",
      );
      assert.equal(typeof a.name, "string");
      assert.equal(typeof a.address, "string");
    }
  }
  assert.equal(typeof rec.subject, "string", label + ": subject");
  assert.ok(
    rec.date === null || typeof rec.date === "string",
    label + ": date",
  );
  assert.equal(typeof rec.textBody, "string", label + ": textBody");
  assert.ok(
    rec.htmlBody === null || typeof rec.htmlBody === "string",
    label + ": htmlBody",
  );
  assert.ok(Array.isArray(rec.links), label + ": links");
  for (const l of rec.links) {
    assert.deepEqual(
      Object.keys(l).sort(),
      ["host", "href", "isShortener", "text"],
      label + ": link keys",
    );
    assert.equal(typeof l.href, "string");
    assert.equal(typeof l.text, "string");
    assert.equal(typeof l.host, "string");
    assert.equal(typeof l.isShortener, "boolean");
  }
  assert.ok(Array.isArray(rec.attachments), label + ": attachments");
  for (const a of rec.attachments) {
    assert.deepEqual(
      Object.keys(a).sort(),
      ["contentType", "filename", "riskyExt", "size"],
      label + ": attachment keys",
    );
    assert.equal(typeof a.filename, "string");
    assert.equal(typeof a.size, "number");
    assert.ok(a.size >= 0);
    assert.equal(typeof a.contentType, "string");
    assert.equal(typeof a.riskyExt, "boolean");
  }
  assert.equal(
    typeof rec.hasRemoteImages,
    "boolean",
    label + ": hasRemoteImages",
  );
  assert.deepEqual(
    Object.keys(rec.auth).sort(),
    ["dkim", "dmarc", "spf"],
    label + ": auth keys",
  );
  for (const k of ["spf", "dkim", "dmarc"])
    assert.ok(AUTH_VALUES.includes(rec.auth[k]), label + ": auth." + k);
  assert.deepEqual(
    Object.keys(rec.headers).sort(),
    [
      "listUnsubscribe",
      "messageId",
      "precedence",
      "receivedCount",
      "returnPath",
    ],
    label + ": header keys",
  );
  for (const k of [
    "messageId",
    "listUnsubscribe",
    "returnPath",
    "precedence",
  ]) {
    assert.ok(
      rec.headers[k] === null || typeof rec.headers[k] === "string",
      label + ": headers." + k,
    );
  }
  assert.equal(
    typeof rec.headers.receivedCount,
    "number",
    label + ": receivedCount",
  );
}

/* ------------------------------------------------------------------ */
/* MailRecord shape                                                     */
/* ------------------------------------------------------------------ */

test("every fixture parses into a complete, correctly typed MailRecord", () => {
  for (const name of ALL_FIXTURES) {
    const rec = parseFixture(name);
    assertShape(rec, name);
    assert.equal(
      rec.date === null || rec.date.endsWith("Z"),
      true,
      name + ": date is ISO 8601",
    );
    assert.equal(
      rec.htmlBody === null || !rec.htmlBody.includes("\u0000"),
      true,
      name + ": no markers leak",
    );
  }
});

test("account / mailbox / uid are returned verbatim, defaults are empty", () => {
  const rec = parseFixture("01-plain-rfc2047.eml", {
    account: "user@example.com",
    mailbox: "INBOX/Sub",
    uid: 4242,
  });
  assert.equal(rec.account, "user@example.com");
  assert.equal(rec.mailbox, "INBOX/Sub");
  assert.equal(rec.uid, 4242);
  const rec2 = parseFixture("12-nested-rfc822.eml", { uid: "uid-9" });
  assert.equal(rec2.account, "");
  assert.equal(rec2.mailbox, "");
  assert.equal(rec2.uid, "uid-9");
  const rec3 = parseFixture("03-attachments-base64.eml");
  assert.equal(rec3.account, "");
  assert.equal(rec3.mailbox, "");
  assert.equal(rec3.uid, null);
});

/* ------------------------------------------------------------------ */
/* 01 - plain text + RFC 2047 subject                                   */
/* ------------------------------------------------------------------ */

test("01: folded adjacent RFC 2047 words decode into one subject", () => {
  const rec = parseFixture("01-plain-rfc2047.eml");
  assert.equal(rec.subject, "月度对账单（自动发送）");
  assert.equal(rec.from.name, "Billing Team");
  assert.equal(rec.from.address, "billing@example.com");
  assert.equal(rec.from.domain, "example.com");
  assert.deepEqual(rec.to, [
    { name: "Zhang San", address: "zhangsan@example.org" },
    { name: "", address: "li@example.net" },
  ]);
  assert.deepEqual(rec.cc, []);
  assert.equal(rec.date, "2025-10-01T04:34:56.000Z");
  assert.equal(rec.headers.messageId, "<20251001.001@example.com>");
  assert.equal(rec.htmlBody, null);
  assert.equal(rec.hasRemoteImages, false);
  assert.ok(rec.textBody.startsWith("尊敬的客户：您好！"));
  assert.ok(rec.textBody.includes("本月对账单已生成"));
  assert.equal(rec.textBody.includes("\r"), false, "textBody uses LF only");
  assert.equal(rec.links.length, 1);
  assert.equal(rec.links[0].href, "https://portal.example.com/bill");
  assert.equal(rec.links[0].host, "portal.example.com");
  assert.equal(rec.links[0].isShortener, false);
});

/* ------------------------------------------------------------------ */
/* 02 - multipart/alternative with remote images                        */
/* ------------------------------------------------------------------ */

test("02: alternative keeps plain text and flags remote images", () => {
  const rec = parseFixture("02-alt-remote-image.eml");
  assert.equal(rec.hasRemoteImages, true);
  assert.ok(rec.htmlBody.startsWith("<html>"));
  assert.ok(
    rec.htmlBody.includes('<img src="https://cdn.example.com/banner.png"'),
  );
  assert.ok(rec.htmlBody.includes("url(https://cdn.example.com/bg.png)"));
  assert.ok(rec.textBody.includes("本周优惠已上线。"));
  assert.ok(rec.textBody.includes("https://shop.example.com/promo"));
  assert.equal(rec.textBody.includes("<"), false, "textBody carries no markup");
  assert.equal(rec.links.length, 2, "duplicate href across parts is merged");
  assert.equal(
    link(rec, "https://shop.example.com/promo").text,
    "查看活动详情",
  );
  assert.equal(
    link(rec, "https://shop.example.com/unsubscribe").host,
    "shop.example.com",
  );
  assert.equal(rec.attachments.length, 0);
});

/* ------------------------------------------------------------------ */
/* 03 - base64 attachments                                              */
/* ------------------------------------------------------------------ */

test("03: base64 attachments carry decoded size and riskyExt", () => {
  const rec = parseFixture("03-attachments-base64.eml");
  assert.equal(rec.subject, "附件测试");
  assert.equal(rec.textBody, "Please find the two files attached.");
  assert.deepEqual(rec.attachments, [
    {
      filename: "invoice.pdf",
      size: 168,
      contentType: "application/pdf",
      riskyExt: false,
    },
    {
      filename: "setup.exe",
      size: 21,
      contentType: "application/octet-stream",
      riskyExt: true,
    },
  ]);
});

test("riskyExt covers the whole extension table (case-insensitive)", () => {
  const risky = [
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
  ];
  const safe = [
    "pdf",
    "txt",
    "jpg",
    "jpeg",
    "png",
    "docx",
    "zip",
    "csv",
    "eml",
    "xlsx",
  ];
  const named = risky
    .map(function (e) {
      return "report." + e;
    })
    .concat(
      safe.map(function (e) {
        return "report." + e;
      }),
    );
  const rec = parseMessage(message.apply(null, attachmentMessage(named)));
  assert.equal(rec.attachments.length, risky.length + safe.length);
  risky.forEach(function (ext, i) {
    assert.equal(rec.attachments[i].riskyExt, true, "risky: ." + ext);
    assert.equal(rec.attachments[i].filename, "report." + ext);
  });
  safe.forEach(function (ext, i) {
    assert.equal(
      rec.attachments[risky.length + i].riskyExt,
      false,
      "safe: ." + ext,
    );
  });
  const upper = parseMessage(
    message.apply(null, attachmentMessage(["INVOICE.EXE", "Photo.JPG"])),
  );
  assert.equal(upper.attachments[0].riskyExt, true);
  assert.equal(upper.attachments[1].riskyExt, false);
  const noExt = parseMessage(
    message.apply(null, attachmentMessage(["README"])),
  );
  assert.equal(noExt.attachments[0].riskyExt, false);
});

test("attachment without a filename keeps an empty name but is still listed", () => {
  const rec = parseLines(
    'Content-Type: multipart/mixed; boundary="B"',
    "",
    "--B",
    "Content-Type: text/plain; charset=us-ascii",
    "",
    "body",
    "",
    "--B",
    "Content-Type: application/pdf",
    "Content-Transfer-Encoding: base64",
    "Content-Disposition: attachment",
    "",
    "aGVsbG8=",
    "",
    "--B--",
  );
  assert.deepEqual(rec.attachments, [
    { filename: "", size: 5, contentType: "application/pdf", riskyExt: false },
  ]);
});

test("attachment filenames: RFC 2231, continuations and RFC 2047", () => {
  const rec = parseMessage(
    message(
      'Content-Type: multipart/mixed; boundary="B"',
      "",
      "--B",
      "Content-Type: text/plain; charset=us-ascii",
      "",
      "x",
      "",
      "--B",
      "Content-Type: application/pdf",
      "Content-Transfer-Encoding: base64",
      "Content-Disposition: attachment; filename*=utf-8''%E5%AE%A1%E6%89%B9%E5%8D%95.pdf",
      "",
      "aGVsbG8=",
      "",
      "--B",
      "Content-Type: application/pdf",
      "Content-Transfer-Encoding: base64",
      "Content-Disposition: attachment; filename*0*=utf-8''%E5%B9%B4%E5%BA%A6; filename*1*=%E6%8A%A5%E5%91%8A.pdf",
      "",
      "aGVsbG8=",
      "",
      "--B",
      "Content-Type: application/pdf",
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="=?utf-8?B?' +
        Buffer.from("账单.pdf", "utf8").toString("base64") +
        '?="',
      "",
      "aGVsbG8=",
      "",
      "--B--",
    ),
  );
  assert.deepEqual(
    rec.attachments.map(function (a) {
      return a.filename;
    }),
    ["审批单.pdf", "年度报告.pdf", "账单.pdf"],
  );
  for (const a of rec.attachments) {
    assert.equal(a.size, 5);
    assert.equal(a.riskyExt, false);
    assert.equal(a.contentType, "application/pdf");
  }
});

/* ------------------------------------------------------------------ */
/* 04 - phishing display name                                           */
/* ------------------------------------------------------------------ */

test("04: friendly display name never hides the real address", () => {
  const rec = parseFixture("04-phishing-display-name.eml");
  assert.equal(rec.from.name, "妈妈");
  assert.equal(rec.from.address, "attacker@example.org");
  assert.equal(rec.from.domain, "example.org");
  assert.equal(rec.subject, "紧急：请立刻打开附件");
  assert.deepEqual(rec.replyTo, [
    { name: "妈妈", address: "support@example.com" },
  ]);
  assert.deepEqual(rec.to, [{ name: "Victim", address: "victim@example.net" }]);
  assert.equal(rec.links.length, 1);
  assert.equal(rec.links[0].host, "t.cn");
  assert.equal(rec.links[0].isShortener, true);
});

/* ------------------------------------------------------------------ */
/* 05 - Authentication-Results                                          */
/* ------------------------------------------------------------------ */

test("05: spf/dkim/dmarc are read from Authentication-Results", () => {
  const rec = parseFixture("05-auth-results.eml");
  assert.deepEqual(rec.auth, { spf: "pass", dkim: "fail", dmarc: "fail" });
  assert.equal(rec.headers.receivedCount, 2);
  assert.equal(rec.headers.returnPath, "<bounce@mailer.example.com>");
  assert.equal(rec.headers.messageId, "<20251005.005@mailer.example.com>");
  assert.equal(rec.headers.precedence, null);
  assert.equal(rec.headers.listUnsubscribe, null);
  assert.equal(rec.subject, "安全提醒");
});

test("auth: Received-SPF is only a fallback, unknown verdicts become none", () => {
  assert.deepEqual(
    parseLines("Received-SPF: softfail (example.org: nope)", "", "x").auth,
    { spf: "softfail", dkim: "none", dmarc: "none" },
  );
  assert.deepEqual(
    parseLines(
      "Authentication-Results: mx.example.org; spf=temperror dkim=neutral dmarc=none",
      "",
      "x",
    ).auth,
    { spf: "none", dkim: "neutral", dmarc: "none" },
  );
  assert.deepEqual(
    parseLines(
      "Authentication-Results: mx.example.org; dkim=pass header.d=example.org",
      "",
      "x",
    ).auth,
    { spf: "none", dkim: "pass", dmarc: "none" },
  );
  assert.deepEqual(parseLines("Subject: nothing to see", "", "x").auth, {
    spf: "none",
    dkim: "none",
    dmarc: "none",
  });
});

/* ------------------------------------------------------------------ */
/* 06 - GBK body                                                        */
/* ------------------------------------------------------------------ */

test("06: gbk charset decodes for both header and body", () => {
  const rec = parseFixture("06-gbk-body.eml");
  assert.equal(rec.subject, "季度报销单已生成");
  assert.ok(rec.textBody.includes("你好，这是本季度的报销汇总，请查收。"));
  assert.ok(rec.textBody.includes("金额：人民币 1234.56 元"));
  assert.ok(rec.textBody.includes("备注：发票原件已寄出，谢谢配合。"));
  assert.equal(
    rec.textBody.includes("\ufffd"),
    false,
    "no replacement characters",
  );
});

/* ------------------------------------------------------------------ */
/* 07 - quoted-printable                                                */
/* ------------------------------------------------------------------ */

test("07: quoted-printable decodes soft line breaks and 8-bit octets", () => {
  const rec = parseFixture("07-quoted-printable.eml");
  assert.equal(rec.subject, "价格变动通知");
  assert.ok(rec.textBody.includes("您好，这是一封 quoted-printable 测试信。"));
  assert.ok(rec.textBody.includes("价格：€ 42（含税），折扣 — 10%。"));
  assert.ok(rec.textBody.endsWith("结束。"));
  assert.equal(
    /=[0-9A-Fa-f]{2}/.test(rec.textBody),
    false,
    "no leftover escapes",
  );
  assert.equal(rec.textBody.split("\n").length, 3);
});

/* ------------------------------------------------------------------ */
/* 08 - nested multipart/mixed with two attachments                     */
/* ------------------------------------------------------------------ */

test("08: nested multipart yields both attachments and the alternative text", () => {
  const rec = parseFixture("08-nested-mixed-two-attachments.eml");
  assert.equal(rec.subject, "两份附件");
  assert.equal(rec.attachments.length, 2);
  assert.deepEqual(
    rec.attachments.map(function (a) {
      return a.filename;
    }),
    ["中文文件.txt", "审批单.docm"],
  );
  assert.equal(rec.attachments[0].size, 23);
  assert.equal(rec.attachments[0].contentType, "text/plain");
  assert.equal(rec.attachments[0].riskyExt, false);
  assert.equal(rec.attachments[1].size, 23);
  assert.equal(rec.attachments[1].riskyExt, true);
  assert.equal(rec.textBody, "外层嵌套结构测试。");
  assert.ok(rec.htmlBody.includes("<b>嵌套</b>"));
});

/* ------------------------------------------------------------------ */
/* 09 - marketing mail with List-Unsubscribe                            */
/* ------------------------------------------------------------------ */

test("09: List-Unsubscribe, Precedence and Return-Path are surfaced", () => {
  const rec = parseFixture("09-list-unsubscribe.eml");
  assert.ok(
    rec.headers.listUnsubscribe.includes(
      "<mailto:unsubscribe@marketing.example.com?subject=unsubscribe>",
    ),
  );
  assert.ok(
    rec.headers.listUnsubscribe.includes(
      "<https://marketing.example.com/unsubscribe?u=abc123>",
    ),
  );
  assert.equal(rec.headers.precedence, "bulk");
  assert.equal(rec.headers.returnPath, "<bounce@marketing.example.com>");
  assert.equal(rec.subject, "今日特惠 5 折");
  assert.equal(rec.links.length, 1, "header URLs are not body links");
  assert.equal(rec.links[0].href, "https://marketing.example.com/deals");
  assert.equal(rec.hasRemoteImages, false);
});

/* ------------------------------------------------------------------ */
/* 10 - shortener links                                                 */
/* ------------------------------------------------------------------ */

test("10: shortener hosts are flagged, normal hosts are not", () => {
  const rec = parseFixture("10-shortener-links.eml");
  assert.equal(rec.links.length, 6);
  const expected = {
    "https://rb.gy/xyz789": true,
    "https://example.org/safe": false,
    "https://bit.ly/3xY9zAb": true,
    "http://t.cn/A6xkQ9z": true,
    "https://www.example.org/news": false,
    "https://tinyurl.com/abc123": true,
  };
  for (const href of Object.keys(expected)) {
    const l = link(rec, href);
    assert.ok(l, "missing link " + href);
    assert.equal(l.isShortener, expected[href], href);
  }
  assert.equal(
    link(rec, "https://rb.gy/xyz789").text,
    "这里",
    "anchor text is kept",
  );
  assert.equal(link(rec, "https://bit.ly/3xY9zAb").text, "");
  assert.equal(link(rec, "https://bit.ly/3xY9zAb").host, "bit.ly");
  assert.equal(
    rec.textBody.includes("。"),
    true,
    "trailing CJK punctuation stays in the text",
  );
  assert.equal(
    link(rec, "https://www.example.org/news").href.endsWith("。"),
    false,
    "trailing CJK punctuation is not part of the link",
  );
});

test("shortener matching: exact host or dot-suffix, never a substring", () => {
  function hosts(html) {
    return parseLines(
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
    ).links.map(function (l) {
      return l.host + "=" + l.isShortener;
    });
  }
  assert.deepEqual(hosts('<a href="https://www.bit.ly/x">a</a>'), [
    "www.bit.ly=true",
  ]);
  assert.deepEqual(hosts('<a href="https://sub.t.co/x">a</a>'), [
    "sub.t.co=true",
  ]);
  assert.deepEqual(hosts('<a href="https://bit.ly.example.com/x">a</a>'), [
    "bit.ly.example.com=false",
  ]);
  assert.deepEqual(hosts('<a href="https://notbit.ly/x">a</a>'), [
    "notbit.ly=false",
  ]);
  assert.deepEqual(hosts('<a href="https://example.com/bit.ly">a</a>'), [
    "example.com=false",
  ]);
});

/* ------------------------------------------------------------------ */
/* 11 - damaged multipart                                               */
/* ------------------------------------------------------------------ */

test("11: a missing boundary degrades to text instead of throwing", () => {
  let rec = null;
  assert.doesNotThrow(function () {
    rec = parseFixture("11-broken-boundary.eml");
  });
  assert.equal(
    rec.textBody,
    "This part has no boundary marker at all.\nSecond line of the damaged body.",
  );
  assert.deepEqual(rec.attachments, []);
  assert.equal(rec.htmlBody, null);
  assert.equal(rec.subject, "Broken boundary sample");
});

test("damaged MIME never throws: empty, headerless, truncated, bogus boundaries", () => {
  const cases = [
    "",
    "no headers at all",
    "Content-Type: multipart/mixed", // no boundary parameter
    'Content-Type: multipart/mixed; boundary="B"', // boundary never appears
    "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n!!!not base64!!!",
    "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n=ZZ= broken =",
    'Content-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\n', // truncated part
    "Content-Type: message/rfc822\r\n\r\n" +
      "Content-Type: message/rfc822\r\n\r\n", // nested empties
    "From: <>\r\nSubject:\r\nDate: not a date\r\n\r\nbody",
    "\u0000\u0001\u0002 binary noise \ufffd",
  ];
  for (const raw of cases) {
    let rec = null;
    assert.doesNotThrow(
      function () {
        rec = parseMessage(raw);
      },
      "threw on: " + JSON.stringify(raw.slice(0, 40)),
    );
    assertShape(rec, JSON.stringify(raw.slice(0, 20)));
  }
  assert.equal(parseMessage("").textBody, "");
  assert.equal(parseMessage("no headers at all").textBody, "no headers at all");
  assert.equal(
    parseMessage("From: <>\r\nSubject:\r\nDate: not a date\r\n\r\nbody").date,
    null,
  );
});

test("a boundary inferred from the body rescues a missing boundary parameter", () => {
  const rec = parseLines(
    "Content-Type: multipart/mixed",
    "",
    "--GUESSED-BOUNDARY",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "rescued body",
    "--GUESSED-BOUNDARY--",
  );
  assert.ok(rec.textBody.includes("rescued body"));
});

/* ------------------------------------------------------------------ */
/* 12 - message/rfc822                                                  */
/* ------------------------------------------------------------------ */

test("12: an encapsulated message becomes an attachment, not body text", () => {
  const rec = parseFixture("12-nested-rfc822.eml");
  assert.equal(rec.attachments.length, 1);
  assert.equal(rec.attachments[0].contentType, "message/rfc822");
  assert.equal(rec.attachments[0].filename, "forwarded.eml");
  assert.equal(rec.attachments[0].riskyExt, false);
  assert.ok(rec.attachments[0].size > 100);
  assert.equal(rec.textBody, "请查看转发的邮件。");
  assert.equal(rec.textBody.includes("这是被转发的原始内容。"), false);
  assert.deepEqual(rec.links, []);
});

test("a top level message/rfc822 is unwrapped into the record", () => {
  const rec = parseLines(
    "Content-Type: message/rfc822",
    "",
    "From: inner@example.org",
    "Subject: inner subject",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "inner body",
  );
  assert.equal(rec.subject, "inner subject");
  assert.equal(rec.from.address, "inner@example.org");
  assert.equal(rec.textBody, "inner body");
});

/* ------------------------------------------------------------------ */
/* HTML -> text                                                         */
/* ------------------------------------------------------------------ */

test("htmlToText removes scripts, styles, comments and keeps entities", () => {
  const out = htmlToText(
    "<html><head><title>T</title><style>p{color:red}</style></head>" +
      "<body><!-- hidden --><p>A&amp;B</p><script>alert(1)</script>" +
      "<p>&lt;tag&gt; &quot;q&quot; &#39;a&#39; &#x4E2D; &nbsp;end</p></body></html>",
  );
  assert.equal(out, "A&B\n<tag> \"q\" 'a' 中 end");
  assert.equal(out.includes("alert"), false);
  assert.equal(out.includes("color:red"), false);
  assert.equal(out.includes("hidden"), false);
});

test('htmlToText renders links as "text (href)" and collapses whitespace', () => {
  const out = htmlToText(
    "<div>Hello</div><div>World</div>" +
      '<p><a href="https://bit.ly/x">Click here</a></p><br><br>End',
  );
  assert.equal(out, "Hello\nWorld\nClick here (https://bit.ly/x)\n\nEnd");
  assert.equal(
    htmlToText('<img src="https://cdn.example.com/x.png" alt="photo">'),
    "photo",
  );
  assert.equal(htmlToText("  <p>  spaced   out  </p>  "), "spaced out");
});

test("htmlToText is defensive about empty and non-html input", () => {
  assert.equal(htmlToText(""), "");
  assert.equal(htmlToText(null), "");
  assert.equal(htmlToText(undefined), "");
  assert.equal(
    htmlToText("plain text with < and > signs"),
    "plain text with < and > signs",
  );
  assert.equal(
    htmlToText('<a href="https://example.com/x"></a>'),
    "(https://example.com/x)",
  );
});

test("htmlToText never keeps image sources or remote references", () => {
  const out = htmlToText(
    '<p>Hi</p><img src="https://evil.example.com/pixel.gif"><img src="cid:logo">',
  );
  assert.equal(out, "Hi");
  assert.equal(out.includes("evil.example.com"), false);
});

/* ------------------------------------------------------------------ */
/* decodeHeaderWord                                                     */
/* ------------------------------------------------------------------ */

test("decodeHeaderWord handles B, Q, adjacency, folding and charsets", () => {
  assert.equal(decodeHeaderWord("=?utf-8?B?5L2g5aW9?="), "你好");
  assert.equal(decodeHeaderWord("=?UTF-8?Q?=E4=BD=A0=E5=A5=BD?="), "你好");
  assert.equal(decodeHeaderWord("=?utf-8?Q?hello_world?="), "hello world");
  assert.equal(decodeHeaderWord("=?utf-8?B?5L2g?= =?utf-8?B?5aW9?="), "你好");
  assert.equal(
    decodeHeaderWord("=?utf-8?B?5L2g?=\r\n =?utf-8?B?5aW9?="),
    "你好",
  );
  assert.equal(decodeHeaderWord("=?utf-8?B?5L2g?=\t=?utf-8?B?5aW9?="), "你好");
  assert.equal(
    decodeHeaderWord("=?gbk?B?vL62yLGoz/q1pdLRyfqzyQ==?="),
    "季度报销单已生成",
  );
  assert.equal(
    decodeHeaderWord("=?big5?B?pKSk6g==?="),
    decodeHeaderWord("=?big5?B?pKSk6g==?="),
  );
  assert.equal(
    decodeHeaderWord("=?x-unknown-charset?B?5L2g5aW9?="),
    "你好",
    "unknown charset falls back",
  );
  assert.equal(
    decodeHeaderWord("Re: =?utf-8?B?5L2g5aW9?= (fwd)"),
    "Re: 你好 (fwd)",
  );
  assert.equal(decodeHeaderWord("plain subject"), "plain subject");
  assert.equal(decodeHeaderWord(""), "");
  assert.equal(decodeHeaderWord(null), "");
  assert.equal(decodeHeaderWord(undefined), "");
  assert.equal(
    typeof decodeHeaderWord("=?utf-8?B?!!!not base64!!!?="),
    "string",
  );
  assert.equal(typeof decodeHeaderWord("=?utf-8?Q?=ZZ?="), "string");
});

test("raw 8-bit UTF-8 header bytes are decoded instead of mojibake", () => {
  const rec = parseMessage(
    Buffer.from("Subject: 中文主题\r\nFrom: a@example.com\r\n\r\nbody", "utf8"),
  );
  assert.equal(rec.subject, "中文主题");
});

/* ------------------------------------------------------------------ */
/* addresses                                                            */
/* ------------------------------------------------------------------ */

test("address lists: quoted names, groups, comments and domain case", () => {
  const rec = parseLines(
    'From: "Doe, John" <John.Doe@Example.COM>',
    "To: undisclosed-recipients:;",
    "Cc: =?utf-8?B?5byg5LiJ?= <zhangsan@example.org>, bare@example.net (Bare User)",
    "",
    "body",
  );
  assert.equal(rec.from.name, "Doe, John");
  assert.equal(rec.from.address, "John.Doe@example.com");
  assert.equal(rec.from.domain, "example.com");
  assert.deepEqual(rec.to, []);
  assert.deepEqual(rec.cc, [
    { name: "张三", address: "zhangsan@example.org" },
    { name: "Bare User", address: "bare@example.net" },
  ]);
});

test("address parsing is defensive about junk", () => {
  const rec = parseLines("From: not an address", "To: <>, a@b, ,", "", "body");
  assert.deepEqual(rec.from, { name: "", address: "", domain: "" });
  assert.deepEqual(rec.to, [{ name: "", address: "a@b" }]);
});

/* ------------------------------------------------------------------ */
/* dates                                                                */
/* ------------------------------------------------------------------ */

test("date parsing: RFC 5322 forms, obsolete zones, failures", () => {
  function date(value) {
    return parseLines("Date: " + value, "", "x").date;
  }
  assert.equal(
    date("Wed, 01 Oct 2025 12:34:56 +0800"),
    "2025-10-01T04:34:56.000Z",
  );
  assert.equal(date("1 Oct 2025 12:34 +0800"), "2025-10-01T04:34:00.000Z");
  assert.equal(date("Wed, 01 Oct 25 12:34:56 GMT"), "2025-10-01T12:34:56.000Z");
  assert.equal(
    date("Wed, 01 Oct 2025 12:34:56 -0500"),
    "2025-10-01T17:34:56.000Z",
  );
  assert.equal(
    date("Wed, 01 Oct 2025 12:34:56 EST"),
    "2025-10-01T17:34:56.000Z",
  );
  assert.equal(date("01 Oct 1997 00:00:00 +0000"), "1997-10-01T00:00:00.000Z");
  assert.equal(
    date("Wed, 01 Oct 2025 12:34:56 +0800 (CST)"),
    "2025-10-01T04:34:56.000Z",
  );
  assert.equal(date("totally bogus"), null);
  assert.equal(parseLines("Subject: no date header", "", "x").date, null);
});

/* ------------------------------------------------------------------ */
/* links                                                                */
/* ------------------------------------------------------------------ */

test("only absolute http(s) links are collected, and duplicates collapse", () => {
  const rec = parseLines(
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p><a href="/relative">rel</a> <a href="mailto:x@example.com">mail</a>' +
      ' <a href="javascript:alert(1)">js</a> <a href="https://example.com/ok">ok</a>' +
      ' <a href="www.example.net/bare">bare</a> <a href="https://example.com/ok">again</a></p>',
  );
  assert.deepEqual(
    rec.links.map(function (l) {
      return l.href;
    }),
    ["https://example.com/ok", "http://www.example.net/bare"],
  );
  assert.equal(
    rec.htmlBody.includes("javascript:"),
    true,
    "raw html is preserved, never executed",
  );
});

test("text links lose trailing sentence punctuation and honour www hosts", () => {
  const rec = parseLines(
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Visit https://example.com/x. Also (https://example.net/y) and www.example.org/z, done.",
  );
  assert.deepEqual(
    rec.links.map(function (l) {
      return l.href;
    }),
    [
      "https://example.com/x",
      "https://example.net/y",
      "http://www.example.org/z",
    ],
  );
  assert.deepEqual(
    rec.links.map(function (l) {
      return l.host;
    }),
    ["example.com", "example.net", "www.example.org"],
  );
});

/* ------------------------------------------------------------------ */
/* remote images                                                        */
/* ------------------------------------------------------------------ */

test("hasRemoteImages detects http(s) and protocol-relative sources only", () => {
  function flag(html) {
    return parseLines("Content-Type: text/html; charset=utf-8", "", html)
      .hasRemoteImages;
  }
  assert.equal(flag('<img src="https://cdn.example.com/x.png">'), true);
  assert.equal(flag('<img src = "http://cdn.example.com/x.png">'), true);
  assert.equal(flag('<img src="//cdn.example.com/x.png">'), true);
  assert.equal(
    flag('<div style="background: url(https://cdn.example.com/x.png)"></div>'),
    true,
  );
  assert.equal(flag('<img src="cid:logo@example.com">'), false);
  assert.equal(flag('<img src="data:image/gif;base64,R0lGOD">'), false);
  assert.equal(flag("<p>no images here</p>"), false);
});

/* ------------------------------------------------------------------ */
/* body selection                                                       */
/* ------------------------------------------------------------------ */

test("html-only mail derives textBody from htmlToText", () => {
  const rec = parseLines(
    "Subject: html only",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><body><p>Hello <b>World</b></p><p>Second</p></body></html>",
  );
  assert.equal(
    rec.htmlBody,
    "<html><body><p>Hello <b>World</b></p><p>Second</p></body></html>",
  );
  assert.equal(rec.textBody, "Hello World\nSecond");
  assert.equal(rec.hasRemoteImages, false);
});

test("multipart/alternative prefers the plain part for textBody", () => {
  const rec = parseLines(
    'Content-Type: multipart/alternative; boundary="A"',
    "",
    "--A",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "plain version",
    "",
    "--A",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>html version</p>",
    "",
    "--A--",
  );
  assert.equal(rec.textBody, "plain version");
  assert.equal(rec.htmlBody, "<p>html version</p>");
});

test("body charsets: windows-1252, iso-8859-1 and unknown fallback", () => {
  const latin = parseLines(
    "Content-Type: text/plain; charset=iso-8859-1",
    "",
    "Caf\u00e9 cr\u00e8me",
  );
  assert.equal(latin.textBody, "Café crème");
  const cp = parseLines(
    "Content-Type: text/plain; charset=windows-1252",
    "",
    Buffer.from([0x93, 0x71, 0x75, 0x6f, 0x74, 0x65, 0x94]).toString("latin1"),
  );
  assert.equal(cp.textBody, "\u201cquote\u201d");
  const unknown = parseLines(
    "Content-Type: text/plain; charset=no-such-charset",
    "",
    "plain ascii survives",
  );
  assert.equal(unknown.textBody, "plain ascii survives");
});

test("base64 bodies ignore line breaks and tolerate whitespace", () => {
  const payload = Buffer.from("你好 base64", "utf8").toString("base64");
  const rec = parseLines(
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    payload.slice(0, 4),
    "  " + payload.slice(4),
  );
  assert.equal(rec.textBody, "你好 base64");
});

/* ------------------------------------------------------------------ */
/* input handling                                                       */
/* ------------------------------------------------------------------ */

test("Buffer and string input produce identical records", () => {
  for (const name of ALL_FIXTURES) {
    const buf = fixture(name);
    assert.deepEqual(
      parseMessage(buf.toString("utf8")),
      parseMessage(buf),
      name,
    );
  }
});

test("a UTF-8 string body is decoded correctly", () => {
  const rec = parseMessage(
    "Subject: 直接字符串\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n字符串正文。",
  );
  assert.equal(rec.subject, "直接字符串");
  assert.equal(rec.textBody, "字符串正文。");
});

test("header lookups are case-insensitive and unfold continuation lines", () => {
  const rec = parseLines(
    "SUBJECT: first",
    "\tsecond",
    "X-Long: a",
    " b",
    "",
    "body",
  );
  assert.equal(rec.subject, "first second");
  assert.equal(rec.textBody, "body");
});
