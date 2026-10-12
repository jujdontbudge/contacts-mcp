import { normalizeHandle, type Channel, type ChannelId } from "./channel.js";
export class ChannelRegistry {
  readonly disabled = new Map<
    ChannelId,
    { account_id: string; reason: string }
  >();
  private channels = new Map<ChannelId, Channel>();
  constructor(channels: Channel[] = []) {
    channels.forEach((c) => this.register(c));
  }
  register(channel: Channel): void {
    if (this.channels.has(channel.id))
      throw new Error(`Channel already registered: ${channel.id}`);
    this.channels.set(channel.id, channel);
  }
  get(id: ChannelId): Channel {
    const c = this.channels.get(id);
    if (!c) throw new Error(`Channel unavailable: ${id}`);
    return c;
  }
  normalize(id: ChannelId, raw: string): string {
    return (
      this.channels.get(id)?.normalizeHandle(raw) ?? normalizeHandle(id, raw)
    );
  }
  list(): Channel[] {
    return [...this.channels.values()];
  }
}

export interface AdapterOptions {
  imessage?: ConstructorParameters<
    typeof import("./imessage.js").IMessageChannel
  >[0];
  instagram?: import("./instagram.js").InstagramOptions;
  instagramOfficial?: import("./instagram-official.js").InstagramOfficialOptions;
  instagramBoth?: import("./instagram-transport.js").InstagramBothOptions;
  email?: import("./email.js").EmailChannelOptions;
  tiktok?: import("./tiktok.js").TikTokOptions;
}

export async function configuredChannels(
  env: NodeJS.ProcessEnv = process.env,
  adapters: AdapterOptions = {},
): Promise<ChannelRegistry> {
  const ids = [
    ...new Set(
      (env.CONTACTS_CHANNELS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  const supported: ChannelId[] = ["imessage", "instagram", "email", "tiktok"];
  for (const id of ids)
    if (!supported.includes(id as ChannelId))
      throw new Error(`Unsupported configured channel: ${id}`);
  const instagramTransport = env.CONTACTS_INSTAGRAM_TRANSPORT ?? "beeper";
  if (!["beeper", "official", "both"].includes(instagramTransport))
    throw new Error("CONTACTS_INSTAGRAM_TRANSPORT must be beeper, official or both");
  const registry = new ChannelRegistry();
  for (const id of supported) {
    const account =
      id === "instagram" && instagramTransport === "official"
        ? (adapters.instagramOfficial?.accountId ?? (adapters.instagramOfficial?.userId?.trim() || env.IG_USER_ID?.trim() || "official"))
        : id === "instagram"
        ? (adapters.instagram?.accountID ??
          env.BEEPER_INSTAGRAM_ACCOUNT_ID ??
          "default")
        : id === "tiktok"
          ? (adapters.tiktok?.accountId ??
            env.ZERNIO_TIKTOK_ACCOUNT_ID ??
            "default")
          : id === "email"
            ? (adapters.email?.accountId ?? "default")
            : (adapters.imessage?.accountId ?? "default");
    if (!ids.includes(id)) {
      registry.disabled.set(id, {
        account_id: account,
        reason: "Not selected in CONTACTS_CHANNELS",
      });
      continue;
    }
    const missing: string[] = [];
    if (id === "instagram" && instagramTransport !== "official") {
      if (
        !adapters.instagram?.client &&
        !(adapters.instagram?.accessToken ?? env.BEEPER_ACCESS_TOKEN)?.trim()
      )
        missing.push("BEEPER_ACCESS_TOKEN");
      if (
        !(
          adapters.instagram?.accountID ?? env.BEEPER_INSTAGRAM_ACCOUNT_ID
        )?.trim()
      )
        missing.push("BEEPER_INSTAGRAM_ACCOUNT_ID");
    }
    if (id === "instagram" && instagramTransport !== "beeper") {
      if (!(adapters.instagramOfficial?.accessToken ?? env.IG_ACCESS_TOKEN)?.trim()) missing.push("IG_ACCESS_TOKEN");
      if (!(adapters.instagramOfficial?.appSecret ?? env.IG_APP_SECRET)?.trim()) missing.push("IG_APP_SECRET");
      if (!(adapters.instagramOfficial?.verifyToken ?? env.IG_WEBHOOK_VERIFY_TOKEN)?.trim()) missing.push("IG_WEBHOOK_VERIFY_TOKEN");
    }
    if (id === "email") {
      for (const [name, value] of [
        [
          "CONTACTS_EMAIL_FROM",
          adapters.email?.from ?? env.CONTACTS_EMAIL_FROM,
        ],
        ["RESEND_API_KEY", adapters.email?.apiKey ?? env.RESEND_API_KEY],
        [
          "RESEND_FULL_API_KEY",
          adapters.email?.fullApiKey ?? env.RESEND_FULL_API_KEY,
        ],
      ])
        if (!value?.trim()) missing.push(name!);
    }
    if (id === "tiktok") {
      if (!(adapters.tiktok?.apiKey ?? env.ZERNIO_API_KEY)?.trim())
        missing.push("ZERNIO_API_KEY");
      if (!(adapters.tiktok?.accountId ?? env.ZERNIO_TIKTOK_ACCOUNT_ID)?.trim())
        missing.push("ZERNIO_TIKTOK_ACCOUNT_ID");
    }
    if (missing.length) {
      registry.disabled.set(id, {
        account_id: account,
        reason: `Missing required env: ${missing.join(", ")}`,
      });
      continue;
    }
    let channel: Channel;
    if (id === "imessage") {
      const { IMessageChannel, ProcessImsgRunner } =
        await import("./imessage.js");
      channel = new IMessageChannel({
        runner: new ProcessImsgRunner(env.CONTACTS_IMSG_PATH),
        ...adapters.imessage,
      });
    } else if (id === "instagram") {
      let beeper: Channel | undefined;
      if (instagramTransport !== "official") {
        const { createInstagramChannel } = await import("./instagram.js");
        beeper = createInstagramChannel({
          accessToken: env.BEEPER_ACCESS_TOKEN,
          baseURL: env.BEEPER_BASE_URL,
          accountID: env.BEEPER_INSTAGRAM_ACCOUNT_ID,
          ...adapters.instagram,
          ...(instagramTransport === "both" ? { onCursor: undefined } : {}),
        });
        beeper.accountId = account;
      }
      if (instagramTransport === "beeper") channel = beeper!;
      else {
        const { createInstagramOfficialChannel } = await import("./instagram-official.js");
        const official = createInstagramOfficialChannel({
          accessToken: env.IG_ACCESS_TOKEN, userId: env.IG_USER_ID,
          version: env.IG_GRAPH_VERSION, appSecret: env.IG_APP_SECRET,
          verifyToken: env.IG_WEBHOOK_VERIFY_TOKEN,
          ...adapters.instagramOfficial, accountId: account,
        });
        if (instagramTransport === "official") channel = official;
        else {
          const { createInstagramBothChannel } = await import("./instagram-transport.js");
          channel = createInstagramBothChannel(beeper!, official, adapters.instagramBoth);
        }
      }
    } else if (id === "email") {
      const { createEmailChannel } = await import("./email.js");
      if (!adapters.email)
        throw new Error("Email requires the contacts composition bridge");
      channel = createEmailChannel({
        from: env.CONTACTS_EMAIL_FROM,
        replyTo: env.CONTACTS_EMAIL_REPLY_TO,
        apiKey: env.RESEND_API_KEY,
        fullApiKey: env.RESEND_FULL_API_KEY,
        ...adapters.email,
      });
    } else {
      const { createTikTokChannel } = await import("./tiktok.js");
      channel = createTikTokChannel({
        apiKey: env.ZERNIO_API_KEY,
        accountId: env.ZERNIO_TIKTOK_ACCOUNT_ID,
        baseUrl: env.ZERNIO_BASE_URL,
        ...adapters.tiktok,
      });
    }
    channel.accountId = account;
    registry.register(channel);
  }
  return registry;
}
