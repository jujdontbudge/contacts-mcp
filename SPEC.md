# contacts-mcp: build spec

Written 2026-10-12 from the owner's grilling session and the follow-up identity decisions. Research behind each choice is in `~/excerlockmarketing/raw/contacts-mcp-research/` (`imessage.md`, `beeper.md`, `instagram-tiktok.md`, `tiktok-now.md`, `unified-and-email.md`).

## 1. Goal
AI agents can find a person by name and message them on any channel. They can read and write that person's conversations and see their whole history across channels, and every message is stored with its context. contacts-mcp is the single source of who is who for every system. The creator CRM is the first consumer, linked through an adapter. It's a separate private GitHub repo (`JohanSardar/contacts-mcp`), installed as an MCP like any other.

## 2. Owner decisions
| Topic | Decision |
|---|---|
| Language | TypeScript (Node 24). |
| Where it runs | The MacBook Air (always on, signed into iMessage). Local agents use stdio; other machines use HTTP over Tailscale. |
| Person IDs | **contacts-mcp is the only place IDs are created.** Other systems keep their own IDs as links (e.g. `creator-crm:7`) and store the contacts ID. |
| Handles | Agents can add and change phone numbers, emails and usernames. Nothing blocks an edit; the agent must get it right and double-check. Every change is logged with who made it and when, so mistakes can be undone. |
| Linking unknown senders | Messages from someone not yet added are stored under an "unlinked" handle. A handle links to a person automatically only on exact proof; fuzzy matches become suggestions. |
| Ambiguous names | Lookup returns ranked candidates. Nothing is sent until the agent picks one person ID. |
| Sending | A draft by default. A message is sent directly only with an authorization (the owner said so in the task, or a standing rule matches). Every message sent records who authorized it and why. |
| Storage | Store everything. Nothing is deleted. |
| iMessage | Full access, 1:1 and group chats. |
| Instagram | Beeper Desktop: read, reply, start new DMs, groups. |
| Email | The existing Resend setup: send from `outreach@excerlock.com` with To/CC/BCC; replies are read from Resend Receiving. Gmail later. |
| TikTok | Zernio (free for 2 accounts, official business API): read and reply. First messages are sent by hand; replies must come within 48 h of their last message. Fallback: browser automation. |
| Approvals | Drafts appear in the creator dashboard's approval inbox through an adapter in the marketing repo. contacts-mcp also exposes them as tools and CLI commands. |
| Setup | I do it on the Air and confirm with the owner right before the final click on any new account and before any spend. Passwords go in the macOS Keychain (`contacts-mcp/<service>`); API keys go in `.env`, which is never committed. |

**One change from the grilling:** iMessage is read through **imsg** (the Mac's own message database) rather than Beeper. imsg needs no account, sees the complete history, and sends through Messages.app. Beeper can't guarantee complete history, so it's used for Instagram only. Using one source per channel also avoids storing duplicate messages.

## 3. Architecture
```
agents ──MCP (stdio | HTTP)──► tools ──► core ──► SQLite (data/contacts.db)
                                          │
                       channel adapters ◄─┘──► imsg · Beeper · Resend · Zernio
                                          ▲
              daemon (`serve`): sync loops + live events + HTTP MCP
```
- **core/** owns all data and decisions: identity, handles, conversations, messages, outbox, authorization, name resolution. Nothing else touches the database.
- **channels/** are adapters behind one `Channel` interface (§5). Adding Gmail or WhatsApp later means adding one file.
- **mcp/** is a thin layer that turns tool calls into core calls.
- **cli/**: `contacts-mcp stdio | serve | sync [channel] | drafts … | person …`.
- One database file in WAL mode, so the stdio server and the daemon can run at the same time.

## 4. Data model (SQLite)
- `persons(id TEXT PK 'p_<ulid>', display_name, aliases JSON, tags JSON, notes, created_at, updated_at)`
- `person_links(person_id, system, external_id, UNIQUE(system, external_id))`, e.g. `creator-crm` / `7`.
- `handles(id PK, channel, value_normalized, value_raw, person_id NULL, account_id, created_at, UNIQUE(channel, account_id, value_normalized))`. Channels: `imessage | instagram | email | tiktok`. Phone numbers are normalized to E.164 and emails to lower case.
- `handle_events(id, handle_id, person_id_before, person_id_after, action add|link|unlink|change, actor, reason, at)`: the edit log.
- `link_suggestions(handle_id, person_id, evidence, score, status)`.
- `conversations(id 'c_<ulid>', channel, account_id, external_id, kind direct|group, title, UNIQUE(channel, account_id, external_id))`.
- `conversation_participants(conversation_id, handle_id)`.
- `messages(id 'm_<ulid>', conversation_id, channel, external_id, direction in|out, sender_handle_id, sent_at, text, subject, email_to/cc/bcc JSON, attachments JSON, reply_to_external_id, raw JSON, ingested_at, UNIQUE(channel, external_id))`. Deduplicated by channel ID.
- `outbox(id 'o_<ulid>', status draft|approved|sending|sent|failed|rejected, target (person_id, conversation_id, handle_id, channel), payload JSON, authorized_by, reason, created_by, created_at, decided_at, sent_message_id, error, reconciled_at, target_snapshot JSON, send_started_sequence)`.
- `send_rules(id, scope person|tag|kind, value, channels JSON, created_by, created_at, active, removed_by, removed_at)`: standing permissions to send.
- `sync_state(channel, account_id, cursor, last_ok_at, last_error)`.
- `sync_leases(channel, account_id, owner, expires_at)`: renewable cross-process poll ownership; the [adapter contract](ADAPTERS.md#sync-coordination-and-remaining-coverage) defines checkpoint/recovery behavior.

## 5. Channel interface
```ts
interface Channel {
  id: 'imessage' | 'instagram' | 'email' | 'tiktok';
  capabilities: { startConversation: boolean; groups: boolean; cc: boolean; replyWindowHours?: number };
  sync(cursor?: string): AsyncIterable<IngestEvent>;           // history + new messages, resumable
  live?(onEvent: (e: IngestEvent) => void): () => void;        // optional push (Beeper WS)
  send(target: SendTarget, content: SendContent): Promise<{ externalId: string; conversationExternalId: string }>;
  normalizeHandle(raw: string): string;
}
```
| Adapter | Read | Live | Send | Notes |
|---|---|---|---|---|
| `imsg` (iMessage) | `imsg` CLI JSON read of chat.db, cursor = message ROWID | `imsg watch`, plus a 5 s poll | `imsg send` by handle or by group chat ID, then confirm it appears in chat.db | needs Full Disk Access and Automation → Messages |
| `beeper` (Instagram) | `@beeper/desktop-api` chats/messages list | WebSocket `ws://localhost:23373/v1/ws`, plus a 5 min reconcile | `messages.send`; new DMs via contacts search by exact username, then `chats.start({ user: { id } })` | Beeper Desktop must be running; sends are rate-limited (default 20/hour) |
| `resend` (email) | list received emails (full-access key), cursor = last ID | 2 min poll | send with to/cc/bcc, `In-Reply-To`/`References` for threading | from `outreach@excerlock.com` |
| `zernio` (TikTok) | `GET /v1/inbox/conversations` and thread messages | 2 min poll (webhooks later) | `POST /v1/inbox/conversations/{id}/messages` | blocked when outside the 48 h window |

## 6. Name resolution
`find_person(query)` scores every person against name, aliases, handles and links, using normalized exact matches, then prefix, then token, then trigram similarity. Candidates include each person's handles, tags, links, last message and last channel.
- **Unique exact match** (score ≥ 0.95 with a margin of ≥ 0.2 over the next candidate): the result can be used to send.
- **Anything else:** the result is `ambiguous`. The agent must call again with a `person_id`.

Embeddings ("the girl from the gym video") can be added later behind the same tool.

## 7. Send flow
1. `send_message` takes a person ID, conversation ID or linked handle ID (deriving its person), an optional channel, the content, and optional `authorized_by` + `reason`.
2. It resolves the target: an explicit conversation, otherwise that person's most recent **direct** conversation on the chosen channel (groups require an explicit conversation ID), otherwise their newest handle on that channel. It refuses if the channel can't start a conversation (TikTok).
3. Checks: the handle belongs to that person, the TikTok reply window is open, and the Instagram rate limit isn't hit.
4. If `authorized_by` is given or a send rule matches, it sends straight away. Otherwise it creates a **draft** and returns the draft ID.
5. A sent message is stored right away as outgoing and later matched to the copy the sync brings in.

The result always echoes the resolved person, handle and channel, so the agent can double-check.

## 8. MCP tools
`find_person`, `get_person`, `create_person`, `update_person`, `add_handle`, `change_handle`, `unlink_handle`, `link_handle`, `list_unlinked`, `list_link_suggestions`, `get_timeline`, `list_conversations`, `get_conversation`, `search_messages`, `send_message`, `list_drafts`, `approve_draft`, `reject_draft`, `add_send_rule`, `remove_send_rule`, `list_send_rules`, `sync_status`.

## 9. Build phases
1. **Core and MCP:** repo, database and migrations, identity, handles with an edit log, resolver, outbox, all tools, and a fake channel. Offline tests.
2. **iMessage (imsg):** install, permissions, full history backfill, watch, 1:1 and group send. Live test: read history, then send one message to the owner.
3. **Daemon:** `serve` with sync loops, HTTP MCP on the tailnet, a launchd agent and a status tool.
4. **Instagram (Beeper):** account (confirm first), token, adapter, rate limit.
5. **Email (Resend):** reuse the existing keys; send, receive and thread.
6. **TikTok (Zernio):** account (confirm first), TikTok business account, adapter, reply window. Real-conversation test.
7. **CRM adapter** in the marketing repo: import creators as persons (storing `creator-crm` links and the person ID back in the CRM), drafts into the dashboard inbox, message events into the creator pipeline.
8. **Push** the private repo; install the MCP in Claude Code and Codex on the Air.

## 10. Tests
Vitest. Offline: core and tools against a fake channel, covering resolution, ambiguity, drafts vs authorized sends, deduplication, the handle edit log and the reply window. Live tests are gated behind `LIVE=1` and the channel name, and only ever message the owner.
