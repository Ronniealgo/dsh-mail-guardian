import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
export function readJson(file, fallback) {
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")), error: null };
  } catch (e) {
    if (e.code === "ENOENT") return { value: fallback, error: null };
    return { value: fallback, error: "本机邮件缓存损坏或无法读取" };
  }
}
export function atomicJson(file, value) {
  atomicText(file, JSON.stringify(value, null, 2) + "\n");
}
export function atomicText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + "." + process.pid + "." + randomUUID() + ".tmp";
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== null && fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch {}
  }
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
export function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify(owner));
      fs.closeSync(fd);
      return () => {
        const current = readJson(file, null).value;
        if (current?.token === owner.token) {
          try {
            fs.unlinkSync(file);
          } catch {}
        }
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const current = readJson(file, null).value;
      if (current && alive(current.pid)) return null;
      if (!current && Date.now() - fs.statSync(file).mtimeMs < 60000)
        return null;
      try {
        fs.unlinkSync(file);
      } catch {
        return null;
      }
    }
  }
  return null;
}
export function lockActive(file) {
  const owner = readJson(file, null).value;
  return !!(owner && alive(owner.pid));
}
