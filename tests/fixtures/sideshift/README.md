# SideShift recruit fixture

`recruit.json` preserves the field shapes returned by authenticated read-only
GETs on 2026-10-14 UTC (2026-10-13 in Chicago): `/jobs`, `/support-channels`,
`/conversations`, and both message-list endpoints for the same native UUID room.
IDs, names, message bodies and URLs are replaced with synthetic values. The job
record is reduced to the identity fields the adapter consumes.

Both lists expose this room: `chatType: native`, `kind: support`, a creator in
`participants`, company and creator IDs in `members`, and a null `channelId`.
The creator reply carries `senderUserId`; the manual brief carries the company
ID. The original brand invite has `sender`/`senderName` display names but **null**
`senderUserId` and `senderExternalUserId`. Neither endpoint exposes its job card.
The adapter must skip that unresolved invite, never infer ownership from its
name, and continue importing the resolved messages. Tests add synthetic future
replies and unknown senders to exercise inbox and safety behavior.
