**Gatehouse 是给 Claude 用的 SSH 客户端兼安全网关。** 你像平常一样用它管理和连接服务器；Claude 只能通过 Gatehouse 提供的 MCP 工具访问你的机器，每一步都受你的权限设置和人工批准控制，主机名、IP 和用户名不会发给 AI。

## 下载

| 你的 Mac | 下载 |
| --- | --- |
| Apple 芯片（M1 及以后） | `Gatehouse-1.0.0-arm64.dmg` |
| Intel 芯片 | `Gatehouse-1.0.0-x64.dmg` |

需要 macOS 12 或更新版本。远端服务器**无需安装任何东西**，只要运行 SSH 服务即可。

**首次打开**：应用只有临时签名（ad-hoc），未经 Apple 公证，macOS 会拦截。任选其一：

- 在“应用程序”中按住 Control 点按 Gatehouse → “打开”；
- “系统设置 → 隐私与安全性” → “仍要打开”；
- 终端执行 `xattr -dr com.apple.quarantine /Applications/Gatehouse.app`。

**校验完整性（可选）**：把 `SHA256SUMS.txt` 和 DMG 放在同一目录，执行
`shasum -a 256 -c SHA256SUMS.txt --ignore-missing`，显示 `OK` 即文件完整。

## 主要功能

- **SSH 客户端**：主机管理与 `~/.ssh/config` 导入（含 Include / ProxyJump）、多标签终端、SFTP 文件管理与在线编辑、本地/远程/SOCKS5 端口转发、密钥生成与部署、命令片段、跳板机链、主机密钥固定。
- **AI 安全网关**：每台主机四档权限（关闭 / 只读 / 询问 / 信任）；需要时弹出人工批准（可先改命令、拒绝并留言、临时授权）；高风险命令即使在“信任”模式下也要批准；一键紧急停用；速率与每日上限。
- **隐私**：Claude 只看到你起的别名；输出中的 IP、MAC、主机名、用户名、各类令牌和私钥会被替换为占位符。
- **审计**：哈希链 JSONL 审计日志（以保险库派生密钥做 HMAC），可一键校验、导出 CSV / JSON。
- **远端不限品牌**：Linux / macOS / Windows(OpenSSH) / BSD，x86_64 / ARM；AMD（含 Ryzen AI Max 395 / ROCm）、Intel（oneAPI）、NVIDIA 的 GPU/NPU 查询命令自动识别为只读，改硬件配置仍需批准。
- **中文 / 英文**双语界面（设置 → 语言）、深色模式、Touch ID 锁屏、加密备份。

## 质量

- 单元测试 243 项、真实 OpenSSH 集成测试 25 项、Electron 端到端测试 15 项全部通过；本安装包在 macOS 上通过了签名校验和打包后冒烟测试。
- 发布前完成三轮审查（安全、代码正确性、界面与无障碍），发现的问题均已修复。

## 已知限制

- 未经 Apple 公证（见上文“首次打开”）；每次更新后钥匙串可能再次询问授权，点“始终允许”即可。
- Windows 远端：终端、SFTP、端口转发均正常；让 Claude 自动执行命令需要对方有 POSIX shell（例如 WSL 或 Git Bash）。

## 文档

- [README（功能与安全设计）](https://github.com/woodyair233-oss/claude/blob/gatehouse-v1.0.0/Gatehouse/README.md)
- [使用说明](https://github.com/woodyair233-oss/claude/blob/gatehouse-v1.0.0/Gatehouse/docs/USAGE.md)
