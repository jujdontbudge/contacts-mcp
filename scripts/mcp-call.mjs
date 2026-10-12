// Usage: node scripts/mcp-call.mjs <tool|--list> ['{"json":"args"}']
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const url = new URL(`http://${env.CONTACTS_HTTP_HOST || '127.0.0.1'}:${env.CONTACTS_HTTP_PORT || 8787}/mcp`);
const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${env.CONTACTS_HTTP_TOKEN}` } } });
const client = new Client({ name: 'mcp-call', version: '1.0.0' });
await client.connect(transport);
const [tool, args] = process.argv.slice(2);
if (tool === '--list') { const t = await client.listTools(); for (const x of t.tools) console.log(x.name, JSON.stringify(x.inputSchema?.properties ? Object.keys(x.inputSchema.properties) : [])); }
else { const r = await client.callTool({ name: tool, arguments: args ? JSON.parse(args) : {} });
  const txt = (r.content || []).map(c => c.text).join('\n');
  let out = txt; try { const d = JSON.parse(txt); const strip = o => { if (Array.isArray(o)) return o.map(strip); if (o && typeof o === 'object') { const c = {}; for (const [k, v] of Object.entries(o)) if (k !== 'raw') c[k] = strip(v); return c; } return o; }; out = JSON.stringify(strip(d)); } catch {}
  console.log((r.isError ? 'ERROR ' : '') + out.slice(0, Number(process.env.MAX || 1500))); }
await client.close();
