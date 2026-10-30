# magpie-agent-codex-cli

仓库：https://gitee.com/mengdj/magpie-agent-codexcli

把 **Codex CLI**（`codex` 命令行的 TUI 与 `codex exec`）接到 magpie 的 Agent 页：
在 magpie 里给它挑一个模型，然后在终端里用 `codex-magpie` 启动，就走 magpie 的网关。

> 完整的使用说明见 [docs/使用说明.md](docs/使用说明.md)：安装步骤、命令一览、两种接入模式、换模型的同步规则、常见问题与平台差异。

## 为什么不直接写 config.toml

magpie 的 Agent 插件只会往 **JSON / YAML / ENV** 里写模型和连接信息。
Codex CLI 的配置是 **TOML**（`~/.codex/config.toml`），magpie 会直接拒绝：

```
agent.format "toml": json, yaml or env
```

所以这个插件自己承担了转换和备份恢复：

```
magpie ──(能写)──> ~/.codex/magpie-codex-cli.env   CODEX_MODEL / CODEX_BASE_URL / CODEX_API_KEY
                          │
                          │  插件转换
                          ▼
                   codex-magpie  ──> codex -c model=... -c model_providers.magpie.base_url=...
```

magpie 负责 env 文件（选模型、换账号、关掉时整行恢复），插件负责把它变成 Codex 认识的形式。

## 安装

```bash
magpie plugin add ./magpie-agent-codexcli
# 或
magpie plugin add git+https://gitee.com/mengdj/magpie-agent-codexcli.git
```

装好后 magpie 的 **Agent** 页会多一行 `Codex CLI`，命令行也可以：

这一行带自己的图标：深色终端底、白色 `>` 提示符和绿色光标，和 Codex CLI
控制台的气质一致。图标是内联的 SVG（`icon.svg` 经 data URI 写进 `package.json`
的 `magpie.icon`），不联网、不依赖外链，magpie 自己把它存成
`~/.config/magpie/icons/<hash>.svg`。

```bash
magpie ls                 # 会列出 Codex CLI 这一行
magpie codex-cli auto/hy3 # 给它挑一个模型
```

### 把 `codex-magpie` 放到 PATH

`magpie plugin add` **不会**执行 npm 安装、也不会创建全局命令（它只把插件登记给
magpie 自己用）。要一个能在终端里直接敲的命令，自己执行一次：

```bash
node bin/setup.mjs              # 写入 npm 的全局 bin 目录（几行 shim）
node bin/setup.mjs --uninstall  # 只删它写的那几个文件
node bin/setup.mjs --print-dir  # 只看会写到哪里
```

这**不会**把包装进全局 npm 依赖列表（`npm ls -g` 里看不到它），只是放了
`codex-magpie` / `codex-magpie.cmd` / `codex-magpie.ps1` 三个很小的转发文件，
内容指向本目录的 `bin/codex-magpie.mjs`；挪了目录就重新跑一次。

也完全可以不装，直接调用：

```powershell
node D:\magpie\magpie-agent-codexcli\bin\codex-magpie.mjs
```

## 用法

```bash
codex-magpie                # 打开 Codex 交互控制台，走 magpie 的模型
codex-magpie exec "..."     # 非交互，参数原样传给 codex
codex-magpie status         # magpie 选了什么、Codex 现在读的是什么
codex-magpie install        # 写进 config.toml（带日志，可还原）
codex-magpie restore        # 按日志把 config.toml 还原
codex-magpie which          # 实际会调用哪个 codex 可执行文件
```

### 其余参数原样透传

只认上面 5 个子命令，**其它参数一律拼在 magpie 的 `-c` 后面交给 codex**，
所以 codex 自己的任何开关都能用：

```bash
codex-magpie --yolo                 # 同 codex --yolo，但走 magpie 的模型
codex-magpie resume --last
codex-magpie exec --skip-git-repo-check "把测试跑一遍"
codex-magpie -m auto/deepseek-v4.1-flash   # 临时换 magpie 里的另一个模型
```

带空格和引号的参数会完整保留（Windows 下 `.cmd` 走 shell 时会重新加引号）。
你自己传的 `-c` / `-m` 排在后面，会覆盖本插件注入的值，方便临时试验。

### 两边换模型都不会被覆盖

有两个地方能换模型：magpie 的 Agent 页，和 Codex 自己的 `/model`。插件按
**谁最后改就用谁**来协调（比较 `magpie-codex-cli.env` 与 `config.toml` 的修改时间），
并且把结果同步到另一边，所以不会出现“换了一个模型、下次启动又变回去”：

```
在 magpie 里选 → env 更新 → 启动时把 config.toml 的 model 一并对齐
在 TUI 里 /model 选并回车 → config.toml 更新 → 启动时写回 env，Agents 页跟着变
```

同步发生时启动器会打一行提示，`codex-magpie status` 也会显示
`in effect <模型> (<谁生效>)`。注意 TUI 里 `/model` 选完按 `s` 只影响当前会话，
按回车才写进默认值。

### 默认：不改任何文件

`codex-magpie` 用 Codex 的 `-c key=value` 覆盖参数启动，**完全不碰** `config.toml`，
所以你想切回原样只要直接敲 `codex` 就行。这是推荐用法。

```bash
codex-magpie                      # 走 magpie
codex                             # 还是你原来的配置
```

### 可选：写进 config.toml

有些场景（IDE 插件、`codex app-server`、别的工具替你启动 codex）读不到你的命令行参数，
这时用 `install`：

```bash
codex-magpie install
codex-magpie status
codex-magpie restore
```

`install` 只改它自己负责的 6 个键，其余内容、注释、顺序全部保留：

| 键 | 值 |
|---|---|
| `model` | magpie 里选的模型 |
| `model_provider` | `magpie` |
| `model_providers.magpie.name` | `magpie` |
| `model_providers.magpie.base_url` | 网关 `/v1` 地址 |
| `model_providers.magpie.wire_api` | `responses` |
| `model_providers.magpie.experimental_bearer_token` | 这个 Agent 自己的网关密钥 |

写之前它把每个键的**原始值（含行尾注释）**记进
`~/.codex/magpie-codex-cli.journal.json`；`restore` 按这份日志逐行放回，
原来不存在的键会被删掉，所以能还原到**逐字节一致**。

## 环境变量

| 变量 | 用途 |
|---|---|
| `CODEX_HOME` | Codex 配置目录，默认 `~/.codex`（与 Codex CLI 一致） |
| `CODEX_MAGPIE_CODEX` | 指定要调用的 codex 可执行文件，默认从 PATH 找 |

## 约定

- 不修改 Codex 的二进制，也不代理它的请求：`codex-magpie` 只是把 magpie 的模型与网关
  以 Codex 自己的方式传进去，请求由 Codex 直接发往 magpie 网关。
- `install` 只认它写过的键；你后来手动改的其他设置不会被 `restore` 影响。
- 每请求都会计入该 Agent 自己的 key，magpie 的 Usage 里能按 `Codex CLI` 区分。
- 想换模型：在 magpie 的 Agent 页换，或者 `magpie codex-cli <provider>/<model>`；
  `codex-magpie` 每次启动都重新读，不用重装。

## 支持平台

Windows、Linux、macOS 都支持，且**不需要**额外依赖（只要有 Node 18+ 和能用的 `codex`）。

| 项目 | Windows | Linux / macOS |
|---|---|---|
| 找 `codex` | `codex.exe` → `codex.cmd` → `codex.bat` → `codex` | `codex`（PATH 里第一个，排除本插件的 shim） |
| 启动方式 | `.cmd`/`.bat` 走 shell，其余直接 spawn | 直接 spawn，不加 shell |
| Ctrl-C | 转发 `SIGINT` 给子进程 | 同左，并按 `128+N` 返回（130/143/129） |
| `setup.mjs` 落到哪 | `npm prefix -g`（通常 `%APPDATA%\npm`） | `npm prefix -g` + `/bin`，找不到则 `~/.local/bin` |
| 生成的 shim | `codex-magpie` + `.cmd` + `.ps1` | 单个 `codex-magpie`（`0755`） |

`~` 的展开来自 `os.homedir()`，`CODEX_HOME` 与 Codex CLI 本身一致，所以
`~/.codex` 在三个平台都指向正确位置。TOML 读写自己做，只按 `\n`/`\r\n` 保留原文件风格。

已知差异：Windows 上 `process.kill(pid, 'SIGTERM')` 会映射成 `TerminateProcess`，
所以退出码是 `1` 而不是 `143`；这只是回显差异，进程不会卡住。

---

## 赞助商

[阿里云 OSS 优惠活动](https://dashi.aliyun.com/activity/oss?userCode=8ub608qu) —— 新老同享：续费同价，OSS 低至 118.99 元/年。

