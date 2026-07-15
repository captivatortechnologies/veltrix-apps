import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildTenableClient,
  parseJson,
  tenableErrorMessage,
  type TenableClient,
} from '../../lib/tenable'
import {
  extractPolicySpecs,
  parseSettingsObject,
  type LivePolicy,
  type PolicySpec,
} from './validate'

export interface PolicyRollbackEntry {
  name: string
  existed: boolean
  /** Numeric policy_id returned by the API — the rollback key. */
  id?: number
  /**
   * Prior policy state captured before an update, replayed (PUT ...\/configure)
   * on rollback: the editor template uuid and the `settings` object.
   */
  prior?: { uuid?: string; settings?: Record<string, unknown> }
}

/**
 * Deploy scan policies to a Tenable VM tenant via the Policies API.
 *
 * For each declared policy:
 *   - GET  /policies                 — list + find by name
 *   - GET  /policies/{id}            — capture prior uuid/settings before an update
 *   - PUT  /policies/{id}/configure  — update existing (keyed on the numeric id)
 *   - POST /policies                 — create missing (capture the created policy_id)
 *
 * A policy is built from an editor POLICY TEMPLATE: the body carries the template
 * uuid at the TOP LEVEL and everything else under `settings`. Names are not
 * guaranteed unique by the API, so create-vs-update is decided by the first name
 * match in the live list and rollback is keyed on the policy_id the API returns
 * — never on the name.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: PolicyRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      // Advanced settings are validated upstream; re-parse here to build the API
      // body and to fail loudly rather than send a malformed settings object.
      const advanced = spec.settingsJson ? parseSettingsObject(spec.settingsJson) : undefined
      if (spec.settingsJson && advanced === null) {
        throw new Error(`Policy "${spec.name}": advanced settings are not a valid JSON object`)
      }

      const existing = await findPolicy(client, spec.name)

      if (existing && existing.id !== undefined) {
        // Capture the prior uuid/settings so rollback can PUT the policy back.
        // The list summary omits settings, so read the detail for a faithful copy.
        const detail = await getPolicyDetail(client, existing.id)
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: { uuid: detail?.uuid ?? detail?.template_uuid, settings: detail?.settings },
        })

        const res = await client.request('PUT', `/policies/${existing.id}/configure`, {
          body: buildPolicyBody(spec, advanced ?? undefined),
        })
        if (!res.ok) {
          throw new Error(`Failed to update policy "${spec.name}": ${tenableErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/policies', {
          body: buildPolicyBody(spec, advanced ?? undefined),
        })
        if (!res.ok) {
          throw new Error(`Failed to create policy "${spec.name}": ${tenableErrorMessage(res)}`)
        }
        // POST /policies returns `{ policy_id, policy_name }`; tolerate a bare `id`.
        const created = parseJson<{ policy_id?: number; id?: number }>(res.body)
        const createdId = created?.policy_id ?? created?.id
        rollbackState.push({ name: spec.name, existed: false, id: createdId })
        if (createdId === undefined) {
          throw new Error(`Policy "${spec.name}" was created but the API returned no policy_id`)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} policy(ies) to Tenable tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      rollbackData: {
        previousState: rollbackState,
        createdIds: rollbackState.filter((e) => !e.existed && e.id !== undefined).map((e) => e.id),
      },
    }
  } catch (error) {
    return {
      success: false,
      message: `Policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: {
        previousState: rollbackState,
        createdIds: rollbackState.filter((e) => !e.existed && e.id !== undefined).map((e) => e.id),
      },
    }
  }
}

// --- Helpers ---

/** Look up a policy by exact name in the tenant list; null when absent. */
export async function findPolicy(client: TenableClient, name: string): Promise<LivePolicy | null> {
  const res = await client.request('GET', '/policies')
  if (!res.ok) {
    throw new Error(`Failed to list policies while resolving "${name}": ${tenableErrorMessage(res)}`)
  }
  const policies = parseJson<{ policies?: LivePolicy[] }>(res.body)?.policies ?? []
  // Names are not guaranteed unique — match the first exact name. Rollback is
  // keyed on the returned policy_id, so an ambiguous name still reverts precisely.
  return policies.find((p) => p.name === name) ?? null
}

/** Read a policy's editor detail (uuid + settings) from GET /policies/{id}; null on 404. */
export async function getPolicyDetail(
  client: TenableClient,
  id: number,
): Promise<LivePolicy | null> {
  const res = await client.request('GET', `/policies/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch policy ${id}: ${tenableErrorMessage(res)}`)
  }
  return parseJson<LivePolicy>(res.body)
}

/**
 * Build the Policies API create/update body. The top-level `uuid` is the editor
 * POLICY TEMPLATE uuid (from GET /editor/policy/templates), NOT the policy's own
 * id; everything else lives inside `settings`.
 */
export function buildPolicyBody(
  spec: PolicySpec,
  advanced: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { uuid: spec.templateUuid, settings: buildPolicySettings(spec, advanced) }
}

/**
 * Assemble the `settings` object. Advanced settingsJson is laid down first as the
 * base, then the modeled `name` (always — it is the identity) and `description`
 * (when provided) are set on top, so the modeled fields win over any same-named
 * keys inside settingsJson and the policy's identity stays stable.
 */
export function buildPolicySettings(
  spec: PolicySpec,
  advanced: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const settings: Record<string, unknown> = { ...(advanced ?? {}) }
  settings.name = spec.name
  if (spec.description !== undefined) settings.description = spec.description
  return settings
}
