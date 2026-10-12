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
