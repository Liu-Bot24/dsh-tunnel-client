# DSH Tunnel Artifact Preview Companion Plugin

Safely preview HTML, HTM, SVG, PNG, JPG, JPEG, WebP, GIF, and AVIF files produced by a remote DSH session in the browser on the controlling device.

This is a companion component maintained inside the DSH Tunnel repository under `plugins/artifact-preview`; it is not a standalone product.

The plugin reuses DSH's existing Produced row and artifact mentions in the closing response, adding no button or panel. Preview interception is enabled only on remote pages marked by DSH Tunnel. Direct local DSH use keeps the stock UI and open behavior.

[简体中文](README.md)

## User Installation

Prefer the install action under **DSH Tunnel → Settings → Remote Artifact Preview Plugin**. To install it on another device, download the plugin package from the DSH Tunnel Release and run this command on the device that hosts the target DSH instance:

```bash
dsh plugin --profile web add ./dsh-plugin-artifact-preview-0.1.8.tgz
```

Restart DSH after installation. To uninstall:

```bash
dsh plugin --profile web remove dsh-plugin-artifact-preview
```

## Scope

- Supports self-contained HTML, HTM, and SVG files up to 5 MiB.
- Supports PNG, JPG, JPEG, WebP, GIF, and AVIF images up to 20 MiB with file-signature verification.
- Reads only regular files inside the session creation directory.
- Blocks external network access, forms, popups, top-level navigation, downloads, and object loading inside previews.
- Unsupported files keep DSH's stock open behavior.
- Only artifact mentions already recognized by DSH are intercepted; ordinary URLs, arbitrary text, and other file links keep their stock behavior.

## Development

Node.js 22.19.0 or newer is required. DeepSeek Harness `0.1.1-rc.2`, `0.1.2-rc.1`, and `0.1.5-rc.1` are currently verified; the minimum compatibility baseline remains `0.1.0-rc.7`. Run these commands in this directory:

```bash
npm run build
npm run check
npm test
```
