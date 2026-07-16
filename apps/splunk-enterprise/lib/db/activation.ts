// =============================================================================
// activation — raw-SQL access to the app-owned `splunk_activation_token` and
// `splunk_notification_outbox` tables (migration 008).
//
// Only token_hash (SHA-256) is stored — never a usable token. The email outbox
// is written in the same flow so a platform notification worker can deliver the
// activation link (the one platform seam; apps have no direct email capability).
// =============================================================================

import type { PlatformDatabaseClient } from '@veltrixsecops/app-sdk'

export interface ActivationTokenRow {
  id: string
  customer_id: string
  infrastructure_id: string
  token_hash: string
  admin_user: string
  admin_email: string
  sh_url: string | null
  environment_name: string | null
  status: string
  expires_at: string | Date
  consumed_at: string | Date | null
  created_at: string | Date
}

export interface CreateTokenInput {
  customerId: string
  infrastructureId: string
  tokenHash: string
  adminUser: string
  adminEmail: string
  shUrl: string | null
  environmentName: string | null
  expiresAtIso: string
}

/** Invalidate any still-pending tokens for an infra, so re-issuing a link
 *  (e.g. after a redeploy) leaves only the newest one usable. */
export async function invalidatePendingForInfra(
  db: PlatformDatabaseClient,
  infrastructureId: string,
): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE splunk_activation_token
       SET status = 'consumed', consumed_at = NOW()
     WHERE infrastructure_id = $1::uuid AND status = 'pending'`,
    infrastructureId,
  )
}

export async function createActivationToken(
  db: PlatformDatabaseClient,
  input: CreateTokenInput,
): Promise<ActivationTokenRow> {
  const rows = await db.$queryRawUnsafe<ActivationTokenRow[]>(
    `INSERT INTO splunk_activation_token
       (customer_id, infrastructure_id, token_hash, admin_user, admin_email,
        sh_url, environment_name, status, expires_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'pending', $8::timestamptz)
     RETURNING *`,
    input.customerId,
    input.infrastructureId,
    input.tokenHash,
    input.adminUser,
    input.adminEmail,
    input.shUrl,
    input.environmentName,
    input.expiresAtIso,
  )
  return rows[0]
}

/** Look up a token by its hash. Returns the row regardless of status/expiry so
 *  the caller can distinguish "unknown" from "already used/expired". */
export async function findTokenByHash(
  db: PlatformDatabaseClient,
  tokenHash: string,
): Promise<ActivationTokenRow | null> {
  const rows = await db.$queryRawUnsafe<ActivationTokenRow[]>(
    'SELECT * FROM splunk_activation_token WHERE token_hash = $1 LIMIT 1',
    tokenHash,
  )
  return rows[0] ?? null
}

/** Mark a token consumed. Conditional on still-pending so a double-submit can't
 *  consume twice (returns the number of rows updated). */
export async function consumeToken(db: PlatformDatabaseClient, id: string): Promise<boolean> {
  const affected = await db.$executeRawUnsafe(
    `UPDATE splunk_activation_token
       SET status = 'consumed', consumed_at = NOW()
     WHERE id = $1::uuid AND status = 'pending'`,
    id,
  )
  return affected > 0
}

export interface EnqueueEmailInput {
  customerId: string
  toEmail: string
  subject: string
  bodyText: string
  bodyHtml: string
  kind?: string
}

/** Write an email to the transactional outbox. A platform notification worker
 *  drains status='pending' and sends. */
export async function enqueueEmail(
  db: PlatformDatabaseClient,
  input: EnqueueEmailInput,
): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO splunk_notification_outbox
       (customer_id, to_email, subject, body_text, body_html, kind, status)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, 'pending')`,
    input.customerId,
    input.toEmail,
    input.subject,
    input.bodyText,
    input.bodyHtml,
    input.kind ?? 'activation',
  )
}
