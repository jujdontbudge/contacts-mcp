import { AsyncLocalStorage } from "node:async_hooks";
import {
  configuredChannels,
  type AdapterOptions,
} from "./channels/registry.js";
import { ContactsCore } from "./core/index.js";
import type { EmailChannel } from "./channels/email.js";

/** One core-facing composition for CLI, stdio and the HTTP daemon. */
export async function createContactsSystem(
  options: {
    env?: NodeJS.ProcessEnv;
    path?: string;
    clock?: () => Date;
    adapters?: Omit<AdapterOptions, "email"> & {
      email?: Omit<
        NonNullable<AdapterOptions["email"]>,
        | "getOutboxId"
        | "lookupMessage"
        | "onSent"
        | "missingMessageIds"
        | "onMetadata"
      >;
    };
  } = {},
) {
  const env = options.env ?? process.env;
  const dispatch = new AsyncLocalStorage<string>();
  let core: ContactsCore;
  const registry = await configuredChannels(env, {
    ...options.adapters,
    instagram: {
      ...options.adapters?.instagram,
      onError: (error) => {
        core.recordSync(
          "instagram",
          registry.get("instagram").accountId!,
          null,
          String(error),
        );
        options.adapters?.instagram?.onError?.(error);
      },
      onCursor: async (cursor) => {
        core.checkpointSync(
          "instagram",
          registry.get("instagram").accountId!,
          cursor,
        );
        await options.adapters?.instagram?.onCursor?.(cursor);
      },
    },
    instagramOfficial: {
      ...options.adapters?.instagramOfficial,
      clock: options.adapters?.instagramOfficial?.clock ?? options.clock,
      loadToken: () =>
        core.loadChannelToken(
          "instagram",
          registry.get("instagram").accountId!,
        ),
      saveToken: (token) =>
        core.saveChannelToken(
          "instagram",
          registry.get("instagram").accountId!,
          token,
        ),
      getLastInboundAt: (external) =>
        core.lastInboundAt(
          "instagram",
          registry.get("instagram").accountId!,
          external,
        ),
    },
    instagramBoth: {
      ...options.adapters?.instagramBoth,
      clock: options.adapters?.instagramBoth?.clock ?? options.clock,
      getLastInboundAt: (target) =>
        target.conversationExternalId
          ? core.lastInboundAt(
              "instagram",
              target.account_id,
              target.conversationExternalId,
            )
          : undefined,
    },
    email: {
      ...options.adapters?.email,
      clock: options.adapters?.email?.clock ?? options.clock,
      getOutboxId: () => {
        const id = dispatch.getStore();
        if (!id || core.outbox.get(id).status !== "sending")
          throw new Error("No active email dispatch");
        return id;
      },
      lookupMessage: (id) => core.conversations.lookupEvent("email", id),
      missingMessageIds: () =>
        core.conversations.missingEmailMessageIds(
          options.adapters?.email?.accountId ?? "default",
        ),
      onMetadata: (id, detail) =>
        core.conversations.updateEmailMetadata(
          options.adapters?.email?.accountId ?? "default",
          id,
          detail,
        ),
      onSent: (event) => {
        const id = (event.raw as { contacts_outbox_id?: string })
          .contacts_outbox_id;
        if (!id) throw new Error("Sent email has no dispatch context");
        core.stageOutgoing(id, event);
      },
    },
  });
  async function reconcile() {
    const email = registry.list().find((c) => c.id === "email") as
      EmailChannel | undefined;
    await email?.flushSent();
    core.reconcileOutgoing();
  }
  core = new ContactsCore({
    registry,
    path: options.path ?? env.CONTACTS_DB,
    clock: options.clock,
    env,
    dispatchHooks: {
      send: (id, target, content) =>
        dispatch.run(id, () =>
          registry.get(target.channel).send(target, content),
        ),
      afterSent: reconcile,
    },
  });
  try {
    await reconcile(); // Recover durable staging from a prior interrupted process.
    for (const channel of registry.list())
      core.ensureSyncState(channel.id, channel.accountId);
  } catch (error) {
    core.close();
    throw error;
  }
  return { core, registry, reconcile };
}
