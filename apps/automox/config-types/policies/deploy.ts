import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAutomoxClient, automoxErrorMessage, parseJson, type AutomoxClient } from '../../lib/automoxApi'
import { extractPolicySpecs, buildPolicyBody, findPolicyByName, priorFieldsOf, policyKey, type AutomoxPolicy } from './_shared'

/** One rollback record per applied policy. */
export interface PolicyRollbackEntry {
  name: string
  /** Whether the policy already existed (update) or was created by this deploy. */
  existed: boolean
  id?: number
  /** Prior managed body, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

/**
 * Deploy Automox Policies over the Console API (`/policies`), org-scoped via
 * `o=<organizationId>`:
 *   list:   GET  /policies                (paged; match candidates by name)
 *   update: PUT  /policies/{id}           with the full managed policy body
 *   create: POST /policies                with the full managed policy body
 *
 * The name is the stable identity used to upsert. Matching is RENAME-SAFE via
 * the per-item resourceIds map (same pattern used by this repo's other
 * name-identified config types, e.g. JumpCloud Policies).
 *
 * VERIFIED (automox-mcp workflow, not documented in the OpenAPI spec):
 * `POST /policies` returns 201 with an EMPTY body — the new policy's id is not
 * in the response. The id is resolved by listing the org's policies and
 * matching the just-created name; `/policies` is ordered by name (not
 * recency), so every matching name is collected and the HIGHEST id (the
 * newest) wins.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildAutomoxClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name)
  const previousState: PolicyRollbackEntry[] = []
  const createdIds: number[] = []
  const applied: string[] = []
  const resourceIds: Record<string, number> = {}
  const priorResourceIds = await readPriorResourceIds(ctx)

  try {
    const livePolicies = await listPolicies(client)

    for (const spec of specs) {
      const builtBody = buildPolicyBody(spec, client.orgId)
      if (builtBody.error) throw new Error(`Policy "${spec.name}" is invalid: ${builtBody.error}`)

      // Match order: (1) the id stored for this canvas item on the last deploy
      // (rename-safe), (2) by name for the first deploy / a stale stored id.
      let existing: AutomoxPolicy | null = null
      const priorId = spec.itemId ? priorResourceIds[spec.itemId] : undefined
      if (priorId) existing = await getPolicyById(client, priorId)
      if (!existing) existing = findPolicyByName(livePolicies, spec.name)

      let policyId: number
      if (existing?.id) {
        policyId = existing.id
        const detailed = (await getPolicyById(client, policyId)) ?? existing
        previousState.push({ name: spec.name, existed: true, id: policyId, prior: priorFieldsOf(detailed) })
        const res = await client.request('PUT', `/policies/${policyId}`, { body: { ...builtBody.body, id: policyId } })
        if (!res.ok) throw new Error(`Failed to update Policy "${spec.name}": ${automoxErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/policies', { body: builtBody.body })
        if (!res.ok) throw new Error(`Failed to create Policy "${spec.name}": ${automoxErrorMessage(res)}`)
        const createdId = extractCreatedPolicyId(res.body) ?? (await resolveCreatedPolicyId(client, spec.name))
        if (!createdId) {
          throw new Error(
            `Policy "${spec.name}" was created but its id could not be resolved (POST /policies returns no body; ` +
              'the follow-up name lookup found no match — verify it in the Automox Console).',
          )
        }
        policyId = createdId
        createdIds.push(policyId)
        previousState.push({ name: spec.name, existed: false, id: policyId })
      }

      if (spec.itemId) resourceIds[spec.itemId] = policyId
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} Policy(ies): ${applied.join(', ') || '(none)'}`,
      artifacts: { organizationId: client.orgId, applied },
      rollbackData: { previousState, createdIds, resourceIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Policy deploy failed after ${applied.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { organizationId: client.orgId, applied },
      rollbackData: { previousState, createdIds, resourceIds: { ...priorResourceIds, ...resourceIds } },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** List every Policy in the org, following pagination. */
export async function listPolicies(client: AutomoxClient): Promise<AutomoxPolicy[]> {
  const res = await client.listAllPaged<AutomoxPolicy>('/policies')
  if (!res.ok) {
    throw new Error(`Failed to list Policies: ${automoxErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`)
  }
  return res.items
}

/** Fetch a policy by id, or null on 404 / any non-ok. */
export async function getPolicyById(client: AutomoxClient, id: number): Promise<AutomoxPolicy | null> {
  const res = await client.request('GET', `/policies/${id}`)
  if (!res.ok) return null
  const policy = parseJson<AutomoxPolicy>(res.body)
  return policy?.id ? policy : null
}

/** A 201 body is documented as empty, but tolerate a future API returning `{ id }` / `{ policy_id }`. */
function extractCreatedPolicyId(body: string): number | null {
  const parsed = parseJson<{ id?: unknown; policy_id?: unknown }>(body)
  const candidate = parsed?.id ?? parsed?.policy_id
  if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) return candidate
  if (typeof candidate === 'string' && /^\d+$/.test(candidate)) return Number.parseInt(candidate, 10)
  return null
}

const CREATED_POLICY_LOOKUP_MAX_PAGES = 40

/**
 * Resolve a just-created policy's id by name (POST /policies returns 201 with
 * an empty body — verified, see module doc). `/policies` is name-ordered, not
 * recency-ordered, so every exact name match is collected and the highest id
 * (the newest) is returned.
 */
export async function resolveCreatedPolicyId(client: AutomoxClient, name: string): Promise<number | null> {
  const target = policyKey(name)
  if (!target) return null

  const matches: number[] = []
  let page = 0
  for (; page < CREATED_POLICY_LOOKUP_MAX_PAGES; page++) {
    const res = await client.request('GET', '/policies', { query: { page, limit: 250 } })
    if (!res.ok) break
    const rows = parseJson<AutomoxPolicy[]>(res.body)
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const row of rows) {
      if (policyKey(String(row.name ?? '')) === target && typeof row.id === 'number') matches.push(row.id)
    }
    if (rows.length < 250) break
  }
  return matches.length > 0 ? Math.max(...matches) : null
}

/**
 * Read the canvas-item-id -> policy-id map this canvas stored on its last
 * SUCCEEDED deploy (rollbackData.resourceIds). Best-effort — {} on no prior
 * deploy or a read error.
 */
async function readPriorResourceIds(ctx: DeployContext): Promise<Record<string, number>> {
  try {
    const prior = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const rb = prior?.rollbackData as { resourceIds?: Record<string, number> } | undefined
    return rb?.resourceIds ?? {}
  } catch {
    return {}
  }
}
