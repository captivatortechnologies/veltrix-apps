import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPPClient, ppErrorMessage, type PPClient } from '../../lib/proofpoint'
import { buildIdpBody, extractIdpSpecs, idpKey, listIdps, type IdpSpec, type LiveIdp } from './validate'

export interface IdpRollbackEntry {
  key: string
  name: string
  existed: boolean
  id?: string
  prior?: LiveIdp
}

/**
 * Deploy Proofpoint Essentials Identity Providers via the Essentials Interface
 * API (/orgs/{org}/authentication/settings/idps).
 *
 * Identity is the IDP name. This is an UPSERT keyed on the name: list the org's
 * IDPs, then PUT an existing IDP (by its server-assigned UUID) to the declared
 * state, or POST a new one. IDPs the deploy did not declare are never touched.
 * The prior state of each touched IDP is captured so rollback can restore it (or
 * delete a created one).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl, orgDomain } = built

  const specs = extractIdpSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: IdpRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const existing = await listIdps(client)
    const byKey = new Map(existing.filter((i) => i.name).map((i) => [idpKey(i.name as string), i]))

    for (const spec of specs) {
      const key = idpKey(spec.name)
      const live = byKey.get(key)
      const body = buildIdpBody(spec)

      if (live?.id) {
        rollbackState.push({ key, name: spec.name, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', idpPath(client, live.id), { body })
        if (!res.ok) throw new Error(`Failed to update Identity Provider "${spec.name}": ${ppErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', `${client.orgPath}/authentication/settings/idps`, { body })
        if (!res.ok) throw new Error(`Failed to create Identity Provider "${spec.name}": ${ppErrorMessage(res)}`)
        const createdId = readCreatedId(res.body)
        rollbackState.push({ key, name: spec.name, existed: false, id: createdId })
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Identity Provider(s) to Proofpoint Essentials org "${orgDomain}": ${deployed.join(', ')}`,
      artifacts: { baseUrl, orgDomain, deployedIdps: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Identity Provider deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, orgDomain, deployedIdps: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** Path to a single IDP by its server-assigned UUID. */
export function idpPath(client: PPClient, id: string): string {
  return `${client.orgPath}/authentication/settings/idps/${encodeURIComponent(id)}`
}

/** Extract the created IDP's id from a 201 response body, when present. */
function readCreatedId(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body || '{}') as Record<string, unknown>
    return typeof parsed.id === 'string' ? parsed.id : undefined
  } catch {
    return undefined
  }
}

// Re-exported so rollback/driftDetect/healthCheck don't need their own import of IdpSpec.
export type { IdpSpec }
