import { test } from "node:test";
import assert from "node:assert/strict";
import { QboClient } from "./qbo-client.js";
import { registerQboTransactionTools } from "./tools/qbo-transactions.js";
import { QBO_RECORDS, QBO_RECORD_KINDS } from "./qbo-records.js";
import type { ToolResult } from "./tool-logging.js";

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** Register the QBO transaction tools against a client whose every request is recorded. */
function harness() {
  const tools = new Map<string, { schema: Record<string, unknown>; handler: Handler }>();
  const server = {
    registerTool: (
      name: string,
      config: { inputSchema?: { shape?: Record<string, unknown> } },
      handler: Handler,
    ) => tools.set(name, { schema: config.inputSchema?.shape ?? {}, handler }),
  };
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const client = Object.create(QboClient.prototype) as QboClient;
  (client as unknown as { request: QboClient["request"] }).request = (async (
    method: string,
    path: string,
    body?: unknown,
  ) => {
    calls.push({ method, path, body });
    return { ok: path };
  }) as QboClient["request"];
  registerQboTransactionTools(server as unknown as Parameters<typeof registerQboTransactionTools>[0], client);
  return { tools, calls };
}

/**
 * Issue #76: qbo_attach_file accepted seven kinds of record and only two could
 * be read back, so a held attach on a Bill could name nothing but its number.
 * Every kind the attach tool accepts must have a registered read-only get tool.
 */
test("every kind of record qbo_attach_file accepts can be read back by id", () => {
  const { tools } = harness();
  const attach = tools.get("qbo_attach_file");
  assert.ok(attach, "qbo_attach_file is not registered");
  const accepted = (attach.schema.entityType as { options: string[] }).options;
  assert.deepEqual([...accepted].sort(), [...QBO_RECORD_KINDS].sort());
  for (const kind of accepted) {
    const spec = QBO_RECORDS[kind as keyof typeof QBO_RECORDS];
    assert.ok(spec, `qbo_attach_file accepts ${kind}, which QBO_RECORDS does not declare`);
    assert.ok(tools.has(spec.tool), `qbo_attach_file accepts ${kind}, but \`${spec.tool}\` is not registered`);
  }
  for (const name of ["qbo_get_bill", "qbo_get_transfer", "qbo_get_journal_entry"]) {
    assert.ok(tools.has(name), `\`${name}\` is not registered`);
  }
});

test("each get tool is one read-only GET of its own kind's endpoint", async () => {
  const { tools, calls } = harness();
  for (const kind of QBO_RECORD_KINDS) {
    const { tool, path } = QBO_RECORDS[kind];
    calls.length = 0;
    const res = await tools.get(tool)!.handler({ id: "42" });
    assert.equal(res.isError, undefined, `${tool} errored: ${res.content[0].text}`);
    assert.deepEqual(calls, [{ method: "GET", path: `/${path}/42`, body: undefined }], tool);
    assert.deepEqual(JSON.parse(res.content[0].text), { ok: `/${path}/42` });
  }
});

test("an id cannot reach past its own record's path", async () => {
  const { tools, calls } = harness();
  await tools.get("qbo_get_bill")!.handler({ id: "1/../../preferences" });
  assert.equal(calls[0].path, "/bill/1%2F..%2F..%2Fpreferences");
});
