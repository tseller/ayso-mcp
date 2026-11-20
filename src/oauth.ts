import { randomUUID, createHash } from "node:crypto";
import express, { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { OAuthStore } from "./oauth-store.js";
import { ACCESS_HEADER, narrow, type AccessStore, type Caller } from "./access.js";

// --- Types ---

interface OAuthConfig {
  /** Our server's public URL (e.g. https://billcom-mcp-xxx.run.app) */
  serverUrl: string;
  googleClientId: string;
  googleClientSecret: string;
}

interface RegisteredClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  clientName: string;
}

interface PendingAuth {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  clientState: string;
  createdAt: number;
}

interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  googleEmail: string;
  expiresAt: number;
}

interface StoredToken {
  clientId: string;
  googleEmail: string;
  expiresAt: number;
}

// --- Collection names (Firestore / in-memory buckets) ---

const C_CLIENTS = "oauth_clients";
const C_PENDING = "oauth_pending_auths";
const C_CODES = "oauth_auth_codes";
const C_ACCESS = "oauth_access_tokens";
const C_REFRESH = "oauth_refresh_tokens";

const PENDING_TTL_MS = 10 * 60_000;

// --- Helpers ---

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  config: OAuthConfig,
): Promise<{ email: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { id_token?: string; access_token: string };

  // Decode ID token to get email (it's a JWT, we just need the payload)
  if (data.id_token) {
    const payload = JSON.parse(
      Buffer.from(data.id_token.split(".")[1], "base64url").toString(),
    ) as { email?: string };
    if (payload.email) return { email: payload.email };
  }

  // Fallback: use userinfo endpoint
  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  const user = (await userRes.json()) as { email: string };
  return { email: user.email };
}

// --- Router factory ---

export function createOAuthRouter(config: OAuthConfig, store: OAuthStore, access: AccessStore): Router {
  const router = Router();

  // Parse URL-encoded bodies (OAuth token requests use application/x-www-form-urlencoded)
  router.use("/oauth/token", express.urlencoded({ extended: false }));

  // Protected Resource Metadata (RFC 9728) — tells clients which AS protects /mcp
  router.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
    res.json({
      resource: config.serverUrl,
      authorization_servers: [config.serverUrl],
    });
  });

  // OAuth 2.0 Authorization Server Metadata (RFC 8414)
  router.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
    res.json({
      issuer: config.serverUrl,
      authorization_endpoint: `${config.serverUrl}/oauth/authorize`,
      token_endpoint: `${config.serverUrl}/oauth/token`,
      registration_endpoint: `${config.serverUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    });
  });

  // Dynamic Client Registration (RFC 7591)
  router.post("/oauth/register", async (req: Request, res: Response) => {
    const { client_name, redirect_uris } = req.body as {
      client_name?: string;
      redirect_uris?: string[];
    };

    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris required" });
      return;
    }

    const clientId = randomUUID();
    const clientSecret = randomUUID();

    const client: RegisteredClient = {
      clientId,
      clientSecret,
      redirectUris: redirect_uris,
      clientName: client_name || "unknown",
    };
    await store.set(C_CLIENTS, clientId, client);
    console.error(`[oauth] Registered client: ${client.clientName} (${clientId})`);

    res.status(201).json({
      client_id: clientId,
      client_secret: clientSecret,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
    });
  });

  // Authorization endpoint — redirects to Google OAuth
  // Accepts both registered clients and unregistered public clients (e.g. Claude Desktop)
  router.get("/oauth/authorize", async (req: Request, res: Response) => {
    const {
      response_type,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      state,
    } = req.query as Record<string, string>;

    if (response_type !== "code") {
      res.status(400).json({ error: "unsupported_response_type" });
      return;
    }

    if (!client_id || !redirect_uri) {
      res.status(400).json({ error: "invalid_request", error_description: "client_id and redirect_uri required" });
      return;
    }

    if (!code_challenge || code_challenge_method !== "S256") {
      res.status(400).json({ error: "invalid_request", error_description: "PKCE with S256 required" });
      return;
    }

    // Store pending auth request, keyed by a state we send to Google
    const googleState = randomUUID();
    const pending: PendingAuth = {
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
      clientState: state || "",
      createdAt: Date.now(),
    };
    await store.set(C_PENDING, googleState, pending);

    // Redirect to Google OAuth
    const googleAuthUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    googleAuthUrl.searchParams.set("client_id", config.googleClientId);
    googleAuthUrl.searchParams.set("redirect_uri", `${config.serverUrl}/oauth/callback`);
    googleAuthUrl.searchParams.set("response_type", "code");
    googleAuthUrl.searchParams.set("scope", "openid email");
    googleAuthUrl.searchParams.set("state", googleState);
    googleAuthUrl.searchParams.set("access_type", "offline");
    googleAuthUrl.searchParams.set("prompt", "consent");

    res.redirect(googleAuthUrl.toString());
  });

  // Google OAuth callback
  router.get("/oauth/callback", async (req: Request, res: Response) => {
    const { code, state, error } = req.query as Record<string, string>;

    if (error) {
      res.status(400).send(`OAuth error: ${error}`);
      return;
    }

    const pending = await store.get<PendingAuth>(C_PENDING, state);
    if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
      res.status(400).send("Invalid or expired state parameter");
      return;
    }
    await store.delete(C_PENDING, state);

    try {
      const { email } = await exchangeGoogleCode(
        code,
        `${config.serverUrl}/oauth/callback`,
        config,
      );

      console.error(`[oauth] Google auth successful for: ${email}`);

      // The treasurer (ALLOWED_EMAILS) or a granted viewer — see access.ts.
      const granted = await access.accessFor(email);
      if (!granted) {
        console.error(`[oauth] Rejected: ${email} is neither in ALLOWED_EMAILS nor a granted viewer`);
        res.status(403).send("Access denied");
        return;
      }
      console.error(`[oauth] ${email} signs in with ${granted} access`);

      // Generate our own auth code
      const ourCode = randomUUID();
      const authCode: AuthCode = {
        code: ourCode,
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        codeChallengeMethod: pending.codeChallengeMethod,
        googleEmail: email,
        expiresAt: Date.now() + 5 * 60_000, // 5 min
      };
      await store.set(C_CODES, ourCode, authCode);

      // Redirect back to Claude Desktop with our auth code
      const redirectUrl = new URL(pending.redirectUri);
      redirectUrl.searchParams.set("code", ourCode);
      if (pending.clientState) redirectUrl.searchParams.set("state", pending.clientState);

      res.redirect(redirectUrl.toString());
    } catch (err) {
      console.error("[oauth] Google token exchange failed:", err);
      res.status(500).send("Authentication failed");
    }
  });

  // Token endpoint — exchanges auth code or refresh token for access token
  // Supports both confidential clients (with client_secret) and public clients (PKCE only)
  router.post("/oauth/token", async (req: Request, res: Response) => {
    const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier, refresh_token } =
      req.body as Record<string, string>;

    if (!client_id) {
      res.status(400).json({ error: "invalid_request", error_description: "client_id required" });
      return;
    }

    // For registered (confidential) clients, validate client_secret
    // For unregistered (public) clients, skip — PKCE provides security
    const client = await store.get<RegisteredClient>(C_CLIENTS, client_id);
    if (client && client.clientSecret !== client_secret) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }

    if (grant_type === "authorization_code") {
      const authCode = await store.get<AuthCode>(C_CODES, code);
      if (!authCode) {
        res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired code" });
        return;
      }
      await store.delete(C_CODES, code);

      if (Date.now() > authCode.expiresAt) {
        res.status(400).json({ error: "invalid_grant", error_description: "Code expired" });
        return;
      }

      if (authCode.clientId !== client_id || authCode.redirectUri !== redirect_uri) {
        res.status(400).json({ error: "invalid_grant", error_description: "Client/redirect mismatch" });
        return;
      }

      // Validate PKCE
      if (!code_verifier || sha256(code_verifier) !== authCode.codeChallenge) {
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }

      // Issue tokens
      const accessToken = randomUUID();
      const refreshTok = randomUUID();
      const expiresIn = 3600; // 1 hour

      await store.set<StoredToken>(C_ACCESS, accessToken, {
        clientId: client_id,
        googleEmail: authCode.googleEmail,
        expiresAt: Date.now() + expiresIn * 1000,
      });

      await store.set<StoredToken>(C_REFRESH, refreshTok, {
        clientId: client_id,
        googleEmail: authCode.googleEmail,
        expiresAt: 0, // doesn't expire
      });

      console.error(`[oauth] Issued tokens for: ${authCode.googleEmail}`);

      res.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: expiresIn,
        refresh_token: refreshTok,
      });
    } else if (grant_type === "refresh_token") {
      const stored = await store.get<StoredToken>(C_REFRESH, refresh_token);
      if (!stored || stored.clientId !== client_id) {
        res.status(400).json({ error: "invalid_grant", error_description: "Invalid refresh token" });
        return;
      }
      // A refresh token outlives any one grant, so access is asked again here:
      // a revoked viewer cannot mint another hour.
      if (!(await access.accessFor(stored.googleEmail))) {
        console.error(`[oauth] Refresh refused: ${stored.googleEmail} no longer has access`);
        res.status(400).json({ error: "invalid_grant", error_description: "Access has been revoked" });
        return;
      }

      const accessToken = randomUUID();
      const expiresIn = 3600;

      await store.set<StoredToken>(C_ACCESS, accessToken, {
        clientId: client_id,
        googleEmail: stored.googleEmail,
        expiresAt: Date.now() + expiresIn * 1000,
      });

      console.error(`[oauth] Refreshed token for: ${stored.googleEmail}`);

      res.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: expiresIn,
      });
    } else {
      res.status(400).json({ error: "unsupported_grant_type" });
    }
  });

  return router;
}

// --- Auth middleware for /mcp ---

/**
 * Bearer check plus access: on success `res.locals.caller` says who is calling
 * and with what access, decided now rather than when the token was issued, so
 * a revoked viewer is refused on their next request (see access.ts).
 */
export function createRequireAuth(store: OAuthStore, access: AccessStore) {
  return async function requireAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const token = authHeader.slice(7);
    const asked = req.headers[ACCESS_HEADER];

    // Static API token for trusted agents (bypasses OAuth)
    const apiToken = process.env.MCP_API_TOKEN;
    if (apiToken && token === apiToken) {
      res.locals.caller = { who: "api-token", access: narrow("full", asked) } satisfies Caller;
      next();
      return;
    }

    const stored = await store.get<StoredToken>(C_ACCESS, token);
    if (!stored || Date.now() > stored.expiresAt) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const granted = await access.accessFor(stored.googleEmail);
    if (!granted) {
      res.locals.refusalReason = `access revoked for ${stored.googleEmail}`;
      res.status(403).json({ error: "Forbidden", error_description: "This account no longer has access" });
      return;
    }

    res.locals.caller = { who: stored.googleEmail, access: narrow(granted, asked) } satisfies Caller;
    next();
  };
}
