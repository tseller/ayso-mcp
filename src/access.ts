/**
 * Who the caller is, and what they may do — decided on every request (#78).
 *
 * Two kinds of caller reach `/mcp`:
 *
 *  - the treasurer (`full`): the static `MCP_API_TOKEN`, or a Google sign-in
 *    whose email is in `ALLOWED_EMAILS`;
 *  - a viewer (`viewer`): a Google sign-in whose email the treasurer granted
 *    with `access_grant_viewer`. Grants live in Firestore, so granting and
 *    revoking is one tool call, with no deploy.
 *
 * Access is looked up on every request rather than stamped onto a token when
 * it is issued. That is what makes revoking one step: the next request after
 * `access_revoke_viewer` — on a live session, or with a token issued an hour
 * ago — finds no grant and is refused. Nothing has to be hunted down and
 * deleted.
 *
 * A full caller may ask to be served as a viewer (`X-Treasurer-Access:
 * viewer`), so the treasurer can see exactly what a viewer sees. The header
 * only ever narrows: it cannot raise anyone's access.
 */

import type { OAuthStore } from "./oauth-store.js";
import type { Access } from "./tool-registry.js";

export const ACCESS_HEADER = "x-treasurer-access";

const C_ACCESS = "access";
const K_VIEWERS = "viewers";

export interface ViewerGrant {
  grantedAt: string;
  /** Who they are, in the treasurer's words ("Laura, regional commissioner"). */
  note?: string;
}

export interface Caller {
  /** An email, or `api-token` for the static token. */
  who: string;
  access: Access;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The treasurer's emails, from `ALLOWED_EMAILS`. `undefined` = no list configured. */
export function fullEmails(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = env.ALLOWED_EMAILS;
  if (raw == null) return undefined;
  return raw.split(",").map(normalizeEmail).filter(Boolean);
}

/**
 * The viewer grants, as one document. One small map rather than a document per
 * viewer because the store reads by key and cannot list, and the list is what
 * the treasurer asks for.
 */
export class AccessStore {
  constructor(private store: OAuthStore) {}

  async viewers(): Promise<Record<string, ViewerGrant>> {
    const doc = await this.store.get<{ viewers?: Record<string, ViewerGrant> }>(C_ACCESS, K_VIEWERS);
    return doc?.viewers ?? {};
  }

  async grant(email: string, note?: string): Promise<{ email: string; grant: ViewerGrant; already: boolean }> {
    const key = normalizeEmail(email);
    const viewers = await this.viewers();
    const already = key in viewers;
    const grant: ViewerGrant = { grantedAt: new Date().toISOString(), ...(note ? { note } : {}) };
    viewers[key] = grant;
    await this.store.set(C_ACCESS, K_VIEWERS, { viewers });
    return { email: key, grant, already };
  }

  async revoke(email: string): Promise<{ email: string; wasViewer: boolean }> {
    const key = normalizeEmail(email);
    const viewers = await this.viewers();
    const wasViewer = key in viewers;
    if (wasViewer) {
      delete viewers[key];
      await this.store.set(C_ACCESS, K_VIEWERS, { viewers });
    }
    return { email: key, wasViewer };
  }

  /**
   * What a signed-in email may do right now, or `undefined` for nothing.
   * The treasurer's list wins over a viewer grant naming the same email.
   */
  async accessFor(email: string, env: NodeJS.ProcessEnv = process.env): Promise<Access | undefined> {
    const key = normalizeEmail(email);
    const full = fullEmails(env);
    // No ALLOWED_EMAILS at all is the server's pre-#78 posture: any Google
    // sign-in is the treasurer. Kept as it was; the deployment sets the list.
    if (full === undefined || full.includes(key)) return "full";
    return key in (await this.viewers()) ? "viewer" : undefined;
  }
}

/** Apply the narrowing header. It can lower access, never raise it. */
export function narrow(access: Access, header: string | string[] | undefined): Access {
  const asked = (Array.isArray(header) ? header[0] : header)?.trim().toLowerCase();
  return asked === "viewer" ? "viewer" : access;
}
