// =============================================================================
// activationFlow — orchestration for the one-time credential handoff.
//
//   issueActivation()          — called on "ready": mint token, persist its hash,
//                                enqueue the activation email (outbox).
//   resolveBootstrapConnection — PLATFORM SEAM: how to reach + authenticate to an
//                                env's splunkd (mgmt URL + bootstrap admin creds)
//                                so the customer's chosen password can be relayed.
//
// Two documented platform seams, both isolated here:
//   • email delivery — the outbox (a platform notification worker drains it);
//   • bootstrap connection — resolveBootstrapConnection (wired to wherever the
//     env's bootstrap admin secret lives, e.g. an app Connection or the env
//     secret in Secrets Manager). Returns null until wired, so the route
//     degrades gracefully instead of crashing.
// =============================================================================

import type { PlatformDatabaseClient } from '@veltrixsecops/app-sdk'
import {
  mintToken,
  expiryFrom,
  buildActivationLink,
  buildActivationEmail,
} from './activation'
import {
  invalidatePendingForInfra,
  createActivationToken,
  enqueueEmail,
} from './db/activation'

export interface IssueActivationInput {
  customerId: string
  infrastructureId: string
  environmentName: string
  adminUser: string
  /** The initiating customer admin — where the activation link is sent. */
  adminEmail: string
  /** Search-head URL for display in the email (relay target is resolved later). */
  shUrl: string | null
  /** Platform console origin the activation link points at. */
  consoleBaseUrl: string
  /** Injected for determinism/testability (onEvent passes Date.now()). */
  nowMs: number
}

/** Mint a single-use activation token, persist its hash, and enqueue the email.
 *  Only the newest link per infra stays valid (prior pending ones are voided). */
export async function issueActivation(
  db: PlatformDatabaseClient,
  input: IssueActivationInput,
): Promise<void> {
  await invalidatePendingForInfra(db, input.infrastructureId)

  const { token, tokenHash } = mintToken()
  const expiresAtIso = expiryFrom(input.nowMs)

  await createActivationToken(db, {
    customerId: input.customerId,
    infrastructureId: input.infrastructureId,
    tokenHash,
    adminUser: input.adminUser,
    adminEmail: input.adminEmail,
    shUrl: input.shUrl,
    environmentName: input.environmentName,
    expiresAtIso,
  })

  const link = buildActivationLink(input.consoleBaseUrl, token)
  const email = buildActivationEmail({
    environmentName: input.environmentName,
    adminUser: input.adminUser,
    link,
    expiresAtIso,
  })

  await enqueueEmail(db, {
    customerId: input.customerId,
    toEmail: input.adminEmail,
    subject: email.subject,
    bodyText: email.text,
    bodyHtml: email.html,
  })
}

/** How to reach + authenticate to an environment's splunkd for the password
 *  relay. Returns the mgmt URL + the bootstrap admin credential. */
export interface BootstrapConnection {
  managementUrl: string
  username: string
  password: string
}

/**
 * PLATFORM SEAM. Resolve the bootstrap admin connection for an environment so
 * the activation route can relay the customer's chosen password. The real
 * implementation reads the env's bootstrap admin secret (registered by the
 * bring-up as an app Connection, or fetched from Secrets Manager via the
 * platform). Until wired it returns null and the route responds "activation
 * temporarily unavailable" rather than crashing.
 *
 * NOTE: the bootstrap secret is Veltrix-generated at bring-up and stops working
 * the moment the customer's password is set here — so the customer becomes the
 * sole holder. Veltrix never persists the customer's chosen password.
 */
export async function resolveBootstrapConnection(
  _db: PlatformDatabaseClient,
  _infrastructureId: string,
): Promise<BootstrapConnection | null> {
  // TODO(platform): wire to the env's bootstrap admin secret. Intentionally
  // returns null so the flow degrades gracefully until the seam is connected.
  return null
}
