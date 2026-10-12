#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolveSettings } from "../lib/config.js";
import { MailState } from "../lib/state.js";
import { MailIndex } from "../lib/mail-index.js";
import { ImapClient } from "../lib/imap-client.js";
import { parseMessage } from "../lib/mime.js";
import { createPipeline } from "../lib/pipeline.js";
import { createSyncRuntime } from "../lib/runtime.js";
import { createFileResolver } from "../lib/credential-resolver.js";
const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
const stateDir =
  process.env.DSH_MAIL_GUARDIAN_HOME ?? path.join(dshHome, "mail-guardian");
const mode = process.argv[2] ?? "report";
const config = JSON.parse(
  fs.readFileSync(path.join(stateDir, "config.standalone.json"), "utf8"),
);
const settings = resolveSettings(config);
const state = new MailState({ statePath: path.join(stateDir, "state.json") });
const index = new MailIndex({ path: path.join(stateDir, "index.json") });
// Report path deliberately does not import the SDK or open the credential file.
let resolveSecret = async () => null;
if (mode !== "report") {
  const require = createRequire(
    process.env.DSH_MAIL_GUARDIAN_SDK_ANCHOR ??
      path.join(dshHome, "profiles", "desktop", "package.json"),
  );
  let parser;
  try {
    parser = (
      await import(
        pathToFileURL(require.resolve("@deepseek-ai/dsh-credentials-local"))
          .href
      )
    ).parseCredentialsDocument;
  } catch {
    for (const a of settings.accounts) state.setCheckpoint(a.id, {lastError:"后台缺少官方凭据组件，同步未完成",status:"error"});
    console.error(
      "后台缺少 DSH 官方凭据组件，请重新运行安装器指定 SDK 位置。不会反复弹授权框。",
    );
    process.exit(2);
  }
  resolveSecret = createFileResolver({
    filename:
      process.env.DSH_MAIL_GUARDIAN_CREDENTIALS ??
      path.join(dshHome, "private-credentials", ".credentials.yaml"),
    parseCredentialsDocument: parser,
  });
}
const pipeline = createPipeline({
  settings,
  state,
  index,
  ImapClient,
  parseMessage,
  resolveSecret,
});
const runtime = createSyncRuntime({
  pipeline,
  stateDir,
  intervalMs: settings.sync.pollIntervalMs,
  onError: () => console.error("后台收信失败，已有报告保留；请查看同步状态"),
});
if (mode === "report") {
  console.log(pipeline.report().text);
} else if (mode === "sync") {
  const r = await runtime.once();
  console.log(r.text);
  if (r.status !== "ready") process.exitCode = 1;
} else if (mode === "worker") {
  if (!runtime.start()) process.exit(0);
  // Keep only this quiet worker alive. No DSH, shell approvals, or model call.
  const hold = setInterval(() => {}, 3600000);
  const stop = async () => {
    clearInterval(hold);
    await runtime.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  console.error("usage: mail-guardian report | sync | worker");
  process.exitCode = 2;
}
