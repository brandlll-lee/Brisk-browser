# @brisk/cli

Command-line entry point for Brisk, an AI-native browser harness built on Chrome DevTools Protocol and MCP.

```bash
npm install -g @brisk/cli
brisk serve --transport stdio
```

`brisk serve` attaches to your current Chrome/Edge/Brave/Chromium when
Way 1 remote debugging is enabled. Use `brisk doctor` to verify Node,
Chrome/CDP, and IPC setup; if Chrome is already running but CDP is off,
doctor points you to `chrome://inspect/#remote-debugging`.

Use `brisk chrome --headless` only for Way 2: an isolated browser
profile for unattended or test work.

For Streamable HTTP, Brisk binds to `127.0.0.1` by default; binding a
non-loopback host requires `--allow-remote`.
