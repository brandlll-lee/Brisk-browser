---
title: Profile Sync (V0.1.1 preview)
tags: [profile, cookies, auth, deferred]
---

# Profile Sync

**Status: PREVIEW. Full implementation in V0.1.1.**

The goal of profile sync is to let an agent reuse the user's logged-in
state — cookies, localStorage, IndexedDB — without the user pasting
credentials. This document captures the design so the V0.1.0 surface
stays compatible.

## What V0.1.0 ships

Two pre-conditions are already in place:

1. **`Network.setCookie` via the `cdp` tool** — cookies can be seeded
   for any origin (see `cookies.md`).
2. **No automatic Chrome relaunch** — Brisk attaches to the user's
   existing Chrome (or a fresh one launched by `brisk chrome`). The
   user controls which profile is in use.

That's enough for an agent that wants to operate on `github.com`
when the user is logged into GitHub in their main Chrome: just have
the user run Chrome with `--remote-debugging-port=9222`, point Brisk
at it, and the existing session cookies are already there.

## What V0.1.1 will add

### `sync_local_profile` (tool)

Copy the cookie jar, localStorage, and IndexedDB from a named local
Chrome profile into the currently-attached Brisk session.

```text
sync_local_profile {profileName: "Default", origins: ["github.com", "linkedin.com"]}
→ {cookies: 23, localStorage: 5, indexedDb: 0}
```

Implementation outline:

1. Find the user's Chrome profile directory (`~/Library/Application Support/...`,
   `~/.config/google-chrome/...`, `%LOCALAPPDATA%\Google\Chrome\User Data\...`).
2. Read `Cookies` (SQLite), `Local Storage/leveldb/`, `IndexedDB/`.
3. Decrypt cookies using the OS-specific key:
   - macOS: keychain `Chrome Safe Storage`
   - Linux: kwallet / libsecret
   - Windows: DPAPI (`CryptUnprotectData`)
4. Replay via `Network.setCookie` (for cookies) and
   `Runtime.evaluate` (for localStorage / IndexedDB).

### Cloud profiles (much further out)

Match browser-harness's remote profile feature:

```text
list_cloud_profiles
→ [{id, name, lastLoginAt}, ...]

start_remote_daemon {name: "work", profileName: "github-prod"}
→ {liveUrl: "https://browser-use.com/live/...", sessionId: "..."}
```

Cloud profiles are a paid Browser Use feature; Brisk integration is
V0.2.0+ when the cost model is settled.

## Caveats baked into the design

### Encryption keys

- macOS: keychain prompts the user for password unless the agent has
  approved access. Brisk can't auto-approve; the user has to grant once.
- Linux: kwallet / libsecret prompt on first access; same caveat.
- Windows: DPAPI uses the current user's profile — no prompt, but only
  works if Brisk runs as the same user (which is the default anyway).

### "Logged-in to one profile, agent acts as another"

If the user has Chrome with Profile A logged into `github.com` and
runs `brisk chrome --port 9223` (which spawns a fresh profile), the
new Chrome won't have the cookies. `sync_local_profile {profileName:
"Profile A", origins: ["github.com"]}` resolves this.

### Re-encrypting on copy

Chrome's cookie store re-encrypts with the destination profile's key
on first write. If we copy raw rows the destination Chrome won't read
them. The transit format is plaintext — we decrypt at source and re-
encrypt at destination by going through `Network.setCookie`.

### IndexedDB

This is the hard part. IndexedDB's storage format isn't documented;
LevelDB blobs are application-specific. The V0.1.1 plan:

- Use `IndexedDB.requestData` over CDP to enumerate from the source
  profile.
- Use `IndexedDB.deleteObjectStoreEntries` + `Runtime.evaluate` to
  replay on the destination.

That's a long round-trip per object. Realistic limit: ~1000 entries.

## Today

If a user asks "log me into github.com", the V0.1.0 answer is:

1. "Run your normal Chrome with `--remote-debugging-port=9222`."
2. Brisk attaches to it. Your existing cookies are already in use.
3. Agent operates without ever seeing your password.

The fresh-profile `brisk chrome` mode is for hermetic sessions where
you don't want the agent to touch your real state.
