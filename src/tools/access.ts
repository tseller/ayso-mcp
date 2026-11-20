import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AccessStore } from "../access.js";
import { TOOL_ACCESS } from "../tool-registry.js";
import { runTool } from "../tool-logging.js";

const email = z.string().email().describe("The Google account email the person signs in with");

/** What a viewer can and cannot do, said once for every access tool's answer. */
function viewerScope() {
  const read = Object.entries(TOOL_ACCESS)
    .filter(([, kind]) => kind === "read")
    .map(([name]) => name);
  return {
    viewerTools: read.length,
    viewerCan: "read QuickBooks, Divvy and Sports Connect (balances, reports, budgets, transactions, cards, orders, refunds, enrollment, volunteers, unpaid registrations, player history)",
    viewerCannot: "create, edit, classify or attach anything anywhere, or change who has access",
  };
}

/**
 * Who may see the books (#78). Registered as writes, so only the treasurer is
 * offered them; a viewer's server does not carry them.
 */
export function registerAccessTools(server: McpServer, store: AccessStore): void {
  server.registerTool(
    "access_list_viewers",
    {
      description:
        "List the people who have read-only access to this server: they connect with the same URL, sign in with Google, and are offered only read tools — any write is refused by the server.",
      inputSchema: z.object({}),
    },
    (args) =>
      runTool("access_list_viewers", args, async () => ({
        viewers: Object.entries(await store.viewers()).map(([e, g]) => ({ email: e, ...g })),
        ...viewerScope(),
      })),
  );

  server.registerTool(
    "access_grant_viewer",
    {
      description:
        "Give someone read-only access to the books. They add this server's URL as a custom connector in Claude and sign in with this Google account; they can read QuickBooks, Divvy and Sports Connect and cannot change anything. Takes effect on their next request.",
      inputSchema: z.object({
        email,
        note: z.string().max(200).optional().describe('Who they are, e.g. "Laura, regional commissioner"'),
      }),
    },
    (args) =>
      runTool("access_grant_viewer", args, async ({ email, note }) => {
        const r = await store.grant(email, note);
        console.error(`[access] granted viewer ${r.email}${r.already ? " (renewed)" : ""}`);
        return { granted: r.email, ...r.grant, alreadyHadAccess: r.already, ...viewerScope() };
      }),
  );

  server.registerTool(
    "access_revoke_viewer",
    {
      description:
        "Turn off someone's read-only access. Their very next request is refused — including on a connection they already have open — and their sign-in can no longer be refreshed.",
      inputSchema: z.object({ email }),
    },
    (args) =>
      runTool("access_revoke_viewer", args, async ({ email }) => {
        const r = await store.revoke(email);
        console.error(`[access] revoked viewer ${r.email} wasViewer=${r.wasViewer}`);
        return r.wasViewer
          ? { revoked: r.email, effect: "refused from their next request on" }
          : { revoked: null, note: `${r.email} had no viewer access` };
      }),
  );
}
