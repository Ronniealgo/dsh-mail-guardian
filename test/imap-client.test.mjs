/**
 * dsh-mail-guardian -- tests for the IMAP4rev1 client (work order A).
 *
 * Run with either:
 *   node --test test/imap-client.test.mjs
 *   node test/imap-client.test.mjs        (in-process, used when the sandbox refuses to spawn)
 */

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import {
  ImapClient,
  ImapError,
  encodeMailboxName,
  decodeMailboxName,
} from "../lib/imap-client.js";
import {
  startStubServer,
  encodeMailboxName as stubEncodeMailboxName,
  decodeMailboxName as stubDecodeMailboxName,
} from "./helpers/imap-stub-server.mjs";

const SENTINEL = "S3NTINEL-pass-do-not-leak";
const ALICE = "alice";
const PASSWORD = "correct-password";

let messageCounter = 0;

function makeMessage({
  subject,
  body,
  date,
  from = "sender@example.com",
  to = "alice@example.com",
}) {
  messageCounter += 1;
  const headers = [
    "From: " + from,
    "To: " + to,
    "Subject: " + subject,
    "Date: " + date,
    "Message-ID: <stub-" + messageCounter + "@example.com>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
  ].join("\r\n");
  return Buffer.concat([
    Buffer.from(headers + "\r\n", "utf8"),
    Buffer.from(body, "utf8"),
  ]);
}

const MESSAGES = [
  makeMessage({
    subject: "第一封：欢迎邮件",
    body: "你好，这是第一封邮件。\r\n带中文正文与多字节字符。\r\n",
    date: "Wed, 01 Jan 2025 10:00:00 +0000",
  }),
  makeMessage({
    subject: "第二封：Re: 欢迎邮件",
    body: "第二封正文 — UTF-8 ✓ 中文测试。\r\n",
    date: "Sat, 01 Feb 2025 10:00:00 +0000",
  }),
  makeMessage({
    subject: "第三封：本月账单",
    body: "账单金额：¥1,234.56\r\n",
    date: "Sat, 01 Mar 2025 10:00:00 +0000",
  }),
];

function collectLogger() {
  const lines = [];
  const push = (level) => (message) => {
    lines.push(level + ": " + String(message));
  };
  return {
    lines,
    logger: {
      debug: push("debug"),
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
    },
  };
}

/** Start a stub, track every client for cleanup, and expose a connect() helper with logger capture. */
async function withServer(t, options, run) {
  const stub = await startStubServer(options);
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.destroy();
    await stub.close();
  });
  const connect = async (overrides = {}) => {
    const captured = collectLogger();
    const client = new ImapClient(
      Object.assign(
        {
          host: stub.host,
          port: stub.port,
          secure: false,
          timeoutMs: 2000,
          logger: captured.logger,
        },
        overrides,
      ),
    );
    clients.push(client);
    await client.connect();
    return { client, lines: captured.lines, logger: captured.logger };
  };
  await run({ stub, connect, state: stub.state });
}

async function rejection(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

/* ------------------------------------------------------------------------------------------- *
 * connect / capabilities
 * ------------------------------------------------------------------------------------------- */

test("connect(): reads the greeting and CAPABILITY, exposing lowercase capabilities", async (t) => {
  await withServer(t, {}, async ({ connect }) => {
    const { client, lines } = await connect();
    assert.ok(client.capabilities instanceof Set);
    for (const capability of ["imap4rev1", "move", "uidplus"]) {
      assert.ok(
        client.capabilities.has(capability),
        "missing capability " + capability,
      );
    }
    for (const capability of client.capabilities)
      assert.equal(capability, capability.toLowerCase());
    assert.ok(lines.some((line) => line.startsWith("debug: ")));
  });
});

test("connect(): merges capabilities seen in the greeting with the CAPABILITY response", async (t) => {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.write("* OK [CAPABILITY IMAP4rev1 MOVE] raw stub ready\r\n");
    socket.on("data", (chunk) => {
      const tag = String(chunk).trim().split(/\s+/)[0];
      socket.write(
        "* CAPABILITY IMAP4rev1 UIDPLUS\r\n" +
          tag +
          " OK CAPABILITY completed\r\n",
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new ImapClient({
    host: "127.0.0.1",
    port: server.address().port,
    secure: false,
    timeoutMs: 2000,
  });
  t.after(async () => {
    client.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  await client.connect();
  assert.deepEqual(Array.from(client.capabilities).sort(), [
    "imap4rev1",
    "move",
    "uidplus",
  ]);
});

test('connect(): a BAD reply to CAPABILITY rejects with kind "protocol"', async (t) => {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.write("* OK raw stub ready\r\n");
    socket.on("data", (chunk) => {
      const tag = String(chunk).trim().split(/\s+/)[0];
      socket.write(tag + " BAD unknown command\r\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new ImapClient({
    host: "127.0.0.1",
    port: server.address().port,
    secure: false,
    timeoutMs: 2000,
  });
  t.after(async () => {
    client.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const error = await rejection(client.connect());
  assert.ok(error instanceof ImapError);
  assert.equal(error.name, "ImapError");
  assert.equal(error.kind, "protocol");
  assert.equal(client.capabilities.size, 0);
});

test("parser: escaped quotes, NIL and two literals inside a single response", async (t) => {
  const header = "Subject: 多字面量测试\r\n\r\n";
  const body = "正文 A ✓ 多字节";
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.write("* OK raw stub ready\r\n");
    socket.on("data", (chunk) => {
      const line = String(chunk).replace(/\r?\n/g, "").trim();
      const tag = line.split(/\s+/)[0];
      const words = line.split(/\s+/).map((word) => word.toUpperCase());
      if (words.includes("CAPABILITY")) {
        socket.write(
          "* CAPABILITY IMAP4rev1\r\n" + tag + " OK CAPABILITY done\r\n",
        );
        return;
      }
      if (words.includes("LIST")) {
        // escaped quotes inside a quoted string and a NIL delimiter
        socket.write(
          '* LIST (\\HasNoChildren) NIL "Quoted \\"Name\\""\r\n' +
            tag +
            " OK LIST done\r\n",
        );
        return;
      }
      // one FETCH response carrying two literals, a quoted flag list and a nested list
      const headerBuffer = Buffer.from(header, "utf8");
      const bodyBuffer = Buffer.from(body, "utf8");
      socket.write(
        "* 1 FETCH (UID 7 BODY[HEADER] {" + headerBuffer.length + "}\r\n",
      );
      socket.write(headerBuffer);
      socket.write(" RFC822 {" + bodyBuffer.length + "}\r\n");
      socket.write(bodyBuffer);
      socket.write(" FLAGS (\\Seen))\r\n" + tag + " OK UID FETCH done\r\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new ImapClient({
    host: "127.0.0.1",
    port: server.address().port,
    secure: false,
    timeoutMs: 2000,
  });
  t.after(async () => {
    client.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  await client.connect();

  assert.deepEqual(await client.listMailboxes(), [
    { name: 'Quoted "Name"', delimiter: null },
  ]);

  const fetched = await client.uidFetch({
    fromUid: 7,
    toUid: 7,
    items: ["UID", "BODY[HEADER]", "RFC822", "FLAGS"],
  });
  assert.deepEqual(
    fetched.map((message) => message.uid),
    [7],
  );
  assert.equal(
    fetched[0].raw.toString("utf8"),
    body,
    "the last body item of the response wins",
  );
  assert.equal(fetched[0].size, Buffer.byteLength(body, "utf8"));
  assert.deepEqual(fetched[0].flags, ["\\Seen"]);
});

test("commands: run strictly one at a time with increasing tags", async (t) => {
  const arrivals = [];
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.write("* OK raw stub ready\r\n");
    socket.on("data", (chunk) => {
      for (const line of String(chunk)
        .split("\r\n")
        .filter((entry) => entry.trim().length > 0)) {
        arrivals.push({ line, at: Date.now() });
        const tag = line.split(/\s+/)[0];
        const prefix = line.toUpperCase().includes("CAPABILITY")
          ? "* CAPABILITY IMAP4rev1\r\n"
          : "";
        setTimeout(() => {
          if (!socket.destroyed) socket.write(prefix + tag + " OK done\r\n");
        }, 30);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new ImapClient({
    host: "127.0.0.1",
    port: server.address().port,
    secure: false,
    timeoutMs: 2000,
  });
  t.after(async () => {
    client.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  await client.connect();
  await Promise.all([client.noop(), client.noop(), client.noop()]);

  assert.deepEqual(
    arrivals.map((entry) => entry.line.split(/\s+/)[0]),
    ["A1", "A2", "A3", "A4"],
  );
  assert.deepEqual(
    arrivals.map((entry) => entry.line.split(/\s+/)[1].toUpperCase()),
    ["CAPABILITY", "NOOP", "NOOP", "NOOP"],
  );
  for (let index = 1; index < arrivals.length; index += 1) {
    assert.ok(
      arrivals[index].at - arrivals[index - 1].at >= 20,
      "command " + (index + 1) + " was sent before the previous reply arrived",
    );
  }
});

/* ------------------------------------------------------------------------------------------- *
 * login / list / select
 * ------------------------------------------------------------------------------------------- */

test("login(): authenticates, listMailboxes() and select() parse untagged data", async (t) => {
  await withServer(
    t,
    { users: { [ALICE]: PASSWORD }, messages: MESSAGES },
    async ({ connect, state }) => {
      const { client } = await connect();
      await client.login(ALICE, PASSWORD);

      assert.deepEqual(await client.listMailboxes(), [
        { name: "INBOX", delimiter: "/" },
        { name: "Archive", delimiter: "/" },
        { name: "Trash", delimiter: "/" },
      ]);

      assert.deepEqual(await client.select("INBOX"), {
        uidValidity: 1,
        uidNext: 4,
        exists: 3,
        readOnly: false,
      });
      assert.deepEqual(state.logins, [{ user: ALICE, ok: true }]);

      await client.noop();
      assert.ok(state.commandLog.includes("NOOP"));
    },
  );
});

test('login(): a wrong password rejects with ImapError kind "auth" and no secret in the message', async (t) => {
  await withServer(
    t,
    { users: { [ALICE]: PASSWORD } },
    async ({ connect, state }) => {
      const { client } = await connect();
      const error = await rejection(client.login(ALICE, "wrong-password"));
      assert.ok(error instanceof ImapError);
      assert.equal(error.kind, "auth");
      assert.ok(!error.message.includes("wrong-password"));
      assert.ok(error.message.includes("LOGIN"));
      assert.deepEqual(state.logins, [{ user: ALICE, ok: false }]);
    },
  );
});

test('select(): a NO answer for a missing mailbox rejects with kind "protocol"', async (t) => {
  await withServer(t, { messages: MESSAGES }, async ({ connect }) => {
    const { client } = await connect();
    await client.login(ALICE, PASSWORD);
    const error = await rejection(client.select("NoSuchMailbox"));
    assert.ok(error instanceof ImapError);
    assert.equal(error.kind, "protocol");
  });
});

/* ------------------------------------------------------------------------------------------- *
 * UID FETCH
 * ------------------------------------------------------------------------------------------- */

test("uidFetch(): parses several messages with literal UTF-8 bodies, ordered by UID", async (t) => {
  await withServer(t, { messages: MESSAGES }, async ({ connect, state }) => {
    const { client } = await connect();
    await client.login(ALICE, PASSWORD);
    await client.select("INBOX");

    const fetched = await client.uidFetch({ fromUid: 1 });
    assert.equal(fetched.length, 3);
    assert.deepEqual(
      fetched.map((message) => message.uid),
      [1, 2, 3],
    );
    assert.ok(
      MESSAGES[0].length > MESSAGES[0].toString("utf8").length,
      "fixture must contain multi-byte UTF-8",
    );

    fetched.forEach((message, index) => {
      assert.deepEqual(Object.keys(message).sort(), [
        "flags",
        "raw",
        "size",
        "uid",
      ]);
      assert.deepEqual(message.flags, []);
      assert.equal(message.size, MESSAGES[index].length);
      assert.ok(Buffer.isBuffer(message.raw));
      assert.ok(
        message.raw.equals(MESSAGES[index]),
        "message " + (index + 1) + " bytes must round-trip exactly",
      );
    });

    assert.ok(
      state.commandLog.some((line) =>
        line.startsWith("UID FETCH 1:* (UID FLAGS RFC822"),
      ),
    );
  });
});

test("uidFetch(): honours a custom item order (literal in the middle) and RFC822.SIZE", async (t) => {
  await withServer(t, { messages: MESSAGES }, async ({ connect }) => {
    const { client } = await connect();
    await client.login(ALICE, PASSWORD);
    await client.select("INBOX");

    const fetched = await client.uidFetch({
      fromUid: 2,
      toUid: 3,
      items: ["UID", "RFC822", "FLAGS", "RFC822.SIZE"],
    });
    assert.deepEqual(
      fetched.map((message) => message.uid),
      [2, 3],
    );
    assert.ok(fetched[0].raw.equals(MESSAGES[1]));
    assert.ok(fetched[1].raw.equals(MESSAGES[2]));
    assert.equal(fetched[0].size, MESSAGES[1].length);
    assert.equal(fetched[1].size, MESSAGES[2].length);
    assert.deepEqual(fetched[0].flags, []);

    const empty = await client.uidFetch({ fromUid: 99 });
    assert.deepEqual(empty, []);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * UID SEARCH
 * ------------------------------------------------------------------------------------------- */

test("uidSearch(): ALL / uidFrom / UNSEEN / SINCE / BEFORE", async (t) => {
  await withServer(t, { messages: MESSAGES }, async ({ connect }) => {
    const { client } = await connect();
    await client.login(ALICE, PASSWORD);
    await client.select("INBOX");

    assert.deepEqual(await client.uidSearch({}), [1, 2, 3]);
    assert.deepEqual(await client.uidSearch({ uidFrom: 2 }), [2, 3]);
    assert.deepEqual(await client.uidSearch({ unseen: true }), [1, 2, 3]);
    assert.deepEqual(await client.uidSearch({ since: "2025-02-01" }), [2, 3]);
    assert.deepEqual(await client.uidSearch({ before: "2025-03-01" }), [1, 2]);
    assert.deepEqual(
      await client.uidSearch({
        uidFrom: 2,
        since: "2025-02-01",
        before: "2025-03-01",
      }),
      [2],
    );
  });
});

/* ------------------------------------------------------------------------------------------- *
 * UID STORE
 * ------------------------------------------------------------------------------------------- */

test("uidStore(): added and removed flags show up in FETCH and in SEARCH UNSEEN", async (t) => {
  await withServer(t, { messages: MESSAGES }, async ({ connect, state }) => {
    const { client } = await connect();
    await client.login(ALICE, PASSWORD);
    await client.select("INBOX");

    await client.uidStore([1, 2], { addFlags: ["\\Seen"] });
    assert.deepEqual(state.flagsOf("INBOX", 1), ["\\Seen"]);
    assert.deepEqual(state.flagsOf("INBOX", 2), ["\\Seen"]);
    assert.ok(state.commandLog.includes("UID STORE 1,2 +FLAGS (\\Seen)"));
    assert.deepEqual(await client.uidSearch({ unseen: true }), [3]);

    const fetched = await client.uidFetch({ fromUid: 1, toUid: 2 });
    assert.deepEqual(fetched[0].flags, ["\\Seen"]);
    assert.deepEqual(fetched[1].flags, ["\\Seen"]);

    await client.uidStore([1], { removeFlags: ["\\Seen"] });
    assert.deepEqual(state.flagsOf("INBOX", 1), []);
    assert.deepEqual(await client.uidSearch({ unseen: true }), [1, 3]);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * UID MOVE and its fallback paths
 * ------------------------------------------------------------------------------------------- */

test("uidMove(): uses UID MOVE when the server advertises the capability", async (t) => {
  await withServer(t, { messages: MESSAGES }, async ({ connect, state }) => {
    const { client } = await connect();
    await client.login(ALICE, PASSWORD);
    await client.select("INBOX");

    await client.uidMove([1], "Archive");
    assert.deepEqual(state.uidsOf("INBOX"), [2, 3]);
    assert.deepEqual(state.uidsOf("Archive"), [1]);
    assert.ok(state.rawOf("Archive", 1).equals(MESSAGES[0]));
    assert.ok(state.commandLog.some((line) => line.startsWith("UID MOVE 1 ")));
    assert.ok(!state.commandLog.some((line) => line.startsWith("UID COPY")));
  });
});

test("uidMove(): without MOVE and UIDPLUS refuses before COPY or global EXPUNGE", async (t) => {
  await withServer(
    t,
    { messages: MESSAGES, capabilities: ["imap4rev1"] },
    async ({ connect, state }) => {
      const { client } = await connect();
      await client.login(ALICE, PASSWORD);
      await client.select("INBOX");
      await assert.rejects(
        client.uidMove([1, 2], "Archive"),
        (e) => e.kind === "protocol",
      );
      assert.deepEqual(state.uidsOf("INBOX"), [1, 2, 3]);
      assert.ok(
        !state.commandLog.some((line) => /UID COPY|EXPUNGE/.test(line)),
      );
    },
  );
});

test("uidMove(): the fallback uses UID EXPUNGE when the server advertises uidplus", async (t) => {
  await withServer(
    t,
    { messages: MESSAGES, capabilities: ["imap4rev1", "uidplus"] },
    async ({ connect, state }) => {
      const { client } = await connect();
      await client.login(ALICE, PASSWORD);
      await client.select("INBOX");

      await client.uidMove([3], "Trash");
      assert.deepEqual(state.uidsOf("INBOX"), [1, 2]);
      assert.deepEqual(state.uidsOf("Trash"), [1]);
      assert.ok(state.commandLog.some((line) => line === "UID EXPUNGE 3"));
      assert.ok(!state.commandLog.includes("EXPUNGE"));
    },
  );
});

test('uidMove(): a NO answer to UID MOVE rejects with kind "protocol" instead of falling back', async (t) => {
  await withServer(
    t,
    { messages: MESSAGES, simulate: "move-no" },
    async ({ connect, state }) => {
      const { client } = await connect();
      await client.login(ALICE, PASSWORD);
      await client.select("INBOX");

      const error = await rejection(client.uidMove([3], "Trash"));
      assert.ok(error instanceof ImapError);
      assert.equal(error.kind, "protocol");
      assert.ok(
        state.commandLog.some((line) => line.startsWith("UID MOVE 3 ")),
      );
      assert.ok(
        !state.commandLog.some((line) => line.startsWith("UID COPY")),
        "a NO answer must not be masked by the fallback",
      );
      assert.deepEqual(
        state.uidsOf("INBOX"),
        [1, 2, 3],
        "nothing may have been moved",
      );
      assert.deepEqual(state.uidsOf("Trash"), []);
    },
  );
});

test("uidMove(): a BAD (unknown command) answer still takes the COPY + STORE + EXPUNGE fallback", async (t) => {
  await withServer(
    t,
    { messages: MESSAGES, simulate: "move-bad" },
    async ({ connect, state }) => {
      const { client } = await connect();
      await client.login(ALICE, PASSWORD);
      await client.select("INBOX");

      await client.uidMove([3], "Trash");
      assert.ok(
        state.commandLog.some((line) => line.startsWith("UID MOVE 3 ")),
      );
      assert.ok(
        state.commandLog.some((line) => line.startsWith("UID COPY 3 ")),
      );
      assert.ok(
        state.commandLog.some(
          (line) => line === "UID STORE 3 +FLAGS (\\Deleted)",
        ),
      );
      assert.ok(state.commandLog.includes("UID EXPUNGE 3"));
      assert.deepEqual(state.uidsOf("INBOX"), [1, 2]);
      assert.deepEqual(state.uidsOf("Trash"), [1]);
    },
  );
});

test("uidMove(): a NO [TRYCREATE] for a missing destination never falls back to COPY", async (t) => {
  await withServer(
    t,
    { messages: MESSAGES, mailboxes: ["INBOX", "Archive"] },
    async ({ connect, state }) => {
      const { client } = await connect();
      await client.login(ALICE, PASSWORD);
      await client.select("INBOX");

      const error = await rejection(client.uidMove([1], "低优先"));
      assert.ok(error instanceof ImapError);
      assert.equal(error.kind, "protocol");
      assert.ok(
        state.commandLog.includes('UID MOVE 1 "&T05PGFFI-"'),
        state.commandLog.join(" | "),
      );
      assert.ok(
        !state.commandLog.some((line) => line.startsWith("UID COPY")),
        "the missing mailbox must not be hidden by a COPY",
      );
      assert.ok(
        !state.commandLog.some((line) => line.startsWith("UID STORE")),
        "no flag may be touched after a refused MOVE",
      );
      assert.ok(!state.commandLog.includes("EXPUNGE"));
      assert.deepEqual(
        state.uidsOf("INBOX"),
        [1, 2, 3],
        "the refused move must leave the mailbox untouched",
      );
      assert.deepEqual(state.uidsOf("Archive"), []);
    },
  );
});

test("uidMove(): moves into a non-ASCII mailbox over UID MOVE with the encoded name on the wire", async (t) => {
  await withServer(
    t,
    { messages: MESSAGES, mailboxes: ["INBOX", "低优先", "垃圾箱"] },
    async ({ connect, state }) => {
      const { client } = await connect();
      await client.login(ALICE, PASSWORD);
      await client.select("INBOX");

      await client.uidMove([1], "低优先");
      assert.deepEqual(state.uidsOf("INBOX"), [2, 3]);
      assert.deepEqual(state.uidsOf("低优先"), [1]);
      assert.ok(
        state.rawOf("低优先", 1).equals(MESSAGES[0]),
        "the raw message must arrive byte for byte",
      );
      assert.ok(
        state.commandLog.includes('UID MOVE 1 "&T05PGFFI-"'),
        state.commandLog.join(" | "),
      );
      assert.ok(!state.commandLog.some((line) => line.startsWith("UID COPY")));
    },
  );
});

test("uidMove(): without the MOVE capability the fallback reaches a non-ASCII mailbox", async (t) => {
  await withServer(
    t,
    {
      messages: MESSAGES,
      capabilities: ["imap4rev1", "uidplus"],
      mailboxes: ["INBOX", "垃圾箱"],
    },
    async ({ connect, state }) => {
      const { client } = await connect();
      await client.login(ALICE, PASSWORD);
      await client.select("INBOX");

      await client.uidMove([1, 2], "垃圾箱");
      assert.deepEqual(state.uidsOf("INBOX"), [3]);
      assert.deepEqual(state.uidsOf("垃圾箱"), [1, 2]);
      assert.ok(state.rawOf("垃圾箱", 1).equals(MESSAGES[0]));
      assert.ok(state.rawOf("垃圾箱", 2).equals(MESSAGES[1]));
      assert.ok(!state.commandLog.some((line) => line.startsWith("UID MOVE")));
      assert.ok(
        state.commandLog.includes('UID COPY 1,2 "&V4NXPnux-"'),
        state.commandLog.join(" | "),
      );
      assert.ok(state.commandLog.includes("UID STORE 1,2 +FLAGS (\\Deleted)"));
      assert.ok(state.commandLog.includes("UID EXPUNGE 1,2"));
    },
  );
});

/* ------------------------------------------------------------------------------------------- *
 * RFC 3501 modified UTF-7 mailbox names
 * ------------------------------------------------------------------------------------------- */

test('mailbox names: encode/decode implement modified UTF-7 (RFC examples, "&" edges, malformed input)', () => {
  // the two worked examples from RFC 3501 section 5.1.3
  assert.equal(
    encodeMailboxName("~peter/mail/台北/日本語"),
    "~peter/mail/&U,BTFw-/&ZeVnLIqe-",
  );
  assert.equal(
    decodeMailboxName("~peter/mail/&U,BTFw-/&ZeVnLIqe-"),
    "~peter/mail/台北/日本語",
  );

  const names = [
    "INBOX",
    "Archive/2025",
    "低优先",
    "垃圾箱",
    "INBOX/低优先",
    "A&B",
    "&&",
    "&",
    "A&-B",
    "&-x",
    "INBOX/低优先 & 归档",
    "Ünïcödé",
    "emoji 😀 box",
    "Mixed 中文 (draft)",
  ];

  for (const name of names) {
    const encoded = encodeMailboxName(name);
    assert.ok(
      /^[\x20-\x7e]*$/.test(encoded),
      "the wire form must be printable ASCII: " + name + " -> " + encoded,
    );
    assert.equal(
      decodeMailboxName(encoded),
      name,
      "client round trip failed for " + name,
    );
    assert.equal(
      stubDecodeMailboxName(encoded),
      name,
      "the stub codec must agree on " + encoded,
    );
    assert.equal(
      stubEncodeMailboxName(name),
      encoded,
      "the two encoders must agree for " + name,
    );
  }

  // pure ASCII is byte for byte unchanged and "&" is the only character that grows
  assert.equal(encodeMailboxName(""), "");
  assert.equal(decodeMailboxName(""), "");
  assert.equal(encodeMailboxName("INBOX"), "INBOX");
  assert.equal(encodeMailboxName("Archive/2025"), "Archive/2025");
  assert.equal(encodeMailboxName("&"), "&-");
  assert.equal(encodeMailboxName("A&B"), "A&-B");
  assert.equal(encodeMailboxName("A&-B"), "A&--B");
  assert.equal(encodeMailboxName("低优先"), "&T05PGFFI-");
  assert.equal(decodeMailboxName("&T05PGFFI-"), "低优先");
  assert.equal(decodeMailboxName("&-"), "&");
  assert.equal(decodeMailboxName("&--"), "&-");
  assert.equal(decodeMailboxName("&--x"), "&-x");

  // malformed or truncated sections are kept verbatim instead of being dropped silently
  assert.equal(decodeMailboxName("&"), "&");
  assert.equal(decodeMailboxName("a&b"), "a&b");
  assert.equal(decodeMailboxName("&!-"), "&!-");
  assert.equal(decodeMailboxName("&A-"), "&A-");
});

test("mailbox names: non-ASCII mailboxes round trip through LIST and SELECT as modified UTF-7", async (t) => {
  const names = [
    "INBOX",
    "低优先",
    "垃圾箱",
    "A&B",
    "A&-B",
    "&-x",
    "INBOX/低优先 & 归档",
  ];
  await withServer(t, { mailboxes: names }, async ({ connect, state }) => {
    const { client } = await connect();
    await client.login(ALICE, PASSWORD);

    assert.deepEqual(
      await client.listMailboxes(),
      names.map((name) => ({ name, delimiter: "/" })),
    );

    // the stub only finds a mailbox when the wire form decodes back to the configured UTF-8 name
    for (const name of names) {
      const selected = await client.select(name);
      assert.deepEqual(
        selected,
        { uidValidity: 1, uidNext: 1, exists: 0, readOnly: false },
        "select(" + name + ")",
      );
    }

    assert.ok(state.commandLog.includes('LIST "" "*"'));
    assert.ok(
      state.commandLog.includes('SELECT "&T05PGFFI-"'),
      "低优先 must be encoded on the wire",
    );
    assert.ok(state.commandLog.includes('SELECT "A&-B"'));
    assert.ok(
      state.commandLog.includes('SELECT "A&--B"'),
      'a literal "&-" must not collapse into "&"',
    );
    assert.ok(state.commandLog.includes('SELECT "&--x"'));
    for (const line of state.commandLog) {
      assert.ok(
        /^[\x20-\x7e]*$/.test(line),
        "every command must stay 7-bit: " + line,
      );
    }
  });
});

/* ------------------------------------------------------------------------------------------- *
 * Failure modes
 * ------------------------------------------------------------------------------------------- */

test('network: a connection dropped in the middle of a FETCH rejects with kind "network"', async (t) => {
  await withServer(
    t,
    { messages: MESSAGES, simulate: "drop-mid-fetch" },
    async ({ connect }) => {
      const { client } = await connect();
      await client.login(ALICE, PASSWORD);
      await client.select("INBOX");

      const error = await rejection(client.uidFetch({ fromUid: 1 }));
      assert.ok(error instanceof ImapError);
      assert.equal(error.kind, "network");
      assert.equal(error.name, "ImapError");
    },
  );
});

test('network: connecting to a closed port rejects with kind "network"', async (t) => {
  const probe = await startStubServer({});
  const port = probe.port;
  await probe.close();
  const client = new ImapClient({
    host: "127.0.0.1",
    port,
    secure: false,
    timeoutMs: 2000,
  });
  t.after(() => client.destroy());
  const error = await rejection(client.connect());
  assert.ok(error instanceof ImapError);
  assert.equal(error.kind, "network");
});

test('timeout: a slow response rejects with kind "timeout"', async (t) => {
  await withServer(
    t,
    { messages: MESSAGES, simulate: "slow", slowCommands: ["UID FETCH"] },
    async ({ connect }) => {
      const { client } = await connect({ timeoutMs: 300 });
      await client.login(ALICE, PASSWORD);
      await client.select("INBOX");

      const started = Date.now();
      const error = await rejection(client.uidFetch({ fromUid: 1 }));
      const elapsed = Date.now() - started;
      assert.ok(error instanceof ImapError);
      assert.equal(error.kind, "timeout");
      assert.ok(
        elapsed >= 250,
        "must have waited for the timeout, took " + elapsed + "ms",
      );
      assert.ok(
        elapsed < 2500,
        "must not have waited for the slow reply, took " + elapsed + "ms",
      );

      const after = await rejection(client.noop());
      assert.ok(after instanceof ImapError);
      assert.equal(after.kind, "network");
    },
  );
});

test("logout(): is idempotent and closes the connection", async (t) => {
  await withServer(t, { messages: MESSAGES }, async ({ connect, state }) => {
    const { client } = await connect();
    await client.login(ALICE, PASSWORD);
    await client.select("INBOX");

    await client.logout();
    await client.logout();
    assert.equal(
      state.commandLog.filter((line) => line === "LOGOUT").length,
      1,
    );

    const error = await rejection(client.noop());
    assert.ok(error instanceof ImapError);
    assert.equal(error.kind, "network");
  });
});

test("logout(): resolves even when the server already dropped the connection", async (t) => {
  await withServer(
    t,
    { messages: MESSAGES, simulate: "drop-mid-fetch" },
    async ({ connect }) => {
      const { client } = await connect();
      await client.login(ALICE, PASSWORD);
      await client.select("INBOX");
      assert.ok(
        (await rejection(client.uidFetch({ fromUid: 1 }))) instanceof ImapError,
      );
      await client.logout();
      await client.logout();
    },
  );
});

test('destroy(): never throws, is idempotent and leaves later commands failing with kind "network"', async (t) => {
  await withServer(t, { messages: MESSAGES }, async ({ connect }) => {
    const { client } = await connect();
    await client.login(ALICE, PASSWORD);
    client.destroy();
    client.destroy();
    const error = await rejection(client.noop());
    assert.ok(error instanceof ImapError);
    assert.equal(error.kind, "network");
  });
});

test('commands: a never-connected client rejects with kind "network" instead of hanging', async () => {
  const client = new ImapClient({
    host: "127.0.0.1",
    port: 1,
    secure: false,
    timeoutMs: 500,
  });
  const error = await rejection(client.noop());
  assert.ok(error instanceof ImapError);
  assert.equal(error.kind, "network");
  client.destroy();
});

/* ------------------------------------------------------------------------------------------- *
 * Secret hygiene
 * ------------------------------------------------------------------------------------------- */

test("secrets: the login password never reaches the logger or an error message", async (t) => {
  await withServer(
    t,
    { users: { [ALICE]: SENTINEL, bob: PASSWORD }, messages: MESSAGES },
    async ({ connect }) => {
      const good = await connect();
      await good.client.login(ALICE, SENTINEL);
      await good.client.select("INBOX");
      await good.client.uidFetch({ fromUid: 1 });
      await good.client.uidMove([1], "Archive");
      await good.client.uidStore([2], { addFlags: ["\\Seen"] });
      await good.client.uidSearch({ unseen: true });
      await good.client.logout();

      const bad = await connect();
      const wrongPassword = "xx" + SENTINEL + "yy";
      const error = await rejection(bad.client.login(ALICE, wrongPassword));
      assert.ok(error instanceof ImapError);
      assert.equal(error.kind, "auth");

      const haystack = [
        good.lines.join("\n"),
        bad.lines.join("\n"),
        error.message,
        String(error),
        String(error.stack),
        error.stack || "",
      ].join("\n");
      assert.ok(
        !haystack.includes(SENTINEL),
        "the sentinel password leaked into logs or an error message",
      );
      assert.ok(!haystack.includes(wrongPassword));
      assert.ok(
        good.lines.length > 0 && bad.lines.length > 0,
        "the logger must actually have received output",
      );

      const loggedIn = bad.client;
      assert.ok(
        (await rejection(loggedIn.uidFetch({ fromUid: 1 }))) === null,
        "the failed LOGIN must not leave a usable authenticated state",
      );
    },
  );
});
