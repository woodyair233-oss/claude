# Gatehouse 使用说明

Gatehouse 是一个「给 AI 用的 SSH 客户端 + 安全网关」。你像平常一样用它连服务器；
Claude（或任何 MCP 客户端）只能通过 Gatehouse 提供的工具访问你的机器，而且每一步都受你的策略和批准控制。

---

## 1. 安装与首次启动

1. 到正式版下载页 <https://github.com/woodyair233-oss/claude/releases/tag/gatehouse-v1.0.0> 下载对应架构的安装包：
   - Apple 芯片（M 系列）：`Gatehouse-1.0.0-arm64.dmg`
   - Intel Mac：`Gatehouse-1.0.0-x64.dmg`
   - 可选：一并下载 `SHA256SUMS.txt`，执行 `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` 校验完整性。
2. 打开 DMG，把 Gatehouse 拖进「应用程序」。
3. 首次打开（应用为临时签名 / ad-hoc signature，macOS 会先拦一下）：
   - 先双击 Gatehouse，提示无法打开时点「完成」（不要点「移到废纸篓」）；
   - 再到「系统设置 → 隐私与安全性」，在下方「安全性」里点 Gatehouse 旁边的 **仍要打开**，输入登录密码或用 Touch ID 确认（按钮只在被拦下后约一小时内出现）；
   - macOS 14 及更早也可以在「应用程序」里 **按住 Control 点按 → 打开**（macOS 15 起这个方法不再有效）；
   - 仍然打不开（例如提示“已损坏”）：在“终端”执行 `xattr -dr com.apple.quarantine /Applications/Gatehouse.app`。
   - 说明：每次版本更新签名都会变，系统钥匙串会把它当成新应用，这是正常现象。

> 需要 macOS 12 或更高版本。

### 保险库（vault）
首次启动会初始化加密保险库，用来保存你的 SSH 密码、密钥口令等机密：
- 有系统钥匙串时，默认用钥匙串自动解锁，无需额外操作。
- 没有钥匙串（或你主动开启）时，用**主密码**加密（AES-256-GCM）。主密码无法找回，请记牢。
- 若某次钥匙串读取失败（例如更新后签名变化），解锁界面会提供 **重试钥匙串 / 重置保险库** 两个选项；
  重置会新建一个空保险库（主机保留，已保存的密码/密钥丢失）。

---

## 2. 添加主机（Host）

左侧 **Hosts → New Host**，或从 `~/.ssh/config` 一键导入（**Import**，支持 `Include`、`ProxyJump`）。

关键字段：
- **Hostname / Username**：真实地址与用户名，只保存在本机，**Claude 永远看不到**。
- **Alias（别名）**：Claude 唯一能看到的名字。默认是中性的 `host-1`、`host-2`……
  如果别名里出现了主机名或 IP，表单会给出提醒——建议改成中性名称（如 `lab-gpu`），避免泄露。
- **认证方式（Auth）**：
  - SSH 密钥（Ed25519 / RSA / ECDSA，可现场生成或导入）
  - 密码（可选「记住」，登录成功后才会存入保险库）
  - SSH Agent（含 1Password agent）
  - 键盘交互 / 两步验证（keyboard-interactive / 2FA）
- **跳板机（Jump host / ProxyJump）**、**保活（keep-alive）**、**启动命令**、**旧算法开关**（连老设备时开启）。

主机密钥（host key）：首次连接核对并固定指纹；日后指纹变化会强制警告，并沿用你 `~/.ssh/known_hosts` 里已有的信任。

---

## 3. 日常使用（和普通 SSH 客户端一样）

- **终端 Terminals**：多标签、WebGL 渲染、终端内搜索、断线重连、7 款配色；多行粘贴会先确认，避免误粘贴命令。
- **文件 Files**：SFTP 浏览、拖放上传、批量下载、在线编辑文本（⌘S 保存）、改权限、传输队列与进度。
- **隧道 Tunnels**：本地转发 `-L`、远程转发 `-R`、SOCKS5 代理 `-D`，可开机自动启动并显示流量统计。
- **密钥 Keys**：生成/导入密钥、查看指纹、一键部署公钥到主机。
- **代码片段 Snippets**：常用命令存成片段；可勾选「允许 AI 使用」，Claude 即可通过 `run_snippet` 调用。
- **命令面板**：⌘K 快速跳转主机、视图和操作。

---

## 4. 把 Claude 连上来（MCP 配置）

进入 **AI Gateway → Overview（或 Setup）**：

1. 选择客户端卡片，点 **Add to Claude Code** 或 **Add to Claude Desktop**，会自动写好配置。
   - 手动配置时，MCP 服务器指向应用内的桥接程序：
     `Gatehouse.app/Contents/Resources/bin/gatehouse-mcp`
2. 点 **Self-test（自检）**，确认桥接握手正常、能列出工具。
3. 在 Claude Code 里运行 `/mcp`，应能看到 `gatehouse` 及其工具。

> 小贴士：Claude Code 自己也会问是否允许使用工具。若觉得两层询问繁琐，可在 Claude Code 中允许
> `mcp__gatehouse__*`，把把关完全交给 Gatehouse。

### Claude 能用的 8 个工具
| 工具 | 作用 |
| --- | --- |
| `list_hosts` | 列出对 AI 可见的主机（只有别名、描述、权限等级） |
| `get_host_info` | 主机概况：系统、内核、负载、CPU、内存、磁盘（只读） |
| `run_command` | 在主机上执行命令（受策略与批准控制，输出会脱敏/截断） |
| `read_file` | 通过 SFTP 读取文本文件（脱敏；凭据文件需批准） |
| `list_directory` | 列目录 |
| `write_file` | 写入/追加文件（通常需批准，你会先看到内容） |
| `list_snippets` / `run_snippet` | 列出并运行你标记为可用的片段 |

桥接程序（gatehouse-mcp）本身**不保存任何机密**，只通过一个 `0600` 权限的私有 Unix 套接字 + 令牌与主应用通信。

---

## 5. AI 权限与批准（核心）

### 每台主机四种权限等级（AI access）
在主机的 **AI Access** 标签页设置（配色由低到高：灰 → 绿 → 蓝 → 琥珀）：

| 等级 | 含义 |
| --- | --- |
| **Off（关闭）** | 对 AI 完全隐藏，Claude 看不到也用不了这台主机。 |
| **Read-only（只读）** | 只有被识别为只读的命令会自动执行，其它一律拒绝。 |
| **Ask（询问）** | 只读命令自动执行；其它任何操作都等你批准。 |
| **Trusted（信任）** | 命令自动执行，但**高风险命令仍然需要你批准**。 |

新建/导入的主机默认是 **Ask**。

### 批准弹窗里你能做什么
当需要你决定时会弹出审批框，显示：发起的客户端、目标主机别名、**将要运行的命令**、风险原因、以及 AI 给的解释（仅供参考，请以命令本身为准）。

- **Allow once**：仅本次允许（也可用 ⌘↩；弹窗出现约 0.7 秒后才生效，防误触）。
- **Allow N min**：在该主机上临时自动批准「非高风险」操作 N 分钟。
- **Always allow**：把这条**精确命令**加入该主机的允许列表（含通配符会被转义，不会扩大范围）。
- **Edit before running**：先改命令再运行。
- **Deny / Deny with note**：拒绝，可留言告诉 Claude 原因。
- 高风险命令：顶部变红标「High risk」；在没有 Touch ID 的机器上，需要**手动输入主机别名**才能允许。

### 命令分类器（command classifier）
- 只读识别是**白名单**：只有「已知的只读程序 + 只读参数、且无写入/替换/后台任务」才算只读。
- 高风险检测是**黑名单**：覆盖 `rm -rf`、关机重启、改防火墙、可能锁死 SSH 的操作、删库、`git push --force`、`curl | sh`、写磁盘设备等三十多类。
- 两者都**不替代人工批准**，只是帮你把关的第一道防线。

---

## 6. 远端兼容性（不限品牌 / 架构 / 系统）

只要对方运行 SSH 服务即可连接：
- **系统**：Linux、macOS、Windows(OpenSSH)、BSD。
- **架构**：x86_64、ARM 等。
- **硬件生态**：AMD（含 Ryzen AI Max 395 / ROCm / XDNA NPU）、Intel（oneAPI）、NVIDIA 等皆可。
- 连接老旧设备时，可在主机设置里开启「旧算法（legacy algorithms）」。

**加速器工具是厂商中立的**：查询/监控类命令自动放行（只读），改硬件配置的才需批准。
- NVIDIA：`nvidia-smi`（`-pl`/`-lgc` 等设置项会要批准）、`nvidia-settings -a`、`nvtop`
- AMD：`rocm-smi`、`amd-smi`、`rocminfo`、`xrt-smi`、`radeontop`（`--setfan`/`--gpureset` 等要批准）
- Intel：`xpu-smi` / `xpumcli`（`config`/`updatefw` 要批准）、`intel_gpu_top`、`clinfo`

---

## 7. 安全功能一览

- **脱敏（redaction）**：发给 AI 的输出会把 IP / IPv6 / MAC、已保存的主机名与用户名、各类 API 令牌与私钥替换成占位符；可加自定义正则（例如病历号）。注意脱敏是隐私措施，不是安全边界——真正的边界是权限与人工批准。
- **占位符回填**：Claude 把占位符（如 `[host:lab-gpu]`、`[ip-1]`）复制回命令时，Gatehouse 会自动还原成真实值再执行。
- **审计日志（audit log）**：SHA-256 哈希链 JSONL，并用保险库派生的 HMAC 密钥加固；可一键校验完整性、导出 CSV / JSON。
- **紧急停用（kill switch）**：一键暂停所有 AI 访问。
- **速率与每日上限**：超过每分钟/每日次数后自动拒绝（被拒请求不计入每日额度）。
- **锁屏**：Touch ID 或主密码解锁；可设置空闲自动锁定。锁定时，底层界面会被禁用，一切改动性操作在主进程被拒绝。
- **隐私模式**：共享屏幕时模糊地址等敏感信息。
- **加固**：渲染进程沙箱、上下文隔离、CSP、IPC 来源校验、Electron fuses（禁用 RunAsNode 等）、asar 完整性校验。

---

## 8. 策略与脱敏设置（Policies）

**AI Gateway → Policies** 里可以：
- 调整速率限制、每日额度、临时授权时长、审批超时、审计保留天数。
- 维护**敏感路径**（默认已含 `/etc/shadow`、`~/.ssh/id_*`、`.env`、各类云凭据等）——命中时即使在 Ask/Trusted 下也会要你批准。
- 增加自定义**危险/拦截**正则，以及自定义**脱敏**规则。

---

## 9. 语言切换

**Settings → Language**：跟随系统 / English / 简体中文。界面、原生菜单、对话框全部跟随切换。

---

## 10. 常见问题（FAQ）

- **打不开 / 提示无法验证开发者**：「系统设置 → 隐私与安全性 → 仍要打开」；macOS 14 及更早也可以按住 Control 点按 → 打开（见第 1 节）。
- **每次更新都要重新允许钥匙串**：临时签名所致，点「始终允许」即可；也可改用主密码解锁。
- **Claude 看不到某台主机**：该主机的 AI Access 可能是 Off，或 Gateway 被紧急停用了。
- **只读命令却要我批准**：可能命中了敏感路径，或命令里有写入/管道/替换等，分类器会保守对待。
- **想让某条命令以后不再问**：在批准框点「Always allow」，或在主机允许列表里添加。
- **连不上老服务器**：在主机设置里开启「旧算法」。

---

## 附：架构速览

```
Claude ──MCP(stdio)──▶ gatehouse-mcp（桥接，无机密）
                         │ 私有 Unix 套接字 + 令牌（0600）
                         ▼
                      Gatehouse（策略 / 批准 / 脱敏 / 审计 / 保险库）
                         │ SSH
                         ▼
                      你的服务器（任意品牌 / 架构 / 系统）
```
