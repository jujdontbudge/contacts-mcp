# Phase 1 adapter handoff

Implement `Channel` in `src/channels/channel.ts`, register it with `ChannelRegistry`, and pass that registry to `ContactsCore`. Call `core.ingest(event)` for inbound and synced outgoing events. External message IDs must be stable and globally unique within their channel, as specified. Supply `account_id`, remote conversation ID, sender handle and participants; include all group participants. Phone normalization defaults to US for national numbers; use E.164 for other countries. Account IDs default to `default` only for manually added handles.

The spec leaves numeric resolver weights open: exact = 1, prefix = 0.74, full query-token inclusion = 0.65, trigram Dice similarity × 0.59. Unknown senders create unlinked handles and similarity suggestions (score ≥ 0.3), never automatic links. `link_handle` requires the caller’s explicit exact-proof statement. Value edits preserve old/new raw values in the required edit-log reason field, avoiding extra schema columns.

A conversation-only send infers its person only when exactly one linked person participates; otherwise select a person ID. Without a channel, the most recent conversation selects it; absent history, a sole handle channel selects it, otherwise choose explicitly. Draft approval re-resolves and checks its stored person/handle/channel. Outgoing messages initially have an unknown (`null`) sender handle because `Channel.send` does not return the sending identity; ingest fills it from the canonical synced copy. Reconciliation retains message IDs and updates the outbox conversation link.

Adapter failures are stored as `failed` and are not automatically retried. A crash or local persistence failure after external send leaves `sending` for manual reconciliation, preventing blind duplicate sends. `approved` is recorded inside the transaction that reserves `sending`. Sync cursor scheduling and recovery are phase 3.

The future creator CRM adapter can store `creator-crm` links, show `list_drafts` in the existing dashboard approval inbox and invoke approve/reject; no parallel CRM or marketing-repo changes are needed.
