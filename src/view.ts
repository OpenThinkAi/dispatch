import { mount } from "@openthink/ui-leaf";
import { existsSync, openSync, readSync, closeSync, statSync, watch } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RELEVANT_DISPATCH_MSGS = new Set<string>([
  "issue filed to vault",
  "issue updated in vault",
  "orchestrator spawned oteam assign",
  "oteam assign spawn failed",
  "orchestrator spawn cap reached; deferring fire to next tick",
  "curator action: gh-comment",
  "curator action: hold",
  "curator call failed",
  "curator action execution failed",
  "could not resolve vault ticket path; marking failed",
  "security held",
  "triage failed",
  "labels apply failed",
  "per-tick curator budget reached; deferring remaining curation",
  "repo poll failed",
  "watch starting",
  "poll complete",
]);

// Seed window: only ingest the last N lines per file at startup. Anything
// older than this is hidden by default; the live tail picks up from there.
const SEED_LINES_PER_FILE = 80;
const MAX_DISPLAY_ENTRIES = 200;

type Level = "info" | "warn" | "error";
type Source = "dispatch" | "telemetry";

interface LogEntry {
  startTs: string;
  endTs: string;
  level: Level;
  source: Source;
  msg: string;
  count: number;
  // For groups: keep representative ticket/slug from the FIRST line, but
  // record distinct slugs so the UI can show "across N repos" when relevant.
  ticket?: string;
  slug?: string;
  number?: number;
  phase?: string;
  ms?: number;
  distinctSlugs: number;
}

interface PollSummary {
  ts: string;
  ingested: number;
  fired: number;
  errors: number;
}

const entries: LogEntry[] = [];
const seenSlugs = new Map<LogEntry, Set<string>>();
let latestPoll: PollSummary | null = null;
const STARTED_AT = new Date().toISOString();
let updateTimer: ReturnType<typeof setTimeout> | null = null;
let viewHandle: Awaited<ReturnType<typeof mount>> | null = null;

function pushOrCollapse(next: Omit<LogEntry, "count" | "startTs" | "endTs" | "distinctSlugs"> & { ts: string }) {
  const last = entries[entries.length - 1];
  const sameKey =
    last &&
    last.msg === next.msg &&
    last.level === next.level &&
    last.source === next.source &&
    !next.ticket && !last.ticket; // never collapse ticket-bearing events — each one matters

  if (sameKey) {
    last.count += 1;
    last.endTs = next.ts;
    if (next.slug) {
      const set = seenSlugs.get(last) ?? new Set<string>();
      set.add(next.slug);
      seenSlugs.set(last, set);
      last.distinctSlugs = set.size;
    }
    return;
  }

  const set = next.slug ? new Set<string>([next.slug]) : new Set<string>();
  const entry: LogEntry = {
    startTs: next.ts,
    endTs: next.ts,
    level: next.level,
    source: next.source,
    msg: next.msg,
    count: 1,
    ticket: next.ticket,
    slug: next.slug,
    number: next.number,
    phase: next.phase,
    ms: next.ms,
    distinctSlugs: set.size,
  };
  entries.push(entry);
  if (set.size > 0) seenSlugs.set(entry, set);
  if (entries.length > MAX_DISPLAY_ENTRIES * 2) {
    const trimmed = entries.splice(0, entries.length - MAX_DISPLAY_ENTRIES);
    for (const e of trimmed) seenSlugs.delete(e);
  }
}

function scheduleUpdate() {
  if (!viewHandle) return;
  if (updateTimer) return;
  updateTimer = setTimeout(() => {
    updateTimer = null;
    // Sort by endTs ascending before slicing the tail. entries[] is filled in
    // ingestion order, but seedTail processes the three log files
    // sequentially — so without a sort, slice(-N) returns "last N entries
    // from whichever file was processed last" instead of "globally most
    // recent N events." Same fix also makes the date sections render in
    // chronological order when reversed in the view.
    const sorted = [...entries].sort(
      (a, b) =>
        new Date(a.endTs).getTime() - new Date(b.endTs).getTime(),
    );
    viewHandle
      ?.update({
        data: {
          entries: sorted.slice(-MAX_DISPLAY_ENTRIES),
          startedAt: STARTED_AT,
          latestPoll,
        },
      })
      .catch(() => {});
  }, 100);
}

function ingestDispatchLine(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return;
  }
  const rawMsg = typeof obj.msg === "string" ? obj.msg : "";
  if (!RELEVANT_DISPATCH_MSGS.has(rawMsg)) return;

  const ts = typeof obj.ts === "string" ? obj.ts : new Date().toISOString();
  const level = obj.level === "error" || obj.level === "warn" ? (obj.level as Level) : "info";

  // Rewrite poll-complete msg to include the result inline. Idle polls all
  // share the same string so collapse folds them; any non-zero count breaks
  // the chain into its own row, surfacing what actually happened.
  let displayMsg = rawMsg;
  if (rawMsg === "poll complete") {
    const ingested = typeof obj.ingested === "number" ? obj.ingested : 0;
    const fired = typeof obj.fired === "number" ? obj.fired : 0;
    const errors = typeof obj.errors === "number" ? obj.errors : 0;
    latestPoll = { ts, ingested, fired, errors };
    if (ingested === 0 && fired === 0 && errors === 0) {
      displayMsg = "poll complete (idle)";
    } else {
      const parts: string[] = [];
      if (ingested > 0) parts.push(`ingested ${ingested}`);
      if (fired > 0) parts.push(`fired ${fired}`);
      if (errors > 0) parts.push(`errors ${errors}`);
      displayMsg = `poll complete · ${parts.join(" · ")}`;
    }
  }

  pushOrCollapse({
    ts,
    level,
    source: "dispatch",
    msg: displayMsg,
    ticket: typeof obj.ticket === "string" ? obj.ticket : undefined,
    slug: typeof obj.slug === "string" ? obj.slug : undefined,
    number: typeof obj.number === "number" ? obj.number : undefined,
  });
  scheduleUpdate();
}

function ingestTelemetryLine(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return;
  }
  const phase = typeof obj.phase === "string" ? obj.phase : undefined;
  const ticket = typeof obj.ticket === "string" ? obj.ticket : undefined;
  if (!phase || !ticket) return;

  const ts = typeof obj["ended-at"] === "string" ? (obj["ended-at"] as string) : new Date().toISOString();
  const ms = typeof obj["wall-clock-ms"] === "number" ? (obj["wall-clock-ms"] as number) : undefined;

  pushOrCollapse({
    ts,
    level: "info",
    source: "telemetry",
    msg: `phase ${phase}`,
    ticket,
    phase,
    ms,
  });
  scheduleUpdate();
}

function tailFile(path: string, ingest: (raw: string) => void) {
  if (!existsSync(path)) return;

  let offset = 0;
  let pendingFragment = "";

  const seedTail = () => {
    try {
      const size = statSync(path).size;
      // Read enough bytes to comfortably contain SEED_LINES_PER_FILE.
      // 4 KB per line average is generous; cap at file size and 1 MB.
      const seedBytes = Math.min(size, 1024 * 1024, SEED_LINES_PER_FILE * 4096);
      const start = size - seedBytes;
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(seedBytes);
        readSync(fd, buf, 0, seedBytes, start);
        const text = buf.toString("utf8");
        const startedMid = start > 0;
        const sliced = startedMid ? text.slice(text.indexOf("\n") + 1) : text;
        const all = sliced.split("\n").filter((s) => s.length > 0);
        const tail = all.slice(-SEED_LINES_PER_FILE);
        for (const line of tail) ingest(line);
        offset = size;
      } finally {
        closeSync(fd);
      }
    } catch {
      // ignore
    }
  };

  const readDelta = () => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.size < offset) {
      offset = 0;
      pendingFragment = "";
    }
    if (stat.size === offset) return;
    const fd = openSync(path, "r");
    try {
      const len = stat.size - offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, offset);
      offset = stat.size;
      const chunk = pendingFragment + buf.toString("utf8");
      const parts = chunk.split("\n");
      pendingFragment = parts.pop() ?? "";
      for (const line of parts) ingest(line);
    } finally {
      closeSync(fd);
    }
  };

  seedTail();
  try {
    watch(path, () => readDelta());
  } catch {
    setInterval(readDelta, 1000);
  }
}

export async function runView(): Promise<number> {
  const here = dirname(fileURLToPath(import.meta.url));
  const viewsRoot = resolve(here, "..", "views");

  const dispatchLogDir = resolve(homedir(), "Library", "Logs", "dispatch");
  const stdoutPath = resolve(dispatchLogDir, "stdout.log");
  const stderrPath = resolve(dispatchLogDir, "stderr.log");
  const telemetryPath = resolve(homedir(), ".open-team", "telemetry", "runs.jsonl");

  viewHandle = await mount({
    view: "log-stream",
    viewsRoot,
    data: { entries: [], startedAt: STARTED_AT, latestPoll: null },
    // ui-leaf's default heartbeat timeout is 5s, which kills backgrounded
    // browser tabs almost immediately (Chrome throttles backgrounded
    // setInterval to ~once per minute, so a 5s server-side window is
    // unsurvivable). dispatch view is a long-monitoring use case, so we
    // extend to 5 minutes — well above Chrome's throttle interval and
    // common system-sleep windows. The trade-off is a longer zombie
    // session if the tab is closed without a clean shutdown, which is
    // fine for an operator dashboard.
    heartbeatTimeoutMs: 300_000,
  });

  console.error(`[dispatch view] ready at ${viewHandle.url}`);
  if (!existsSync(stdoutPath) && !existsSync(stderrPath)) {
    console.error(
      `[dispatch view] note: ${dispatchLogDir} has no logs yet — view will populate once the daemon writes its first event.`,
    );
  }

  tailFile(stdoutPath, ingestDispatchLine);
  tailFile(stderrPath, ingestDispatchLine);
  tailFile(telemetryPath, ingestTelemetryLine);

  process.once("SIGTERM", () => void viewHandle?.close());
  process.once("SIGINT", () => void viewHandle?.close());

  scheduleUpdate();
  const { reason } = await viewHandle.closed;
  console.error(`[dispatch view] closed (${reason})`);
  return 0;
}
