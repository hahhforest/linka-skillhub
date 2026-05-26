import fs from "node:fs/promises";

// Lightweight filesystem helpers shared across core modules. Kept private to
// the core package: not re-exported through the barrel because the API surface
// for downstream consumers should stay narrow.

export const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

export const ensureDir = async (dir: string): Promise<void> => {
  await fs.mkdir(dir, { recursive: true });
};
