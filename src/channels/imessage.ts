import { spawn } from "node:child_process";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  normalizeHandle,
  type Channel,
  type IngestEvent,
  type SendContent,
  type SendTarget,
} from "./channel.js";

type Row = Record<string, unknown>;
// NDJSON is deliberately parsed at the boundary; unexpected records fail sync
// rather than allowing its durable cursor to jump past an unparsed message.
export function parseImsgJSON(output: string): Row[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Expected an imsg JSON object");
      return value as Row;
    });
}
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function messageRowid(row: Row): number {
  if (!Number.isSafeInteger(row.id) || Number(row.id) < 1)
    throw new Error("Invalid imsg message rowid");
  return Number(row.id);
}
export interface ImsgRunner {
  run(args: string[], options?: { timeoutMs?: number }): Promise<string>;
  stream(args: string[]): AsyncIterable<string>;
  watch(
    args: string[],
    onLine: (line: string) => void,
    onExit: (error: Error) => void,
  ): () => void;
}
export class ProcessImsgRunner implements ImsgRunner {
  constructor(
    private binary = process.env.CONTACTS_IMSG_PATH ?? "/opt/homebrew/bin/imsg",
  ) {}
  run(args: string[], options: { timeoutMs?: number } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.setEncoding("utf8").on("data", (data) => {
        stdout += data;
      });
      child.stderr.setEncoding("utf8").on("data", (data) => {
        stderr = (stderr + data).slice(-8192);
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, options.timeoutMs ?? 120_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0)
          reject(new Error(`imsg ${args[0]} exited ${code}: ${stderr.trim()}`));
        else resolve(stdout);
      });
    });
  }
  async *stream(args: string[]): AsyncIterable<string> {
    const child = spawn(this.binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (data) => {
      stderr = (stderr + data).slice(-8192);
    });
    // Attach exit/error handlers immediately, even while the consumer is paused.
    const closed = new Promise<Error | undefined>((resolve) => {
      child.once("error", resolve);
      child.once("close", (code) =>
        resolve(
          code === 0
            ? undefined
            : new Error(`imsg ${args[0]} exited ${code}: ${stderr.trim()}`),
        ),
      );
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.stdout.setEncoding("utf8");
    let pending = "";
    try {
      // Readable's async iterator applies backpressure; no whole-history buffer.
      for await (const chunk of child.stdout) {
        pending += chunk;
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.trim()) yield line;
        }
      }
      if (pending.trim()) yield pending;
      const error = await closed;
      if (error) throw error;
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  }
  watch(
    args: string[],
    onLine: (line: string) => void,
    onExit: (error: Error) => void,
  ): () => void {
    const child = spawn(this.binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    let stopped = false,
      reported = false,
      stderr = "";
    const finish = (error: Error) => {
      if (!stopped && !reported) {
        reported = true;
        onExit(error);
      }
    };
    lines.on("line", onLine);
    child.stderr.setEncoding("utf8").on("data", (data) => {
      stderr = (stderr + data).slice(-8192);
    });
    child.once("error", finish);
    child.once("close", (code) =>
      finish(new Error(`imsg watch exited ${code}: ${stderr.trim()}`)),
    );
    return () => {
      stopped = true;
      lines.close();
      child.kill();
    };
  }
}
const ALL = "2147483647";
const PAGE = 1000;
const OVERLAP_MS = 10 * 60_000;
interface SyncCursor {
  version: 1;
  maxRowid: number;
  lastSync?: string;
  backfill?: {
    started: string;
    completed: number[];
    chatId?: number;
    end?: string;
    legacyRowid: number;
  };
}
function parseCursor(cursor: string | undefined, started: string): SyncCursor {
  if (cursor === undefined || /^\d+$/.test(cursor)) {
    const rowid = Number(cursor ?? 0);
    if (!Number.isSafeInteger(rowid) || rowid < 0)
      throw new Error("Invalid imsg cursor");
    return {
      version: 1,
      maxRowid: rowid,
      backfill: { started, completed: [], legacyRowid: rowid },
    };
  }
  let c: SyncCursor;
  try {
    c = JSON.parse(cursor);
  } catch {
    throw new Error("Invalid imsg cursor");
  }
  const validDate = (v: unknown) =>
    typeof v === "string" && Number.isFinite(Date.parse(v));
  if (
    !c ||
    c.version !== 1 ||
    !Number.isSafeInteger(c.maxRowid) ||
    c.maxRowid < 0 ||
    (c.backfill
      ? !validDate(c.backfill.started) ||
        !Array.isArray(c.backfill.completed) ||
        c.backfill.completed.some(
          (id) => !Number.isSafeInteger(id) || id < 1,
        ) ||
        !Number.isSafeInteger(c.backfill.legacyRowid) ||
        c.backfill.legacyRowid < 0 ||
        (c.backfill.chatId !== undefined &&
          (!Number.isSafeInteger(c.backfill.chatId) ||
            c.backfill.chatId < 1)) ||
        (c.backfill.end !== undefined && !validDate(c.backfill.end))
      : !validDate(c.lastSync))
  )
    throw new Error("Invalid imsg cursor");
  return c;
}
export class IMessageChannel implements Channel {
  readonly id = "imessage" as const;
  readonly capabilities = { startConversation: true, groups: true, cc: false };
  private runner: ImsgRunner;
  accountId: string;
  constructor(
    private options: {
      runner?: ImsgRunner;
      accountId?: string;
      confirmationTimeoutMs?: number;
      confirmationPollMs?: number;
      restartBackoffMs?: number;
      onLiveError?: (error: Error) => void;
    } = {},
  ) {
    this.runner = options.runner ?? new ProcessImsgRunner();
    this.accountId = options.accountId ?? "default";
  }
  normalizeHandle(raw: string): string {
    // Opaque/unknown handles are evidence, never a reason to discard a message.
    try {
      return normalizeHandle(this.id, raw);
    } catch {
      if (!raw.trim()) throw new Error("Empty imsg handle");
      return raw.trim().toLowerCase();
    }
  }
  parseMessage(row: Row, chat: Row = {}): IngestEvent {
    const id = messageRowid(row);
    if (
      typeof row.is_from_me !== "boolean" ||
      !Number.isFinite(Date.parse(string(row.created_at)))
    )
      throw new Error(`Invalid imsg message ${id}`);
    const external =
      string(row.chat_guid) ||
      string(chat.guid) ||
      string(row.chat_identifier) ||
      string(chat.identifier);
    if (!external)
      throw new Error(`Missing imsg chat identity for message ${id}`);
    const handles = row.participants ?? chat.participants ?? [];
    if (!Array.isArray(handles) || handles.some((h) => typeof h !== "string"))
      throw new Error(`Invalid imsg participants for message ${id}`);
    const sender =
      string(row.sender) ||
      (row.is_from_me
        ? string(row.destination_caller_id) || "self@contacts-mcp.invalid"
        : `unknown-${id}@contacts-mcp.invalid`);
    const attachments = row.attachments ?? [];
    if (!Array.isArray(attachments))
      throw new Error(`Invalid imsg attachments for message ${id}`);
    return {
      channel: this.id,
      account_id: this.accountId,
      external_id: string(row.guid) || `rowid:${this.accountId}:${id}`,
      conversation_external_id: external,
      kind:
        (row.is_group ?? chat.is_group ?? external.includes(";+;"))
          ? "group"
          : "direct",
      title:
        string(row.chat_name) ||
        string(chat.display_name) ||
        string(chat.name) ||
        undefined,
      participants: [
        ...new Set(
          handles.filter((h) => h.trim()).map((h) => this.normalizeHandle(h)),
        ),
      ],
      sender: this.normalizeHandle(sender),
      direction: row.is_from_me ? "out" : "in",
      sent_at: new Date(string(row.created_at)).toISOString(),
      text: string(row.text),
      attachments: attachments.map((value: unknown) => {
        if (!value || typeof value !== "object")
          throw new Error("Invalid imsg attachment");
        const a = value as Row;
        const path = string(a.original_path) || string(a.filename);
        // Preserve missing/remote attachment metadata in raw even without a path.
        return {
          url: path.startsWith("/")
            ? pathToFileURL(path).href
            : path || "imsg:attachment-unavailable",
          mimeType: string(a.mime_type) || undefined,
          name: string(a.transfer_name) || undefined,
        };
      }),
      reply_to_external_id: string(row.reply_to_guid) || undefined,
      raw: { ...row, chat, imsg_rowid: id },
    };
  }
  private async chats(timeoutMs?: number): Promise<Row[]> {
    return parseImsgJSON(
      await this.runner.run(["chats", "--limit", ALL, "--json"], { timeoutMs }),
    );
  }
  private historyArgs(
    chat: Row,
    options: { start?: string; end?: string; limit?: number } = {},
  ): string[] {
    if (!Number.isSafeInteger(chat.id) || Number(chat.id) < 1)
      throw new Error("Invalid imsg chat rowid");
    return [
      "history",
      "--chat-id",
      String(chat.id),
      "--limit",
      String(options.limit ?? ALL),
      ...(options.start ? ["--start", options.start] : []),
      ...(options.end ? ["--end", options.end] : []),
      "--attachments",
      "--json",
    ];
  }
  private async history(
    chat: Row,
    options: { start?: string; end?: string; limit?: number },
    timeoutMs?: number,
  ): Promise<Row[]> {
    return parseImsgJSON(
      await this.runner.run(this.historyArgs(chat, options), { timeoutMs }),
    );
  }
  private async *streamHistory(
    chat: Row,
    options: { start?: string; end?: string },
  ): AsyncIterable<Row> {
    for await (const line of this.runner.stream(
      this.historyArgs(chat, options),
    ))
      yield* parseImsgJSON(line);
  }
  async *sync(
    cursor?: string,
    checkpoint?: (cursor: string) => void,
  ): AsyncIterable<IngestEvent> {
    const started = new Date().toISOString();
    const state = parseCursor(cursor, started);
    const save = () => checkpoint?.(JSON.stringify(state));
    const chats = await this.chats();
    const event = (row: Row, chat: Row) => {
      const parsed = this.parseMessage(row, chat);
      state.maxRowid = Math.max(state.maxRowid, messageRowid(row));
      return parsed;
    };
    if (state.backfill) {
      const progress = state.backfill;
      for (const chat of chats) {
        if (progress.completed.includes(Number(chat.id))) continue;
        let end = progress.chatId === chat.id ? progress.end : undefined;
        for (;;) {
          const page = await this.history(chat, { end, limit: PAGE });
          // Validate the entire page before using any of its dates for pagination.
          for (const row of page) this.parseMessage(row, chat);
          if (page.length < PAGE) {
            for (const row of page)
              if (messageRowid(row) > progress.legacyRowid)
                yield event(row, chat);
            break;
          }
          const oldest = Math.min(
            ...page.map((row) => Date.parse(string(row.created_at))),
          );
          const boundary = new Date(oldest - 1).toISOString();
          const bucketEnd = new Date(oldest + 1).toISOString();
          if (end && oldest - 1 >= Date.parse(end))
            throw new Error("imsg history pagination did not advance");
          for (const row of page)
            if (
              Date.parse(string(row.created_at)) >= oldest + 1 &&
              messageRowid(row) > progress.legacyRowid
            )
              yield event(row, chat);
          // A timestamp can have more than PAGE rows. Stream the whole boundary
          // bucket rather than dropping ties with an exclusive end cursor.
          // Pad below by 1ms: imsg formats nanosecond dates to milliseconds.
          for await (const row of this.streamHistory(chat, {
            start: boundary,
            end: bucketEnd,
          }))
            if (messageRowid(row) > progress.legacyRowid)
              yield event(row, chat);
          end = boundary;
          progress.chatId = Number(chat.id);
          progress.end = end;
          save();
        }
        progress.completed.push(Number(chat.id));
        delete progress.chatId;
        delete progress.end;
        save();
      }
      // Use the backfill START, not its finish: late inserts in previously read
      // chats are picked up by the next safety-net pass, regardless of rowid.
      state.lastSync = progress.started;
      delete state.backfill;
      save();
      return;
    }
    const start = new Date(
      Date.parse(state.lastSync!) - OVERLAP_MS,
    ).toISOString();
    for (const chat of chats) {
      const activity = Date.parse(string(chat.last_message_at));
      // Missing activity metadata cannot safely exclude a chat.
      if (Number.isFinite(activity) && activity < Date.parse(start)) continue;
      for await (const row of this.streamHistory(chat, { start }))
        yield event(row, chat);
    }
    // Never filter overlap by maxRowid: a late row from an earlier chat may be
    // below a later chat's watermark. Core deduplicates by external_id.
    state.lastSync = started;
    save();
  }
  live(
    onEvent: (event: IngestEvent) => void,
    onError?: (error: Error) => void,
  ): () => void {
    const report = (error: Error) => {
      this.options.onLiveError?.(error);
      onError?.(error);
    };
    let stopped = false,
      failures = 0,
      stopChild: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      if (stopped) return;
      stopChild = this.runner.watch(
        ["watch", "--attachments", "--json"],
        (line) => {
          try {
            for (const row of parseImsgJSON(line))
              onEvent(this.parseMessage(row));
            failures = 0;
          } catch (error) {
            report(error instanceof Error ? error : new Error(String(error)));
          }
        },
        (error) => {
          report(error);
          if (!stopped)
            timer = setTimeout(
              start,
              Math.min(
                60_000,
                (this.options.restartBackoffMs ?? 1000) *
                  2 ** Math.min(failures++, 6),
              ),
            );
        },
      );
    };
    start();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stopChild?.();
    };
  }
  async send(
    target: SendTarget,
    content: SendContent,
  ): Promise<{ externalId: string; conversationExternalId: string }> {
    if (target.account_id !== this.accountId)
      throw new Error("imsg cannot select a different sending account");
    if (
      content.subject ||
      content.reply_to_external_id ||
      content.email_cc?.length ||
      content.email_bcc?.length ||
      content.email_to?.length
    )
      throw new Error(
        "imsg send does not support subjects, inline replies or email routing",
      );
    if ((content.attachments?.length ?? 0) > 1)
      throw new Error("imsg send supports one attachment per message");
    const file = content.attachments?.[0]?.url;
    if (file && !file.startsWith("file://") && !file.startsWith("/"))
      throw new Error(
        "imsg attachments require an absolute local path or file URL",
      );
    if (target.conversationKind === "group" && !target.conversationExternalId)
      throw new Error("Group send requires a chat identifier");
    const requested = normalizeHandle("imessage", target.handle);
    const isGroup = (chat: Row) => chat.is_group === true || string(chat.guid).includes(";+;") || string(chat.identifier).includes(";+;");
    const matches = (chat: Row) =>
      target.conversationKind === "group"
        ? [chat.guid, chat.identifier].includes(target.conversationExternalId)
        : !isGroup(chat) &&
          Array.isArray(chat.participants) &&
          chat.participants.some(
            (h) =>
              typeof h === "string" &&
              this.normalizeHandle(h) === this.normalizeHandle(target.handle),
          );
    const started = Date.now();
    const confirmationStart = new Date(started - 60_000).toISOString();
    const beforeChats = (await this.chats()).filter(matches);
    if (target.conversationKind === "group" && beforeChats.length !== 1)
      throw new Error("Group chat identifier must match one existing chat");
    if (target.conversationKind === "group" && (!isGroup(beforeChats[0]) ||
        !Array.isArray(beforeChats[0].participants) ||
        !beforeChats[0].participants.some(h => typeof h === "string" && this.normalizeHandle(h) === requested)))
      throw new Error("Selected iMessage handle is no longer a verified group participant");
    const seen = new Set<string>();
    for (const chat of beforeChats)
      for (const row of await this.history(chat, {
        start: confirmationStart,
        limit: 100,
      }))
        seen.add(String(row.guid || messageRowid(row)));
    const args = [
      "send",
      ...(target.conversationKind === "group"
        ? [
            "--chat-identifier",
            string(beforeChats[0]?.identifier) ||
              target.conversationExternalId!,
          ]
        : ["--to", this.normalizeHandle(target.handle)]),
      "--text",
      content.text,
      "--service",
      "imessage",
      "--json",
    ];
    if (file)
      args.push(
        "--file",
        file.startsWith("file://") ? fileURLToPath(file) : file,
      );
    let ack: Row[];
    try {
      ack = parseImsgJSON(await this.runner.run(args));
    } catch (error) {
      throw new Error(
        `iMessage send uncertain; do not retry automatically: ${String(error)}`,
      );
    }
    const ackGuid = ack
      .map((a) => string(a.guid) || string(a.message_id))
      .find(Boolean);
    const deadline =
      Date.now() + (this.options.confirmationTimeoutMs ?? 15_000);
    do {
      try {
        const candidates: IngestEvent[] = [];
        for (const chat of (
          await this.chats(Math.max(1, deadline - Date.now()))
        ).filter(matches))
          for (const row of await this.history(
            chat,
            { start: confirmationStart, limit: 100 },
            Math.max(1, deadline - Date.now()),
          )) {
            if (
              !row.is_from_me ||
              seen.has(String(row.guid || messageRowid(row))) ||
              Date.parse(string(row.created_at)) < started - 1000
            )
              continue;
            if (
              ackGuid
                ? string(row.guid) !== ackGuid
                : string(row.text) !== content.text
            )
              continue;
            if (
              file &&
              (!Array.isArray(row.attachments) || row.attachments.length !== 1)
            )
              continue;
            if (file && !ackGuid) {
              const expectedName = basename(
                file.startsWith("file://") ? fileURLToPath(file) : file,
              );
              const a = (row.attachments as Row[])[0];
              if (
                (string(a.transfer_name) || basename(string(a.filename))) !==
                expectedName
              )
                continue;
            }
            candidates.push(this.parseMessage(row, chat));
          }
        if (candidates.length === 1 && Date.now() <= deadline)
          return {
            externalId: candidates[0].external_id,
            conversationExternalId: candidates[0].conversation_external_id,
          };
      } catch {
        /* The mutation may already have happened. Retry only reads. */
      }
      if (Date.now() >= deadline) break;
      await delay(
        Math.min(
          this.options.confirmationPollMs ?? 500,
          Math.max(0, deadline - Date.now()),
        ),
      );
    } while (Date.now() <= deadline);
    throw new Error(
      "iMessage send uncertain: outgoing history confirmation timed out; do not retry automatically",
    );
  }
}
