import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage, boolFlag, compactBody, parseJson, type AkeylessClient } from '../../lib/akeyless'
import { extractRotatedSecretSpecs, type RotatedSecretSpec } from './validate'

export interface LiveProducerSummary {
  id?: number
  name?: string
  type?: string
  active?: boolean
}

export interface RotatedSecretRollbackEntry {
  name: string
  existed: boolean
}

/**
 * Deploy Akeyless rotated secret configs. ONE item = ONE rotator, matched
 * on NAME:
 *   - POST /rotated-secret-list  (Akeyless has no plain "get" for this
 *     object type - see canvas.yaml header - so existence is checked by
 *     listing and matching by name; the list only returns id/name/type/
 *     active, never the rotation settings)
 *   - POST /rotated-secret-create-{type}  (type fixed for a new item)
 *   - POST /rotated-secret-update-{type}  (type must match the LIVE type)
 * Never deletes a rotator absent from this canvas - rollback only deletes
 * what THIS deploy itself created (an UPDATE to a pre-existing rotator
 * cannot be reverted - Akeyless never returns its prior settings; see
 * rollback.ts).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractRotatedSecretSpecs(ctx.canvas).filter((s) => s.name && s.type)
  const rollbackState: RotatedSecretRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const liveProducers = await listRotatedSecrets(client)
    const liveByName = new Map(liveProducers.map((p) => [p.name, p]))

    for (const spec of specs) {
      const existing = liveByName.get(spec.name) ?? null

      if (existing) {
        if (existing.type && !typesLikelyMatch(existing.type, spec.type)) {
          throw new Error(
            `Rotated secret config "${spec.name}" already exists as type "${existing.type}" - this app does not ` +
              `support changing a rotator's type in place (declared type is "${spec.type}").`,
          )
        }
        rollbackState.push({ name: spec.name, existed: true })

        const res = await client.request(`/rotated-secret-update-${spec.type}`, buildBody(spec, { isUpdate: true }))
        if (!res.ok) throw new Error(`Failed to update rotated secret config "${spec.name}": ${akeylessErrorMessage(res)}`)
      } else {
        rollbackState.push({ name: spec.name, existed: false })

        const res = await client.request(`/rotated-secret-create-${spec.type}`, buildBody(spec, { isUpdate: false }))
        if (!res.ok) throw new Error(`Failed to create rotated secret config "${spec.name}": ${akeylessErrorMessage(res)}`)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} rotated secret config(s) to Akeyless (${baseUrl}): ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedConfigs: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Rotated secret config deployment failed after ${deployed.length} of ${specs.length} item(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedConfigs: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers -------------------------------------------------------------------

export async function listRotatedSecrets(client: AkeylessClient): Promise<LiveProducerSummary[]> {
  const res = await client.request('/rotated-secret-list')
  if (!res.ok) throw new Error(`Failed to list rotated secret configs: ${akeylessErrorMessage(res)}`)
  const parsed = parseJson<{ producers?: LiveProducerSummary[] }>(res.body)
  return parsed?.producers ?? []
}

/** Loose match - the exact casing/format of Producer.type is not documented in the OpenAPI spec. */
function typesLikelyMatch(liveType: string, declaredType: string): boolean {
  return liveType.toLowerCase().includes(declaredType.toLowerCase())
}

export function buildBody(spec: RotatedSecretSpec, opts: { isUpdate: boolean }): Record<string, unknown> {
  const common: Record<string, unknown> = {
    name: spec.name,
    'target-name': spec.targetName,
    description: spec.description,
    delete_protection: boolFlag(spec.deleteProtection),
    'rotator-type': spec.rotatorType,
    'authentication-credentials': spec.authenticationCredentials,
    'auto-rotate': boolFlag(spec.autoRotate),
    'rotation-interval': spec.rotationInterval,
    'rotation-hour': spec.rotationHour,
    'password-length': spec.passwordLength,
    'rotate-after-disconnect': boolFlag(spec.rotateAfterDisconnect),
    'rotation-event-in': spec.rotationEventIn,
    tags: spec.tags,
    'item-custom-fields': spec.itemCustomFields,
  }
  if (opts.isUpdate) common['new-name'] = spec.name

  let specific: Record<string, unknown> = {}
  if (spec.type === 'postgresql') {
    specific = { 'rotated-username': spec.rotatedUsername }
  } else if (spec.type === 'aws') {
    specific = {
      'api-id': spec.apiId,
      'aws-region': spec.awsRegion,
      'grace-rotation': boolFlag(spec.graceRotation),
      'grace-rotation-hour': spec.graceRotationHour,
      'grace-rotation-interval': spec.graceRotationInterval,
    }
  }

  return compactBody({ ...common, ...specific })
}
