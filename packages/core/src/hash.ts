import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const IGNORED_ENTRIES = new Set([".DS_Store", "node_modules", ".git"]);

export const sha256 = (input: string | Buffer): string => createHash("sha256").update(input).digest("hex");

export const hashDirectory = async (dir: string): Promise<string> => {
  const chunks: string[] = [];

  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (IGNORED_ENTRIES.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const relative = path.relative(dir, absolute);
      if (entry.isDirectory()) {
        chunks.push(`dir:${relative}\n`);
        await walk(absolute);
      } else if (entry.isFile()) {
        const data = await fs.readFile(absolute);
        chunks.push(`file:${relative}:${sha256(data)}\n`);
      } else if (entry.isSymbolicLink()) {
        const target = await fs.readlink(absolute);
        chunks.push(`link:${relative}:${target}\n`);
      }
    }
  };

  await walk(dir);
  return sha256(chunks.join(""));
};

export const makeVariantId = (agent: string, scope: string, hash: string): string =>
  `${agent}-${scope}-${hash.slice(0, 12)}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
