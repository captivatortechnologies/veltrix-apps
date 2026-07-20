import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  buildCreateBody,
  buildUpdateBody,
  extractEmailDomainSpecs,
  type LiveEmailDomain,
} from './validate'

export interface EmailDomainRollbackEntry {
  /** The declared domain — carried for messages only; rollback keys on the id. */
  domain: string
  existed: boolean
  /** The email-domain id Okta assigns — the rollback key (never the domain). */
  id?: string
  /** Prior sender fields (displayName/userName), replayed via PUT on rollback. */
  prior?: { displayName?: string; userName?: string }
}

/**
 * Deploy custom email domains to an Okta org via the Email Domains API. NO UPSERT
 * exists, so for each declared domain:
 *   - GET  /email-domains        — list all and match by domain (case-insensitive)
 *   - PUT  /email-domains/{id}    — update an existing domain (displayName/userName)
 *   - POST /email-domains         — create a missing domain (born UNVERIFIED)
 *
 * domain, brandId and validationSubdomain are IMMUTABLE (Okta's PUT only accepts
 * displayName + userName). A declared brandId/validationSubdomain that differs from
 * a live domain is a hard error asking the operator to delete-and-recreate.
 *
 * VERIFICATION is an external one-time DNS handshake (the operator adds the DNS
 * records Okta returns, then verifies). This app NEVER auto-verifies — every newly
 * CREATED domain is surfaced in the deploy message so it can be verified out of band.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractEmailDomainSpecs(ctx.canvas).filter((s) => s.domain)
  const rollbackState: EmailDomainRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []
  // Domains created UNVERIFIED that need the external DNS verify handshake.
  const needsVerify: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findEmailDomain(client, spec.domain)

      if (existing && existing.id) {
        // brandId + validationSubdomain are IMMUTABLE. Okta cannot change them in
        // place, so a declared value that differs from the live one is a hard
        // error — the operator must delete and recreate the domain. Guard each
        // comparison on the live value being present (some fields are not always
        // returned) so an absent field never reads as an immutable-conflict.
        const liveBrand = (existing.brandId ?? '').toString().trim()
        if (liveBrand && liveBrand !== spec.brandId) {
          throw new Error(
            `Email domain "${spec.domain}": brandId is immutable — an email domain's domain, brand and validation subdomain cannot be changed in place. Delete "${spec.domain}" and redeploy to bind it to a different brand.`,
          )
        }
        const liveSub = (existing.validationSubdomain ?? '').toString().trim()
        if (liveSub && liveSub.toLowerCase() !== spec.validationSubdomain.toLowerCase()) {
          throw new Error(
            `Email domain "${spec.domain}": validationSubdomain is immutable — an email domain's domain, brand and validation subdomain cannot be changed in place. Delete "${spec.domain}" and redeploy to change its validation subdomain.`,
          )
        }

        // UPDATE IN PLACE — capture the prior sender fields for rollback (keyed on
        // the returned id, never the domain), then PUT displayName + userName.
        rollbackState.push({
          domain: spec.domain,
          existed: true,
          id: existing.id,
          prior: { displayName: existing.displayName, userName: existing.userName },
        })

        const res = await client.request('PUT', `/email-domains/${existing.id}`, {
          body: buildUpdateBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update email domain "${spec.domain}": ${oktaErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/email-domains', { body: buildCreateBody(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create email domain "${spec.domain}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveEmailDomain>(res.body)
        if (!created?.id) {
          throw new Error(`Email domain "${spec.domain}" was created but the API returned no id`)
        }
        rollbackState.push({ domain: spec.domain, existed: false, id: created.id })
        createdIds.push(created.id)
        // A newly created custom email domain is UNVERIFIED — flag it for the
        // external DNS verify handshake.
        needsVerify.push(spec.domain)
      }

      deployed.push(spec.domain)
    }

    let message = `Deployed ${deployed.length} email domain(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}`
    if (needsVerify.length > 0) {
      message +=
        `. DNS verification required (external one-time handshake — this app does NOT auto-verify): ${needsVerify.join(', ')}. ` +
        `New custom email domains are created UNVERIFIED — add the DNS records Okta returned (GET /email-domains/{id} to see dnsValidationRecords) to your DNS, then verify from the Okta Admin console or via POST /email-domains/{id}/verify.`
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
      message: `Email domain deployment failed after ${deployed.length} of ${specs.length} domain(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedDomains: deployed, needsVerify },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** Find an email domain by domain (case-insensitive) across the list; null when absent. */
export async function findEmailDomain(client: OktaClient, domain: string): Promise<LiveEmailDomain | null> {
  const res = await client.getAll<LiveEmailDomain>('/email-domains')
  if (!res.ok) {
    throw new Error(
      `Failed to list email domains while resolving "${domain}": ${oktaErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
        nextUrl: null,
      })}`,
    )
  }
  const target = domain.trim().toLowerCase()
  return res.items.find((d) => (d.domain ?? '').toString().trim().toLowerCase() === target) ?? null
}

/** Fetch a single email domain by id; null on 404. */
export async function getEmailDomainById(client: OktaClient, id: string): Promise<LiveEmailDomain | null> {
  const res = await client.request('GET', `/email-domains/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch email domain ${id}: ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveEmailDomain>(res.body)
}
