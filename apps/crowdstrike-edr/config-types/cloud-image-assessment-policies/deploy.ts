import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  parseEnvelope,
  type FalconClient,
} from '../../lib/falcon'
import {
  buildPolicyData,
  extractImagePolicySpecs,
  parseImagePolicyConditions,
  type LiveImagePolicy,
} from './validate'

/** Entity path for the image assessment policy collection. */
export const IMAGE_POLICY_ENTITY = '/container-security/entities/image-assessment-policies/v1'

/** Policy fields this app manages and can restore on rollback. */
export interface ImagePolicyRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    name?: string
    description?: string
    is_enabled?: boolean
    policy_data?: LiveImagePolicy['policy_data']
  }
}

/**
 * Deploy image assessment policies to a Falcon tenant via the Cloud Security
 * container image-assessment-policies API.
 *
 * For each declared policy (identity = name):
 *   - GET   …/image-assessment-policies/v1                 — read all, match by name
 *   - POST  …/image-assessment-policies/v1                 — create the shell (name + description)
 *   - PATCH …/image-assessment-policies/v1?id=<id>         — converge full desired state
 *                                                            (name, description, is_enabled, policy_data)
 *
 * The create endpoint accepts only name + description; the rules/action and
 * enablement are always applied via a follow-up PATCH so create and update
 * converge to the same declared state.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractImagePolicySpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ImagePolicyRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const { conditions, errors: conditionErrors } = parseImagePolicyConditions(spec.rulesRaw)
      if (conditionErrors.length > 0) {
        throw new Error(`Policy "${spec.name}": invalid rules — ${conditionErrors[0]}`)
      }

      const existing = await findImagePolicyByName(client, spec.name)

      let id: string
      if (existing?.id) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: {
            name: existing.name,
            description: existing.description ?? '',
            is_enabled: existing.is_enabled,
            policy_data: existing.policy_data,
          },
        })
        id = existing.id
      } else {
        const createRes = await client.request('POST', IMAGE_POLICY_ENTITY, {
          body: { name: spec.name, description: spec.description ?? '' },
        })
        const createFailure = falconFailure(createRes)
        if (createFailure) {
          throw new Error(`Failed to create policy "${spec.name}": ${createFailure}`)
        }
        const created = parseEnvelope<LiveImagePolicy>(createRes.body)?.resources?.[0]
        if (!created?.id) {
          throw new Error(`Policy "${spec.name}" was created but the API returned no policy id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        id = created.id
      }

      // Converge the full declared state (description is always sent so clearing
      // it on the canvas converges the live policy and drift agrees with deploy).
      const updateRes = await client.request('PATCH', `${IMAGE_POLICY_ENTITY}?id=${encodeURIComponent(id)}`, {
        body: {
          name: spec.name,
          description: spec.description ?? '',
          is_enabled: spec.enabled,
          policy_data: buildPolicyData(spec.action, conditions),
        },
      })
      const updateFailure = falconFailure(updateRes)
      if (updateFailure) {
        throw new Error(`Failed to configure policy "${spec.name}": ${updateFailure}`)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} image assessment policy(ies) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Image assessment policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/**
 * Find an image assessment policy by exact name. The collection has no query
 * endpoint, so this reads every policy and pins the exact name (a single
 * unambiguous case-insensitive match is tolerated). Returns null when absent.
 */
export async function findImagePolicyByName(
  client: FalconClient,
  name: string,
): Promise<LiveImagePolicy | null> {
  const res = await client.request('GET', IMAGE_POLICY_ENTITY)
  if (!res.ok) {
    throw new Error(`Failed to search policy "${name}": ${falconErrorMessage(res)}`)
  }
  const policies = parseEnvelope<LiveImagePolicy>(res.body)?.resources ?? []
  const exact = policies.find((p) => p.name === name)
  if (exact) return exact
  const caseInsensitive = policies.filter((p) => p.name?.toLowerCase() === name.toLowerCase())
  return caseInsensitive.length === 1 ? caseInsensitive[0] : null
}
