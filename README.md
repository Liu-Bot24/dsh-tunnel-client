<div align="center">

# DSH Tunnel

[简体中文](README.md) | [English](README.en.md)

![Stars](https://img.shields.io/github/stars/Liu-Bot24/dsh-tunnel-client?style=flat&label=Stars) ![Forks](https://img.shields.io/github/forks/Liu-Bot24/dsh-tunnel-client?style=flat&label=Forks) ![Views 14d](https://github-stats.liu-qi.cn/api/badge/Liu-Bot24/dsh-tunnel-client/views14d.svg?v=4) ![Clones 14d](https://github-stats.liu-qi.cn/api/badge/Liu-Bot24/dsh-tunnel-client/clones14d.svg?v=4) ![Version](https://img.shields.io/badge/version-0.1.0-68ded5) ![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-173746?logo=apple&logoColor=white) ![Windows](https://img.shields.io/badge/Windows-x64-1554d1?logo=windows11&logoColor=white) ![License](https://img.shields.io/badge/license-MIT-b54b3b)

用于启动本机 DeepSeek Harness（DSH），并通过系统 OpenSSH 安全连接远程 DSH 的桌面工具。

</div>

![DSH Tunnel](docs/images/hero.jpg)

## 界面预览

<table>
  <tr>
    <td align="center"><strong>主题选择</strong><br><img src="docs/images/themes/theme-selector.jpg" alt="主题选择界面" width="100%"></td>
    <td align="center"><strong>深海鲸歌</strong><br><img src="docs/images/themes/whale-song.jpg" alt="深海鲸歌主题" width="100%"></td>
  </tr>
  <tr>
    <td align="center"><strong>航海图纸</strong><br><img src="docs/images/themes/nautical-chart.jpg" alt="航海图纸主题" width="100%"></td>
    <td align="center"><strong>夜视终端</strong><br><img src="docs/images/themes/phosphor.jpg" alt="夜视终端主题" width="100%"></td>
  </tr>
  <tr>
    <td align="center"><strong>包豪斯信号</strong><br><img src="docs/images/themes/bauhaus-signal.jpg" alt="包豪斯信号主题" width="100%"></td>
    <td align="center"><strong>柔雾器物</strong><br><img src="docs/images/themes/soft-porcelain.jpg" alt="柔雾器物主题" width="100%"></td>
  </tr>
</table>

DSH Tunnel 可以启动本机 DSH，也可以为远程 DSH 建立本地 SSH 隧道，并在默认浏览器中打开对应的 WebUI。

## 功能

- 启动、停止并打开本机 DSH
- 保存和管理多个远程 DSH 主机
- 通过 SSH 本地端口转发安全访问远程 WebUI
- 同时连接多个 DSH，并为每个连接分配独立的本地端口
- 在连接可用后自动打开默认浏览器
- 通过 macOS 菜单栏或 Windows 系统托盘快速操作
- 提供深海鲸歌、航海图纸、夜视终端、包豪斯信号和柔雾器物五套主题
- 使用系统 SSH 配置、密钥和 SSH Agent，不保存密码或私钥

## 支持平台

- macOS Apple Silicon
- Windows x64

## 安装

### macOS

1. 下载 `DSH.Tunnel-<版本>-macos-arm64.dmg`。
2. 打开 DMG，将 `DSH Tunnel.app` 拖入 Applications。
3. 从“应用程序”打开 DSH Tunnel。

当前 macOS 安装包采用 ad-hoc 签名，尚未经过 Apple 公证。首次启动时，macOS 可能要求在“系统设置”→“隐私与安全性”中确认打开。

安装包旁提供同名的 `.sha256` 文件，可用于校验下载完整性：

```bash
shasum -a 256 -c DSH.Tunnel-<版本>-macos-arm64.dmg.sha256
```

### Windows

1. 下载 `DSH-Tunnel-Setup-<版本>-x64.exe`。
2. 运行安装程序，并按向导完成安装。
3. 从开始菜单或桌面快捷方式打开 DSH Tunnel。

当前 Windows 安装包尚未使用受信任的代码签名证书，系统可能显示“未知发布者”提示。

## 使用要求

- 系统中存在可用的 OpenSSH 客户端
- 如需由客户端启动本机 DSH，`dsh` 命令必须已安装并可运行
- 远程主机已启用 SSH，并允许使用密钥、SSH Agent 或 SSH config 非交互登录
- 远程 DSH 可从该主机自身的 `127.0.0.1:<端口>` 访问

首次连接一台新主机前，请先通过可信方式核对并写入 SSH host key。DSH Tunnel 不会关闭或绕过主机密钥校验。

## 启动本机 DSH

“本机 DSH”固定显示在主机列表第一项。

1. 选择“本机 DSH”。
2. 点击“启动并打开”。
3. DSH Tunnel 启动 DSH，并在服务就绪后打开 WebUI。

默认端口为 `3080`。可以通过“编辑”修改显示名称和启动端口；新的端口会在下次启动时生效。客户端只会停止由自身启动的 DSH，不会终止由其他程序启动的实例。

## 连接远程 DSH

点击“添加主机”，填写：

- **显示名称**：仅用于主机列表显示
- **SSH 地址**：IP 地址、域名或 SSH config 中的 Host 别名
- **SSH 用户**：可留空，留空时使用 SSH config
- **SSH 端口**：可留空，留空时使用 SSH config 或默认端口 `22`
- **DSH 端口**：远程主机上的 DSH 监听端口，默认为 `3080`
- **本地端口**：本机浏览器访问该 DSH 时使用的端口

保存后点击“连接并打开”。例如，本地端口为 `13080` 时，浏览器会打开：

```text
http://127.0.0.1:13080/
```

不同主机必须使用不同的本地端口。只要端口不冲突，本机 DSH 和多个远程 DSH 可以同时运行。

## 菜单栏与系统托盘

macOS 关闭主窗口后，DSH Tunnel 会继续在菜单栏运行。可以从菜单栏恢复窗口、打开 WebUI、连接或断开远程主机，以及退出应用。

Windows 最小化后可继续使用系统托盘快捷菜单；关闭主窗口会退出应用。退出时，客户端会停止由自身启动的 DSH 和 SSH 隧道。如果进程未能安全停止，客户端会保留状态并提示重试。

## 配置与隐私

DSH Tunnel 保存显示名称、SSH 地址、SSH 用户和端口等连接设置，不保存：

- SSH 密码
- SSH 私钥或私钥内容
- SSH Agent 凭据
- DSH 账户凭据

配置文件保存在系统应用数据目录：

- macOS：`~/Library/Application Support/DSH Tunnel/`
- Windows：`%APPDATA%\DSH Tunnel\`

主机配置损坏时，客户端会先备份原文件，再恢复默认配置；如果无法安全备份或写入，则以只读模式运行，不覆盖原文件。

## 从源码运行

需要 Node.js 22 或更新版本。

```bash
npm install
npm start
```

运行测试和语法检查：

```bash
npm test
npm run check
```

## 构建安装包

请在对应操作系统上构建：

```bash
npm run package:mac
npm run package:win
```

macOS 构建产物：

```text
dist/mac/DSH.Tunnel-<版本>-macos-arm64.dmg
dist/mac/DSH.Tunnel-<版本>-macos-arm64.dmg.sha256
```

Windows x64 构建产物：

```text
dist/DSH-Tunnel-Setup-<版本>-x64.exe
dist/win-unpacked/DSH Tunnel.exe
```

正式公开分发前，应分别完成 Apple Developer ID 签名与公证，以及 Windows 代码签名。

## 许可证

DSH Tunnel 使用 MIT License。

## 友情链接

- [LINUX DO](https://linux.do/) — 新的理想型社区
