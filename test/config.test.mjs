// dsh-mail-guardian — test/config.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { resolveSettings, isQuietHours } from "../lib/config.js";

const account = {
  id: "qq",
  host: "imap.qq.com",
  username: "me@qq.com",
  credentialRef: "MAIL_QQ",
};

test("默认值：时间/风格/文件夹/保留天数", () => {
  const s = resolveSettings({});
  assert.equal(s.briefTime, "08:00");
  assert.equal(s.style, "caring");
  assert.equal(s.trashRetentionDays, 30);
  assert.equal(s.folders.trash, "垃圾箱");
  assert.equal(s.modelJudge.enabled, false);
  assert.equal(s.accounts.length, 0);
});

test("未知配置键一律报错（拼错要炸在加载时）", () => {
  assert.throws(
    () => resolveSettings({ briefTim: "08:00" }),
    /unknown config key/,
  );
  assert.throws(
    () => resolveSettings({ accounts: [{ ...account, passwrod: "x" }] }),
    /unknown config key/,
  );
});

test("凭据只允许写引用名，且必须是合法标识符", () => {
  assert.throws(
    () =>
      resolveSettings({ accounts: [{ ...account, credentialRef: "MAIL QQ" }] }),
    /credentialRef/,
  );
  assert.throws(
    () => resolveSettings({ accounts: [{ ...account, credentialRef: "" }] }),
    /credentialRef/,
  );
  const s = resolveSettings({ accounts: [account] });
  assert.equal(s.accounts[0].credentialRef, "MAIL_QQ");
  assert.equal(s.accounts[0].secure, true);
  assert.equal(s.accounts[0].mailbox, "INBOX");
});

test("时间/风格/保留天数校验", () => {
  assert.throws(() => resolveSettings({ briefTime: "25:00" }), /briefTime/);
  assert.throws(() => resolveSettings({ style: "cute" }), /style/);
  assert.throws(
    () => resolveSettings({ trashRetentionDays: 0 }),
    /trashRetentionDays/,
  );
});

test("免打扰时段跨夜正确", () => {
  const s = resolveSettings({ quietHours: { start: "22:00", end: "08:00" } });
  assert.equal(isQuietHours(s, "23:30"), true);
  assert.equal(isQuietHours(s, "07:00"), true);
  assert.equal(isQuietHours(s, "12:00"), false);
  const day = resolveSettings({ quietHours: { start: "12:00", end: "14:00" } });
  assert.equal(isQuietHours(day, "13:00"), true);
  assert.equal(isQuietHours(day, "15:00"), false);
});
