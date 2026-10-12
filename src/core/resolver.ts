import { normalizeHandle } from "../channels/channel.js";
import { Identity } from "./identity.js";
import { Conversations } from "./conversations.js";
export function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@+]+/gu, " ")
    .trim();
}
function trigrams(v: string): Set<string> {
  const text = `  ${v}  `;
  return new Set(
    Array.from({ length: Math.max(0, text.length - 2) }, (_, i) =>
      text.slice(i, i + 3),
    ),
  );
}
function score(query: string, value: string): number {
  if (query === value) return 1;
  if (value.startsWith(query)) return 0.74;
  const tokens = query.split(" ");
  if (tokens.every((t) => value.split(" ").includes(t))) return 0.65;
  const a = trigrams(query),
    b = trigrams(value);
  const shared = [...a].filter((x) => b.has(x)).length;
  return 0.59 * ((2 * shared) / (a.size + b.size));
}
export class Resolver {
  constructor(
    private identity: Identity,
    private conversations: Conversations,
  ) {}
  find(query: string) {
    const queries = new Set([normalized(query)]);
    if (!queries.has(""))
      for (const c of ["imessage", "email", "instagram", "tiktok"] as const) {
        try {
          queries.add(normalized(normalizeHandle(c, query)));
        } catch {
          /* Not a phone number. */
        }
      }
    const candidates = this.identity
      .list()
      .map((p) => {
        const detail = this.identity.detail(p.id);
        const values = [
          p.display_name,
          ...p.aliases,
          ...detail.links.map((l) => `${l.system}:${l.external_id}`),
        ];
        const typedHandle = query.includes("@") || /^(tiktok:|beeper:|igsid:)/.test(query);
        let best = 0;
        for (const value of values) {
          for (const q of queries) if (q) best = Math.max(best, Math.min(typedHandle ? 0.94 : 1, score(q, normalized(value))));
          if (best === 1) break;
        }
        // Names are accent/punctuation tolerant; handles keep their channel's exact identity.
        // Never turn foo.bar and foo_bar, or case-sensitive platform IDs, into exact proof.
        for (const handle of detail.handles) {
          let exact = false;
          try { exact = normalizeHandle(handle.channel, query) === handle.value_normalized; }
          catch { /* Query is not a handle on this channel. */ }
          if (exact) best = 1;
          else for (const q of queries) if (q) best = Math.max(best, Math.min(0.94, score(q, normalized(handle.value_normalized))));
        }
        const last_message = this.conversations.timeline(p.id, 1)[0] ?? null;
        return {
          ...detail,
          score: best,
          last_message,
          last_channel: last_message?.channel ?? null,
        };
      })
      // Drop weak fuzzy noise so an unknown name reports not_found instead of random people.
      .filter((p) => p.score >= 0.2)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const top = candidates[0];
    const margin = top ? top.score - (candidates[1]?.score ?? 0) : 0;
    const sendable = !!top && top.score >= 0.95 && margin >= 0.2;
    return {
      status: sendable
        ? ("resolved" as const)
        : candidates.length
          ? ("ambiguous" as const)
          : ("not_found" as const),
      sendable,
      person_id: sendable ? top.id : null,
      candidates,
    };
  }
}
