import path from "node:path";

export const sanitizePathSegment = (input: string, fallback = "unnamed"): string => {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return slug || fallback;
};

export const assertNoPathSeparators = (name: string, label: string): void => {
  if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new Error(`${label} cannot contain path separators or dot path segments: ${name}`);
  }
};

const isPathInside = (parent: string, child: string): boolean => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

export const assertPathInside = (parent: string, child: string, label: string): void => {
  if (!isPathInside(parent, child)) throw new Error(`${label} escapes allowed root. root=${parent} path=${child}`);
};
