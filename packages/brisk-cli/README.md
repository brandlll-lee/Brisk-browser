# @brisk/cli

Command-line entry point for Brisk, an AI-native browser harness built on Chrome DevTools Protocol and MCP.

```bash
npm install -g @brisk/cli
brisk chrome --headless
brisk serve --transport stdio
```

Use `brisk doctor` to verify Node, Chrome/CDP, and IPC setup. For Streamable HTTP, Brisk binds to `127.0.0.1` by default; binding a non-loopback host requires `--allow-remote`.
