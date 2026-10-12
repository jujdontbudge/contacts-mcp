# Phase 1 adapter handoff

Implement `Channel` in `src/channels/channel.ts`, register it with `ChannelRegistry`, and pass that registry to `ContactsCore`. Call `core.ingest(event)` for inbound and synced outgoing events. External message IDs must be stable and globally unique within their channel, as specified. Supply `account_id`, remote conversation ID, sender handle and participants; include all group participants. Phone normalization defaults to US for national numbers; use E.164 for other countries. Account IDs default to `default` only for manually added handles.

The spec leaves numeric resolver weights open: exact = 1, prefix = 0.74, full query-token inclusion = 0.65, trigram Dice similarity × 0.59. Unknown senders create unlinked handles and similarity suggestions (score ≥ 0.3), never automatic links. `link_handle` requires the caller’s explicit exact-proof statement. Value edits preserve old/new raw values in the required edit-log reason field, avoiding extra schema columns.

A conversation-only send infers its person only when exactly one linked person participates; otherwise select a person ID. Without a channel, the most recent conversation selects it; absent history, a sole handle channel selects it, otherwise choose explicitly. Draft approval re-resolves and checks its stored person/handle/channel. Outgoing messages initially have an unknown (`null`) sender handle because `Channel.send` does not return the sending identity; ingest fills it from the canonical synced copy. Reconciliation retains message IDs and updates the outbox conversation link.

Adapter failures are stored as `failed` and are not automatically retried. A crash or local persistence failure after external send leaves `sending` for manual reconciliation, preventing blind duplicate sends. `approved` is recorded inside the transaction that reserves `sending`. Sync cursor scheduling and recovery are phase 3.

The future creator CRM adapter can store `creator-crm` links, show `list_drafts` in the existing dashboard approval inbox and invoke approve/reject; no parallel CRM or marketing-repo changes are needed.

## Instagram via Beeper Desktop (phase 4)

Register `createInstagramChannel()` from `src/channels/instagram.ts` with `registry.register(...)` before constructing `ContactsCore({ registry })`. Set `BEEPER_ACCESS_TOKEN`, optional `BEEPER_BASE_URL` (default `http://localhost:23373`) and `BEEPER_INSTAGRAM_ACCOUNT_ID` (otherwise exactly one Instagram account is required). Use that account ID on handles/targets. Desktop must remain running; new DMs need v4.2.808+. The MIT SDK is pinned to 6.0.0. Route sends through the core outbox for authorization and its existing 20/hour Instagram limit; that limit cannot guarantee freedom from network restrictions.

Sync auto-paginates API-visible history and retrieves all participants. The base64url cursor holds the account and per-chat timestamp/sort key. `Channel` has no cursor-output method: persist `getCursor()` after full sync, or use awaited `onCursor(cursor)` checkpoints, called when the consumer resumes **after** successful `core.ingest(event)`. Replay after interruption is safe. Sync buffers one chat and scans full history each time, resuming emissions rather than opaque HTTP pagination tokens. Older edits/backfills require a no-cursor rescan; Beeper does not guarantee complete history.

Live subscribes to all chats at authenticated `/v1/ws`, filters to the selected account and ingests hydrated `message.upserted` entries. Reconnect backs off from 1s to 30s; call cleanup on shutdown and supply `onError`. Reconcile via REST every five minutes because sockets have no durable replay. `client` and `socketFactory` support offline injection. Missing usernames/incomplete participants fail closed. Attachments are metadata-only, with complete payloads retained in `raw`.

New DMs start without message text, then verify exactly one non-self recipient matching the normalized username and no `cannotMessage`. Existing direct chats also verify identity; groups require an existing chat ID. Merged/foreign/read-only chats are refused. Sends support text/replies only. Message and reply IDs encode JSON `[chatID, messageID]`. Pending sends receive bounded confirmation reads (20 at 250ms intervals); uncertain writes are never retried. Reconcile failures manually before retrying.

Live checks remain: owner-approved account/token setup; actual usernames/participants and history pagination; new-DM creation without initial text; pending-to-canonical IDs/status; owner-only direct/group/reply sends; socket auth/events and Desktop restart. No setup or real send was performed. Synthetic SDK-typed fixtures cover offline mapping, pagination, cursor resume, refusals, confirmation and reconnect.
## Phase 5: Resend email adapter

`src/channels/email.ts` exports `createEmailChannel(opts)`, an injectable-fetch adapter with start-conversation, groups and CC/BCC capabilities. No SDK or new dependency is needed. Environment defaults are `CONTACTS_EMAIL_FROM` (required), `CONTACTS_EMAIL_REPLY_TO` (optional), `RESEND_API_KEY` (send) and `RESEND_FULL_API_KEY` (receive/read sent metadata). `accountId` defaults to `default`; send rejects another account. An outbound subject is required unless inherited from a stored reply. Adapter-level `EmailContent` adds optional `html` and `outbox_id`; phase 1 core/tool schemas do not yet forward those two fields.

Sync starts at the newest received page, follows `after=<last page ID>` backwards, stops before the supplied received-email ID, retrieves full bodies/headers, then emits oldest first. Persist the last successfully ingested event's `external_id` as the cursor. Empty polls keep the previous cursor. A missing/expired cursor causes a deduplicated backfill. Outgoing email is staged at send time rather than mixed into the received cursor stream.

Thread keys use the first References ID, then In-Reply-To, resolving known/stored ancestors before hashing an unknown root. Headerless threads fall back to normalized subject plus sorted visible participants. Persist and supply `lookupMessage(id)` for both Resend IDs and RFC Message-IDs so a resumed/restarted adapter can reuse the original conversation key. Incoming parent links resolve to the parent's Resend ID when known; otherwise they retain the RFC header ID. Participants are lowercased From/To/CC addresses; BCC is preserved per outgoing message but excluded from visible conversation participants. Direction compares the From domain exactly to the configured sender domain. Full provider content, HTML, headers and received attachment metadata remain in `raw`; downloading attachment bytes is outside this adapter.

Send uses the outbox ID verbatim as `Idempotency-Key`. Supply `getOutboxId(target, content)` or adapter-level `content.outbox_id`; missing/ambiguous dispatch context must fail before HTTP, never generate a random key. Reply headers use the stored actual RFC Message-ID and extend the parent's References. The provider-issued sent Message-ID is fetched after send and preserved in `raw.message_id`; a metadata retrieval failure still reports a successful send, but replies to that message are blocked until its RFC ID has been reconciled. Resend idempotency retention is 24 hours; this does not authorize blind retries of old outbox entries.

### Registration and phase 1 integration seam

The current `Channel.send` contract does not carry the outbox ID. Its core dispatch inserts an outgoing row **after** the adapter returns, so passing `core.ingest` directly as `onSent` causes a duplicate-row conflict. These are composition responsibilities until a future core API passes dispatch context and atomically reconciles the event:

```ts
import { createEmailChannel } from "./channels/email.js";

const email = createEmailChannel({
  // Resolve exactly the sending outbox by target + payload; reject ambiguity.
  getOutboxId: (target, content) => emailBridge.dispatchingOutboxId(target, content),
  // Return an IngestEvent with conversation_external_id and raw Resend metadata.
  lookupMessage: id => emailBridge.lookupStoredMessage(id),
  // Durably stage; do not call phase 1 core.ingest here.
  onSent: event => emailBridge.stageSent(event),
});
registry.register(email);

// In the composition wrapper, immediately after each awaited send/approve:
await email.flushSent(); // retries a failed staging sink; never sends email again
await emailBridge.reconcileStaged(event => core.ingest(event));
```

`emailBridge` denotes the integrating application's durable composition adapter, not an implementation bundled here. It should map each external/RFC message ID to a stored event, provide the exact dispatching outbox ID, stage outgoing metadata durably and reconcile after core persistence. An offline integration test proves this ordering with an in-memory staging sink. If staging fails, `send` still returns the provider ID and retains the event in an in-process retry buffer; the application must call `flushSent()` and surface persistent staging errors. That buffer alone does not survive a crash. No registry, CLI, daemon, core or schema file was changed in this phase.

Creator-system connection: the future composition adapter in the marketing repo should reuse the creator dashboard's approval inbox for contacts outbox drafts, retain `creator-crm` person links, and feed reconciled email events into the existing reply/follow-up jobs. Creators keeps do-not-contact/deal decisions; contacts keeps identities and conversation history. This avoids another outreach tracker or direct coupling between sections.

Verified against official Resend docs on 2026-10-12: [sending](https://resend.com/docs/api-reference/emails/send-email), [received lists](https://resend.com/docs/api-reference/emails/list-received-emails), [received retrieval](https://resend.com/docs/api-reference/emails/retrieve-received-email), [sent retrieval](https://resend.com/docs/api-reference/emails/retrieve-email), and [pagination](https://resend.com/docs/api-reference/pagination). Offline fixtures contain only invented addresses/content; no live sends are permitted by these tests.
