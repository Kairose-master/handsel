/**
 * Access control matrix: (user × permission) -> granted, stored in
 * admin_grants. Replaces a single global "is admin" boolean — different
 * admins can hold different capabilities.
 *
 * ADMIN_EMAIL (env) is a separate superadmin bootstrap: it implicitly holds
 * every permission and isn't stored as a row, so misconfiguring or clearing
 * the grants table can never lock the platform operator out.
 */
import { db } from '@/lib/db'
import { adminGrant, user } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { getSession } from '@/lib/get-session'
import { SAFE_USER_COLUMNS } from '@/lib/db/safe-select'

export const PERMISSIONS = ['disputes', 'credit_rules', 'agent_messages', 'treasury', 'billing'] as const
export type Permission = (typeof PERMISSIONS)[number]

export function isSuperAdminEmail(email: string | undefined | null): boolean {
  const superEmail = process.env.ADMIN_EMAIL
  return Boolean(superEmail && email === superEmail)
}

async function hasGrant(userId: string, permission: Permission): Promise<boolean> {
  const [row] = await db
    .select()
    .from(adminGrant)
    .where(and(eq(adminGrant.userId, userId), eq(adminGrant.permission, permission)))
  return Boolean(row)
}

/** Throws unless the current session holds `permission` (directly granted,
 *  or implicitly as the superadmin). Returns the session user on success. */
export async function requirePermission(permission: Permission) {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  if (isSuperAdminEmail(session.user.email)) return session.user
  if (await hasGrant(session.user.id, permission)) return session.user
  throw new Error('Admin access required')
}

/** Superadmin-only: the full access control matrix, plus enough user info
 *  to render it. */
export async function listGrants() {
  const grants = await db.select().from(adminGrant)
  const userIds = [...new Set(grants.map((g) => g.userId))]
  const users = userIds.length > 0 ? await db.select(SAFE_USER_COLUMNS).from(user) : []
  const byId = new Map(users.map((u) => [u.id, u]))

  return grants
    .map((g) => ({
      userId: g.userId,
      email: byId.get(g.userId)?.email ?? '(unknown user)',
      permission: g.permission as Permission,
      grantedAt: g.grantedAt,
    }))
    .sort((a, b) => a.email.localeCompare(b.email))
}

/** Superadmin-only: grant `permission` to the user with `email`. */
export async function grantPermission(email: string, permission: Permission, grantedBy: string) {
  const [target] = await db.select(SAFE_USER_COLUMNS).from(user).where(eq(user.email, email))
  if (!target) throw new Error('No user found with that email')
  if (isSuperAdminEmail(target.email)) throw new Error('That account is already the superadmin')

  if (await hasGrant(target.id, permission)) return // idempotent
  await db.insert(adminGrant).values({ userId: target.id, permission, grantedBy })
}

/** Superadmin-only: revoke `permission` from a user. */
export async function revokePermission(userId: string, permission: Permission) {
  await db.delete(adminGrant).where(and(eq(adminGrant.userId, userId), eq(adminGrant.permission, permission)))
}
