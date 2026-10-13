export const migrations = [
  `
CREATE TABLE persons(id TEXT PRIMARY KEY, display_name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE person_links(person_id TEXT NOT NULL REFERENCES persons(id), system TEXT NOT NULL, external_id TEXT NOT NULL, UNIQUE(system, external_id));
CREATE TABLE handles(id TEXT PRIMARY KEY, channel TEXT NOT NULL, value_normalized TEXT NOT NULL, value_raw TEXT NOT NULL, person_id TEXT REFERENCES persons(id), account_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(channel, account_id, value_normalized));
CREATE TABLE handle_events(id TEXT PRIMARY KEY, handle_id TEXT NOT NULL REFERENCES handles(id), person_id_before TEXT, person_id_after TEXT, action TEXT NOT NULL CHECK(action IN ('add','link','unlink','change')), actor TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE link_suggestions(handle_id TEXT NOT NULL REFERENCES handles(id), person_id TEXT NOT NULL REFERENCES persons(id), evidence TEXT NOT NULL, score REAL NOT NULL, status TEXT NOT NULL, UNIQUE(handle_id,person_id));
CREATE TABLE conversations(id TEXT PRIMARY KEY, channel TEXT NOT NULL, account_id TEXT NOT NULL, external_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('direct','group')), title TEXT, UNIQUE(channel,account_id,external_id));
CREATE TABLE conversation_participants(conversation_id TEXT NOT NULL REFERENCES conversations(id), handle_id TEXT NOT NULL REFERENCES handles(id), PRIMARY KEY(conversation_id,handle_id));
CREATE TABLE messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), channel TEXT NOT NULL, external_id TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('in','out')), sender_handle_id TEXT REFERENCES handles(id), sent_at TEXT NOT NULL, text TEXT NOT NULL, subject TEXT, email_to TEXT, email_cc TEXT, email_bcc TEXT, attachments TEXT NOT NULL, reply_to_external_id TEXT, raw TEXT NOT NULL, ingested_at TEXT NOT NULL, UNIQUE(channel,external_id));
CREATE TABLE outbox(id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('draft','approved','sending','sent','failed','rejected')), person_id TEXT NOT NULL REFERENCES persons(id), conversation_id TEXT REFERENCES conversations(id), handle_id TEXT NOT NULL REFERENCES handles(id), channel TEXT NOT NULL, payload TEXT NOT NULL, authorized_by TEXT, reason TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT, sent_message_id TEXT REFERENCES messages(id), error TEXT);
CREATE TABLE send_rules(id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('person','tag','kind')), value TEXT NOT NULL, channels TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, active INTEGER NOT NULL);
CREATE TABLE sync_state(channel TEXT NOT NULL, account_id TEXT NOT NULL, cursor TEXT, last_ok_at TEXT, last_error TEXT, PRIMARY KEY(channel,account_id));
CREATE INDEX messages_time ON messages(sent_at);
CREATE INDEX handles_person ON handles(person_id);
CREATE INDEX outbox_rate ON outbox(channel,status,decided_at);
`,
  `CREATE TABLE staged_outgoing(outbox_id TEXT PRIMARY KEY REFERENCES outbox(id), payload TEXT NOT NULL);`,
  `CREATE TABLE channel_secrets(channel TEXT NOT NULL, account_id TEXT NOT NULL, access_token TEXT NOT NULL, refreshed_at TEXT NOT NULL, PRIMARY KEY(channel,account_id));`,
  // Repair: remove our own sending accounts from conversation participants (they were
  // added as the sender of outgoing messages), except in a chat with ourselves.
  `DELETE FROM conversation_participants WHERE handle_id IN (SELECT DISTINCT sender_handle_id FROM messages WHERE direction='out' AND sender_handle_id IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM conversations c JOIN handles h ON h.id=conversation_participants.handle_id WHERE c.id=conversation_participants.conversation_id AND instr(c.external_id, h.value_normalized) > 0);`,
  `ALTER TABLE send_rules ADD COLUMN removed_by TEXT;
ALTER TABLE send_rules ADD COLUMN removed_at TEXT;
ALTER TABLE outbox ADD COLUMN reconciled_at TEXT;
ALTER TABLE outbox ADD COLUMN target_snapshot TEXT;
ALTER TABLE outbox ADD COLUMN send_started_sequence INTEGER;
CREATE INDEX outbox_reconcile ON outbox(channel,status,conversation_id);
CREATE INDEX messages_conversation_time ON messages(conversation_id,sent_at);
CREATE TABLE sync_leases(channel TEXT NOT NULL, account_id TEXT NOT NULL, owner TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(channel,account_id));`,
  `CREATE TABLE inbox_config(id INTEGER PRIMARY KEY CHECK(id=1), cutoff TEXT NOT NULL, actor TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE inbox_handling(message_id TEXT PRIMARY KEY REFERENCES messages(id), outcome TEXT NOT NULL CHECK(outcome IN ('new','claimed','auto_replied','escalated','ignored','done')), actor TEXT NOT NULL, note TEXT NOT NULL, rule TEXT, outbox_id TEXT REFERENCES outbox(id), claim_token TEXT, claim_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE inbox_events(id TEXT PRIMARY KEY, message_id TEXT REFERENCES messages(id), outcome TEXT NOT NULL, actor TEXT NOT NULL, note TEXT NOT NULL, rule TEXT, outbox_id TEXT REFERENCES outbox(id), claim_token TEXT, claim_expires_at TEXT, at TEXT NOT NULL);
ALTER TABLE outbox ADD COLUMN idempotency_key TEXT;
ALTER TABLE outbox ADD COLUMN inbox_message_id TEXT REFERENCES messages(id);
CREATE UNIQUE INDEX outbox_idempotency ON outbox(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX outbox_inbox_reply ON outbox(inbox_message_id) WHERE inbox_message_id IS NOT NULL;
CREATE INDEX inbox_state ON inbox_handling(outcome,claim_expires_at);
CREATE INDEX messages_inbox ON messages(direction,sent_at);`,
  `ALTER TABLE handles ADD COLUMN profile TEXT;`,
];
