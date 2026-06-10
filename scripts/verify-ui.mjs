#!/usr/bin/env node
import { spawn } from "node:child_process";
import net from "node:net";

const host = "127.0.0.1";

const findFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a local TCP port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });

const waitForHttp = async (url, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
};

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });

const stopServer = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });

const port = await findFreePort();
const baseUrl = `http://${host}:${port}`;
const server = spawn("node", ["packages/cli/dist/index.js", "--profile", "mirror", "serve", "--host", host, "--port", String(port)], {
  stdio: ["ignore", "pipe", "pipe"]
});

server.stdout.on("data", (chunk) => process.stdout.write(chunk));
server.stderr.on("data", (chunk) => process.stderr.write(chunk));

try {
  await waitForHttp(baseUrl);
  const env = { ...process.env, LINKA_SKILLHUB_URL: baseUrl };
  await run("node", ["scripts/ui-audit.mjs"], { env });
  await run("node", ["scripts/ui-flow-test.mjs"], { env });
} finally {
  await stopServer(server);
}
