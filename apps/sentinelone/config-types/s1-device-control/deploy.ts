import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildS1Client,
  MISSING_SCOPE_MESSAGE,
  s1ErrorMessage,
  s1Result,
  type S1Client,
} from '../../lib/s1'
import { extractDeviceRuleSpecs, ruleKey, type DeviceRuleSpec, type LiveDeviceRule } from './validate'

export interface DeviceRuleRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveDeviceRule
}

/**
 * Deploy SentinelOne Device Control rules via the Management API
 * (`/device-control`, USB and Bluetooth peripheral control).
 *
 * Identity is the rule `ruleName` at the configured scope: list
 * /device-control, match on the (case-insensitive) name, then PUT an existing
 * rule or POST a new one. Scope is carried in the request body's `filter`, and
 * an existing rule's id is carried inside `data` — the same request shape this
 * app already uses for /exclusions and /firewall-control.
 *
 * Sources (endpoint existence, filter/field names):
 *  - Celerium/SentinelOne-PowerShellWrapper `Get-SentinelOneDeviceControlRules`
 *    (GET /device-control; accessPermissions/actions/interfaces/statuses enums,
 *    vendorIds/productIds/uids/deviceClasses/bluetoothAddresses)
 *  - Postman API Network "Create Device Control Rule" / "Get Device Rules"
 *    (SentinelOne workspace)
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built
  if (!client.hasScope) return { success: false, message: MISSING_SCOPE_MESSAGE }

  const sf = client.scopeFilter()
  if (sf.error || !sf.filter) return { success: false, message: sf.error ?? MISSING_SCOPE_MESSAGE }
  const filter = sf.filter

  const specs = extractDeviceRuleSpecs(ctx.canvas).filter((s) => s.ruleName)
  const rollbackState: DeviceRuleRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listDeviceRules(client)
    const byKey = new Map(existing.filter((r) => r.ruleName).map((r) => [ruleKey(r.ruleName as string), r]))

    for (const spec of specs) {
      const label = spec.ruleName
      const key = ruleKey(spec.ruleName)
      const live = byKey.get(key)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', '/device-control', {
          body: { filter, data: { id: live.id, ...buildData(spec) } },
        })
        if (!res.ok) throw new Error(`Failed to update device control rule "${label}": ${s1ErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/device-control', { body: { filter, data: buildData(spec) } })
        if (!res.ok) throw new Error(`Failed to create device control rule "${label}": ${s1ErrorMessage(res)}`)
        const created = firstResult(s1Result<LiveDeviceRule | LiveDeviceRule[]>(res))
        if (!created?.id) throw new Error(`Device control rule "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} device control rule(s) to ${consoleUrl} (${client.currentScope} scope): ${deployed.join(', ')}`,
      artifacts: { consoleUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Device control rule deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all Device Control rules at the configured scope; throws on a non-OK response. */
export async function listDeviceRules(client: S1Client): Promise<LiveDeviceRule[]> {
  const sq = client.scopeQuery()
  if (sq.error || !sq.query) throw new Error(sq.error ?? 'scope not configured')
  const res = await client.getAll<LiveDeviceRule>('/device-control', sq.query)
  if (!res.ok) {
    throw new Error(`Failed to list device control rules: ${s1ErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** POST /device-control may return the created object or an array; normalize to the first. */
function firstResult(result: LiveDeviceRule | LiveDeviceRule[] | null): LiveDeviceRule | null {
  if (!result) return null
  return Array.isArray(result) ? result[0] ?? null : result
}

function buildData(spec: DeviceRuleSpec): Record<string, unknown> {
  return {
    ruleName: spec.ruleName,
    interface: spec.interfaceType,
    action: spec.action,
    accessPermission: spec.accessPermission,
    deviceClass: spec.deviceClass ?? '',
    vendorId: spec.vendorId ?? '',
    productId: spec.productId ?? '',
    uid: spec.serialId ?? '',
    bluetoothAddress: spec.bluetoothAddress ?? '',
    status: spec.status,
  }
}
