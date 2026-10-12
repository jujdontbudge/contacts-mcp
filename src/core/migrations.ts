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
];
