# @brisk/cli

The command-line app for Brisk.

Brisk lets an MCP-capable AI client control a real Chrome-family
browser. It can attach to your everyday Chrome profile, so the agent can
work with your logged-in sessions, cookies, extensions, and open tabs.

## Install

```bash
npm install -g @brisk/cli
```

## Recommended: use your current browser

Open this in Chrome once:

```text
chrome://inspect/#remote-debugging
```

Tick:

```text
Allow remote debugging for this browser instance
```

Then run:

```bash
brisk doctor
brisk serve
```

`brisk serve` starts the MCP server over stdio by default.

## Use a separate browser instead

For tests, scripts, or headless work:

```bash
brisk chrome --port 9222
brisk serve --cdp-port 9222
```

Headless:

```bash
brisk chrome --port 9222 --headless
```

## Commands

| Command | What it does |
|---|---|
| `brisk doctor` | Checks Node, Chrome, browser access, and daemon state |
| `brisk serve` | Starts the MCP server |
| `brisk chrome` | Launches a clean Chrome for automation |
| `brisk daemon start` | Starts the IPC daemon |
| `brisk daemon stop` | Stops the IPC daemon |
| `brisk daemon status` | Shows daemon status |

## HTTP mode

```bash
brisk serve --transport http --port 9100
```

The endpoint is:

```text
http://127.0.0.1:9100/mcp
```

Brisk binds to localhost by default. To bind a non-loopback host, you
must pass `--allow-remote`. Only do that on a trusted network because
Brisk V0.1.0 has no authentication.
