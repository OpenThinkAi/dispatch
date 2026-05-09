import { useEffect, useRef } from "react";
import type { ViewProps } from "@openthink/ui-leaf/view";

interface LogEntry {
  startTs: string;
  endTs: string;
  level: "info" | "warn" | "error";
  source: "dispatch" | "telemetry";
  msg: string;
  count: number;
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

interface LogStreamData {
  entries: LogEntry[];
  startedAt: string;
  latestPoll: PollSummary | null;
}

const COLORS = {
  bg: "#0e1116",
  panel: "#161b22",
  border: "#30363d",
  text: "#e6edf3",
  muted: "#8b949e",
  info: "#79c0ff",
  warn: "#f0c674",
  error: "#ff7b72",
  success: "#7ee787",
  ticket: "#d2a8ff",
  count: "#f0c674",
};

function formatTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString("en-US", { hour12: true });
}

function formatDate(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function dateKey(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  // Use local-tz Y-M-D as the boundary key; toDateString() does this.
  return d.toDateString();
}

function relativeTime(ts: string): string {
  const d = new Date(ts).getTime();
  if (Number.isNaN(d)) return ts;
  const seconds = Math.round((Date.now() - d) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function levelColor(level: LogEntry["level"]): string {
  if (level === "error") return COLORS.error;
  if (level === "warn") return COLORS.warn;
  return COLORS.info;
}

function eventClass(msg: string, source: string): string {
  if (source === "telemetry") return "phase";
  if (msg.startsWith("issue ")) return "ingest";
  if (msg.includes("orchestrator spawned")) return "fire";
  if (msg.startsWith("curator action:")) return "curator";
  if (msg.startsWith("poll complete")) return "poll";
  return "system";
}

function eventClassColor(cls: string): string {
  switch (cls) {
    case "ingest": return COLORS.success;
    case "fire": return COLORS.ticket;
    case "phase": return COLORS.info;
    case "curator": return COLORS.warn;
    case "poll": return COLORS.muted;
    default: return COLORS.muted;
  }
}

function describe(e: LogEntry): string {
  if (e.source === "telemetry") {
    const ms = e.ms != null ? ` · ${(e.ms / 1000).toFixed(1)}s` : "";
    return `phase ${e.phase ?? "?"}${ms}`;
  }
  return e.msg;
}

function repoCell(e: LogEntry): string {
  if (!e.slug) return "";
  if (e.count > 1 && e.distinctSlugs > 1) {
    return `${e.distinctSlugs} repos`;
  }
  return `${e.slug}${e.number != null ? `#${e.number}` : ""}`;
}

export default function LogStream({ data }: ViewProps<LogStreamData>) {
  const entries = data.entries ?? [];
  const latest = data.latestPoll;
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on first paint and whenever new events arrive,
  // mimicking `tail -f`. Latest event is always visible without manual scroll.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [entries.length, entries[entries.length - 1]?.endTs]);

  return (
    <div
      style={{
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
        background: COLORS.bg,
        color: COLORS.text,
        margin: 0,
        padding: 0,
        minHeight: "100vh",
        fontSize: "12px",
      }}
    >
      <header
        style={{
          padding: "10px 16px",
          borderBottom: `1px solid ${COLORS.border}`,
          background: COLORS.panel,
          position: "sticky",
          top: 0,
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          gap: "20px",
          fontSize: "12px",
        }}
      >
        <strong style={{ fontSize: "13px" }}>dispatch</strong>
        <span style={{ color: COLORS.muted }}>
          {entries.length} {entries.length === 1 ? "entry" : "entries"}
        </span>
        {latest && (
          <span style={{ color: COLORS.muted }}>
            last poll {relativeTime(latest.ts)}
            {latest.ingested > 0 && (
              <span style={{ color: COLORS.success, marginLeft: "8px" }}>
                · ingested {latest.ingested}
              </span>
            )}
            {latest.fired > 0 && (
              <span style={{ color: COLORS.ticket, marginLeft: "8px" }}>
                · fired {latest.fired}
              </span>
            )}
            {latest.errors > 0 && (
              <span style={{ color: COLORS.error, marginLeft: "8px" }}>
                · errors {latest.errors}
              </span>
            )}
          </span>
        )}
        <span style={{ marginLeft: "auto", color: COLORS.muted, fontSize: "11px" }}>
          view started {new Date(data.startedAt).toLocaleTimeString("en-US", { hour12: true })}
        </span>
      </header>

      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
        }}
      >
        <colgroup>
          <col style={{ width: "100px" }} />
          <col style={{ width: "70px" }} />
          <col style={{ width: "80px" }} />
          <col />
          <col style={{ width: "100px" }} />
          <col style={{ width: "240px" }} />
        </colgroup>
        <thead>
          <tr style={{ background: COLORS.panel, color: COLORS.muted }}>
            <th style={thStyle}>time</th>
            <th style={thStyle}>level</th>
            <th style={thStyle}>kind</th>
            <th style={thStyle}>event</th>
            <th style={thStyle}>ticket</th>
            <th style={thStyle}>repo</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 ? (
            <tr>
              <td
                colSpan={6}
                style={{
                  padding: "32px 20px",
                  color: COLORS.muted,
                  textAlign: "center",
                }}
              >
                Waiting for events. The next dispatch poll tick will appear here.
              </td>
            </tr>
          ) : (
            (() => {
              const rows: JSX.Element[] = [];
              let lastDate = "";
              for (let i = 0; i < entries.length; i++) {
                const e = entries[i]!;
                const k = dateKey(e.endTs);
                if (k !== lastDate) {
                  lastDate = k;
                  rows.push(
                    <tr key={`date-${k}`}>
                      <td
                        colSpan={6}
                        style={{
                          padding: "14px 16px 6px",
                          background: COLORS.bg,
                          color: COLORS.muted,
                          fontSize: "11px",
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                          borderTop: `1px solid ${COLORS.border}`,
                          fontWeight: 600,
                        }}
                      >
                        {formatDate(e.endTs)}
                      </td>
                    </tr>,
                  );
                }
                const cls = eventClass(e.msg, e.source);
                const isCollapsed = e.count > 1;
                rows.push(
                  <tr
                    key={`${e.startTs}-${i}`}
                    style={{ borderBottom: `1px solid ${COLORS.border}` }}
                  >
                    <td style={tdStyle}>
                      <div>{formatTime(e.endTs)}</div>
                      {isCollapsed && (
                        <div style={{ color: COLORS.muted, fontSize: "10px" }}>
                          from {formatTime(e.startTs)}
                        </div>
                      )}
                    </td>
                    <td style={{ ...tdStyle, color: levelColor(e.level) }}>
                      {e.level.toUpperCase()}
                    </td>
                    <td style={{ ...tdStyle, color: eventClassColor(cls) }}>
                      {cls}
                    </td>
                    <td style={tdStyle}>
                      {describe(e)}
                      {isCollapsed && (
                        <span
                          style={{
                            marginLeft: "8px",
                            color: COLORS.count,
                            fontWeight: 600,
                          }}
                        >
                          × {e.count}
                        </span>
                      )}
                    </td>
                    <td style={{ ...tdStyle, color: COLORS.ticket }}>
                      {e.ticket ?? ""}
                    </td>
                    <td style={{ ...tdStyle, color: COLORS.muted, fontSize: "11px" }}>
                      {repoCell(e)}
                    </td>
                  </tr>,
                );
              }
              return rows;
            })()
          )}
        </tbody>
      </table>
      <div ref={bottomRef} style={{ height: 1 }} />
    </div>
  );
}

const thStyle = {
  padding: "8px 12px",
  textAlign: "left" as const,
  fontWeight: 500,
  borderBottom: `1px solid ${COLORS.border}`,
  fontSize: "10px",
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
};

const tdStyle = {
  padding: "6px 12px",
  verticalAlign: "top" as const,
  whiteSpace: "nowrap" as const,
  overflow: "hidden" as const,
  textOverflow: "ellipsis" as const,
};
