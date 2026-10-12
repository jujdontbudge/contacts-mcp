Synthetic offline NDJSON, not private Messages data. Field names and shapes follow
imsg v0.16.0 `docs/json.md`, `OutputModels.swift`, and history/watch commands:
https://github.com/openclaw/imsg/tree/v0.16.0
Source checkout commit: 25c98a026bf9fe2c6f9473c00376672581089d62.
History records are newest-first; IDs intentionally interleave across chats to
catch cursor advancement that would silently skip an older chat.
