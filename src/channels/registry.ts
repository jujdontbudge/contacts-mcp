import { normalizeHandle, type Channel, type ChannelId } from "./channel.js";
export class ChannelRegistry {
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

export async function configuredChannels(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChannelRegistry> {
  const ids = [
    ...new Set(
      (env.CONTACTS_CHANNELS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  const registry = new ChannelRegistry();
  for (const id of ids) {
    if (id !== "imessage")
      throw new Error(`Unsupported configured channel: ${id}`);
    const { IMessageChannel, ProcessImsgRunner } =
      await import("./imessage.js");
    registry.register(
      new IMessageChannel({
        runner: new ProcessImsgRunner(env.CONTACTS_IMSG_PATH),
        onLiveError: (error) => console.error(error.message),
      }),
    );
  }
  return registry;
}
