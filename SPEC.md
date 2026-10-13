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
- `handles(id PK, channel, value_normalized, value_raw, person_id NULL, account_id, created_at, profile JSON NULL, UNIQUE(channel, account_id, value_normalized))`. Channels: `imessage | instagram | email | tiktok | sideshift`. Phone numbers are normalized to E.164 and emails to lower case.
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
  id: 'imessage' | 'instagram' | 'email' | 'tiktok' | 'sideshift';
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
`find_person`, `get_person`, `create_person`, `update_person`, `add_handle`, `change_handle`, `unlink_handle`, `link_handle`, `list_unlinked`, `list_link_suggestions`, `get_timeline`, `list_conversations`, `get_conversation`, `search_messages`, `send_message`, `list_drafts`, `approve_draft`, `reject_draft`, `add_send_rule`, `remove_send_rule`, `list_send_rules`, `sync_status`, `list_inbox`, `claim_inbox`, `mark_inbox`, `set_inbox_cutoff`.

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

## 11. Inbox handling and at-most-once replies

Core owns `Inbox` behind list/claim/mark/config methods; MCP and CLI remain thin.
Migration 6 adds `inbox_config` (cutoff, actor, update time), `inbox_handling`
(one row per handled inbound) and append-only `inbox_events`. Handling rows
contain outcome, actor, note, optional rule/outbox ID, claim token/expiry and
creation/update times. Outcomes are `new`, `claimed`, `auto_replied`, `escalated`,
`ignored`, `done`. Missing rows represent `new`; eligible list results persist
that initial state lazily, without allocating handling rows for historical
backfill. State changes and cutoff changes are audited.

`list_inbox({channels?,limit?})` returns `{cutoff,items}` with inbound metadata,
linked person `{id,name,tags}` or null, handle, conversation ID, latest five
thread messages and state. No raw payloads. Default channels: email, instagram,
tiktok, sideshift. iMessage requires explicit inclusion. Default limit 100, maximum 1000.
Only inbound provider timestamps strictly after the persisted cutoff qualify.
No cutoff means disabled, never an implicit historical inbox.

`claim_inbox({message_ids,actor,lease_seconds?})` returns
`{claim_token,claim_expires_at,items}`. All-or-nothing immediate SQLite
transactions coordinate processes. Default lease 600 seconds, bounded 1–3600.
Expired claims are listable; reacquisition creates a fresh fencing token.
`mark_inbox({message_id,claim_token,outcome,actor,note,rule?,outbox_id?})`
requires ownership and a final outcome. Exact repetitions do not add audit
entries; conflicting final decisions fail. `auto_replied` needs a confirmed
bound send. A worker can finish recording its own confirmed bound reply after
reply reconciliation; its token must still match that send's original claim.
`set_inbox_cutoff({cutoff,actor})` and CLI `inbox cutoff <ISO|now> <actor>` audit
activation. Cutoff changes never reopen finalized messages.

`send_message` adds optional `idempotency_key`, `inbox_message_id`, `claim_token`.
Unique indexes enforce one outbox per non-null key and bound inbound. Creation,
claim checking and dispatch reservation use immediate transactions; dispatch
rechecks the token before the external await. Every retry returns the original
record with `already_used: true`; no retry path dispatches it again. An initial
result has false. Keys are permanent and global, not scoped to an actor/channel.
Automation must bind its inbound and supply its claim token/conversation, using
`rule:<rule-id>:msg:<message-id>` or `rule:<rule-id>:person:<person-id>`.
Duplicate once-per-person results can belong to a different message and should
lead to an `ignored` decision for the current inbound.

At most one provider dispatch is guaranteed per key/bound inbound, including
crashes before/after external writes and overlapping workers. This is not an
exactly-once delivery claim. Interrupted drafts/sending records are returned
without automatically resuming; only explicit owner draft approval can dispatch
a retained draft. Conservative existing outgoing reconciliation also admits
keyed `sending` crash records, with the same identity/time/sequence/content
checks as failed sends. Uncertain entries never retry external mutations.

A confirmed outgoing message strictly later in the same conversation closes
earlier pending inbound, including manually sent/synced replies and late
inbound ingestion. Provider pending/failed copies are excluded. Inbox operations
persist `done` (reply elsewhere) or `auto_replied` (confirmed bound reply),
retaining final decisions and audit. This rule intentionally covers all pending
inbound in a group thread. See README's Inbox automation workflow.

Offline tests cover overlapping connections, rollback of claim sets, exact
expiry, stale fencing, cutoff/history, personal-channel exclusion, manual
replies, permanent once-per-person keys, concurrent send calls, crash before
dispatch and after mutation, sync recovery, binding and idempotent finalization.

## 12. SideShift

SideShift is a Platform REST channel behind the existing `Channel` interface.
Registration uses `CONTACTS_CHANNELS=sideshift` and `SIDESHIFT_API_KEY`; no new
account setup or messaging webhook is needed. The poll delay is two minutes,
configurable by `CONTACTS_SYNC_INTERVAL_SIDESHIFT_MS`. Both support channels and
DM conversations enter the same core history and default business inbox.
The 15-minute inbox worker needs no change to its list/claim/send/mark sequence.

Migration 7 adds nullable JSON `handles.profile`. Optional `Channel.syncProfiles`
returns identity observations under the same sync lease, before message sync;
it creates no synthetic conversation or inbound for an applicant without chat.
`IngestEvent.handle_profiles` carries observations from conversation peers.
Core owns profile persistence and linking: an exact SideShift `person_links`
user ID can link an unlinked handle with audit; conflicting links fail instead
of reassigning. Names and public Instagram/TikTok handles are suggestions only.
No new person IDs are invented during sync.

SideShift handles preserve case-sensitive creator user IDs, display names,
exposed profile/image URLs, social handles and all observed applicant job IDs.
Company/member identities remain outgoing senders, never recipients. Where the
API cannot resolve a provider customer to a SideShift user, a scoped provider
handle stays unlinked. Missing direction proof fails sync instead of guessing.

Reply routing is explicit (`support:<remote ID>` or `dm:<remote ID>`).
New applicant messages use `/applicants/message`, with the selected SideShift
user ID and approved `metadata.sideshift_job_id`. `includeJobLink: false`
keeps the single approved text as the only message. Core's authorization,
drafts, standing rules, permanent idempotency keys and reconciliation apply.
The composition passes the active outbox ID as provider `Idempotency-Key`.
No automatic POST retry occurs; uncertain results await conservative synced
outgoing evidence. Delivery=false is uncertain, never confirmed sent.

The canonical pagination, sync checkpoints, rate/error policy and provider
limitations are in [ADAPTERS.md](ADAPTERS.md#sideshift-platform-rest).
