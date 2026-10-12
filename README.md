# contacts-mcp

One local source of person IDs, channel handles and conversations for AI agents. Phase 1 provides SQLite identity, resolution, audited handle edits, an authorized outbox and all MCP tools. No real channel adapters are included; the fake adapter is only for offline tests. `serve` and `sync` print `phase 3`.

## Install

Use Node 24 and npm:

```sh
npm ci
npm run build
claude mcp add contacts -- node /Users/johansardar/contacts-mcp/dist/cli.js stdio
```

Set `CONTACTS_DB` to an absolute path when the MCP host starts in a different directory. A new database is migrated automatically and uses WAL.

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

Names resolve as exact > prefix > token > trigram. Only an exact match scoring at least 0.95 with at least a 0.2 margin is sendable; tools require selecting a person ID for ambiguous results. Sending defaults to a draft. Direct sends need `authorized_by` and `reason`, or a matching standing permission. Approval rechecks identity, channel capability, reply window and rate limits. No adapter is registered in the CLI yet, so send/approval returns “Channel unavailable” until later phases supply adapters.

## Environment

- `CONTACTS_DB`: SQLite path; default `./data/contacts.db`.
- `CONTACTS_RATE_LIMIT_IMESSAGE`, `CONTACTS_RATE_LIMIT_INSTAGRAM`, `CONTACTS_RATE_LIMIT_EMAIL`, `CONTACTS_RATE_LIMIT_TIKTOK`: integer per-channel outgoing sends/hour. Instagram defaults to 20; others are unlimited unless configured. Zero blocks sends. Pending sends reserve slots across processes.

Environment variables are read from the process; `.env` is ignored and is not auto-loaded. Never commit credentials or the database.

See [ADAPTERS.md](ADAPTERS.md) for the channel contract, reconciliation behavior and spec decisions. The future creator CRM adapter should reuse person links and draft tools for the dashboard approval inbox.

```sh
npm run typecheck
npm test
```
