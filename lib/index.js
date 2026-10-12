import os from "node:os";
import path from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { resolveSettings } from "./config.js";
import { MailState } from "./state.js";
import { MailIndex } from "./mail-index.js";
import { ImapClient } from "./imap-client.js";
import { parseMessage } from "./mime.js";
import { createPipeline } from "./pipeline.js";
import { createSyncRuntime } from "./runtime.js";
import { buildToolDefinitions } from "./tools.js";
import { atomicJson } from "./persistence.js";
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config);
  const stateDir =
    settings.stateDir ??
    path.join(
      process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"),
      "mail-guardian",
    );
  const state = new MailState({ statePath: path.join(stateDir, "state.json") });
  const index = new MailIndex({ path: path.join(stateDir, "index.json") });
  const pipeline = createPipeline({
    settings,
    state,
    index,
    ImapClient,
    parseMessage,
    resolveSecret: async (ref) => {
      const r = await ctx.credentials.resolve(credentialRef(ref));
      return r?.value ?? null;
    },
  });
  const runtime = createSyncRuntime({
    pipeline,
    stateDir,
    intervalMs: settings.sync.pollIntervalMs,
    onError: (m) => ctx.logger?.warn?.(m),
  });
  ctx.effect(() => {
    // Keep the logon worker aligned with the actual plugin configuration.
    // This file contains only config/reference names, never resolved secrets.
    atomicJson(path.join(stateDir,"config.standalone.json"), {...config,stateDir});
    if (settings.accounts.length) runtime.start();
    return () => runtime.stop();
  });
  ctx.inject(["tools"], (s) =>
    s.effect(() => {
      const disposers = buildToolDefinitions({
        defineTool,
        pipeline,
        state,
        syncRequest: () => runtime.request(),
      }).map((t) => s.tools.register(t));
      return () => disposers.forEach((f) => f());
    }),
  );
  ctx.inject(["commands"], (s) =>
    s.effect(() => {
      const off = [
        s.commands.register({
          name: "mail_brief",
          description: "立即显示最新邮件报告，不联网、不等授权",
          handler: async () => ({
            kind: "success",
            text: pipeline.report().text,
          }),
        }),
        s.commands.register({
          name: "mail_check",
          description: "查看本机双邮箱同步状态（不现场收信）",
          handler: async () => ({
            kind: "success",
            text: pipeline
              .report()
              .accounts.map(
                (a) =>
                  a.label +
                  "：" +
                  a.status +
                  "；" +
                  (a.lastSyncedAt ?? "尚未成功同步"),
              )
              .join("\n"),
          }),
        }),
      ];
      return () => off.forEach((f) => f());
    }),
  );
  // Register under connection admission, not a direct exact webServer route.
  ctx.inject(["connection"], (s) =>
    s.effect(() =>
      s.connection.fetch.register({
        path: "/api/dsh-mail-guardian/report",
        methods: ["GET", "HEAD"],
        requestBody: "buffered",
        fetch: async (req) => {
          const r = pipeline.report();
          return new Response(
            req.method === "HEAD"
              ? null
              : JSON.stringify({
                  day: r.day,
                  text: r.text,
                  status: r.status,
                  generatedAt: r.generatedAt,
                  counts: r.counts,
                  accounts: r.accounts,
                }),
            {
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-store",
              },
            },
          );
        },
      }),
    ),
  );
}
