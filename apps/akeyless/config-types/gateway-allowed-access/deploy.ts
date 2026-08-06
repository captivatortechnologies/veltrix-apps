import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage, boolFlag, compactBody, parseJson, type AkeylessClient } from '../../lib/akeyless'
import { extractAllowedAccessSpecs, type AllowedAccessSpec } from './validate'

export interface LiveAllowedAccess {
  access_id?: string
  description?: string
  permissions?: string[]
  sub_claims?: Record<string, string[]>
  sub_claims_case_insensitive?: boolean
}

export interface AllowedAccessRollbackEntry {
  name: string
  existed: boolean
  priorSpec?: AllowedAccessSpec
}

/**
 * Deploy Akeyless Gateway allowed-access rules. ONE item = ONE rule,
 * matched on NAME:
 *   - GET  /gateway-get-allowed-access     (404 -> does not exist yet)
 *   - POST /gateway-create-allowed-access  (new item)
 *   - POST /gateway-update-allowed-access  (existing item)
 * Never deletes a rule absent from this canvas - rollback only reverts what
 * THIS deploy created or changed.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractAllowedAccessSpecs(ctx.canvas).filter((s) => s.name && s.accessId)
  const rollbackState: AllowedAccessRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await getAllowedAccess(client, spec.name)

      if (existing) {
        rollbackState.push({ name: spec.name, existed: true, priorSpec: mapLiveToSpec(spec, existing) })
        const res = await client.request('/gateway-update-allowed-access', buildBody(spec, { isUpdate: true }))
        if (!res.ok) throw new Error(`Failed to update allowed access rule "${spec.name}": ${akeylessErrorMessage(res)}`)
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        const res = await client.request('/gateway-create-allowed-access', buildBody(spec, { isUpdate: false }))
        if (!res.ok) throw new Error(`Failed to create allowed access rule "${spec.name}": ${akeylessErrorMessage(res)}`)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} allowed access rule(s) to Akeyless (${baseUrl}): ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Allowed access deployment failed after ${deployed.length} of ${specs.length} item(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers -------------------------------------------------------------------

export async function getAllowedAccess(client: AkeylessClient, name: string): Promise<LiveAllowedAccess | null> {
  const res = await client.request('/gateway-get-allowed-access', { name })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to look up allowed access rule "${name}": ${akeylessErrorMessage(res)}`)
  return parseJson<LiveAllowedAccess>(res.body) ?? {}
}

/**
 * `permissions` and `sub-claims` are comma-joined strings / {key: "v1,v2"}
 * maps on WRITE, but arrays / {key: [v1,v2]} on READ (the same asymmetry
 * seen on Roles' auth-method associations - see roles/deploy.ts).
 */
export function buildBody(spec: AllowedAccessSpec, opts: { isUpdate: boolean }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    'access-id': spec.accessId,
    permissions: spec.permissions.join(','),
    'sub-claims': spec.subClaims,
    'case-sensitive': boolFlag(spec.caseSensitive),
  }
  if (opts.isUpdate) body['new-name'] = spec.name
  return compactBody(body)
}

export function mapLiveToSpec(declared: AllowedAccessSpec, live: LiveAllowedAccess): AllowedAccessSpec {
  const subClaims: Record<string, string> = {}
  for (const [key, values] of Object.entries(live.sub_claims ?? {})) subClaims[key] = (values ?? []).join(',')

  return {
    ...declared,
    description: live.description ?? '',
    permissions: Array.isArray(live.permissions) ? live.permissions : [],
    subClaims,
    caseSensitive: live.sub_claims_case_insensitive !== true,
  }
}
