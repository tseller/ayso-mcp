import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { NodeStreamableHTTPServerTransport, toNodeHandler } from "@modelcontextprotocol/node";
import type { InboundLegacyRouteReason } from "@modelcontextprotocol/server";
import { McpServer, createMcpHandler, isInitializeRequest } from "@modelcontextprotocol/server";
import express from "express";
import type { QboConfig } from "./qbo-client.js";
import { QboClient } from "./qbo-client.js";
import { registerQboAccountTools } from "./tools/qbo-accounts.js";
import { registerQboVendorTools } from "./tools/qbo-vendors.js";
import { registerQboTransactionTools } from "./tools/qbo-transactions.js";
import { registerQboReportTools } from "./tools/qbo-reports.js";
import { registerQboReconcileTools } from "./tools/qbo-reconcile.js";
import { registerQboClassTools } from "./tools/qbo-classes.js";
import { registerQboClassReportTools } from "./tools/qbo-class-reports.js";
import { registerQboClassWriteTools } from "./tools/qbo-class-writes.js";
import { registerQboBudgetTools } from "./tools/qbo-budgets.js";
import { createOAuthRouter, createRequireAuth } from "./oauth.js";
import { FirestoreOAuthStore } from "./oauth-store.js";
import { createQboAuthRouter } from "./qbo-auth-callback.js";
import { DivvyClient } from "./divvy-client.js";
import { registerDivvyTools } from "./tools/divvy.js";
import { IdempotencyStore } from "./idempotency.js";
import { gmailClientFromEnv } from "./gmail-client.js";
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  negotiateProtocolVersion,
  reconcileProtocolVersion,
  setRequestHeader,
} from "./protocol-version.js";
import {
  answerMissingSession,
  answerPreSession,
  answerUnknownSession,
  type PreSessionAnswer,
} from "./pre-session.js";
import { cachedDiscoverReading } from "./discover.js";
import { routeEra } from "./era-routing.js";

/**
 * Send one of `src/pre-session.ts`'s answers, and record its reason where the
 * rejection logger will pick it up — so the log line and the response body are
 * two views of the same decision rather than two texts that can disagree.
 */
function sendAnswer(res: Response, answer: PreSessionAnswer): void {
  res.locals.refusalReason = answer.reason;
  res.status(answer.status).json(answer.body);
}

export function startHttpServer(qboConfig?: QboConfig): void {
  const transports = new Map<string, NodeStreamableHTTPServerTransport>();

  // The protocol version each live session negotiated at `initialize`. This is
  // the authoritative answer to "what does this session speak" — see
  // protocol-version.ts for why the client's per-request header isn't.
  const negotiatedVersions = new Map<string, string>();

  const serverUrl = process.env.SERVER_URL || `http://localhost:${process.env.PORT || "8080"}`;
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

  // One QboClient per process — shared across sessions so single-flight refresh
  // applies across concurrent tool calls. Refresh happens lazily on the first
  // real request rather than on cold start, so two near-simultaneous cold
  // starts don't both race the same refresh token to Intuit (which would trip
  // refresh-token-reuse detection and revoke the whole token family).
  const qboClient = qboConfig ? new QboClient(qboConfig) : undefined;

  // Firestore-backed stores shared across sessions/instances. The Firestore
  // store works off the metadata-server token, independent of the OAuth layer.
  const gcpProjectId = process.env.GCP_PROJECT_ID || "mcp-servers-487419";
  const firestore = new FirestoreOAuthStore(gcpProjectId);
  const idempotency = new IdempotencyStore(firestore);
  const gmail = gmailClientFromEnv();

  /**
   * One fresh server instance with every tool on it.
   *
   * Both eras are served from this one factory, which is the point: a tool
   * registered here is reachable from a 2025 client through the sessionful
   * legacy transport and from a 2026 client through the per-request modern
   * handler, with no second registration list to keep in step.
   */
  const buildServer = (): McpServer => {
    const server = new McpServer(
      { name: "treasurer-mcp", version: "0.2.0" },
      { capabilities: { tools: {} } },
    );

    if (qboClient) {
      registerQboAccountTools(server, qboClient);
      registerQboVendorTools(server, qboClient);
      registerQboTransactionTools(server, qboClient, { idempotency, gmail });
      registerQboReportTools(server, qboClient);
      registerQboReconcileTools(server, qboClient);
      registerQboClassTools(server, qboClient, { idempotency });
      registerQboClassReportTools(server, qboClient);
      registerQboClassWriteTools(server, qboClient);
      registerQboBudgetTools(server, qboClient);
    }

    const divvyToken = process.env.DIVVY_API_TOKEN;
    if (divvyToken) {
      registerDivvyTools(server, new DivvyClient(divvyToken), { gmail });
    }

    return server;
  };

  /**
   * The modern leg: MCP revision 2026-07-28, served per request.
   *
   * `legacy: "reject"` because the legacy leg below is *sessionful* and keeps
   * its own sessions, event stream and teardown. `createMcpHandler`'s built-in
   * legacy posture is stateless-per-request, which would answer a client's GET
   * and DELETE with `405` and silently drop the sessions this deployment's
   * clients already hold. So the two legs are routed in front of, rather than
   * folded into, one another — the arrangement the SDK's own
   * `isLegacyRequest` recipe describes for exactly this case.
   */
  const modern = createMcpHandler(() => buildServer(), { legacy: "reject" });
  const modernNode = toNodeHandler(modern, {
    onerror: (error) => console.error(`[http] modern handler error: ${error.message}`),
  });

  /** What the modern leg advertises, read from the modern leg. See discover.ts. */
  const discoverReading = cachedDiscoverReading((request) => modern.fetch(request));

  // Build the Express app ourselves so we control the JSON body limit.
  // The SDK's createMcpExpressApp hard-codes express.json() at express's
  // default 100kb, which rejects receipt-photo attachments — a 2-3MB JPEG is
  // ~3-4MB as base64 inside the JSON-RPC body. 25mb leaves ample headroom and
  // stays under Cloud Run's 32MB request cap. For our 0.0.0.0 bind the SDK
  // helper adds no DNS-rebinding middleware anyway, so this is otherwise
  // equivalent (and /mcp is still bearer-protected below).
  const app = express();

  // Name every rejected /mcp request in the logs. Cloud Run's access log shows
  // only "400" with a byte count, so a request the transport turns away (wrong
  // protocol version, dead session, bad handshake) is invisible server-side and
  // surfaces to the user as an unexplained tool failure. Log the method,
  // session and protocol version so the next one is readable, not guessed at.
  //
  // Mounted first, ahead of body parsing and auth, so it covers *every* way a
  // /mcp request can be refused — a 401 from the bearer check and a 400 from a
  // body that failed to parse are rejections too, and were previously as
  // anonymous as the ones this line was added for. It logs from `res.finish`,
  // so `req.body` is read after the parser has run (or stays `-` if it never
  // did).
  app.use("/mcp", (req: Request, res: Response, next) => {
    res.on("finish", () => {
      if (res.statusCode < 400) return;
      const body = req.body as { method?: string; id?: unknown } | undefined;
      console.error(
        `[http] ${req.method} /mcp rejected ${res.statusCode}` +
          ` rpc=${body?.method ?? "-"}` +
          ` session=${(req.headers["mcp-session-id"] as string) ?? "-"}` +
          ` protocolVersion=${(req.headers["mcp-protocol-version"] as string) ?? "-"}` +
          ` ua=${req.headers["user-agent"] ?? "-"}` +
          ` why=${(res.locals.refusalReason as string | undefined) ?? "-"}`,
      );
    });
    next();
  });

  app.use(express.json({ limit: "25mb" }));

  // Mount OAuth routes if Google credentials are configured
  if (googleClientId && googleClientSecret) {
    const oauthStore = firestore;
    const oauthRouter = createOAuthRouter(
      { serverUrl, googleClientId, googleClientSecret },
      oauthStore,
    );
    app.use(oauthRouter);

    // Protect MCP endpoints with OAuth
    app.use("/mcp", createRequireAuth(oauthStore));
    console.error("[http] OAuth enabled (Firestore-backed)");
  } else {
    console.error("[http] OAuth disabled (no GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)");
  }

  // --- The era fork ---
  //
  // One URL, two eras. Which one a request belongs to is decided once, here,
  // by the SDK's own classifier — the same step `createMcpHandler` performs
  // internally — so this branch cannot disagree with how either leg would
  // have handled the request. A modern-enveloped request is served by the
  // modern handler and never reaches the session machinery below; everything
  // else continues to the sessionful legacy leg exactly as before.
  //
  // Mounted after `express.json()` (the classifier reads the body) and after
  // the bearer check (both legs are equally protected; an unauthorized request
  // is refused before either sees it).
  app.use("/mcp", async (req: Request, res: Response, next) => {
    const route = routeEra({
      httpMethod: req.method,
      sessionId: req.headers["mcp-session-id"] as string | undefined,
      protocolVersionHeader: req.headers["mcp-protocol-version"] as string | undefined,
      mcpMethodHeader: req.headers["mcp-method"] as string | undefined,
      mcpNameHeader: req.headers["mcp-name"] as string | undefined,
      body: req.body,
    });

    if (route.leg === "modern") {
      // The modern era answers its own errors, including the ones for a
      // malformed modern claim — the SDK's rule is that every non-legacy
      // request is the modern path's to answer.
      if (route.reason === "malformed-modern") {
        res.locals.refusalReason = `modern claim rejected at ${route.rung} (${route.cell})`;
      }
      await modernNode(req, res, req.body);
      return;
    }

    // Legacy-era traffic. Carry the routing reason forward so the pre-session
    // answer and the log line explain the branch that was actually taken
    // rather than a second guess at it.
    res.locals.legacyRouteReason = route.reason;

    // Reconcile the client's MCP-Protocol-Version header against the version
    // this session actually negotiated, so a client that announces a version we
    // don't speak is answered rather than refused. See protocol-version.ts.
    // Legacy-only by construction: the modern era has no negotiated session
    // version to reconcile a header against, and its header is validated
    // against the body by the handler above.
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const header = req.headers["mcp-protocol-version"] as string | undefined;
    const decision = reconcileProtocolVersion(
      header,
      sessionId ? negotiatedVersions.get(sessionId) : undefined,
    );
    if (decision.action === "replace") {
      setRequestHeader(req, "MCP-Protocol-Version", decision.value);
      console.error(
        `[http] protocol-version reconciled session=${sessionId}` +
          ` client=${header} negotiated=${decision.value}` +
          ` ua=${req.headers["user-agent"] ?? "-"}`,
      );
    }

    next();
  });

  // QBO auth routes — for re-auth when refresh token expires
  const intuitClientId = process.env.INTUIT_CLIENT_ID;
  const intuitClientSecret = process.env.INTUIT_CLIENT_SECRET;
  if (intuitClientId && intuitClientSecret) {
    app.use(createQboAuthRouter({ clientId: intuitClientId, clientSecret: intuitClientSecret, serverUrl }));
    console.error("[http] QBO auth routes enabled at /qbo/auth");
  }

  // Unauthenticated liveness probe — lets "container up" be distinguished
  // from "instance failed to start" when diagnosing edge 5xx responses.
  //
  // It also answers "which MCP protocol versions does the deployed server
  // speak?" without a deploy or a log dig. That list is compiled into the SDK,
  // so before this it could only be learned from the 400 the server emitted
  // when it refused a client — the exact failure #15 is about.
  //
  // The modern half of that answer is not a constant here: it is read back
  // from the modern leg's own `server/discover`, so what `/health` reports and
  // what a modern client is told are one answer rather than two. See
  // src/discover.ts.
  app.get("/health", async (_req: Request, res: Response) => {
    const reading = await discoverReading();
    res.json({
      ok: true,
      revision: process.env.K_REVISION ?? null,
      protocol: {
        // This endpoint serves both eras on the same URL: a modern client is
        // routed to a real `server/discover`, a 2025 client keeps the
        // `initialize` handshake and its session.
        era: "dual",
        modern: reading.ok
          ? {
              // Straight from the DiscoverResult the modern leg just produced.
              supportedVersions: reading.advertisement.supportedVersions,
              capabilities: reading.advertisement.capabilities,
              serverInfo: reading.advertisement.serverInfo ?? null,
              entry: "server/discover",
              serving: "per request, no session",
            }
          : { error: reading.error },
        legacy: {
          latest: LATEST_PROTOCOL_VERSION,
          supported: SUPPORTED_PROTOCOL_VERSIONS,
          entry: "initialize",
          serving: "sessionful",
          // A version outside `supported` is not refused on an established
          // session: it is reconciled to the version that session negotiated.
          unsupportedHeaderPolicy: "reconcile-to-negotiated",
        },
        // What the legacy leg answers a pre-session request it cannot serve.
        // `server/discover` is no longer one of those — it is served on the
        // modern leg. See src/pre-session.ts.
        preSessionMethodPolicy: "jsonrpc-error-naming-both-eras",
      },
    });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Existing session — route to its transport
    if (sessionId) {
      const transport = transports.get(sessionId);
      if (!transport) {
        // 404 per MCP Streamable HTTP spec — signals the client to
        // start a new session via an initialize request, and the body now
        // says so in JSON-RPC rather than in a shape nothing parses.
        sendAnswer(res, answerUnknownSession(sessionId));
        return;
      }
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // New session — the handshake is the only thing this era of the protocol
    // can open one with. Anything else is answered as a JSON-RPC error that
    // names both ways in, never an anonymous 400. See src/pre-session.ts.
    const body = req.body;
    if (!isInitializeRequest(body)) {
      sendAnswer(
        res,
        answerPreSession(body, res.locals.legacyRouteReason as InboundLegacyRouteReason | undefined),
      );
      return;
    }

    // Record what this session settles on, applying the same rule the SDK's
    // initialize handler does. The SDK keeps the negotiated version to itself,
    // and it is the only authority on what the session speaks afterwards.
    const negotiated = negotiateProtocolVersion(
      (body as { params?: { protocolVersion?: unknown } }).params?.protocolVersion,
    );

    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        transports.set(sessionId, transport);
        negotiatedVersions.set(sessionId, negotiated);
        console.error(`[http] New session: ${sessionId} protocolVersion=${negotiated}`);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        transports.delete(sid);
        negotiatedVersions.delete(sid);
      }
      console.error(`[http] Session closed: ${sid}`);
    };

    // A fresh server for this session, from the same factory the modern leg
    // builds its per-request instances with.
    const server = buildServer();

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // GET (SSE stream) and DELETE (session teardown) only ever act on a session
  // that already exists, so both refusals are the pre-session answers above.
  const sessionScoped = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      sendAnswer(res, answerMissingSession());
      return;
    }
    const transport = transports.get(sessionId);
    if (!transport) {
      // 404 per MCP Streamable HTTP spec — signals the client to
      // start a new session via an initialize request.
      sendAnswer(res, answerUnknownSession(sessionId));
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.get("/mcp", sessionScoped);

  app.delete("/mcp", sessionScoped);

  const port = parseInt(process.env.PORT || "8080", 10);

  const httpServer = app.listen(port, "0.0.0.0", () => {
    console.error(`[http] Listening on 0.0.0.0:${port}`);
    // Say which eras this process actually serves, in the process's own log,
    // by asking the modern leg rather than announcing a compiled-in constant.
    void discoverReading().then((reading) => {
      console.error(
        reading.ok
          ? `[http] Serving both MCP eras — modern: ${reading.advertisement.supportedVersions.join(", ")}` +
              ` (server/discover); legacy: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")} (initialize, sessionful)`
          : `[http] Modern leg did not answer its own server/discover: ${reading.error}`,
      );
    });
  });

  // Graceful shutdown for Cloud Run SIGTERM
  process.on("SIGTERM", async () => {
    console.error("[http] SIGTERM received, shutting down...");
    for (const transport of transports.values()) {
      await transport.close();
    }
    // Both legs are torn down: the modern handler aborts its in-flight
    // per-request exchanges and closes their instances.
    await modern.close();
    httpServer.close();
  });
}
