**Gatehouse 1.2.0：Windows 主机现在也能让 Claude 顺畅执行命令了。**

## 新功能：Windows 的 PowerShell 与 WSL 支持

过去 Gatehouse 把每条 AI 命令都包在 bash 语法里执行。连到 Windows 服务器时，OpenSSH 默认把命令交给 PowerShell，而旧版 Windows PowerShell 5.1 不认识 `&&`，命令会直接报错，中文系统上还会出现 GBK 乱码。

1.2.0 起，Gatehouse 会**自动识别 Windows 主机**（依据服务器的 SSH 问候信息），并改用 PowerShell 执行 AI 命令。**远端无需安装任何东西**——不用 bash、不用 WSL、不用 Git Bash，一台只开了 OpenSSH 的 Windows 就能用。

- **两种语法可切换**：
  - **PowerShell**：原生执行，生成的命令同时兼容 Windows PowerShell 5.1（系统自带）和 PowerShell 7（pwsh）。
  - **WSL（bash）**：允许后，Claude 也可以把命令送进 WSL 用 bash 语法执行，可指定发行版。
  - Claude 每条命令都可以指定用哪种（在你允许的范围内）；`list_hosts` 会告诉它每台主机的系统和可用 shell。
- **各用各的安全规则**：PowerShell 命令由**专门的 PowerShell 分类器**判断风险，能识别 `Remove-Item -Recurse -Force`、`Set-ExecutionPolicy Bypass`、关闭 Defender、写 `HKLM` 注册表、`Format-Volume`、`Clear-Disk`、`bcdedit`、`.NET`/`reg`/`net user` 等高风险操作，以及 `iwr … | iex` 这类下载执行；WSL 命令沿用原来的 bash 分类器。只读识别同样是白名单，拿不准就要你批准。
- **编码不再乱**：输出统一按 UTF-8 读取；个别仍按本地代码页（如简体中文 936/GBK、繁体 950、日文 932 等）输出的程序，会按该代码页正确解码。
- **批准弹窗**会标明这条命令将在 **PowerShell** 还是 **WSL** 中运行；审计日志也会记录用了哪种 shell。

**在哪里设置**：主机编辑器 →「高级」→「远端系统」。可选「自动检测 / Linux·macOS / Windows」；选 Windows 后可设置默认 shell、PowerShell 版本（5.1 / 7）、是否允许 WSL 及其发行版。自动识别不准时也能手动指定。

## 改进与修复

- **命令测试器**：主机「AI 权限」页的「试一条命令」现在会按主机的系统选择语法；Windows 主机可在 PowerShell 和 WSL 之间切换，实时看到判定结果。
- **主机概况**（`get_host_info`）：Windows 主机改用 CIM 查询系统版本、CPU、内存和磁盘，不再套用 Linux 的命令。
- **超时与取消**：Windows 上无法用信号停止进程，改用 `taskkill /T /F` 结束整棵进程树；WSL 命令会先在 WSL 内部结束，再收尾。
- **长命令**：超长命令会通过标准输入传入，不受命令行长度限制。

## 下载

| 你的 Mac | 下载 |
| --- | --- |
| Apple 芯片（M1 及以后） | `Gatehouse-1.2.0-arm64.dmg` |
| Intel 芯片 | `Gatehouse-1.2.0-x64.dmg` |

需要 macOS 12 或更新版本。远端服务器**无需安装任何东西**，只要运行 SSH 服务即可（Windows 用自带的 OpenSSH 即可）。

**从 1.1.0 升级**：把新版拖进“应用程序”替换旧版即可，主机、密钥和设置都会保留。新版第一次打开时，macOS 可能会再拦一次（步骤见下）；钥匙串可能询问授权，输入 Mac 登录密码后点“始终允许”。

**首次打开**：应用只有临时签名（ad-hoc），未经 Apple 公证，macOS 会先拦一下：

1. 双击 Gatehouse，出现无法打开的提示时点“完成”（不要点“移到废纸篓”）。
2. 打开“系统设置 → 隐私与安全性”，在下方“安全性”里点 Gatehouse 旁边的“仍要打开”，用登录密码或 Touch ID 确认。这个按钮只在被拦下后约一小时内出现。

- macOS 14 及更早版本也可以在“应用程序”中按住 Control 点按 Gatehouse，选择“打开”。
- 仍然打不开（例如提示“已损坏”）：在“终端”执行 `xattr -dr com.apple.quarantine /Applications/Gatehouse.app`。

**校验完整性（可选）**：把 `SHA256SUMS.txt` 和 DMG 放在同一目录，执行
`shasum -a 256 -c SHA256SUMS.txt --ignore-missing`，显示 `OK` 即文件完整。

## 质量

- 单元测试 374 项、真实 OpenSSH 集成测试 50 项（含 6 项专门覆盖 Windows 的 PowerShell/WSL 传输：编码、进程标记剥离、GBK 解码、退出码、标准输入传递、超时结束）、Electron 端到端测试全部通过；安装包在 macOS 上通过签名校验、加固检查和打包后冒烟测试。
- PowerShell 支持经过两轮独立审查（分类器安全性；传输与接线正确性），发现的问题均已修复并补充了测试。

## 文档

- [README（功能与安全设计）](https://github.com/woodyair233-oss/claude/blob/gatehouse-v1.2.0/Gatehouse/README.md)
- [使用说明（含“Windows 主机：PowerShell 与 WSL”）](https://github.com/woodyair233-oss/claude/blob/gatehouse-v1.2.0/Gatehouse/docs/USAGE.md)
