# Installing and connecting Brisk

Brisk is an MCP server that drives a real Chrome browser over CDP. Three
ways to get it running: **Way 1** (your everyday Chrome), **Way 2**
(isolated Chrome you let Brisk launch), and **Cloud** (V0.1.1).

## Prerequisites

| | Minimum | Recommended |
|---|---|---|
| Node.js | 22.12 | 22.x or 24 LTS |
| OS | Win 10 · macOS 12 · Ubuntu 22.04 | Win 11 · macOS 14+ · Ubuntu 24.04 |
| Browser | Chrome / Chromium / Edge / Brave (any 2024+ build) | Chrome stable |
| Memory | 1 GB free | 4 GB free |

Brisk itself is ~12 MB on disk after install. No Chrome embedding, no
native compilation.

## Install

```bash
# Global, recommended
npm install --global @brisk/cli

# Or per-project
npm install --save-dev @brisk/cli
npx brisk doctor
```

Yarn / pnpm work too:

```bash
pnpm add --global @brisk/cli
yarn global add @brisk/cli
```

Verify:

```bash
brisk --version          # 0.1.0
brisk doctor             # checks Node, platform, Chrome, CDP, daemon
```

A green doctor report looks like:

```
Brisk environment check
========================
  node       ✓ 22.22.0
  platform   ✓ win32 (x64)
             named-pipe namespace: \\.\pipe\brisk-<instance>
             stdout TTY: no (encoding=utf8)
  chrome     ✓ chrome at C:\...\chrome.exe (known-location)
  cdp        ✓ ws://127.0.0.1:51748/devtools/browser/3c4...
  daemon     - not running (endpoint=\\.\pipe\brisk-default)
========================
All required checks passed.
```

`daemon - not running` is fine — `brisk serve` starts it on demand.

CDP endpoint precedence is:

1. CLI `--cdp-ws`
2. CLI `--cdp-url`
3. CLI `--cdp-port`
4. `BRISK_CDP_WS`
5. `BRISK_CDP_URL`
6. `DevToolsActivePort` files from running browser profiles
7. loopback probes on 9222 and 9223

## Way 1 — Your everyday Chrome (recommended for interactive use)

Use this when you want the agent to share your cookies / sessions /
extensions.

### 1. Enable remote debugging once

Navigate to **`chrome://inspect/#remote-debugging`** in your existing
Chrome and tick **"Allow remote debugging for this browser instance"**.
The setting is per-profile and sticky — set it once.

### 2. Click "Allow" on the popup

On Chrome 144+, the first time Brisk attaches you'll get an in-browser
"Allow remote debugging?" popup. Click Allow. It may reappear under
some conditions (browser restart, version change); just click again.

### 3. Connect

```bash
brisk doctor             # confirm CDP discoverable
brisk serve              # stdio MCP server (for Claude Desktop / Cursor stdio)
```

That's it. Brisk inherits your Chrome's profile, including every
logged-in session, cookies, extensions, and currently open real tabs.
If Chrome is already running but CDP is not enabled, `brisk doctor`
prints the Way 1 steps and tries to open
`chrome://inspect/#remote-debugging` for you.

### Way 1 limitations

- The "Allow remote debugging?" popup is interactive. Unattended
  automation (cron jobs / CI) needs Way 2.
- Some enterprise Chrome policies disable `chrome://inspect`.
- Closing all Chrome windows kills Brisk's connection.

## Way 2 — Isolated Chrome (recommended for unattended / dev work)

Use this when you want a hermetic Chrome instance Brisk owns, no popups
and a fresh profile each time.

### Auto-launch

```bash
brisk chrome --port 9222
# Chrome opens; profile is a fresh temp dir under your OS tmp.
# Leave this terminal open — Chrome stays alive until you Ctrl-C.
```

Brisk picks the first Chrome-family browser it finds (priority:
Chrome > Chromium > Edge > Brave). Override with `--brand` or
`--chrome-path`:

```bash
brisk chrome --port 9222 --brand brave
brisk chrome --port 9222 --chrome-path "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
```

### Persistent profile

If you want cookies to survive across runs:

```bash
mkdir -p ~/brisk-profile
brisk chrome --port 9222 --user-data-dir ~/brisk-profile
```

> **Don't** point `--user-data-dir` at Chrome's default profile path.
> Chrome 136+ silently disables `--remote-debugging-port` for the
> platform default. Brisk refuses with a clear error.

### Manual launch

If you need to launch Chrome with custom flags:

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir=$HOME/brisk-profile

# Linux
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=$HOME/brisk-profile

# Windows (cmd)
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir=C:\Users\you\brisk-profile
```

Then in a second terminal:

```bash
brisk doctor --cdp-port 9222
brisk serve  --cdp-port 9222
```

### Headless mode

```bash
brisk chrome --port 9222 --headless
```

`--headless=new` (Chrome 132+) is used — same behaviour as a real
window for most purposes, including screenshots and JS execution.

## Configuring MCP clients

### Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "brisk": {
      "command": "brisk",
      "args": ["serve", "--transport", "stdio"]
    }
  }
}
```

### Cursor

Cursor → Settings → MCP → "Add new MCP Server":

| Field | Value |
|---|---|
| Name | `brisk` |
| Type | `stdio` or `http` |
| Command | `brisk serve --transport stdio` |
| URL (if http) | `http://127.0.0.1:9100/mcp` |

For HTTP transport, run `brisk serve --transport http --port 9100`
first in a separate terminal.

### Cline

```bash
# In your VS Code workspace
echo '{
  "mcpServers": {
    "brisk": {
      "command": "brisk",
      "args": ["serve"],
      "type": "stdio"
    }
  }
}' > .cline/mcp.json
```

### Claude Code

Add to `~/.claude/CLAUDE.md`:

```text
@brisk-docs: f:/path/to/brisk/SKILL.md
```

Then in any project:

```bash
claude mcp add brisk -- brisk serve
```

### ChatGPT Desktop

Settings → Connectors → Add → MCP Server → stdio command:

```bash
brisk serve
```

### Generic MCP client

Brisk exposes the standard `tools/list`, `tools/call`, `resources/list`,
`resources/read` MCP methods. Any compliant client (2025-06-18 spec
or later) works.

## Cross-platform notes

### Windows

- Uses **named pipes** for IPC: `\\.\pipe\brisk-<instance>`. No file
  permissions hassle.
- Chrome lives at `%PROGRAMFILES%\Google\Chrome\Application\chrome.exe`
  by default. Brisk auto-detects.
- Long paths: keep `C:\Users\…` short. pnpm workspaces can hit Windows'
  260-char path limit if you clone into a deep dir.

### macOS

- Uses **Unix sockets** for IPC: `/tmp/brisk-<instance>.sock`.
- Code-signed Chrome is fine; Brisk doesn't notarize anything.
- First time Brisk attaches via Way 1, macOS may ask "Allow Brisk to
  control Google Chrome?". Click Allow. (System Preferences →
  Privacy & Security → Automation.)
- `osascript` is the platform automation hook; `brisk doctor`
  confirms it's available.

### Linux

- Uses **Unix sockets** for IPC: `/tmp/brisk-<instance>.sock`.
- **Snap chromium**: works but `--user-data-dir` paths are restricted
  to `$HOME/snap/chromium/`. Brisk warns. Recommend
  `sudo apt install google-chrome-stable` for fewer surprises.
- **Flatpak Chrome**: paths similar; tested less. File issues with details.
- **Wayland**: works headed and headless on Chrome 130+. If headed
  Chrome crashes, try `--headless` or unset `WAYLAND_DISPLAY` to force
  X11.
- **No DISPLAY at all** (containers, SSH-only): pass `--headless` —
  required.

## Troubleshooting

### `brisk doctor` reports `cdp ✗`

If your normal Chrome is already open, enable Way 1:

```bash
chrome://inspect/#remote-debugging
```

Tick **"Allow remote debugging for this browser instance"**, then click
Allow if Chrome shows a popup. Re-run `brisk doctor`.

For unattended or headless work, use Way 2 instead:

```bash
brisk chrome --port 9222
```

### MCP client says "no tools"

The MCP server is running but couldn't reach Chrome. Run
`brisk doctor` to diagnose. Most common cause: Chrome was closed
between `brisk serve` start and the first client request.

### "All Chrome instances must close" popup

You launched a `--user-data-dir` that conflicts with an open
Chrome. Either close the conflicting Chrome or pick a different dir.

### Brisk hangs at `daemon` step on Linux

A stale socket. Doctor reports it explicitly:

```
daemon     - not running (endpoint=/tmp/brisk-default.sock)
             warning: socket file exists but no daemon is listening
             → rm /tmp/brisk-default.sock if you're sure no daemon is running
```

Run the `rm` and retry.

### High CPU when idle

Brisk's daemon does one CDP `Browser.getVersion` heartbeat every 5
seconds. If you see high CPU, run `brisk daemon stop` and report the
stack trace — it shouldn't happen.

## Uninstall

```bash
npm uninstall --global @brisk/cli
rm -rf ~/.brisk-workspace          # if you opted into skills
```

That's it. No driver, no service, no registry keys.
