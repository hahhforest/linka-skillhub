import readline from "node:readline";
import type { DistributionItemPlan, DistributionPlan } from "@linka-skillhub/core";

export class ConfirmationRequiredError extends Error {
  readonly code = "ERR_CONFIRMATION_REQUIRED";
  constructor(message: string) {
    super(message);
  }
}

export interface ConfirmOptions {
  readonly yes?: boolean;
  readonly action: string;
  readonly summary: readonly string[];
  readonly totalItems: number;
  readonly targets?: readonly string[];
  readonly skipOnEmpty?: boolean;
}

const escapeLine = (line: string): string => line.replace(/\r?\n/g, " ").trim();

export const summarizePlanForPrompt = (plan: DistributionPlan): readonly string[] => {
  const items = plan.items.slice(0, 16);
  const lines: string[] = [];
  for (const item of items) {
    const action = item.action.padEnd(9, " ");
    lines.push(`${action}${item.skill.name} -> ${item.target.agent}${item.backupPath ? `  (backup ${item.backupPath})` : ""}`);
  }
  if (plan.items.length > items.length) lines.push(`... ${plan.items.length - items.length} more items`);
  return lines.map(escapeLine);
};

export const summarizeCopyForPrompt = (
  fromAgent: string,
  toAgent: string,
  items: readonly DistributionItemPlan[]
): readonly string[] => {
  const head = [`From: ${fromAgent}`, `To:   ${toAgent}`, `Items: ${items.length}`];
  const tail = items.slice(0, 12).map((item) => {
    const action = item.action.padEnd(9, " ");
    return `${action}${item.skill.name}${item.existingPath ? `  (existing ${item.existingPath})` : ""}`;
  });
  if (items.length > 12) tail.push(`... ${items.length - 12} more items`);
  return [...head, ...tail].map(escapeLine);
};

const isInteractive = (): boolean => Boolean(process.stdout.isTTY && process.stdin.isTTY);

const promptYesNo = async (question: string): Promise<boolean> => {
  if (!isInteractive()) return false;
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === "y" || trimmed === "yes");
    });
  });
};

export const assertInteractiveOrYes = async (opts: ConfirmOptions): Promise<void> => {
  if (opts.skipOnEmpty && opts.totalItems === 0) return;
  if (opts.yes === true) return;
  if (process.env.LINKA_SKILLHUB_FORCE_YES === "1") return;
  if (!isInteractive()) {
    const summaryHint = opts.summary.length > 0 ? `\n${opts.summary.join("\n")}` : "";
    throw new ConfirmationRequiredError(
      `Action "${opts.action}" requires --yes in non-interactive shells.${summaryHint}`
    );
  }
  process.stderr.write(`\nAction: ${opts.action}\n`);
  for (const line of opts.summary) process.stderr.write(`  ${line}\n`);
  if (opts.targets && opts.targets.length > 0) {
    process.stderr.write(`Targets: ${opts.targets.join(", ")}\n`);
  }
  process.stderr.write(`Total items: ${opts.totalItems}\n`);
  const accepted = await promptYesNo("Continue?");
  if (!accepted) {
    throw new ConfirmationRequiredError(`Action "${opts.action}" cancelled by user.`);
  }
};
