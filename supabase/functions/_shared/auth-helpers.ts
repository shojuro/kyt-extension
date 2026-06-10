/**
 * Shared auth resolution for service-role-gated edge functions.
 *
 * Trust model (production-safe):
 *   1. Real user JWT (role=authenticated) → that user's id. Always wins.
 *   2. Service-role key → trusted backend (benchmark harness / admin tooling);
 *      may impersonate any user via a body-supplied userId.
 *   3. Anything else (anon key, no token) → no impersonation.
 *
 * This closes the anon-key IDOR: a public client holding only the anon key can
 * no longer read or write another user's data by supplying a target userId,
 * while server-side tooling that authenticates with the service-role key keeps
 * full freedom to operate on arbitrary user ids.
 */

// Structural type — avoids coupling to a specific @supabase/supabase-js version.
interface AdminClientLike {
  auth: {
    getUser(token: string): Promise<{
      data: { user: { id: string } | null };
      error: unknown;
    }>;
  };
}

/**
 * Decode a JWT's payload WITHOUT verifying its signature and return the `role`
 * claim.
 *
 * SAFE ONLY when the Supabase gateway already verified the token
 * (verify_jwt = true). The gateway guarantees the bearer is signed by the
 * project secret, so the decoded `role` is trustworthy. If a function is
 * deployed with verify_jwt = false, an attacker could forge role=service_role,
 * so these functions MUST keep verify_jwt = true.
 */
export function decodeJwtRole(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(json);
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

export interface ResolvedAuth {
  /** Effective user id, or null when the caller may not be identified. */
  userId: string | null;
  /** True when the caller authenticated with the service-role key. */
  isServiceRole: boolean;
}

/**
 * Resolve the effective user id from an Authorization header.
 *
 * @param authHeader     The raw `Authorization` header value (may be null).
 * @param admin          A service-role Supabase client (for token validation).
 * @param fallbackUserId Body-supplied user id, honored ONLY for service-role
 *                       callers (impersonation by trusted backends).
 */
export async function resolveUserId(
  authHeader: string | null,
  admin: AdminClientLike,
  fallbackUserId?: string | null,
): Promise<ResolvedAuth> {
  if (!authHeader?.startsWith("Bearer ") || authHeader.length <= 50) {
    return { userId: null, isServiceRole: false };
  }
  const token = authHeader.slice(7);

  // 1. Real user session token — wins over everything.
  try {
    const { data: { user }, error } = await admin.auth.getUser(token);
    if (user && !error) return { userId: user.id, isServiceRole: false };
  } catch {
    // Not a valid user token — fall through to role check.
  }

  // 2. Service-role key → trusted backend may impersonate any user.
  if (decodeJwtRole(token) === "service_role") {
    return { userId: fallbackUserId ?? null, isServiceRole: true };
  }

  // 3. Anon key (or anything else) → no impersonation.
  return { userId: null, isServiceRole: false };
}
