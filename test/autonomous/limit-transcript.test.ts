import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTranscriptLine,
  classifyLimitType,
  scanTranscriptTailForLimit,
  transcriptHasTurnAfter,
  readFileTailLines,
} from "../../src/autonomous/limit-transcript.js";

function limitEntry(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    error: "rate_limit",
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    entrypoint: "cli",
    cwd: "/tmp/project",
    sessionId: "abc-123",
    timestamp: "2026-07-05T12:00:00Z",
    message: { content: [{ type: "text", text: "You've hit your session limit · resets 6:40pm (Asia/Calcutta)" }] },
    ...overrides,
  });
}

describe("parseTranscriptLine", () => {
  it("parses a rate_limit API-error entry", () => {
    const parsed = parseTranscriptLine(limitEntry());
    expect(parsed).toMatchObject({
      sessionId: "abc-123",
      cwd: "/tmp/project",
      limitType: "session",
      timestampMs: Date.parse("2026-07-05T12:00:00Z"),
    });
    expect(parsed!.bannerText).toContain("resets 6:40pm");
  });

  it("skips non-error entries, other errors, and sidechain entries", () => {
    expect(parseTranscriptLine(JSON.stringify({ type: "assistant", message: {} }))).toBeNull();
    expect(parseTranscriptLine(limitEntry({ error: "overloaded" }))).toBeNull();
    expect(parseTranscriptLine(limitEntry({ isApiErrorMessage: false }))).toBeNull();
    expect(parseTranscriptLine(limitEntry({ isSidechain: true }))).toBeNull();
  });

  it("never throws on malformed input", () => {
    expect(parseTranscriptLine("")).toBeNull();
    expect(parseTranscriptLine("not json {{{")).toBeNull();
    expect(parseTranscriptLine("null")).toBeNull();
    expect(parseTranscriptLine(JSON.stringify({ error: "rate_limit", isApiErrorMessage: true, message: "not-an-array" }))).toMatchObject({
      bannerText: "",
      limitType: "unknown",
    });
  });

  it("tolerates missing optional fields", () => {
    const parsed = parseTranscriptLine(
      JSON.stringify({ error: "rate_limit", isApiErrorMessage: true }),
    );
    expect(parsed).toMatchObject({ sessionId: null, cwd: null, bannerText: "", limitType: "unknown", timestampMs: null });
  });
});

describe("classifyLimitType", () => {
  it("classifies weekly banners", () => {
    expect(classifyLimitType("You've hit your weekly limit · resets Tuesday 9am")).toBe("weekly");
    expect(classifyLimitType("usage limit · resets Jul 4 at 12:30am (Asia/Calcutta)")).toBe("weekly");
  });

  it("classifies session banners", () => {
    expect(classifyLimitType("You've hit your 5-hour limit · resets 3pm")).toBe("session");
    expect(classifyLimitType("session limit reached · resets 3pm")).toBe("session");
  });

  it("returns unknown otherwise", () => {
    expect(classifyLimitType("You've hit your usage limit")).toBe("unknown");
  });
});

describe("scanTranscriptTailForLimit", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sb-limit-transcript-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds the most recent rate_limit entry bottom-up", () => {
    const path = join(dir, "t.jsonl");
    const lines = [
      JSON.stringify({ type: "user", message: {} }),
      limitEntry({ message: { content: [{ type: "text", text: "old banner · resets 1pm (UTC)" }] } }),
      JSON.stringify({ type: "assistant", message: {} }),
      limitEntry({ message: { content: [{ type: "text", text: "new banner · resets 6:40pm (UTC)" }] } }),
      JSON.stringify({ type: "user", message: {} }),
    ];
    writeFileSync(path, lines.join("\n") + "\n");
    const found = scanTranscriptTailForLimit(path);
    expect(found).not.toBeNull();
    expect(found!.bannerText).toContain("6:40pm");
  });

  it("returns null when no limit entry exists", () => {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, JSON.stringify({ type: "user" }) + "\n");
    expect(scanTranscriptTailForLimit(path)).toBeNull();
  });

  it("returns null for a missing file or missing path", () => {
    expect(scanTranscriptTailForLimit(join(dir, "nope.jsonl"))).toBeNull();
    expect(scanTranscriptTailForLimit(null)).toBeNull();
    expect(scanTranscriptTailForLimit(undefined)).toBeNull();
  });

  it("only scans the tail window", () => {
    const path = join(dir, "t.jsonl");
    const filler = Array.from({ length: 300 }, (_, i) => JSON.stringify({ type: "user", i }));
    writeFileSync(path, [limitEntry(), ...filler].join("\n") + "\n");
    // The limit entry is 300 lines above the end -- outside the 200-line tail.
    expect(scanTranscriptTailForLimit(path, 200)).toBeNull();
    expect(scanTranscriptTailForLimit(path, 400)).not.toBeNull();
  });

  it("skips a rate_limit entry whose sessionId does not match the identity filter", () => {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, limitEntry({ sessionId: "other-session" }) + "\n");
    // Wrong session: a stale/swapped transcript must not supply this reset.
    expect(scanTranscriptTailForLimit(path, 200, { sessionId: "abc-123" })).toBeNull();
    // The same entry IS accepted once the filter matches.
    expect(scanTranscriptTailForLimit(path, 200, { sessionId: "other-session" })).not.toBeNull();
  });

  it("skips a rate_limit entry whose cwd resolves to another project", () => {
    const path = join(dir, "t.jsonl");
    const other = mkdtempSync(join(tmpdir(), "sb-other-proj-"));
    const mine = mkdtempSync(join(tmpdir(), "sb-my-proj-"));
    try {
      writeFileSync(path, limitEntry({ cwd: other }) + "\n");
      expect(scanTranscriptTailForLimit(path, 200, { cwd: mine })).toBeNull();
      expect(scanTranscriptTailForLimit(path, 200, { cwd: other })).not.toBeNull();
    } finally {
      rmSync(other, { recursive: true, force: true });
      rmSync(mine, { recursive: true, force: true });
    }
  });

  it("FAILS CLOSED when the filtered field is absent on the entry (attacker-influenced path)", () => {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, limitEntry({ sessionId: undefined }) + "\n");
    // The transcript path is user-writable: an entry that omits sessionId cannot
    // PROVE it belongs to the stopped session, so a sessionId filter rejects it
    // and the caller falls back to a safe reset (never adopts unattributed evidence).
    expect(scanTranscriptTailForLimit(path, 200, { sessionId: "abc-123" })).toBeNull();
    // With no filter, best-effort evidence is still used.
    expect(scanTranscriptTailForLimit(path, 200)).not.toBeNull();
  });

  it("FAILS CLOSED when a cwd filter is set but the entry omits cwd", () => {
    const path = join(dir, "t.jsonl");
    const mine = mkdtempSync(join(tmpdir(), "sb-my-proj-"));
    try {
      writeFileSync(path, limitEntry({ cwd: undefined }) + "\n");
      expect(scanTranscriptTailForLimit(path, 200, { cwd: mine })).toBeNull();
    } finally {
      rmSync(mine, { recursive: true, force: true });
    }
  });

  it("decodes a >512KiB tail whose read window BEGINS mid multi-byte UTF-8", () => {
    const path = join(dir, "big.jsonl");
    const MAX_TAIL_BYTES = 512 * 1024;
    const banner = "resets 6:40pm - usage café limit 日本語 " + "🚀".repeat(50);
    // A padding first line LARGER than the 512KiB read window, made entirely of
    // 2-byte "é": its code-point boundaries sit at EVEN byte offsets, so an ODD
    // window-start offset lands on a continuation byte (mid-code-point).
    const padLine = "é".repeat(300_000); // 600_000 bytes > MAX_TAIL_BYTES
    const tail = "\n" + [
      JSON.stringify({ type: "user", message: {} }),
      limitEntry({ message: { content: [{ type: "text", text: banner }] } }),
    ].join("\n") + "\n";
    let content = padLine + tail;
    // Force the window-start offset (size - MAX_TAIL_BYTES) ODD => mid-"é".
    // Appending one byte to the (discarded) first line flips its parity.
    let offset = Buffer.byteLength(content, "utf-8") - MAX_TAIL_BYTES;
    if (offset % 2 === 0) {
      content = padLine + " " + tail;
      offset = Buffer.byteLength(content, "utf-8") - MAX_TAIL_BYTES;
    }
    // Prove the test actually bites: the window truly starts on a UTF-8
    // continuation byte (0b10xxxxxx), i.e. inside a code point.
    expect(offset).toBeGreaterThan(0);
    expect(Buffer.from(content, "utf-8")[offset]! & 0xc0).toBe(0x80);

    writeFileSync(path, content);
    const found = scanTranscriptTailForLimit(path, 5);
    expect(found).not.toBeNull();
    // The COMPLETE banner record (after the discarded partial first line) decodes
    // cleanly despite the mid-code-point window start.
    expect(found!.bannerText).toContain("café");
    expect(found!.bannerText).toContain("日本語");
    expect(found!.bannerText).not.toContain("�"); // no replacement chars
  });
});

describe("transcriptHasTurnAfter", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sb-limit-turn-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const SINCE = Date.parse("2026-07-05T12:00:00Z");
  function turn(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type: "assistant",
      sessionId: "abc-123",
      cwd: "/tmp/project",
      timestamp: "2026-07-05T12:00:05Z",
      message: { content: [] },
      ...overrides,
    });
  }
  function write(...lines: string[]): string {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
  }

  it("returns true for a session-attributed assistant/user turn newer than sinceMs", () => {
    expect(transcriptHasTurnAfter(write(turn()), SINCE, { sessionId: "abc-123" })).toBe(true);
    expect(transcriptHasTurnAfter(write(turn({ type: "user" })), SINCE, { sessionId: "abc-123" })).toBe(true);
  });

  it("returns true with no filter on any valid fresh turn", () => {
    expect(transcriptHasTurnAfter(write(turn({ sessionId: undefined })), SINCE)).toBe(true);
  });

  it("returns false for a turn at or before the baseline (not NEW evidence)", () => {
    expect(transcriptHasTurnAfter(write(turn({ timestamp: "2026-07-05T11:59:59Z" })), SINCE, { sessionId: "abc-123" })).toBe(false);
    // Exactly AT the baseline is the boundary turn (possibly the pre-stop turn
    // itself), not strictly-after progress -- must not count.
    expect(transcriptHasTurnAfter(write(turn({ timestamp: "2026-07-05T12:00:00Z" })), SINCE, { sessionId: "abc-123" })).toBe(false);
    // One millisecond after the baseline IS fresh evidence.
    expect(transcriptHasTurnAfter(write(turn({ timestamp: "2026-07-05T12:00:00.001Z" })), SINCE, { sessionId: "abc-123" })).toBe(true);
  });

  it("FAILS CLOSED when a sessionId filter is set but the turn omits sessionId", () => {
    expect(transcriptHasTurnAfter(write(turn({ sessionId: undefined })), SINCE, { sessionId: "abc-123" })).toBe(false);
  });

  it("rejects a foreign-session turn", () => {
    expect(transcriptHasTurnAfter(write(turn({ sessionId: "other" })), SINCE, { sessionId: "abc-123" })).toBe(false);
  });

  it("ignores a sidechain (subagent) turn -- it is not the resumed session", () => {
    expect(transcriptHasTurnAfter(write(turn({ isSidechain: true })), SINCE, { sessionId: "abc-123" })).toBe(false);
  });

  it("ignores malformed lines, non-turn entries, and turns without a valid timestamp", () => {
    expect(transcriptHasTurnAfter(write("not json {{{"), SINCE, { sessionId: "abc-123" })).toBe(false);
    expect(transcriptHasTurnAfter(write(turn({ type: "system" })), SINCE, { sessionId: "abc-123" })).toBe(false);
    expect(transcriptHasTurnAfter(write(turn({ timestamp: undefined })), SINCE, { sessionId: "abc-123" })).toBe(false);
    expect(transcriptHasTurnAfter(write(turn({ timestamp: "not-a-date" })), SINCE, { sessionId: "abc-123" })).toBe(false);
  });

  it("returns false for a missing path or file", () => {
    expect(transcriptHasTurnAfter(null, SINCE)).toBe(false);
    expect(transcriptHasTurnAfter(join(dir, "nope.jsonl"), SINCE)).toBe(false);
  });
});

describe("readFileTailLines", () => {
  it("reads the last N lines of a large file without loading it all", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "sb-limit-tail-"));
    try {
      const path = join(dir2, "big.jsonl");
      const lines = Array.from({ length: 5000 }, (_, i) => `{"i":${i}}`);
      writeFileSync(path, lines.join("\n") + "\n");
      const tail = readFileTailLines(path, 10);
      // Trailing newline yields a final empty element; the content lines before it are the last of the file.
      expect(tail.length).toBe(10);
      expect(tail[tail.length - 2]).toBe('{"i":4999}');
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("returns [] on error", () => {
    expect(readFileTailLines("/nonexistent/path/file.jsonl")).toEqual([]);
  });

  it("rejects a FIFO without blocking (transcript path is attacker-influenced)", () => {
    // O_NONBLOCK makes the in-process open of a never-written FIFO safe: it
    // opens immediately instead of hanging the StopFailure hook, and the
    // isFile() gate rejects it before any read.
    const dir2 = mkdtempSync(join(tmpdir(), "sb-limit-fifo-"));
    try {
      const fifoPath = join(dir2, "fake.jsonl");
      execSync(`mkfifo ${JSON.stringify(fifoPath)}`);
      const started = Date.now();
      expect(readFileTailLines(fifoPath)).toEqual([]);
      expect(Date.now() - started).toBeLessThan(2_000); // did not block on the FIFO
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("rejects a final-component symlink (O_NOFOLLOW)", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "sb-limit-symlink-"));
    try {
      const realPath = join(dir2, "real.jsonl");
      writeFileSync(realPath, '{"i":1}\n');
      const linkPath = join(dir2, "link.jsonl");
      symlinkSync(realPath, linkPath);
      expect(readFileTailLines(linkPath)).toEqual([]);
      // The real file still reads fine directly.
      expect(readFileTailLines(realPath).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
