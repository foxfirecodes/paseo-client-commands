import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { CommandQueue } from "./server/queue.ts";
import { registerCommands } from "./server/register.ts";

export default function contribute(server: PluginServerContext) {
  const queue = new CommandQueue(join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "client-commands", "queue.json"));
  const stop = registerCommands(server, queue);
  return () => { stop(); return queue.close(); };
}
