# DSH Tunnel Artifact Preview 配套插件

在使用 DSH Tunnel 控制远程 DSH 时，安全地在当前设备浏览器中预览远程会话生成的 HTML、HTM、SVG、PNG、JPG、JPEG、WebP、GIF 和 AVIF 文件。

这是 DSH Tunnel 主项目内的配套组件，源码位于 `plugins/artifact-preview`；它不作为独立产品使用。

插件复用 DSH 原有的“产物”文件行和收尾回复中的产物文件提及，不增加按钮或面板。仅由 DSH Tunnel 标记的远程页面会启用预览接管；直接使用本机 DSH 时，界面和打开行为保持不变。

[English](README.en.md)

## 用户安装

优先使用 DSH Tunnel 客户端“设置 → 远程产物预览插件”中的安装入口。需要安装到另一台设备时，从 DSH Tunnel Release 下载插件包，在运行目标 DSH 的设备上执行：

```bash
dsh plugin --profile web add ./dsh-plugin-artifact-preview-0.1.5.tgz
```

重启 DSH 后生效。卸载时运行：

```bash
dsh plugin --profile web remove dsh-plugin-artifact-preview
```

## 范围

- 支持单文件 HTML、HTM、SVG，文本文件上限 5 MiB。
- 支持 PNG、JPG、JPEG、WebP、GIF、AVIF，图片文件上限 20 MiB，并校验文件头。
- 预览仅允许读取会话创建目录内的普通文件。
- 预览页禁止外部网络、表单、弹窗、顶层跳转和下载。
- 未支持的文件继续使用 DSH 原有打开方式。
- 只接管 DSH 已识别的产物文件提及；普通网址、任意文本和其他文件链接保持原有行为。

## 开发

需要 Node.js 22.19.0 或更高版本，以及 DeepSeek Harness `0.1.0-rc.7`。在本目录中运行：

```bash
npm run build
npm run check
npm test
```
