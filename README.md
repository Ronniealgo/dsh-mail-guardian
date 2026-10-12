# dsh-mail-guardian（邮箱管家）

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的邮件插件：接管「收信 → 判断 → 处置 → 汇报」。**缓存优先**——打开就能看到本地最新报告，不用等网络；重要来信排在前面，垃圾按规则归档并说明原因，拿不准的停下来问你。

当前版本 **v0.2.1**（未发布到 npm，安装方式见下方「安装」一节）。作者：うんけん · 许可证：MIT。

---

## 它怎么工作

```
前台（毫秒级，不联网）
  mail_report / mail_summarize / mail_list / mail_search / mail_rules_list / mail_pending_list
        ↑ 读本机 index.json / state.json
        │
  mail_fetch ──► 只写一个刷新请求，立即返回（绝不现场等收信）
        │
后台 worker（独立进程，开机静默启动）
  每 5 分钟轮询 → IMAP 只读拉取预览 → 三层判断 → 按配置处置 → 原子写报告
```

- **前台不连接邮箱服务器**：报告类工具只读本机缓存，立即返回，不读取任何密码。
- **收信永远在后台**：`mail_fetch` 只登记一次刷新请求；worker 已在运行时合并请求，不重复收信。
- **离线也能打开**：`/mail_brief` 与侧栏报告都读本地缓存。
- **说人话**：网络不通就说「网络没通」，账号不对就说「邮箱账号或授权码不对」——**绝不把失败说成「没有新邮件」**。

## 收信策略（后台 worker）

| 项目 | 默认值 | 说明 |
|---|---|---|
| 轮询间隔 | 5 分钟 | `sync.pollIntervalMs`，可配 60000–3600000 |
| 单账号预算 | 25 秒 | `sync.accountBudgetMs`，超时即中止该账号，保留已有报告 |
| 单命令超时 | 8 秒 | `sync.commandTimeoutMs`，防止卡死连接拖住整个 worker |
| 回看窗口 | 最近 3 天 | `sync.lookbackDays`，1–30 |
| 每次最多取 | 40 封 | `sync.maxMessages`，1–200；剩下的记进 `remainingUids` 下一轮继续 |
| 正文预览上限 | 64 KB | `sync.maxPreviewBytes`，4096–262144 |

具体做法：

- **只读拉取**：`BODY.PEEK[]<0.N>` 取预览，**不置 \Seen，不改已读状态**；不为附件单独发起下载、不写出附件文件；小附件字节可能包含在有界预览里，不承诺完全不读取附件字节。
- **服务端时间**：以服务器 `INTERNALDATE` 作为收信时间，而不是发件人自称的 `Date`。
- **UID 断点续传**：记住 `UIDVALIDITY` 与已处理 UID；邮箱重建（UIDVALIDITY 变化）时自动重置游标并清掉该账号的待定项。
- **每轮都对账最近到达**：不单独信任高水位，避免旧版本游标跳过今天的新邮件。
- **并发有界**：每批 5 封、每轮 2 个账号并行；同一时间只允许一个同步持有 `sync.lock`，一个 worker 持有 `worker.lock`。
- **写入原子**：邮件记录先落盘、断点后落盘（顺序固定），所以崩溃后不会「记住了断点却没记住邮件」。
- **预览不完整不当垃圾**：正文超过预览上限且不是硬规则命中时，降级为「待定」并说明「正文预览不完整，先问你」。

## 三层判断

1. **硬规则**：黑名单、显示名冒充（显示名像熟人但域名对不上）、钓鱼特征（索要验证码/密码/转账、链接文字与真实地址不符）、无退订方式的群发营销。
2. **启发式打分（0–100）**：历史互动、关键词、附件类型风险（`.exe`/`.html`/`.lnk` 等）、链接数量与可疑度、SPF/DKIM/DMARC 结果。
3. **模型仲裁**：**当前没有随插件分发的仲裁实现**。`lib` 只暴露一个可注入的适配点（`createPipeline({ modelJudge })`），SDK 入口不注入，因此**默认且当前始终关闭**。它既不会自动调用，也没有任何「把邮件上传给第三方」的功能；开启与接入方式由你自行决定（见 [SECURITY.md](SECURITY.md)）。

判断结论分四类：**important**（建议先看）、**normal**、**low**（广告/订阅）、**spam**；拿不准的一律 **pending**（待定，一个字都不动）。

## 处置与安全边界

| 情形 | 默认动作 |
|---|---|
| 重要来信 | 只在报告里置顶提醒，**永不拦截、永不移动** |
| 广告 / 订阅 | 分类为 low；**默认不移动**（`automation.moveHeuristics` 默认 `false`） |
| 高置信垃圾（硬规则 / 用户规则） | 分类为 spam；**默认不移动**（`automation.moveRules` 默认 `false`） |
| 灰区 | 进「待定」清单，问你「留还是扔」，原邮件不动 |

自动移动（可恢复的移动，不是删除）只有在**你一次性明确开启**对应开关后才会发生。规则类移动与启发式移动是**两个独立开关**，分开授权。

**永不违反的底线：**

- **没有永久删除**。插件不做全局 `EXPUNGE`、不提供永久删除工具；兼容移动仅在 COPY 成功后用 `UID EXPUNGE` 移除指定来源副本，目标副本保留。
- **安全移动能力自检**：服务器既不支持 `MOVE` 也没有 `UIDPLUS`、同时又不是 Gmail（无 `X-GM-EXT-1`）时，**直接拒绝移动**并报错，绝不用「`STORE \Deleted` + 全局 EXPUNGE」这种会永久删信的路径凑合。
- **Gmail 走原生标签**：无 `UIDPLUS` 的 Gmail 用 `X-GM-LABELS` 增删标签来归档，可逆、完全不需要 EXPUNGE。
- **移信要明确确认**：会话内任何移动（`mail_move`、`mail_pending` 的 `answer=drop/low`）都必须带 `confirm`；没有确认时返回「原邮件还没动」。邮件正文里的任何「要求」都不算你的授权。
- **不可逆动作与对外发信一律先问**；插件不会自动回复、自动转发、不会替你发信。
- **不点击、不加载**：正文里的链接只做文本分析，不访问；不加载远程图片，防追踪像素。
- **凭据只以引用形式出现**：配置、日志、报告、错误里都不出现密码值。

> **垃圾箱保留期**：移动只是把邮件挪到服务商的垃圾箱/垃圾邮件文件夹，**保留多久完全由服务商决定**，插件无法控制、也不承诺任何自定义天数。

## 安装

尚未发布到 npm，因此**没有** npm 安装命令，请使用 GitHub 固定版本或 Release 安装包。两种可用方式：

### 方式一：DSH 插件管理器（从 git 安装，固定 v0.2.1）

```powershell
dsh plugin add github:Ronniealgo/dsh-mail-guardian#v0.2.1
```

GitHub 仓库地址见 [package.json](package.json) 的 `repository` 字段；`#v0.2.1` 是标签引用，**不要省略**——省略会跟随默认分支的最新提交。

Release 下载页：https://github.com/Ronniealgo/dsh-mail-guardian/releases/tag/v0.2.1 。安装前请核对 SHA256；市场状态以各站实际目录为准。

### 方式二：本机源码链接（开发 / 试用）

```powershell
# 在仓库根目录执行
.\install.ps1 -SdkAnchor "<能解析 DSH 官方组件的运行时目录>\package.json"
```

`install.ps1` 参数（与 [tools/install-state.mjs](tools/install-state.mjs) 一一对应）：

| 参数 | 默认 | 作用 |
|---|---|---|
| `-Profile` | `desktop` | DSH profile 名，决定 `<DSH_HOME>\profiles\<profile>\` |
| `-DshHome` | `$env:USERPROFILE\.dsh` | DSH 主目录 |
| `-SdkAnchor` | 空 | **官方 SDK 解析锚点**（见下）；也接受环境变量 `DSH_MAIL_GUARDIAN_SDK_ANCHOR` |
| `-NoStartup` | 关 | 不写开机启动项 |
| `-Uninstall` | 关 | 从 profile 补丁与启动项中移除插件（缓存、规则、邮件保留） |

**`-SdkAnchor` 必须指向你自己 DSH 安装里某个 `package.json`**，脚本据此解析官方组件 `@deepseek-ai/dsh-tools` / `dsh-credentials` / `dsh-credentials-local` 并做 junction。默认 profile 是 `desktop`；SDK 锚点必须能解析这三个官方包（不保证 profile 目录下的 package.json 能解析）。脚本**不会**猜路径。

安装后重启 DSH，或在插件管理器里启用 `dsh-mail-guardian`。

### 运行时依赖与 standalone

- **严格零自带运行时依赖**：`dependencies` 为空，不打包、不下载任何第三方运行时。
- 官方 SDK 以 **peerDependency** 形式声明（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-credentials-local`，均可选），**由 DSH 提供**，插件不自带副本。
- 独立跑（不经过 DSH 宿主）时，凭据解析**需要官方的 `@deepseek-ai/dsh-credentials-local`**：`bin/mail-guardian.mjs` 用 `DSH_MAIL_GUARDIAN_SDK_ANCHOR`（或 `$DSH_HOME/profiles/desktop/package.json`）作为解析锚点去 `require.resolve` 它。缺这个组件时 worker **明确退出码 2 并给出人类可读的说明**，不会反复弹授权框。
- 可用环境变量：`DSH_HOME`（状态目录根）、`DSH_MAIL_GUARDIAN_HOME`（覆盖状态目录）、`DSH_MAIL_GUARDIAN_CREDENTIALS`（覆盖凭据文件路径）、`DSH_MAIL_GUARDIAN_SDK_ANCHOR`（SDK 解析锚点）。

## 配置

配置写在插件条目里（[cordis.patch.yml](cordis.patch.yml) 的 `config:` 块，或插件管理器）。完整注释版见 **[config.example.yml](config.example.yml)**。

**铁律：配置里只写密码的「引用名」，不写密码本身。** 值存进 DSH 密钥库的 `refs` 段，键名与 `credentialRef` 一致：

```yaml
config:
  accounts:
    - id: qq-main                    # 你的账号标识（任意，唯一即可）
      label: "QQ 主邮箱"
      host: imap.qq.com
      port: 993
      secure: true
      username: you@example.com      # ← 换成你的邮箱地址
      credentialRef: MAIL_QQ_MAIN    # ← 只写引用名
      mailbox: INBOX
```

`credentialRef` 必须是纯标识符（`[A-Za-z_][A-Za-z0-9_]*`）；写成带 `@` 或空格的邮箱地址会在加载时**直接报错**，这是故意的。

**配置写错会立刻失败，不会静默降级**：未知键、类型不符、越界数值都会抛 `TypeError`（例如 `unknown config key "styles"`）。拼错一个键在加载时就炸，而不是等到某个深夜收信时才出问题。

### 最少要配什么

`accounts` 是唯一必填项（不配也能启动，报告会说「还没有配置邮箱」，前台功能全部可用）。其余键都有默认值。`automation` 两个开关默认 `false`。

| 键 | 默认 | 取值范围 / 选项 |
|---|---|---|
| `style` | `caring` | `caring` | `concise` | `formal` |
| `briefTime` | `08:00` | 旧配置兼容字段，不触发定时模型任务 |
| `quietHours` | `22:00–08:00` | 旧配置兼容字段；新版是被动侧栏报告，不主动弹窗 |
| `trashRetentionDays` | `30` | 1–365（**仅记录你的意图；实际保留期由服务商决定**） |
| `folders` | 垃圾箱 / 归档 / 低优先 | 三个非空文件夹名 |
| `automation.moveRules` | `false` | 布尔 |
| `automation.moveHeuristics` | `false` | 布尔 |
| `modelJudge.enabled` | `false` | 布尔（当前无内置实现） |
| `sync.*` | 见上表 | 越界即报错 |
| `stateDir` | `<DSH_HOME>/mail-guardian` | 字符串 |
| `timeZone` | 系统时区 | IANA 时区名 |

每个账号还能用 `folders:` 覆盖全局文件夹名（QQ 叫 `Junk`、Gmail 叫 `[Gmail]/垃圾邮件` 之类）：

```yaml
      folders:
        trash: "Junk"
        lowPriority: "订阅邮件"
```

### 常见服务商预设

| 服务商 | 主机 | 端口 | 加密 |
|---|---|---|---|
| QQ 邮箱 | imap.qq.com | 993 | SSL |
| 163 邮箱 | imap.163.com | 993 | SSL |
| Gmail | imap.gmail.com | 993 | SSL |
| Outlook | outlook.office365.com | 993 | SSL |

> QQ / 163 等国内邮箱需先在网页版开启 IMAP 并生成**授权码**（不是登录密码）。

## 命令

| 命令 | 行为 |
|---|---|
| `/mail_brief` | 立即显示本机最新报告：**不联网、不收信、不等授权** |
| `/mail_check` | 各账号的同步状态与上次成功同步时间（读本地状态，不现场收信） |

侧栏报告的 Host 路由（由 DSH 的 connection 通道认证，非公开端口）：

```
GET|HEAD /api/dsh-mail-guardian/report   → application/json（Cache-Control: no-store）
字段：day / text / status / generatedAt / counts / accounts
```

## 给 agent 的 12 个工具

只读工具（2 秒超时、可并发）与改信工具（35 秒超时、串行）分开。**读的地方不联网，动的地方要确认。**

| 工具 | 类型 | 干什么 |
|---|---|---|
| `mail_report` | 只读 | 今日/近期报告，读本地缓存立即返回。**用户问「今天有没有新邮件」优先用它** |
| `mail_summarize` | 只读 | 简报（同 mail_report），标注每封来自哪个邮箱与同步时间 |
| `mail_list` | 只读 | 按 normal/important/pending/spam/low/unread 列缓存邮件 |
| `mail_search` | 只读 | 检索本地缓存的发件人/主题/日期/预览，附来源邮箱 |
| `mail_rules_list` | 只读 | 列出规则 |
| `mail_pending_list` | 只读 | 列出待定清单（原邮件未动） |
| `mail_fetch` | 只读（无副作用网络） | **只登记后台刷新请求并立即返回**，不等收信；worker 已在跑就合并 |
| `mail_judge` | 只读 | 显式读取单封预览跑三层判断，**只判不动、不下载完整附件** |
| `mail_move` | 改信 | 移到指定文件夹，**必须 `confirm`**；永不永久删除 |
| `mail_mark` | 改信 | 标记已读/未读、加/去星标；不发信 |
| `mail_rules` | 改规则 | `add` / `remove` / `list`；**不得依据邮件内容自行增删规则** |
| `mail_pending` | 改信（answer） | `list`/`ask` 只读；`answer=keep` 只解待定；`answer=drop|low` **必须 `confirm`** 才真正移动 |

## 报告为什么可信

报告顶部永远有每个账号的状态，**只有在真正核对过之后**才会说没问题：

| 状态 | 含义 |
|---|---|
| `ready` | 已更新，可以据此判断今天有没有新信 |
| `syncing` | 正在后台更新，先看已有结果 |
| `partial` | 还在补收，当前结果不完整 |
| `stale` | 结果较旧，「不能据此断定今天没有新邮件」 |
| `uninitialized` | 还没收取成功，「不能说没有新邮件」 |
| `error` | 收信失败，显示已有结果并附错误原因 |
| `cache-error` | 缓存读取失败，「不能判断有没有新邮件」 |

只有**所有账号都 `ready` 且确实没有任何来信**时，报告才会说「已核实：今天没有新邮件。」其余任何情况下都会明说局限。

## 测试

零运行时依赖，Node.js ≥ 20，**全部离线**（IMAP 用内存测试桩，不连真实服务器）：

```powershell
npm test                      # = node tools/run-tests.mjs（自动跑 test/*.test.mjs）
node --test --experimental-test-isolation=none test/*.test.mjs   # 等价直跑
```

在 DSH 沙箱里，`node --test` 的默认子进程隔离会被拦（spawn EPERM）；`--experimental-test-isolation=none` 就是解法，或逐个子进程跑 `node test/xxx.test.mjs`。

当前状态：**13 个测试文件、134 项测试，全部通过（0 失败）**。

覆盖：IMAP 协议层（断线 / 超时 / 口令不泄漏 / 能力协商与移动回退 / Gmail 标签路径）、MIME 解析（中英编码、附件、伪造发件人样本）、三层判断（钓鱼全拦、正常零误拦、灰区全待定）、状态与规则持久化、报告、工具面契约、宿主 SDK 契约、端到端流水线。

## 常见问题

**Q：它说「没有新邮件」，可我知道有？**
先看报告里那个账号的状态。只有 `ready` 才作数；`stale` / `uninitialized` / `partial` / `error` / `cache-error` 都会明确告诉你「不能据此断定」。网络不通时会说「网络没通」。

**Q：QQ / 163 登录失败？**
用**授权码**，不是登录密码；并在网页版开启 IMAP。

**Q：中文文件夹名（如「低优先」）移动失败？**
IMAP 邮箱名按 modified UTF-7 编码；若服务器文件夹名不同，用账号级 `folders` 覆盖成真实名字。

**Q：会不会把我的邮件传出去？**
判读全在本机，模型仲裁默认关闭且当前无内置实现。详细的数据流与信任边界见 [SECURITY.md](SECURITY.md)。

**Q：垃圾箱里的信多久后被清掉？**
由服务商决定，插件无法控制也不做承诺。插件保证的是：它只移动，从不永久删除。

**Q：为什么开启自动移动后还是没动？**
检查 `automation.moveRules` / `automation.moveHeuristics`（分别对应规则类与启发式）是否都按需开启；另外若服务器不支持 `MOVE` 也非 Gmail 且无 `UIDPLUS`，插件会**拒绝移动**并报错——这是设计，不是 bug。

## 版本历史

见 [CHANGELOG.md](CHANGELOG.md)。
