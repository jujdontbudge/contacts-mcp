# Phase 1 adapter handoff

Implement `Channel` in `src/channels/channel.ts`, register it with `ChannelRegistry`, and pass that registry to `ContactsCore`. Call `core.ingest(event)` for inbound and synced outgoing events. External message IDs must be stable and globally unique within their channel, as specified. Supply `account_id`, remote conversation ID, sender handle and participants; include all group participants. Phone normalization defaults to US for national numbers; use E.164 for other countries. Account IDs default to `default` only for manually added handles.

The spec leaves numeric resolver weights open: exact = 1, prefix = 0.74, full query-token inclusion = 0.65, trigram Dice similarity × 0.59. Unknown senders create unlinked handles and similarity suggestions (score ≥ 0.3), never automatic links. `link_handle` requires the caller’s explicit exact-proof statement. Value edits preserve old/new raw values in the required edit-log reason field, avoiding extra schema columns.

A conversation-only send infers its person only when exactly one linked person participates; otherwise select a person ID. Without a channel, the most recent conversation selects it; absent history, a sole handle channel selects it, otherwise choose explicitly. Draft approval re-resolves and checks its stored person/handle/channel. Outgoing messages initially have an unknown (`null`) sender handle because `Channel.send` does not return the sending identity; ingest fills it from the canonical synced copy. Reconciliation retains message IDs and updates the outbox conversation link.

Adapter failures are stored as `failed` and are not automatically retried. A crash or local persistence failure after external send leaves `sending` for manual reconciliation, preventing blind duplicate sends. `approved` is recorded inside the transaction that reserves `sending`. Sync cursor scheduling and recovery are phase 3.

The future creator CRM adapter can store `creator-crm` links, show `list_drafts` in the existing dashboard approval inbox and invoke approve/reject; no parallel CRM or marketing-repo changes are needed.

## TikTok — Zernio (phase 6, offline implementation)

`src/channels/tiktok.ts` exports `createTikTokChannel(opts)` implementing `Channel`, plus `getCursor()` and `getLastInboundAt(conversationExternalId)`. Options are `apiKey`, `accountId`, `baseUrl`, injectable `fetch` (the native fetch signature) and `clock`. Defaults read `ZERNIO_API_KEY`, `ZERNIO_TIKTOK_ACCOUNT_ID`, and `ZERNIO_BASE_URL` (default `https://zernio.com/api`). Auth is `Authorization: Bearer <key>`. No SDK or additional dependencies.

Registration at the composition layer (not wired here):

```ts
import { createTikTokChannel } from "./channels/tiktok.js";
const tiktok = createTikTokChannel();
registry.register(tiktok);
```

Sync lists every conversation page with `accountId` and `platform=tiktok`, filters other accounts/platforms, fetches every message page with required `accountId`, and sorts each thread by timestamp and ID without assuming TikTok honors sort order. The opaque Zernio pagination cursors are forwarded verbatim. Partial account failures/skips and broken pagination throw instead of recording a successful empty sync. Unknown fields are retained in `raw: { conversation, message }`; invalid required IDs, timestamps and directions fail closed.

Cursor integration for the daemon owner: persist `tiktok.getCursor()` into the existing `sync_state` for this account after a successful sync. The base `Channel` interface has no checkpoint return value, so the composition layer needs to call this adapter's small additional interface; core needs no edit. A watermark is advanced only when the generator resumes after a yielded event (after ingestion). Interrupted/failed ingest therefore permits safe replay. The base64url JSON cursor carries version/account plus each thread's latest message time, all IDs at that timestamp, and last inbound time. Resume scans all thread pages but yields only unseen watermark/newer messages. A delayed historic message older than a saved watermark, or an edit to an older message, requires a reconciliation sweep with `sync()` without a cursor; core deduplicates stable IDs. Never reset the stored cursor on a failed run.

```ts
for await (const event of tiktok.sync(savedCursor)) core.ingest(event);
const nextCursor = tiktok.getCursor(); // save to the existing sync_state
```

`direction: in` and real `sent_at` timestamps are exactly what `OutboxService` queries for its 48-hour gate. No additional reply-window hook is needed. Stable identity uses `tiktok:user:<opaque TikTok user ID>` (case preserved). When returned, `@participantUsername` is also a participant handle; `participantName` is display text only. Core does not auto-link these two handles: attach them to the same person only with explicit exact-ID proof. The original participant fields remain in raw. Outgoing sender IDs are preserved; absent sender ID uses `tiktok:account:<Zernio account ID>`. Message IDs are `zernio:<encoded account>:<encoded conversation>:<encoded platform message ID>`, identically on send and sync, preventing cross-account/thread collisions in core's channel-wide unique key.

Send requires an existing remote thread, correct account/channel, direct conversation and supported content. There is no create-conversation call. Before POST it paginates current thread history and refuses absent/expired inbound (at 48 hours exactly) or ten outgoing messages since the latest inbound. This counts native human replies too; a new inbound resets the budget. Sends are serialized within one instance; Zernio/TikTok remain authoritative for concurrent processes, eventual history visibility and delivery. Text limit is 6,000 characters; one image must declare JPG/PNG MIME type; upstream enforces the 3 MB limit. Unsupported email fields, multiple/non-image media and undocumented quote replies are rejected. A successful send returns the original opaque target thread ID; the generic send docs warn some other platforms return a different stored conversation ID, so confirm TikTok's correlation live. Errors distinguish window closure, rate limits (including Retry-After), auth and other HTTP failures. Sends are never retried automatically; opaque failures or missing sent IDs require reconciliation before retrying.

### Documentation checked 2026-10-12

- [TikTok inbox](https://docs.zernio.com/platforms/tiktok#direct-messages): Business-app connection, Business Account, eligible sign-up region outside EEA/Switzerland/UK, messaging permissions and accepting DMs; replies only, ten business messages within 48 hours of the latest inbound.
- [Conversation listing](https://docs.zernio.com/messages/list-inbox-conversations): `accountId` is optional in generic schema (always supplied here). The supported-platform prose and platform enum still omit `tiktok`, contradicting the platform guide. This adapter deliberately requests both `accountId` and `platform=tiktok`; a schema rejection is surfaced, not silently turned into another account's inbox. Confirm acceptance with an authenticated read or vendor clarification.
- [Message listing](https://docs.zernio.com/messages/get-inbox-conversation-messages): `accountId` required; pagination uses `pagination.nextCursor`, `hasMore`; native message ID is `id`, not webhook `platformMessageId`. TikTok is absent from the documented list of platforms that honor sort order, so all pages are read and locally sorted.
- [Send](https://docs.zernio.com/messages/send-inbox-message): JSON body `accountId`, `message`, optional `attachmentUrl`/`attachmentType`; response `data.messageId`. Thread path IDs are opaque, preserved verbatim and URL encoded.
- [Quickstart/auth](https://docs.zernio.com/): default base URL and Bearer header. No `X-API-Key` header.
- [Inbox webhooks](https://docs.zernio.com/webhooks/inbox): current message schema **does include TikTok**, unlike the older research snapshot; `message.received`/`message.sent` and reactions are documented. Webhook message IDs differ in field naming from REST. No webhook receiver or daemon edit is part of this adapter; use the existing scheduled sync loop (spec: two minutes).
- TikTok pre-connection full-history backfill is not guaranteed in the reviewed docs; “read all” here means all messages made available by every paginated API response. Fixture payloads are synthetic documented shapes, not live captures.

### Exact live verification still needed (owner-authorized, not run)

1. On the Air, ask the owner immediately before creating a Zernio account or final OAuth consent and before any spend. Connect the intended TikTok Business Account through the Business app, grant messaging permissions, enable incoming DMs/message requests and confirm eligible sign-up region. Record its Zernio account ID and put the key/account ID in untracked environment settings. Do not print secrets.
2. Register the adapter above in the composition layer, use an isolated test database, and run `sync()` through `core.ingest`. Verify the actual GET `/v1/inbox/conversations?accountId=<id>&platform=tiktok&limit=100` is accepted. If `platform=tiktok` is rejected, capture the non-secret error and get vendor confirmation; test an accountId-only read separately before changing the adapter.
3. Have the owner send an initial message manually to a consenting test participant, then have that participant send a reply. Sync again and verify remote conversation ID, user ID/username, direction, original timestamps, text and image metadata against TikTok. Compare old known threads/messages to determine pre-connect coverage; verify native-app outgoing visibility and page beyond 100 messages/conversations where available.
4. Save `getCursor()` only after ingestion completes; recreate the adapter and sync with that cursor. Confirm zero duplicates, then a new inbound appears once and updates stored last inbound. Simulate an interrupted consumer and verify safe replay. Link the observed TikTok user ID/username to the test person with exact proof.
5. With explicit authorization to send that one reply, invoke core `send_message` for the existing conversation within 48 hours. Confirm delivery in TikTok, sync its copy and confirm a single stored outgoing message matches the returned external ID. Test an owner-approved small PNG/JPG separately if image sending is required.
6. Attempt no-contact sending (no remote conversation) and confirm local refusal/no POST. At/after 48 hours, confirm core refuses without HTTP send. Validate the ten-message budget with synthetic offline tests first; only exhaust a real window with separate explicit owner authorization. Confirm a new inbound resets it. Capture actual non-secret TikTok error codes for window/rate-limit mapping when naturally encountered. Never blind-retry an ambiguous failed send.

Future CRM composition can expose these core drafts through the existing creator dashboard approval inbox and ingest replies into the pipeline, using contacts person IDs and `creator-crm` links. This adapter owns no dashboard, scheduler or alternate tracker.
