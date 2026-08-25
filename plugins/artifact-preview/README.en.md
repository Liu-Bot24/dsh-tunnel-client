# DSH Tunnel Artifact Preview Companion Plugin

Safely preview HTML, HTM, and SVG files produced by a remote DSH session in the browser on the controlling device.

This is a companion component maintained inside the DSH Tunnel repository under `plugins/artifact-preview`; it is not a standalone product.

The plugin reuses DSH's existing Produced row and adds no button or panel. Preview interception is enabled only on remote pages marked by DSH Tunnel. Direct local DSH use keeps the stock UI and open behavior.

[简体中文](README.md)

## User Installation

Prefer the install action under **DSH Tunnel → Settings → Remote Artifact Preview Plugin**. To install it on another device, download the plugin package from the DSH Tunnel Release and run this command on the device that hosts the target DSH instance:

```bash
dsh plugin --profile web add ./dsh-plugin-artifact-preview-0.1.4.tgz
```

Restart DSH after installation. To uninstall:

```bash
dsh plugin --profile web remove dsh-plugin-artifact-preview
```

## Scope

- Supports self-contained HTML, HTM, and SVG files up to 5 MiB.
- Reads only regular UTF-8 files inside the session creation directory.
- Blocks external network access, forms, popups, top-level navigation, downloads, and object loading inside previews.
- Images, text, and other non-preview files keep DSH's stock open behavior.
- Inline file links keep DSH's stock behavior; only the bottom Produced row is intercepted.

## Development

Node.js 22.19.0 or newer and DeepSeek Harness `0.1.0-rc.7` are required. Run these commands in this directory:

```bash
npm run build
npm run check
npm test
```
