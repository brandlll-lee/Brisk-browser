# Brisk

> Give your AI a real browser to use.

Brisk lets an AI agent control Chrome the way you do.

It can open pages, click buttons, type into forms, scroll, take
screenshots, read page content, and pull data out of websites. The nice
part: it can do this inside the Chrome profile you already use.

So if you are logged in to a site, Brisk can work with that same session.
No weird empty browser. No starting from scratch every time.

Think of Brisk as the hands and eyes for Codex, Cursor, Claude, Cline,
Continue, ChatGPT Desktop, or any tool that speaks MCP.

The AI still does the thinking.

Brisk gives it the browser.

## What Brisk Can Do Today

Brisk V0.1.0 is a working browser-control layer.

It is not a full AI assistant yet. It does not call an LLM by itself. It
connects an AI client to a real browser and gives that AI 37 practical
tools.

With those tools, an agent can:

- open a new tab
- go to a website
- switch between tabs
- close tabs
- see the current page URL and title
- take screenshots
- inspect the page
- run JavaScript on the page
- read console errors
- click
- type
- press keys
- scroll
- hover
- fill inputs
- upload files
- choose dropdown options
- wait for pages to load
- wait for elements to appear
- make simple HTTP requests
- call raw Chrome DevTools commands when needed
- check the browser connection
- restart the connection
- notice browser dialogs
- read and write site-specific skills
- record failures so future agents can learn from them

That is the core idea.

Instead of asking an AI to guess what is on a page, Brisk lets it look.
Instead of asking an AI to imagine a click, Brisk lets it click.

## The Best Part: It Can Use Your Real Browser

Most browser automation tools open a clean test browser.

That is useful for tests, but annoying for real work. You lose your
logged-in sessions, cookies, extensions, and open tabs.

Brisk's recommended path is different.

It connects to the Chrome, Edge, Brave, or Chromium profile you already
use.

That means an agent can help with real browsing tasks like:

- open a product page and extract the price
- summarize a page you already have open
- inspect a web app after you log in
- click through a workflow while you watch
- grab data from a page that needs your normal browser session

There is also a clean isolated-browser mode for tests and unattended
jobs. You choose.

## Quick Start

### 1. Install

```bash
npm install -g @brisk/cli
```

Check it installed:

```bash
brisk --version
```

You should see:

```text
0.1.0
```

### 2. Turn On Browser Access

Open this in your normal Chrome:

```text
chrome://inspect/#remote-debugging
```

Tick:

```text
Allow remote debugging for this browser instance
```

Chrome may show an "Allow remote debugging?" popup the first time Brisk
connects. Click Allow.

This is the only slightly strange setup step. Browser automation is
still browser automation. Chrome wants your permission.

### 3. Check Everything

```bash
brisk doctor
```

`doctor` checks Node, Chrome, the browser connection, and the local
Brisk daemon.

If Chrome is open but Brisk cannot connect, `doctor` tells you what to
do and tries to open the Chrome settings page for you.

### 4. Start Brisk

For most AI apps:

```bash
brisk serve
```

That starts Brisk over stdio, which is the default MCP mode for desktop
clients.

For HTTP:

```bash
brisk serve --transport http --port 9100
```

Then connect your MCP client to:

```text
http://127.0.0.1:9100/mcp
```

Brisk only binds HTTP to localhost by default. That is intentional.
V0.1.0 has no authentication, so exposing it to a network is something
you should only do on a trusted setup.

## Connect It To An AI Client

Brisk is an MCP server.

Any MCP-capable client can use it.

### Claude Desktop

Add this to your Claude Desktop config:

```json
{
  "mcpServers": {
    "brisk": {
      "command": "brisk",
      "args": ["serve"]
    }
  }
}
```

### Cursor

Use either stdio:

```text
brisk serve
```

Or HTTP:

```text
http://127.0.0.1:9100/mcp
```

### ChatGPT Desktop

Add an MCP server with this command:

```bash
brisk serve
```

### Generic MCP Client

Brisk supports standard MCP tools and resources.

It exposes:

- `tools/list`
- `tools/call`
- `resources/list`
- `resources/read`

## Example: Ask An Agent To Use The Browser

Once Brisk is connected to your AI client, ask something like:

```text
Open this Amazon product page and extract the title, price, rating,
review count, and availability.
```

Behind the scenes, the agent can:

```text
1. open a new tab
2. wait for the page to load
3. read the page
4. run a small extraction script
5. return the data
```

Brisk already includes an Amazon product extraction skill with selectors
for title, price, rating, reviews, availability, brand, ASIN, and bullet
points.

Important: if Amazon shows a CAPTCHA, Brisk tells the agent to stop and
tell you. It does not try to bypass it.

## Way 1 And Way 2

Brisk has two browser modes.

### Way 1: Your Everyday Browser

This is the recommended mode.

Use it when you want the agent to work with your current browser:

- your logged-in sessions
- your cookies
- your extensions
- your open tabs

Run:

```bash
brisk doctor
brisk serve
```

### Way 2: A Fresh Browser For Automation

Use this when you want a clean browser that Brisk owns.

Good for tests, CI, and unattended jobs.

Run:

```bash
brisk chrome --port 9222
```

Then in another terminal:

```bash
brisk serve --cdp-port 9222
```

For headless mode:

```bash
brisk chrome --port 9222 --headless
```

## What Makes Brisk Different

**It is thin.**

Brisk does not try to be a giant automation framework. It does not hide
the browser behind a big abstraction. It gives the AI simple, direct
tools.

**It is local.**

Your browser runs on your machine. Brisk talks to it over Chrome's own
debugging interface.

**It speaks MCP.**

That means many AI tools can use it without Brisk needing a special
plugin for each one.

**It can learn.**

When an agent hits a weird website behavior, it can record the failure
and write a small skill. Next time, another agent can read that skill
instead of falling into the same hole.

## What Brisk Is Not Yet

Brisk V0.1.0 is the browser-control foundation.

It is not yet:

- a full AI agent
- an LLM provider
- a browser fork
- a cloud browser service
- a replacement for Playwright or Selenium

It is closer to a very sharp remote control for a real browser.

That is enough to make a lot of useful agent work possible.

## Project Layout

```text
brisk/
├── packages/
│   ├── brisk-types     Shared TypeScript types
│   ├── brisk-ipc       Local daemon communication
│   ├── brisk-core      Chrome connection, sessions, browser helpers
│   ├── brisk-skills    Skill store and failure log
│   ├── brisk-mcp       MCP tools and transports
│   └── brisk-cli       brisk doctor / serve / chrome / daemon
├── agent-workspace/    Skills and failure records the agent can edit
├── interaction-skills/ Browser operation notes exposed as MCP resources
├── references/         Upstream projects used for study
└── docs/               Install, protocol, architecture, and roadmap docs
```

## Useful Docs

| Doc | What It Is For |
|---|---|
| [Install Guide](docs/install.md) | Set up Brisk and connect AI clients |
| [Architecture](docs/architecture.md) | How the pieces fit together |
| [MCP Protocol](docs/mcp-protocol.md) | Tool list and MCP wire details |
| [Chromium Embedding](docs/chromium-embedding.md) | Future browser-fork plan |
| [V0.1.0 Plan](docs/v0.1.0-plan.md) | Original detailed build plan |

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 22+ |
| Language | TypeScript |
| Browser link | Chrome DevTools Protocol |
| AI link | Model Context Protocol |
| HTTP server | Hono |
| Skill DB | better-sqlite3 with FTS5 |
| Package manager | pnpm |

## Roadmap

- **V0.1.0**: local browser control, 37 MCP tools, real-browser attach,
  stdio and HTTP transports, skill storage.
- **V0.1.1**: richer skill bundle, profile sync experiments, more remote
  browser work.
- **V0.2.x**: an agent SDK on top of Brisk.
- **V0.3.x**: deeper Chromium integration.
- **V1.0**: a full Brisk Browser distribution.

## License

Apache-2.0.

The projects under `references/` are kept for study only.

## One Sentence

Brisk turns your real browser into something an AI can see, touch, and
learn from.
