/** RFC identifiers and localized reply prefixes shared by ingestion and repair. */
export function emailHeader(raw: unknown, name: string): string {
  const headers = (raw as { headers?: Record<string, unknown> } | null)
    ?.headers;
  const value = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
  return typeof value === "string" ? value : "";
}
export function emailMessageIds(value: string): string[] {
  return value.match(/<[^<>\s]+>/g) ?? [];
}
export function emailSubject(subject: string): string {
  return subject
    .replace(
      /^(?:\s*(?:re|fw|fwd|aw|wg|sv|vs|答复|回复|转发)\s*(?:\[\d+\])?\s*:\s*)+/i,
      "",
    )
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}
export function emailAddress(value: string): string {
  return (value.match(/<([^<>]+)>/)?.[1] ?? value).trim().toLowerCase();
}
export function emailRfcId(raw: unknown): string | undefined {
  const id = (raw as { message_id?: unknown } | null)?.message_id;
  return emailMessageIds(
    typeof id === "string" ? id : emailHeader(raw, "Message-ID"),
  )[0];
}
