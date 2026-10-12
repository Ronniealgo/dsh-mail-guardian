import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { atomicText, atomicJson } from "../lib/persistence.js";
const args = process.argv.slice(2);
const value = (key, def) => {
  const i = args.indexOf(key);
  return i < 0 ? def : args[i + 1];
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = path.resolve(value("--home", path.join(os.homedir(), ".dsh")));
const profile = value("--profile", "desktop");
if (!/^[a-z0-9_-]+$/i.test(profile)) throw new Error("invalid profile");
const sdk = value("--sdk", process.env.DSH_MAIL_GUARDIAN_SDK_ANCHOR ?? "");
const dir = path.join(home, "profiles", profile);
const patch = path.join(dir, "cordis.patch.yml");
const stateDir = path.join(home, "mail-guardian");
const link = path.join(dir, "node_modules", "dsh-mail-guardian");
const startup = value(
  "--startup",
  path.join(
    os.homedir(),
    "AppData",
    "Roaming",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  ),
);
const startupFile = path.join(startup, "dsh-mail-guardian-startup.vbs");
if (!fs.existsSync(patch)) throw new Error("DSH profile not found");
const before = fs.readFileSync(patch, "utf8").replace(/^\uFEFF/, "");
const lines = before.split(/\r?\n/);
let after = [];
for (let i = 0; i < lines.length; i++) {
  if (/^[-] insert:/.test(lines[i])) {
    let end = i + 1;
    while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end])))
      end++;
    const block = lines.slice(i, end);
    if (block.some((l) => /id:\s*mail-guardian(?:\s|$)/.test(l))) {
      i = end - 1;
      continue;
    }
  }
  after.push(lines[i]);
}
fs.copyFileSync(patch, patch + ".bak-mail-guardian-" + Date.now());
if (args.includes("--uninstall")) {
  atomicText(patch, after.join("\n").trimEnd() + "\n");
  if (
    fs.existsSync(startupFile) &&
    fs.readFileSync(startupFile, "utf8").includes("mail-guardian")
  )
    fs.unlinkSync(startupFile);
  if (
    fs.existsSync(link) &&
    fs.lstatSync(link).isSymbolicLink() &&
    fs.realpathSync(link).toLowerCase() === root.toLowerCase()
  )
    fs.unlinkSync(link);
  console.log("插件与启动项已移除，邮件、规则和本机缓存保留。");
  process.exit(0);
}
fs.mkdirSync(path.dirname(link), { recursive: true });
if (fs.existsSync(link)) {
  if (!fs.lstatSync(link).isSymbolicLink())
    throw new Error("existing package is not a junction; left untouched");
  if (fs.realpathSync(link).toLowerCase() !== root.toLowerCase()) {
    fs.unlinkSync(link);
    fs.symlinkSync(root, link, "junction");
  }
} else fs.symlinkSync(root, link, "junction");
fs.mkdirSync(stateDir, { recursive: true });
const configFile = path.join(stateDir, "config.standalone.json");
let config = fs.existsSync(configFile)
  ? JSON.parse(fs.readFileSync(configFile, "utf8"))
  : {
      accounts: [],
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
config.stateDir = stateDir;
atomicJson(configFile, config);
const block = [
  "- insert:",
  "    - id: mail-guardian",
  "      name: dsh-mail-guardian",
  "      config: " + JSON.stringify(config),
].join("\n");
const retained = after.join("\n").trimEnd();
atomicText(patch, (retained === "[]" ? "" : retained) + "\n" + block + "\n");
if (sdk) {
  const req = createRequire(path.resolve(sdk));
  for (const name of [
    "@deepseek-ai/dsh-tools",
    "@deepseek-ai/dsh-credentials",
    "@deepseek-ai/dsh-credentials-local",
  ]) {
    const moduleFile = req.resolve(name);
    let packageDir = path.dirname(moduleFile);
    while (!fs.existsSync(path.join(packageDir, "package.json")))
      packageDir = path.dirname(packageDir);
    const peer = path.join(root, "node_modules", ...name.split("/"));
    fs.mkdirSync(path.dirname(peer), { recursive: true });
    if (!fs.existsSync(peer)) fs.symlinkSync(packageDir, peer, "junction");
  }
}
if (!args.includes("--no-startup")) {
  fs.mkdirSync(startup, { recursive: true });
  const cmdFile = path.join(stateDir, "run-mail-guardian.cmd");
  const cmd =
    [
      "@echo off",
      'set "DSH_HOME=' + home + '"',
      sdk ? 'set "DSH_MAIL_GUARDIAN_SDK_ANCHOR=' + path.resolve(sdk) + '"' : "",
      '"' +
        process.execPath +
        '" "' +
        path.join(root, "bin", "mail-guardian.mjs") +
        '" worker >> "' +
        path.join(stateDir, "runner-console.log") +
        '" 2>&1',
    ]
      .filter(Boolean)
      .join("\r\n") + "\r\n";
  atomicText(cmdFile, cmd);
  const command = '"' + cmdFile + '"';
  const vbs =
    [
      "' Mail Guardian v2: user-logon, no elevation, no interactive credential prompt",
      'CreateObject("WScript.Shell").Run "' +
        command.replaceAll('"', '""') +
        '", 0, False',
    ].join("\r\n") + "\r\n";
  atomicText(startupFile, vbs);
}
console.log("已更新插件配置；下次登录静默收信，打开 DSH 直接看缓存报告。");
