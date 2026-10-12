import { z } from "zod";
import type { ContactsCore } from "../core/index.js";
const id = z.string().min(1);
const channel = z.enum(["imessage", "instagram", "email", "tiktok"]);
const actor = z
  .string()
  .trim()
  .min(1)
  .describe("Agent or human responsible for this action");
const reason = z
  .string()
  .trim()
  .min(1)
  .describe("Why the action is appropriate");
const link = z.object({ system: id, external_id: id });
const person = {
  display_name: z.string().trim().min(1),
  aliases: z.array(id).optional(),
  tags: z.array(id).optional(),
  notes: z.string().optional(),
  links: z.array(link).optional(),
};
const include_raw = z
  .boolean()
  .optional()
  .default(false)
  .describe("Include full stored platform payloads; omitted by default");
function messageOutput<T extends { raw: unknown }>(
  message: T,
  includeRaw?: boolean,
): T | Omit<T, "raw"> {
  if (includeRaw) return message;
  const { raw: _raw, ...result } = message;
  return result;
}
const limit = z.number().int().min(1).max(1000).default(100);
const createSchema = z.object(person);
const updateSchema = z.object({
  person_id: id,
  display_name: person.display_name.optional(),
  aliases: person.aliases,
  tags: person.tags,
  notes: person.notes,
  links: person.links,
});
const attachment = z.object({
  url: id,
  mimeType: id.optional(),
  name: id.optional(),
});
const content = {
  text: z.string(),
  subject: z.string().optional(),
  email_to: z.array(z.string().email()).optional(),
  email_cc: z.array(z.string().email()).optional(),
  email_bcc: z.array(z.string().email()).optional(),
  attachments: z.array(attachment).optional(),
  reply_to_external_id: id.optional(),
  metadata: z
    .object({ instagram_tag: z.literal("HUMAN_AGENT").optional() })
    .optional()
    .describe(
      "Explicit human support tag; requires Meta Human Agent approval, never for automated or promotional messages",
    ),
  kind: id.optional().describe("Message category used by standing kind rules"),
};
export function tools(core: ContactsCore) {
  return {
    find_person: {
      description:
        "Resolve a name, alias, phone, email, username or system:external_id. Only a unique exact match is sendable; ambiguous results require selecting an explicit person_id.",
      schema: z.object({ query: id }),
      call: ({ query }: { query: string }) => {
        const result = core.resolver.find(query);
        return { ...result, candidates: result.candidates.map(candidate => ({ ...candidate, last_message: candidate.last_message ? messageOutput(candidate.last_message) : null })) };
      },
    },
    get_person: {
      description:
        "Read one person with handles, tags and external system links.",
      schema: z.object({ person_id: id }),
      call: ({ person_id }: { person_id: string }) =>
        core.identity.detail(person_id),
    },
    create_person: {
      description:
        "Create the canonical person ID. External systems must store this ID and their own ID as a link.",
      schema: createSchema,
      call: (args: z.infer<typeof createSchema>) => core.identity.create(args),
    },
    update_person: {
      description:
        "Update supplied identity fields. Arrays replace existing arrays; links are added, and cannot be taken from another person.",
      schema: updateSchema,
      call: (args: {
        person_id: string;
        display_name?: string;
        aliases?: string[];
        tags?: string[];
        notes?: string;
        links?: { system: string; external_id: string }[];
      }) => core.identity.update(args.person_id, args),
    },
    add_handle: {
      description:
        "Add a channel handle, optionally linked to a person, and record actor/reason in the edit log. Account defaults to default.",
      schema: z.object({
        channel,
        value: id,
        person_id: id.optional(),
        account_id: id.optional(),
        actor,
        reason,
      }),
      call: (args: z.infer<typeof addHandleSchema>) => core.handles.add(args),
    },
    change_handle: {
      description:
        "Edit a handle value or person association immediately and log the change. Explicit null unlinks it; verify identity before editing.",
      schema: z.object({
        handle_id: id,
        value: id.optional(),
        person_id: id.nullable().optional(),
        actor,
        reason,
      }),
      call: (args: {
        handle_id: string;
        value?: string;
        person_id?: string | null;
        actor: string;
        reason: string;
      }) => core.handles.change(args.handle_id, args),
    },
    unlink_handle: {
      description:
        "Unlink a handle without deleting its messages; record actor and reason.",
      schema: z.object({ handle_id: id, actor, reason }),
      call: (args: { handle_id: string; actor: string; reason: string }) =>
        core.handles.unlink(args.handle_id, args.actor, args.reason),
    },
    link_handle: {
      description:
        "Explicitly link an unlinked or mislinked handle to a person. Proof means a verified exact identity match (e.g. confirmed address or username), not fuzzy similarity. Supply a proof statement or true to attest you verified it.",
      schema: z.object({
        handle_id: id,
        person_id: id,
        actor,
        reason,
        exact_proof: z.union([id.trim().min(1), z.literal(true)]),
      }),
      call: (args: {
        handle_id: string;
        person_id: string;
        actor: string;
        reason: string;
        exact_proof: string | true;
      }) =>
        core.handles.link(
          args.handle_id,
          args.person_id,
          args.actor,
          args.reason,
          args.exact_proof,
        ),
    },
    list_unlinked: {
      description:
        "List unlinked participant handles for explicit identity review.",
      schema: z.object({}),
      call: () => core.handles.unlinked(),
    },
    list_link_suggestions: {
      description:
        "List possible identity links and their evidence; suggestions never authorize linking or sending.",
      schema: z.object({}),
      call: () => core.handles.suggestions(),
    },
    get_timeline: {
      description:
        "Read a person’s messages across channels, newest first, including group conversations they participate in.",
      schema: z.object({ person_id: id, limit, include_raw }),
      call: (args: {
        person_id: string;
        limit: number;
        include_raw?: boolean;
      }) =>
        core.conversations
          .timeline(args.person_id, args.limit)
          .map((m) => messageOutput(m, args.include_raw)),
    },
    list_conversations: {
      description:
        "List conversations, optionally filtered by person and channel, most recently messaged first.",
      schema: z.object({
        person_id: id.optional(),
        channel: channel.optional(),
      }),
      call: (args: { person_id?: string; channel?: z.infer<typeof channel> }) =>
        core.conversations.list(args.person_id, args.channel),
    },
    get_conversation: {
      description:
        "Read participants and the latest messages (100 by default), ordered chronologically. Use next_offset as offset to page backward through older history; next_offset is null when exhausted. Raw provider payloads are omitted by default.",
      schema: z.object({ conversation_id: id, include_raw, limit, offset: z.number().int().min(0).default(0) }),
      call: ({
        conversation_id,
        include_raw,
        limit,
        offset,
      }: {
        conversation_id: string;
        include_raw?: boolean;
        limit?: number;
        offset?: number;
      }) => {
        const detail = core.conversations.detail(conversation_id, limit ?? 100, offset ?? 0);
        return {
          ...detail,
          next_offset: (offset ?? 0) + detail.messages.length < detail.total_messages ? (offset ?? 0) + detail.messages.length : null,
          messages: detail.messages.map((m) => messageOutput(m, include_raw)),
        };
      },
    },
    search_messages: {
      description:
        "Search stored message text and subjects; optional person/channel filters. Never contacts a real channel.",
      schema: z.object({
        query: id,
        person_id: id.optional(),
        channel: channel.optional(),
        limit,
        include_raw,
      }),
      call: (args: {
        query: string;
        person_id?: string;
        channel?: z.infer<typeof channel>;
        limit: number;
        include_raw?: boolean;
      }) =>
        core.conversations
          .search(args.query, args.person_id, args.channel, args.limit)
          .map((m) => messageOutput(m, args.include_raw)),
    },
    send_message: {
      description:
        "First find_person, inspect candidates, pick a person_id (or verified linked handle_id), then send_message. Draft by default; sends immediately only with owner authorization via authorized_by plus reason or a standing rule. Person-only sends select a direct chat; groups REQUIRE explicit conversation_id. Specify channel/handle to control routing. Email To must include that handle; CC/BCC are explicit, never inherited. Echoes recipient/channel/status. Failed or uncertain sends are reconciled from sync evidence, never automatically retried; inspect history before creating another send.",
      schema: z
        .object({
          ...content,
          include_raw,
          person_id: id.optional(),
          conversation_id: id.optional(),
          handle_id: id.optional(),
          channel: channel.optional(),
          authorized_by: actor.optional(),
          reason: reason.optional(),
          created_by: actor,
        })
        .refine(
          (a) => a.person_id || a.conversation_id || a.handle_id,
          "Provide person_id, conversation_id or linked handle_id",
        ),
      call: async (
        args: Parameters<typeof core.outbox.send>[0] & {
          include_raw?: boolean;
        },
      ) => {
        const result = await core.outbox.send(args);
        if (
          !args.include_raw ||
          !result.sent_message_id ||
          !result.conversation_id
        )
          return result;
        return {
          ...result,
          message: core.conversations.message(result.sent_message_id),
        };
      },
    },
    list_drafts: {
      description: "List pending draft messages for the approval inbox.",
      schema: z.object({}),
      call: () => core.outbox.list(),
    },
    approve_draft: {
      description:
        "Approve and send a pending draft with the named authorizer and reason. Rechecks current identity, capabilities, reply window and rate limit. Never retries an already sent/failed message.",
      schema: z.object({ draft_id: id, authorized_by: actor, reason }),
      call: (args: {
        draft_id: string;
        authorized_by: string;
        reason: string;
      }) => core.outbox.approve(args.draft_id, args.authorized_by, args.reason),
    },
    reject_draft: {
      description:
        "Reject a pending draft, preserving it and recording the decision actor and reason.",
      schema: z.object({ draft_id: id, actor, reason }),
      call: (args: { draft_id: string; actor: string; reason: string }) =>
        core.outbox.reject(args.draft_id, args.actor, args.reason),
    },
    add_send_rule: {
      description:
        "Create a standing authorization for a person ID, tag or message kind on selected channels. Record the owner-authorized rule creator; matching sends record the rule ID and authorizer.",
      schema: z.object({
        scope: z.enum(["person", "tag", "kind"]),
        value: id,
        channels: z.array(channel).min(1),
        created_by: actor,
      }),
      call: (args: Parameters<typeof core.authorization.add>[0]) =>
        core.authorization.add(args),
    },
    list_send_rules: {
      description: "List standing send permissions, including inactive rules.",
      schema: z.object({}),
      call: () => core.authorization.list(),
    },
    remove_send_rule: {
      description: "Deactivate a standing send permission by rule_id and record the actor/time. Preserves the rule and past authorizations; repeated removal retains the first removal audit. Later messages no longer match it.",
      schema: z.object({ rule_id: id, actor }),
      call: (args: { rule_id: string; actor: string }) => core.authorization.remove(args.rule_id, args.actor),
    },
    sync_status: {
      description:
        "Read per-channel/account sync cursors, last successful sync and errors. The daemon and sync command update this state.",
      schema: z.object({}),
      call: () => core.syncStatus(),
    },
  };
}
const addHandleSchema = z.object({
  channel,
  value: id,
  person_id: id.optional(),
  account_id: id.optional(),
  actor,
  reason,
});
