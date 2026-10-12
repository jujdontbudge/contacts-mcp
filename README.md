# contacts-mcp

One local source of person IDs, channel handles and conversations for AI agents. Provides SQLite identity, resolution, audited handle edits, an authorized outbox, all MCP tools, iMessage (imsg), Instagram (Beeper Desktop), email (Resend), TikTok (Zernio), and a daemon with authenticated HTTP. The fake adapter is only for offline tests.

## Setup and agent connections

Use Node 24 and npm, then copy the environment template and fill in only the channels you want:

```sh
cd /Users/johansardar/contacts-mcp
npm ci
cp .env.example .env
# Edit .env: CONTACTS_CHANNELS=imessage,instagram,email,tiktok plus required keys.
npm run build
```

Every CLI command loads `.env` from this repository root, including when launched from another working directory. Existing process environment values take precedence. The CLI defaults to the repository's `data/contacts.db`; set `CONTACTS_DB` to an absolute path to use another database. A new database is migrated automatically and uses WAL. Keep `.env` and databases private; both are ignored by git. Leaving `CONTACTS_CHANNELS` empty disables every adapter. Missing required credentials disable only that channel, reported by `sync_status` with `status: "disabled"` and `disabled_reason`; unknown channel IDs fail startup.

Local agents can start a stdio server. It runs the same composition, polling and live listeners as `serve`, and writes MCP protocol data to stdout (diagnostics go to stderr):

```sh
claude mcp add --transport stdio contacts -- /absolute/path/to/node24 /Users/johansardar/contacts-mcp/dist/cli.js stdio
```

For agents on other machines, run one daemon on the Air and connect over authenticated Streamable HTTP:

```sh
# Set CONTACTS_HTTP_TOKEN in .env first.
node dist/cli.js serve
# Local agent, with the same token available in its environment:
claude mcp add --transport http contacts-http http://127.0.0.1:8787/mcp --header "Authorization: Bearer $CONTACTS_HTTP_TOKEN"
# Remote agent: substitute the Air's Tailscale Serve URL for the loopback URL.
claude mcp add --transport http contacts-air https://<air-tailnet-name>/mcp --header "Authorization: Bearer $CONTACTS_HTTP_TOKEN"
```

Use the Node 24 binary's actual absolute path for stdio and launchd. Other MCP clients use the same command/args for stdio, or the same `/mcp` URL and `Authorization: Bearer <token>` header for HTTP. A stdio process owns its own sync listeners; prefer the daemon HTTP connection when multiple agents use the same accounts. HTTP requires a nonempty token on every request. Keep loopback binding and expose it via Tailscale Serve, or bind explicitly to the Air's tailnet address.

```sh
contacts-mcp person create "Alice Smith"
contacts-mcp person list
contacts-mcp person show p_...
contacts-mcp drafts list
contacts-mcp drafts approve o_... owner "Approved outreach"
contacts-mcp drafts reject o_... owner "Do not contact"
```

Run these commands through the installed bin, or `node dist/cli.js …` from this checkout.

## Tools

- Identity: `find_person`, `get_person`, `create_person`, `update_person`.
- Handles: `add_handle`, `change_handle`, `unlink_handle`, `link_handle`, `list_unlinked`, `list_link_suggestions`.
- History: `get_timeline`, `list_conversations`, `get_conversation`, `search_messages`.
- Outbox: `send_message`, `list_drafts`, `approve_draft`, `reject_draft`.
- Permissions/status: `add_send_rule`, `list_send_rules`, `sync_status`.

Names resolve as exact > prefix > token > trigram. Only an exact match scoring at least 0.95 with at least a 0.2 margin is sendable; tools require selecting a person ID for ambiguous results. Sending defaults to a draft. Direct sends need `authorized_by` and `reason`, or a matching standing permission. Approval rechecks identity, channel capability, reply window and rate limits. Set `CONTACTS_CHANNELS=imessage` to enable the real adapter in every CLI mode, including stdio. Sending is never enabled by default.

## Environment

- `CONTACTS_DB`: SQLite path; CLI default `<repo-root>/data/contacts.db`.
- `CONTACTS_RATE_LIMIT_IMESSAGE`, `CONTACTS_RATE_LIMIT_INSTAGRAM`, `CONTACTS_RATE_LIMIT_EMAIL`, `CONTACTS_RATE_LIMIT_TIKTOK`: integer per-channel outgoing sends/hour. Defaults are iMessage 60, Instagram 20, email 60 and TikTok 10. Zero blocks sends. Pending sends reserve slots across processes.

The CLI loads the repo-root `.env`; process environment values take precedence. [`.env.example`](.env.example) documents every variable. Never commit credentials or the database.

See [ADAPTERS.md](ADAPTERS.md) for the channel contract, reconciliation behavior and spec decisions. The future creator CRM adapter should reuse person links and draft tools for the dashboard approval inbox.

```sh
npm run typecheck
npm test
npm run build
```

## Channel requirements

- **iMessage:** install imsg on the Mac signed into Messages; grant Full Disk Access and Automation → Messages to the responsible Node/daemon executable. `CONTACTS_IMSG_PATH` overrides the binary location. No credential variables are required. Polls every 30 seconds plus `imsg watch` live events.
- **Instagram:** Beeper Desktop must be running with the intended Instagram account connected. Set `BEEPER_ACCESS_TOKEN` and `BEEPER_INSTAGRAM_ACCOUNT_ID`; `BEEPER_BASE_URL` defaults to `http://localhost:23373`. The composed system requires an explicit account ID so cursors and sends use the same account. Five-minute REST reconciliation plus reconnecting WebSocket live events.
- **Email:** configure Resend Sending with a verified `CONTACTS_EMAIL_FROM` (normally `outreach@excerlock.com`), `RESEND_API_KEY` for sends and `RESEND_FULL_API_KEY` for receiving and metadata. Configure Resend Receiving and forward the reply mailbox there. Optional `CONTACTS_EMAIL_REPLY_TO` controls the reply address. Two-minute polling; To/CC/BCC and stored RFC Message-ID threading are supported. A first outbound email needs a subject; a reply can inherit one. The composition bridge uses the dispatching outbox ID as the Resend idempotency key, durably stages sent metadata and reconciles through core after dispatch commits, including on restart. A send remains recorded if later metadata reconciliation fails; inspect the outbox before any retry. Provider metadata retrieval failure leaves the RFC ID absent, so replies to that email remain blocked until metadata is reconciled.
- **TikTok:** set `ZERNIO_API_KEY` and `ZERNIO_TIKTOK_ACCOUNT_ID`; `ZERNIO_BASE_URL` defaults to `https://zernio.com/api`. Connect an eligible TikTok Business account through Zernio with messaging permissions and incoming DMs enabled. Two-minute polling. Requires an existing thread and an inbound within 48 hours; first DMs must be sent manually. The adapter also enforces ten business replies since the latest inbound. Live confirmation is still needed for Zernio's generic conversation endpoint accepting `platform=tiktok` (see adapter notes).

All four channels persist cursors in `sync_state` under their actual account ID (iMessage/email use `default`). Cursors advance only after ingest, and failed passes preserve safe checkpoints. Live events do not advance history cursors. `sync_status` exposes last success, last error and enabled/disabled status. You can run one reconciliation without a daemon with `node dist/cli.js sync [channel]`.

## iMessage and daemon

Install [imsg](https://github.com/openclaw/imsg) (adapter checked against v0.16.0) and grant **Full Disk Access** and **Automation → Messages** to the exact **node binary running the daemon** in System Settings → Privacy & Security. Parent-process TCC grants can vary; if launchd still reports authorization denied, check the imsg permissions guide and grant the responsible executable. Restart the daemon after granting access. Agents should prefer the HTTP endpoint so only the daemon needs these permissions; an agent using the enabled stdio adapter to send also needs permissions.

```sh
export CONTACTS_CHANNELS=imessage
export CONTACTS_DB=/absolute/path/to/contacts-mcp/data/contacts.db
export CONTACTS_HTTP_TOKEN='your-private-random-token'
node dist/cli.js sync imessage  # one backfill/reconcile, then exit
node dist/cli.js serve          # sync + watch + MCP at http://127.0.0.1:8787/mcp
```

HTTP clients must send `Authorization: Bearer <CONTACTS_HTTP_TOKEN>` on every request. The endpoint uses the SDK's stateless Streamable HTTP transport and the same 21 tools as stdio. Keep loopback binding for local use; use Tailscale Serve to expose it on the tailnet, or explicitly bind `CONTACTS_HTTP_HOST` to the machine's tailnet address. Do not expose it on a public interface.

Additional environment variables:

- `CONTACTS_CHANNELS`: comma-separated channel IDs; `imessage`, `instagram`, `email`, `tiktok` are supported. Empty disables adapters. Unknown IDs fail startup.
- `CONTACTS_IMSG_PATH`: binary path; defaults to `/opt/homebrew/bin/imsg`.
- `CONTACTS_HTTP_HOST` / `CONTACTS_HTTP_PORT`: defaults `127.0.0.1` / `8787`.
- `CONTACTS_HTTP_TOKEN`: required, nonempty bearer token for `serve`.
- `CONTACTS_SYNC_INTERVAL_<CHANNEL>_MS`: delay after a completed sync pass. Defaults: iMessage `30000`, Instagram `300000`, email `120000`, TikTok `120000`. No overlapping polls for a channel within one process.

`sync_status` reports cursors, last completed successful sync and most recent error for each channel/account. A sync read failure preserves the last completed backfill page or incremental pass checkpoint. Live events ingest independently and never advance the backfill cursor; periodic sync fills watch gaps. Watch exits restart with exponential backoff capped at 60 seconds. Handles remain unlinked until there is exact identity proof. Routing diagnostics from imsg remain in raw metadata; the adapter uses account `default` because AppleScript cannot select a sending account.

The adapter executes these commands without a shell:

```text
imsg chats --limit 2147483647 --json
# Backfill pages (first page has no --end):
imsg history --chat-id <rowid> --limit 1000 [--end <page-boundary-ISO>] --attachments --json
# Timestamp ties at the oldest page boundary (streamed, 2ms window):
imsg history --chat-id <rowid> --limit 2147483647 --start <boundary-ISO> --end <bucket-end-ISO> --attachments --json
# Incremental: only chats with last_message_at >= overlap start:
imsg history --chat-id <rowid> --limit 2147483647 --start <last-sync-minus-10-minutes-ISO> --attachments --json
# Pre-send snapshot and confirmation (only matching chats):
imsg history --chat-id <rowid> --limit 100 --start <send-start-minus-1-minute-ISO> --attachments --json
imsg watch --attachments --json
imsg send --to <normalized-handle> --text <text> --service imessage --json [--file <absolute-path>]
imsg send --chat-identifier <chat.identifier> --text <text> --service imessage --json [--file <absolute-path>]
```

History has no rowid pagination flag. Initial backfill uses 1000-message pages, descending by date, with an exclusive `--end` for older pages. The boundary timestamp bucket is streamed separately so more than 1000 messages sharing a timestamp cannot be skipped; its bounds account for imsg's millisecond timestamp formatting. The adapter buffers at most one page, and streams incremental and boundary output with backpressure (imsg itself prepares each date-window result in memory). Progress is durably checkpointed after a page or chat is fully ingested; an interrupted page is replayed and deduplicated.

Versioned JSON cursors contain the maximum observed rowid, last successful scan's **start** time, and backfill progress while applicable. Numeric cursors migrate through one bounded backfill pass, emitting only rowids above the legacy cursor because a numeric cursor provides no safe timestamp to start from. Afterwards, each periodic pass lists chats once, selects chats using `last_message_at` with a ten-minute safety overlap, and streams only that date window. Missing/invalid activity dates include the chat conservatively. The explicit large limit prevents imsg's default 50-message limit from truncating an active window; it never requests an entire chat history in steady state. The timestamp advances only after all selected chats succeed, including empty passes. Overlap events are not filtered by rowid, so a racing lower-rowid insert in an already-scanned chat is recovered on the next pass. The ten-minute overlap covers recent insert races; historical imports dated outside it require a cursor reset/backfill. Saved cursors must also be reset if the underlying Messages database is restored/replaced. Message GUIDs deduplicate history and live copies; attachment metadata is retained without opening or copying attachment files. Some self-sent rows have no sender: they use the routed caller ID if present, otherwise `self@contacts-mcp.invalid`; missing inbound senders use a per-row unlinked placeholder. These placeholders are evidence gaps, not discovered people.

Send accepts text and at most one absolute local attachment path or `file://` URL; remote attachment URLs, subjects, email routing and inline replies are rejected. Direct sends route by normalized phone/email, group sends resolve the stored portable chat GUID to its exact `chat.identifier`. The adapter takes a pre-send snapshot limited to 100 recent messages since one minute before the send begins, sends once, then polls the same bounded history window for a new outgoing row (matching the returned GUID when available). Timeout or an error after the mutation reports **uncertain; do not retry automatically**. Core retains a failed outbox entry with that diagnostic for manual reconciliation. History confirmation proves Messages recorded the outgoing row, not a recipient delivery/read receipt.

### launchd

Copy [the example](deploy/com.contacts-mcp.daemon.plist.example) to `~/Library/LaunchAgents/com.contacts-mcp.daemon.plist`, replace every absolute-path/user/token placeholder, and build first. launchd does not expand `~`; the CLI itself loads the repo-root `.env`. Keep the installed plist private because it contains the bearer token.

```sh
mkdir -p ~/Library/LaunchAgents ~/Library/Logs/contacts-mcp
chmod 600 ~/Library/LaunchAgents/com.contacts-mcp.daemon.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.contacts-mcp.daemon.plist
# Stop:
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.contacts-mcp.daemon.plist
```

No live Messages reads/sends are part of the offline tests. After permissions are granted, validate initial/repeated backfill, group participants/identifiers, a watch reconnect with poll reconciliation, and an explicitly authorized message to the owner (including confirmation and no duplicate stored copy).
