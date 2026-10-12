import {
  emailSubject as subjectKey,
  emailHeader as header,
  emailMessageIds as messageIds,
  emailRfcId as rfcId,
} from "../core/email-threading.js";
import { createHash } from "node:crypto";
import type {
  Channel,
  IngestEvent,
  SendContent,
  SendTarget,
} from "./channel.js";

type MaybePromise<T> = T | Promise<T>;
export type EmailContent = SendContent & { html?: string; outbox_id?: string };
export interface ResendEmail {
  id: string;
  from: string;
  to: string[];
  cc?: string[] | null;
  bcc?: string[] | null;
  subject: string;
  created_at: string;
  text?: string | null;
  html?: string | null;
  message_id?: string | null;
  headers?: Record<string, string>;
  attachments?: unknown[];
}
export interface EmailChannelOptions {
  from?: string;
  replyTo?: string;
  apiKey?: string;
  fullApiKey?: string;
  accountId?: string;
  fetch?: typeof globalThis.fetch;
  pageSize?: number;
  /** Must resolve exactly the outbox being dispatched, never guess among matches. */
  getOutboxId?: (
    target: SendTarget,
    content: EmailContent,
  ) => MaybePromise<string>;
  /** Lookup stored events by Resend ID OR RFC Message-ID, including across restarts. */
  lookupMessage?: (id: string) => MaybePromise<IngestEvent | undefined>;
  /** Durable event staging sink; phase 1 core ingestion must happen after dispatch. */
  onSent: (event: IngestEvent) => MaybePromise<void>;
  /** Durable retry inventory; queried on every sync, including after restart. */
  missingMessageIds?: () => MaybePromise<string[]>;
  onMetadata?: (id: string, detail: ResendEmail) => MaybePromise<void>;
  clock?: () => Date;
}

function address(raw: string): string {
  const value = (raw.match(/<([^<>]+)>/)?.[1] ?? raw).trim().toLowerCase();
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+$/.test(value))
    throw new Error("Invalid email address");
  return value;
}
function addresses(values: string[] = []): string[] {
  return [...new Set(values.map(address))];
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function emailRaw(event: IngestEvent): ResendEmail | undefined {
  const raw = event.raw as ResendEmail | undefined;
  return raw && typeof raw === "object" ? raw : undefined;
}

export interface EmailChannel extends Channel {
  send(
    target: SendTarget,
    content: EmailContent,
  ): Promise<{ externalId: string; conversationExternalId: string }>;
  /** Retry failed staging, without ever resending an email. */
  flushSent(): Promise<void>;
  refreshSent(): Promise<void>;
}

export function createEmailChannel(opts: EmailChannelOptions): EmailChannel {
  const from = opts.from ?? process.env.CONTACTS_EMAIL_FROM;
  if (!from) throw new Error("CONTACTS_EMAIL_FROM missing");
  const sender = address(from);
  const domain = sender.split("@")[1];
  const replyTo = opts.replyTo ?? process.env.CONTACTS_EMAIL_REPLY_TO;
  if (replyTo) address(replyTo);
  const apiKey = opts.apiKey ?? process.env.RESEND_API_KEY;
  const fullApiKey = opts.fullApiKey ?? process.env.RESEND_FULL_API_KEY;
  const accountId = opts.accountId ?? "default";
  const http = opts.fetch ?? globalThis.fetch;
  const pageSize = opts.pageSize ?? 100;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)
    throw new Error("pageSize must be an integer from 1 to 100");
  const known = new Map<string, IngestEvent>();
  const unstaged = new Map<string, IngestEvent>();
  let flushing: Promise<void> | undefined;
  function flushSent(): Promise<void> {
    if (flushing) return flushing;
    flushing = (async () => {
      for (const [id, event] of unstaged) {
        await opts.onSent(event);
        unstaged.delete(id);
      }
    })().finally(() => {
      flushing = undefined;
    });
    return flushing;
  }
  async function lookup(id: string): Promise<IngestEvent | undefined> {
    // Core may have joined this event by subject or repaired a legacy split after
    // the adapter cached it. Durable conversation identity always wins.
    return (await opts.lookupMessage?.(id)) ?? known.get(id);
  }
  function remember(event: IngestEvent): void {
    known.set(event.external_id, event);
    const raw = emailRaw(event);
    const id = raw && rfcId(raw);
    if (id) known.set(id, event);
  }
  async function request<T>(
    path: string,
    key: string | undefined,
    init: RequestInit = {},
  ): Promise<T> {
    if (!key)
      throw new Error(
        path.startsWith("/emails/receiving")
          ? "RESEND_FULL_API_KEY missing"
          : "RESEND_API_KEY missing",
      );
    const response = await http(`https://api.resend.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
    // Do not include provider response bodies: they may contain private content.
    if (!response.ok)
      throw new Error(
        `Resend ${init.method ?? "GET"} ${path.split("?")[0]} HTTP ${response.status}`,
      );
    return (await response.json()) as T;
  }
  async function refreshSent(): Promise<void> {
    const ids = (await opts.missingMessageIds?.()) ?? [];
    let failures = 0;
    for (const id of ids) {
      try {
        const detail = await request<ResendEmail>(
          `/emails/${encodeURIComponent(id)}`,
          fullApiKey ?? apiKey,
        );
        if (detail.id !== id) throw new Error("Resend sent email ID mismatch");
        await opts.onMetadata?.(id, detail);
        const stored = await opts.lookupMessage?.(id);
        if (stored) remember(stored);
      } catch {
        failures++;
      }
    }
    if (failures)
      throw new Error(
        `Resend sent metadata reconciliation failed for ${failures} email(s); retry on next sync`,
      );
  }

  async function map(
    email: ResendEmail,
    conversationId?: string,
    replyExternalId?: string,
    cache = true,
  ): Promise<IngestEvent> {
    const participants = addresses([
      email.from,
      ...email.to,
      ...(email.cc ?? []),
    ]).sort();
    const refs = messageIds(header(email, "References"));
    const parent = messageIds(header(email, "In-Reply-To"))[0];
    const root = refs[0] ?? parent;
    let rootEvent: IngestEvent | undefined;
    for (const id of [parent, ...refs.slice().reverse()]) {
      if (!id) continue;
      const stored = await lookup(id);
      if (stored && stored.account_id === accountId) {
        rootEvent = stored;
        break;
      }
    }
    const candidateParent = parent ? await lookup(parent) : undefined;
    const parentEvent =
      candidateParent?.account_id === accountId ? candidateParent : undefined;
    const conversation =
      conversationId ??
      rootEvent?.conversation_external_id ??
      parentEvent?.conversation_external_id ??
      (root
        ? `email:thread:${digest(root)}`
        : `email:subject:${digest(JSON.stringify([subjectKey(email.subject), participants]))}`);
    const event: IngestEvent = {
      channel: "email",
      account_id: accountId,
      external_id: email.id,
      conversation_external_id: conversation,
      kind: participants.length > 2 ? "group" : "direct",
      title: email.subject,
      participants,
      sender: address(email.from),
      direction: address(email.from).split("@")[1] === domain ? "out" : "in",
      sent_at: new Date(email.created_at).toISOString(),
      text: email.text ?? "",
      subject: email.subject,
      email_to: addresses(email.to),
      email_cc: addresses(email.cc ?? []),
      email_bcc: addresses(email.bcc ?? []),
      reply_to_external_id:
        replyExternalId ?? parentEvent?.external_id ?? parent,
      // Preserve full provider headers/body/attachment metadata in raw. Received attachment
      // download URLs require a separate API call and are not invented here.
      raw: email,
    };
    if (cache) remember(event);
    return event;
  }
  return {
    id: "email",
    capabilities: { startConversation: true, groups: true, cc: true },
    normalizeHandle: address,
    flushSent,
    refreshSent,
    async *sync(cursor?: string) {
      let metadataError: unknown;
      try {
        await refreshSent();
      } catch (error) {
        metadataError = error;
      }
      const pending: ResendEmail[] = [];
      let after: string | undefined;
      const pages = new Set<string>();
      for (;;) {
        const query = new URLSearchParams({ limit: String(pageSize) });
        if (after) query.set("after", after);
        const page = await request<{ data: ResendEmail[]; has_more: boolean }>(
          `/emails/receiving?${query}`,
          fullApiKey,
        );
        if (!Array.isArray(page.data) || typeof page.has_more !== "boolean")
          throw new Error("Invalid Resend receiving list response");
        let reached = false;
        for (const email of page.data) {
          if (email.id === cursor) {
            reached = true;
            break;
          }
          pending.push(email);
        }
        if (reached || !page.has_more) break;
        const next = page.data.at(-1)?.id;
        if (!next || pages.has(next))
          throw new Error("Resend pagination did not advance");
        pages.add(next);
        after = next;
      }
      // Collect every page before yielding: a later page failure must not advance the cursor.
      // Last yielded ID is the newest received email, suitable for the next poll's cursor.
      for (const email of pending.reverse()) {
        const detail = await request<ResendEmail>(
          `/emails/receiving/${encodeURIComponent(email.id)}`,
          fullApiKey,
        );
        if (detail.id !== email.id)
          throw new Error("Resend received email ID mismatch");
        yield await map(detail);
      }
      if (metadataError) throw metadataError;
    },
    async send(target: SendTarget, content: EmailContent) {
      if (target.channel !== "email" || target.account_id !== accountId)
        throw new Error("Email target channel/account mismatch");
      const outboxId =
        content.outbox_id ?? (await opts.getOutboxId?.(target, content));
      if (!outboxId?.trim() || outboxId.length > 256 || /[\r\n]/.test(outboxId))
        throw new Error("Email send requires the dispatching outbox ID");
      const to = addresses(
        content.email_to?.length ? content.email_to : [target.handle],
      );
      const cc = addresses(content.email_cc);
      const bcc = addresses(content.email_bcc);
      const parent = content.reply_to_external_id
        ? await lookup(content.reply_to_external_id)
        : undefined;
      if (content.reply_to_external_id && !parent)
        throw new Error("Email reply message not found");
      if (
        parent &&
        (parent.channel !== "email" ||
          parent.account_id !== accountId ||
          (target.conversationExternalId &&
            target.conversationExternalId !== parent.conversation_external_id))
      )
        throw new Error("Email reply conversation/account mismatch");
      const parentRaw = parent && emailRaw(parent);
      const parentId = parentRaw && rfcId(parentRaw);
      if (parent && !parentId)
        throw new Error("Email reply requires stored RFC Message-ID");
      const references = [
        ...new Set([
          ...messageIds(parentRaw ? header(parentRaw, "References") : ""),
          ...messageIds(parentRaw ? header(parentRaw, "In-Reply-To") : ""),
          ...(parentId ? [parentId] : []),
        ]),
      ];
      const subject = content.subject ?? parent?.subject;
      if (subject === undefined) throw new Error("Email subject required");
      const headers: Record<string, string> = parentId
        ? { "In-Reply-To": parentId, References: references.join(" ") }
        : {};
      const payload = {
        from,
        to,
        cc,
        bcc,
        subject,
        text: content.text,
        ...(content.html !== undefined ? { html: content.html } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
        headers,
        ...(content.attachments?.length
          ? {
              attachments: content.attachments.map((a) => ({
                path: a.url,
                filename: a.name,
                content_type: a.mimeType,
              })),
            }
          : {}),
      };
      // Resolve storage-backed thread metadata before the irreversible HTTP send.
      const outgoing: ResendEmail = {
        id: outboxId,
        from,
        to,
        cc,
        bcc,
        subject,
        text: content.text,
        html: content.html,
        headers,
        created_at: (opts.clock ?? (() => new Date()))().toISOString(),
      };
      const event = await map(
        outgoing,
        parent?.conversation_external_id ?? target.conversationExternalId,
        content.reply_to_external_id,
        false,
      );
      const sent = await request<{ id: string }>("/emails", apiKey, {
        method: "POST",
        headers: { "Idempotency-Key": outboxId },
        body: JSON.stringify(payload),
      });
      if (!sent.id) throw new Error("Resend send response missing ID");
      // Preserve an outgoing event even if metadata retrieval fails after a successful send.
      // Never report that failure as a failed send and encourage a duplicate retry.
      let detail: Partial<ResendEmail> = {};
      try {
        detail = await request<ResendEmail>(
          `/emails/${encodeURIComponent(sent.id)}`,
          fullApiKey ?? apiKey,
        );
        if (detail.id !== sent.id) detail = {};
      } catch {
        /* staged raw marks missing Message-ID */
      }
      event.external_id = sent.id;
      const timestamp = detail.created_at && Date.parse(detail.created_at);
      if (timestamp && Number.isFinite(timestamp))
        event.sent_at = new Date(timestamp).toISOString();
      event.raw = {
        ...detail,
        ...outgoing,
        id: sent.id,
        contacts_outbox_id: outboxId,
        message_id: detail.message_id,
        html: content.html ?? detail.html,
        headers: { ...detail.headers, ...headers },
        created_at: event.sent_at,
      };
      remember(event);
      unstaged.set(event.external_id, event);
      try {
        await flushSent();
      } catch {
        /* retry staging with flushSent(), never resend */
      }
      return {
        externalId: sent.id,
        conversationExternalId: event.conversation_external_id,
      };
    },
  };
}
