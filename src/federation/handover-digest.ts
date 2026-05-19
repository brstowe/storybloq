import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedNode } from "./resolver.js";

export interface HandoverDigestEntry {
  nodeName: string;
  heading: string | null;
  date: string | null;
  filename: string | null;
}

export async function buildHandoverDigest(
  resolvedNodes: Map<string, ResolvedNode>,
): Promise<HandoverDigestEntry[]> {
  const entries: HandoverDigestEntry[] = [];

  for (const [name, node] of resolvedNodes) {
    if (!node.resolved) {
      entries.push({ nodeName: name, heading: null, date: null, filename: null });
      continue;
    }

    const handoversDir = join(node.storyDir, "handovers");
    try {
      const files = await readdir(handoversDir);
      const mdFiles = files.filter((f) => f.endsWith(".md")).sort();

      if (mdFiles.length === 0) {
        entries.push({ nodeName: name, heading: null, date: null, filename: null });
        continue;
      }

      const latest = mdFiles[mdFiles.length - 1]!;
      const dateMatch = latest.match(/^(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch ? dateMatch[1]! : null;

      let heading: string | null = null;
      try {
        const content = await readFile(join(handoversDir, latest), "utf-8");
        const headingMatch = content.match(/^#\s+(.+)/m);
        if (headingMatch) {
          heading = headingMatch[1]!.trim();
          if (heading.length > 120) {
            heading = heading.slice(0, 117) + "...";
          }
        }
      } catch {
        // read error, skip heading
      }

      entries.push({ nodeName: name, heading, date, filename: latest });
    } catch {
      entries.push({ nodeName: name, heading: null, date: null, filename: null });
    }
  }

  return entries;
}
