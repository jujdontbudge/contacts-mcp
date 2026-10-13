# contacts-mcp

One local source of person IDs, channel handles and conversations for AI agents. Provides SQLite identity, resolution, audited handle edits, an authorized outbox, all MCP tools, iMessage (imsg), Instagram (Beeper Desktop and official Meta API), email (Resend), TikTok (Zernio), and a daemon with authenticated HTTP. The fake adapter is only for offline tests.

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

Use the Node 24 binary's actual absolute path for stdio and launchd. Other MCP clients use the same command/args for stdio, or the same `/mcp` URL and `Authorization: Bearer <token>` header for HTTP. A stdio process owns its own sync listeners; prefer the daemon HTTP connection when multiple agents use the same accounts. HTTP MCP requires a nonempty token on every request; the optional Instagram webhook path uses Meta signatures instead. Keep loopback binding and expose it via Tailscale Serve, or bind explicitly to the Air's tailnet address.

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
- Inbox: `list_inbox`, `claim_inbox`, `mark_inbox`, `set_inbox_cutoff`.
- Outbox: `send_message`, `list_drafts`, `approve_draft`, `reject_draft`.
- Permissions/status: `add_send_rule`, `remove_send_rule`, `list_send_rules`, `sync_status`.

Names resolve as exact > prefix > token > trigram. Only an exact match scoring at least 0.95 with at least a 0.2 margin is sendable; tools require selecting a person ID for ambiguous results. Sending defaults to a draft. Direct sends need `authorized_by` and `reason`, or a matching standing permission. Approval rechecks identity, channel capability, reply window and rate limits. Set `CONTACTS_CHANNELS=imessage` to enable the real adapter in every CLI mode, including stdio. Sending is never enabled by default.

Agent workflow: `find_person` → inspect candidates and pick a person ID → `send_message`. Groups require an explicit `conversation_id`; choose `handle_id` and channel when routing matters. `get_conversation` returns the latest 100 messages by default and supplies `next_offset` for older pages. See [send safety and reconciliation](ADAPTERS.md#send-safety-and-failed-send-reconciliation) for approval snapshots, rule revocation and settled uncertain sends.

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
- **Instagram:** `CONTACTS_INSTAGRAM_TRANSPORT=beeper` (default), `official`, or `both`. Beeper requires Desktop, `BEEPER_ACCESS_TOKEN` and `BEEPER_INSTAGRAM_ACCOUNT_ID`; optional `BEEPER_BASE_URL` defaults to `http://localhost:23373`. Official requires a professional Instagram account authorized via **Instagram Login**, `IG_ACCESS_TOKEN` (long-lived), `IG_APP_SECRET`, `IG_WEBHOOK_VERIFY_TOKEN`; set `IG_USER_ID` or resolve `/me`, and optionally `IG_GRAPH_VERSION` (default `v25.0`). Official reads the latest 20 messages per thread, captures signed webhooks and phone echoes at `/webhooks/instagram`, and replies within 24 hours. It cannot cold-start DMs. `both` uses Beeper for new/cold DMs and groups, official for eligible direct replies, and refuses expired replies without fallback. Configure the same ExcerLock account in both; the logical account remains the Beeper account ID. Beeper local IDs do not automatically dedupe against Meta IDs. Five-minute reconciliation; weekly official token refresh persists privately in SQLite. See [the official adapter and exact Meta settings](ADAPTERS.md#instagram-official-api-and-transport-composition), including Human Agent use, echo subscription nuances, public HTTPS callback setup and token rotation.

- **Email:** configure Resend Sending with a verified `CONTACTS_EMAIL_FROM` (normally `outreach@excerlock.com`), `RESEND_API_KEY` for sends and `RESEND_FULL_API_KEY` for receiving and metadata. Configure Resend Receiving and forward the reply mailbox there. Optional `CONTACTS_EMAIL_REPLY_TO` controls the reply address. Two-minute polling; To/CC/BCC and stored RFC Message-ID threading are supported. A first outbound email needs a subject; a reply can inherit one. The composition bridge uses the dispatching outbox ID as the Resend idempotency key, durably stages sent metadata and reconciles through core after dispatch commits, including on restart. A send remains recorded if later metadata reconciliation fails; inspect the outbox before any retry. Missing provider Message-IDs are retried on later syncs, including after restart. Inbound replies first match stored ancestry, then normalized subject plus exact counterpart addresses. Outbound replies requiring an absent RFC ID remain blocked until reconciliation. For legacy splits, see [email-thread repair](ADAPTERS.md#repair-legacy-email-splits).
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

HTTP clients must send `Authorization: Bearer <CONTACTS_HTTP_TOKEN>` on every request. The endpoint uses the SDK's stateless Streamable HTTP transport and the same 26 tools as stdio. Keep loopback binding for local use; use Tailscale Serve to expose it on the tailnet, or explicitly bind `CONTACTS_HTTP_HOST` to the machine's tailnet address. Do not expose it on a public interface.

Additional environment variables:

- `CONTACTS_CHANNELS`: comma-separated channel IDs; `imessage`, `instagram`, `email`, `tiktok` are supported. Empty disables adapters. Unknown IDs fail startup.
- `CONTACTS_IMSG_PATH`: binary path; defaults to `/opt/homebrew/bin/imsg`.
- `CONTACTS_HTTP_HOST` / `CONTACTS_HTTP_PORT`: defaults `127.0.0.1` / `8787`.
- `CONTACTS_HTTP_TOKEN`: required, nonempty bearer token for `serve`.
- `CONTACTS_SYNC_INTERVAL_<CHANNEL>_MS`: delay after a completed sync pass. Defaults: iMessage `30000`, Instagram `300000`, email `120000`, TikTok `120000`. Renewable SQLite leases prevent overlapping polls for the same channel/account across upgraded processes.

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

Send accepts text and at most one absolute local attachment path or `file://` URL; remote attachment URLs, subjects, email routing and inline replies are rejected. Direct sends route by normalized phone/email, group sends resolve the stored portable chat GUID to its exact `chat.identifier`. The adapter takes a pre-send snapshot limited to 100 recent messages since one minute before the send begins, sends once, then polls the same bounded history window for a new outgoing row (matching the returned GUID when available). Timeout or an error after the mutation reports **uncertain; do not retry automatically**. Core retains a failed outbox entry with that diagnostic; later sync may settle it through the conservative reconciliation policy in ADAPTERS.md. History confirmation proves Messages recorded the outgoing row, not a recipient delivery/read receipt.

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

Message-reading tools omit full `raw` platform payloads by default; pass `include_raw: true` to inspect them. `send_message` also accepts this flag to return its stored sent message. Raw payloads remain in the database.

## Inbox automation

Activate deliberately with `node dist/cli.js inbox cutoff now owner`, or
`set_inbox_cutoff({cutoff: "<ISO timestamp>", actor: "owner"})`. The cutoff is stored
in SQLite and audited. Until set, inbox processing is disabled. Only provider
message timestamps strictly after the cutoff qualify, so old history imported
later remains excluded. Moving the cutoff does not reset handled messages.

- `list_inbox({channels?, limit?})` returns `{cutoff, items}` oldest first. Defaults
  to email, Instagram and TikTok; **iMessage is personal and requires explicit
  inclusion**. Each item includes the inbound, person `{id,name,tags}` (or null
  for unlinked senders), handle, conversation ID, latest five thread messages
  and handling state. Raw payloads are omitted. Limit defaults to 100 (max 1000).
- `claim_inbox({message_ids, actor, lease_seconds?})` claims the entire set
  atomically or fails without claiming any. Default lease: 600 seconds (1–3600).
  Returns `claim_token`, `claim_expires_at` and state items. Each acquisition has
  a fresh token, even for the same actor. Expired claims become listable again;
  stale tokens cannot send or finalize work.
- `mark_inbox({message_id, claim_token, outcome, actor, note, rule?, outbox_id?})`
  finalizes as `auto_replied`, `escalated`, `ignored` or `done`. Identical calls
  are idempotent; conflicting final decisions fail. Every state change is
  audited with actor, reason, rule, linked outbox, token, lease and timestamp.
  `auto_replied` requires a confirmed sent outbox bound to the inbound.
- `set_inbox_cutoff({cutoff, actor})` sets an ISO timestamp and returns config.

A scheduled agent uses **list → claim → send (when authorized) → mark**. Claim
only the IDs it can finish within the lease. For a reply call `send_message`
with the listed `conversation_id`, `inbox_message_id`, `claim_token` and an
`idempotency_key`, in addition to the existing target/content/authorization.
Use `rule:<rule-id>:msg:<message-id>` for per-message rules or
`rule:<rule-id>:person:<person-id>` for once-per-person rules. The key is global
and permanent. Reuse returns the original outbox and `already_used: true`, even
if the new payload differs; a new record returns false. The inbound binding
also returns the original send if a different rule/key tries that same message.
A once-per-person duplicate may refer to another inbound: mark the current
message `ignored` with that explanation rather than pretending a new reply was
sent. Unlinked senders can be escalated without creating a guessed identity.

The guarantee is **at most one provider dispatch per key or bound inbound**,
across processes and crashes. A draft, failed or `sending` result is not a
confirmed reply. Never generate a new key to retry it. A crash between storing
an outbox and dispatch leaves a draft; a crash around the external mutation
leaves `sending`. Repeated `send_message` returns that record without resuming
it. Existing conservative sync reconciliation can settle keyed uncertain
`sending` and failed records from outgoing evidence. Unsettled records require
owner investigation; safety deliberately takes precedence over delivery.
Authorization and owner-approved draft handling still apply. Claims coordinate
work; binding and keys prevent side effects from repeating after lease expiry.

A confirmed outgoing message in the same conversation with a provider timestamp
strictly later than an inbound closes all earlier `new`/`claimed` messages.
This applies to manual/native replies and server sends, including replies
synced before an older inbound arrives. Drafts, pending and failed provider
copies do not count. The next inbox operation persists `done` for replies
elsewhere, or `auto_replied` for a confirmed bound send; final decisions retain
their audit. In groups this deliberately treats any outgoing reply as answering
earlier pending messages in the conversation.

Creator-system connection: extend the existing marketing-repo contacts adapter
to read `inbox_handling`/`inbox_events` through a future narrow escalation-read
interface and render `escalated` notes in the dashboard's generic approval inbox.
The scheduled T3 agent owns triage; contacts-mcp owns leases and send safety.
No dashboard, rule engine, recurring task or parallel CRM is added here.
