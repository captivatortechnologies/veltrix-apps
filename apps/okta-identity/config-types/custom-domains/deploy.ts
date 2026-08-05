import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  buildBrandBody,
  buildCertificateBody,
  buildCreateBody,
  extractCustomDomainSpecs,
  hasFullCertMaterial,
  isManualCertificate,
  type CustomDomainSpec,
  type LiveCustomDomain,
} from './validate'

export interface CustomDomainRollbackEntry {
  /** The declared domain — carried for messages only; rollback keys on the id. */
  domain: string
  existed: boolean
  /** The domain id Okta assigns — the rollback key (never the domain string). */
  id?: string
  /** The brandId bound BEFORE this deploy touched it, replayed via PUT on rollback. */
  priorBrandId?: string
}

/**
 * Deploy custom login-URL domains to an Okta org via the Custom Domains API. NO
 * UPSERT exists, so for each declared domain:
 *   - GET  /domains                    — list all and match by domain (case-insensitive)
 *   - POST /domains                    — create a missing domain (born UNVERIFIED)
 *   - PUT  /domains/{id}                — rebind the brand (the ONLY field this
 *                                         endpoint accepts — brandId is the one
 *                                         updatable field on an existing domain)
 *   - PUT  /domains/{id}/certificate    — upsert (create OR renew) a MANUAL
 *                                         certificate; called on every deploy
 *                                         where full material is supplied, so
 *                                         rotating a cert is just redeploying
 *
 * `domain` is IMMUTABLE — Okta has no rename endpoint, so a declared domain that
 * differs from anything live is simply a different item (matched separately).
 * Once a domain's certificate has been switched to MANUAL, Okta has no endpoint
 * to revert it to OKTA_MANAGED — that is a hard error surfaced with
 * delete-and-recreate guidance.
 *
 * VERIFICATION is an external one-time DNS handshake (the operator adds the DNS
 * records Okta returns, then verifies). This app NEVER auto-verifies — every
 * newly CREATED domain is surfaced in the deploy message so it can be verified
 * out of band, matching the Email Domains config type's established principle.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractCustomDomainSpecs(ctx.canvas).filter((s) => s.domain)
  const rollbackState: CustomDomainRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []
  // Domains created UNVERIFIED that need the external DNS verify handshake.
  const needsVerify: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findCustomDomain(client, spec.domain)

      if (existing && existing.id) {
        // Once MANUAL, Okta has no endpoint to revert a domain's certificate
        // source back to OKTA_MANAGED — fail fast with clear guidance rather
        // than silently ignoring the desired change.
        const liveSource = (existing.certificateSourceType ?? '').toUpperCase()
        if (liveSource === 'MANUAL' && !isManualCertificate(spec.certificateSourceType)) {
          throw new Error(
            `Custom domain "${spec.domain}" already has a MANUAL certificate — Okta has no API to revert a domain to OKTA_MANAGED. Delete "${spec.domain}" and redeploy to switch it back.`,
          )
        }

        const priorBrandId = (existing.brandId ?? '').toString().trim() || undefined
        rollbackState.push({ domain: spec.domain, existed: true, id: existing.id, priorBrandId })

        // brandId is the ONLY updatable field on an existing domain — rebind it
        // when declared. Blank means "leave untouched" (Okta has no unbind API).
        if (spec.brandId && spec.brandId !== priorBrandId) {
          const res = await client.request('PUT', `/domains/${existing.id}`, { body: buildBrandBody(spec.brandId) })
          if (!res.ok) {
            throw new Error(`Failed to rebind brand for custom domain "${spec.domain}": ${oktaErrorMessage(res)}`)
          }
        }

        // Upsert (create or RENEW) the MANUAL certificate whenever full material
        // is supplied — this endpoint is explicitly idempotent/renewable, unlike
        // a create-only secret (e.g. the log-streams Splunk HEC token).
        if (isManualCertificate(spec.certificateSourceType) && hasFullCertMaterial(spec)) {
          const certRes = await client.request('PUT', `/domains/${existing.id}/certificate`, {
            body: buildCertificateBody(spec),
          })
          if (!certRes.ok) {
            throw new Error(`Failed to upsert certificate for custom domain "${spec.domain}": ${oktaErrorMessage(certRes)}`)
          }
        }
      } else {
        const res = await client.request('POST', '/domains', { body: buildCreateBody(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create custom domain "${spec.domain}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveCustomDomain>(res.body)
        if (!created?.id) {
          throw new Error(`Custom domain "${spec.domain}" was created but the API returned no id`)
        }
        rollbackState.push({ domain: spec.domain, existed: false, id: created.id })
        createdIds.push(created.id)
        // A newly created custom domain is UNVERIFIED — flag it for the
        // external DNS verify handshake.
        needsVerify.push(spec.domain)

        if (isManualCertificate(spec.certificateSourceType) && hasFullCertMaterial(spec)) {
          const certRes = await client.request('PUT', `/domains/${created.id}/certificate`, {
            body: buildCertificateBody(spec),
          })
          if (!certRes.ok) {
            throw new Error(`Failed to set certificate for custom domain "${spec.domain}": ${oktaErrorMessage(certRes)}`)
          }
        }

        if (spec.brandId) {
          const brandRes = await client.request('PUT', `/domains/${created.id}`, { body: buildBrandBody(spec.brandId) })
          if (!brandRes.ok) {
            throw new Error(`Failed to bind brand for custom domain "${spec.domain}": ${oktaErrorMessage(brandRes)}`)
          }
        }
      }

      deployed.push(spec.domain)
    }

    let message = `Deployed ${deployed.length} custom domain(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}`
    if (needsVerify.length > 0) {
      message +=
        `. DNS verification required (external one-time handshake — this app does NOT auto-verify): ${needsVerify.join(', ')}. ` +
        `New custom domains are created UNVERIFIED — add the DNS records Okta returned (GET /domains/{id} to see dnsRecords) to your DNS, then verify from the Okta Admin console or via POST /domains/{id}/verify.`
    }

    return {
      success: true,
      message,
      artifacts: { baseUrl, deployedDomains: deployed, needsVerify },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom domain deployment failed after ${deployed.length} of ${specs.length} domain(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedDomains: deployed, needsVerify },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** Find a custom domain by domain (case-insensitive) across the list; null when absent. */
export async function findCustomDomain(client: OktaClient, domain: string): Promise<LiveCustomDomain | null> {
  const res = await client.request('GET', '/domains')
  if (!res.ok) {
    throw new Error(`Failed to list custom domains while resolving "${domain}": ${oktaErrorMessage(res)}`)
  }
  const parsed = parseJson<{ domains?: LiveCustomDomain[] }>(res.body)
  const target = domain.trim().toLowerCase()
  return (parsed?.domains ?? []).find((d) => (d.domain ?? '').toString().trim().toLowerCase() === target) ?? null
}

/** Fetch a single custom domain by id; null on 404. */
export async function getCustomDomainById(client: OktaClient, id: string): Promise<LiveCustomDomain | null> {
  const res = await client.request('GET', `/domains/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch custom domain ${id}: ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveCustomDomain>(res.body)
}

// Re-exported so rollback/driftDetect/healthCheck share one spec type.
export type { CustomDomainSpec }
