# Changelog

本文件记录 dsh-mail-guardian 的版本变化。**尚未发布到 npm**：v0.2.1 是仓库内当前版本（`package.json` 中 `version: 0.2.1`），安装方式见 [README.md](README.md#安装)。

## 0.2.1 — 缓存优先重构（当前）

这一版把「收信」从用户可见的操作彻底挪到了后台：前台一律读本机缓存、立即返回，收信只由独立 worker 在后台做。

### Added

- **缓存优先的即时报告**：`mail_report` / `mail_summarize` 只读本机 `index.json` / `state.json`，不联网、不读凭据，立即返回。
- **独立后台 worker**：`bin/mail-guardian.mjs worker` 进程，开机（用户登录）静默启动、每 5 分钟轮询，不经过 DSH 宿主、不触发 shell 授权、不调用模型。
- **两把锁**：`worker.lock` 保证同时只有一个 worker（重复启动会安静退出），`sync.lock` 保证同一时间只有一次同步在跑。
- **有界收信预算**：单账号 25 秒预算、单命令 8 秒超时、回看 3 天、每次最多 40 封、正文预览上限 64 KB——超时即中止该账号并保留已有报告。
- **`/mail_check` 改为状态视图**：显示各账号同步状态与上次成功同步时间，**不现场收信**。
- **同步状态可信化**：报告里每个账号带 `ready / syncing / partial / stale / uninitialized / error / cache-error`，只有在全部 `ready` 且确实无来信时才说「已核实：今天没有新邮件」。
- **`automation` 两组独立开关**：`moveRules` 与 `moveHeuristics`，默认均为 `false`，需要用户一次明确开启才允许任何自动移动。
- **Host 路由** `GET|HEAD /api/dsh-mail-guardian/report`（走 DSH connection 认证，返回 JSON，`Cache-Control: no-store`），供侧栏每天首次打开时展示报告。
- **`sync` 配置块**：`lookbackDays` / `maxMessages` / `maxPreviewBytes` / `commandTimeoutMs` / `accountBudgetMs` / `pollIntervalMs`，全部带范围校验。
- **账号级 `folders` 覆盖**：QQ 的 `Junk`、Gmail 的 `[Gmail]/垃圾邮件` 等可按账号单独指定。
- **standalone 运行方式**：`report` / `sync` / `worker` 三个子命令；`report` 路径刻意不 import SDK、不打开凭据文件。

### Changed

- **`mail_fetch` 语义变更（破坏性）**：不再现场收信，只登记后台刷新请求并立即返回；后台已在运行时合并请求。查今日来信请改用 `mail_report`。
- **工具面从 9 个改为 12 个**：新增只读的 `mail_report` / `mail_rules_list` / `mail_pending_list`；`mail_summarize` 也变为缓存读取。只读工具 2 秒超时并允许并发，改信工具 35 秒超时。
- **`/mail_brief` 不再生成、只显示**：直接输出本机最新报告，不联网、不等授权。
- **收信只读化**：用 `BODY.PEEK[]` 取预览，不置 `\\Seen`、不改已读；不再为大附件下载完整内容，仅取有界预览。
- **收信时间以服务器为准**：采用 `INTERNALDATE`，不再采信发件人自称的 `Date`。
- **配置校验收紧**：未知键、类型不符、越界数值一律在加载时抛 `TypeError`；`credentialRef` 必须是纯标识符。
- **开机启动改为用户级静默**：登录启动项 + `.cmd` 包装，不需要提权、不弹交互式凭据框。

### Fixed

- **不再漏掉今日新邮件**：每轮都对账最近到达的 UID，不单独信任旧版本遗留的高水位游标。
- **预览不完整不再误判垃圾**：正文超过预览上限且非硬规则命中时降级为「待定」，理由写明「正文预览不完整，先问你」。
- **缓存读取失败不再表现为空邮箱**：`state` / `index` 载入错误会显式呈现为 `cache-error`。
- **UIDVALIDITY 变化时重置游标**：邮箱重建后清空该账号的断点与待定项，避免拿旧 UID 操作新邮件。
- **移动失败保留原文**：单封移动失败只记 `move-failed`，不连带影响该轮其余邮件，也不重试到误删。

### Security

- 即使官方凭据组件缺失，也绝不覆盖已损坏的缓存文件或重置用户规则。

- **拒绝不安全的移动路径**：服务器既不支持 `MOVE` 也无 `UIDPLUS`、且非 Gmail（无 `X-GM-EXT-1`）时，直接抛错拒绝移动，**不用全局 `EXPUNGE` 兜底**。
- **Gmail 走原生标签**：无 `UIDPLUS` 的 Gmail 用 `X-GM-LABELS` 增删标签实现可逆归档，无需 EXPUNGE。
- **服务器明确拒绝不掩盖**：`MOVE` 返回 `NO`/`BYE`（如目标文件夹不存在、策略拦截）时如实上报，只有 `BAD`（未知命令）才走回退。
- **缺少官方凭据组件时拒绝启动**：standalone worker 找不到 `@deepseek-ai/dsh-credentials-local` 时以退出码 2 明确失败，不反复弹授权框。

### Verified（本机验收记录）

- **134 项离线测试通过**（13 个测试文件，`npm test`，0 失败）：IMAP 协议层、MIME、配置、判断、状态、报告、工具面、宿主 SDK 契约、端到端流水线。
- **`npm test` 与 `node --test --experimental-test-isolation=none test/*.test.mjs` 两条路径均为 134 通过 / 0 失败**。
- **本机缓存报告约 92–115 ms**（读本地缓存，不联网）；**双邮箱只读刷新一轮约 14.6 s**。
  > 这只是**一次**本机实测，取决于邮箱服务商、网络与邮件数量，**不是性能承诺，也不保证在所有网络环境下成立**。
- **`config.example.yml` 通过真实 `resolveSettings` 校验**；安全默认值实测为 `automation={moveRules:false,moveHeuristics:false}`、`modelJudge={enabled:false}`。

### Notes

- **未发布到 npm**；使用 GitHub Release 安装。市场同步/审核状态以各站实际目录为准。
- **模型仲裁当前没有内置实现**：`lib` 只保留可注入的适配点（`createPipeline({ modelJudge })`），默认关闭；不存在可用的第三方自动上传通道。
- **`trashRetentionDays` 只是记录你的意图**：值被解析与校验（1–365），但垃圾箱实际保留期由服务商决定，插件不控制、不承诺。
- Release 提供源码、安装包、SHA256 与逐文件 MANIFEST 校验清单；不包含本机账户、缓存或凭据。

## 0.1.0 — 初版（未发布）

- IMAP 多账号增量收信（UID 断点续传；断网说「网络没通」，口令不落日志）。
- 三层垃圾识别（硬规则 / 启发式打分 / 可选模型仲裁）。
- 分层处置：垃圾 → 垃圾箱、广告 → 低优先、灰区 → 待定提问、重要 → 提醒。
- 每日简报与自检命令，语气三档可配。
- 规则学习（keep / drop / block）与检索问答。
- 9 个 agent 工具，零运行时依赖，离线测试通过。

> 0.1.0 从未发布：仓库内版本已直接推进到 0.2.1。
