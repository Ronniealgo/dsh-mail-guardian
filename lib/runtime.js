import fs from "node:fs";
import path from "node:path";
import {
  atomicJson,
  atomicText,
  acquireLock,
  readJson,
} from "./persistence.js";
export function createSyncRuntime({
  pipeline,
  stateDir,
  intervalMs,
  onError = () => {},
}) {
  let stopped = false,
    inFlight = null,
    timer = null,
    releaseWorker = null,
    next = 0;
  const requestFile = path.join(stateDir, "sync-request.json");
  const controller = new AbortController();
  async function tick() {
    if (stopped || inFlight) return;
    const request = readJson(requestFile, null).value;
    const due = Date.now() >= next || request?.requestedAt > next - intervalMs;
    if (!due) return;
    next = Date.now() + intervalMs;
    inFlight = (async () => {
      try {
        await pipeline.fetch({ signal: controller.signal });
        const report = await pipeline.summarize({ range: "today" });
        atomicJson(path.join(stateDir, "report.json"), report);
        atomicText(path.join(stateDir, "brief-latest.txt"), report.text + "\n");
      } catch (e) {
        onError("后台收信未完成，保留上次报告");
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  }
  return {
    start() {
      releaseWorker = acquireLock(path.join(stateDir, "worker.lock"));
      if (!releaseWorker) return false;
      stopped = false;
      timer = setInterval(tick, 15000);
      timer.unref?.();
      setTimeout(tick, 0).unref?.();
      return true;
    },
    request() {
      atomicJson(requestFile, { requestedAt: Date.now() });
      if (releaseWorker) setTimeout(tick, 0).unref?.();
      return {
        status: "queued",
        text: "后台刷新已安排。已有报告立即可看，不必等收信。",
      };
    },
    async once() {
      await pipeline.fetch({ signal: controller.signal });
      const r = await pipeline.summarize({ range: "today" });
      atomicJson(path.join(stateDir, "report.json"), r);
      atomicText(path.join(stateDir, "brief-latest.txt"), r.text + "\n");
      return r;
    },
    async stop() {
      stopped = true;
      controller.abort();
      clearInterval(timer);
      if (inFlight) await inFlight;
      releaseWorker?.();
      releaseWorker = null;
    },
  };
}
