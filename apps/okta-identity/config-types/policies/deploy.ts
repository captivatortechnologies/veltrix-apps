import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  buildConditions,
  extractPolicySpecs,
  parseRulesArray,
  parseSettingsObject,
  ruleName,
  type LivePolicy,
  type LiveRule,
  type PolicySpec,
} from './validate'

/** Prior state of one reconciled rule, captured so rollback can revert it. */
export interface PolicyRuleRollback {
  id: string
  name: string
  /** True when the rule existed before this deploy (updated), false when created. */
  existed: boolean
  /** Prior rule body (created/updated fields), captured for an updated rule. */
  prior?: Record<string, unknown>
}

/** Prior state of one policy (and its reconciled rules), captured for rollback. */
export interface PolicyRollbackEntry {
  type: string
  name: string
  /** True when the policy existed before this deploy (updated), false when created. */
  existed: boolean
  id?: string
  /** Full prior policy body, captured for an updated policy. */
  priorPolicy?: Record<string, unknown>
  /** Prior status, restored via the lifecycle endpoint on rollback. */
  priorStatus?: string
  rules: PolicyRuleRollback[]
}

/**
 * Deploy Okta policies (and their rules) via the Okta Management API.
 *
 * Okta has NO upsert. For each declared policy:
 *   - GET  /policies?type={TYPE}   — list, then match on (type, name)
 *   - PUT  /policies/{id}          — replace an existing policy (capture prior body)
 *   - POST /policies               — create a missing policy (capture new id)
 * then reconcile its rules BY NAME (PUT same-name / POST new; never delete a
 * system rule; never prune rules the canvas does not mention), and move the
 * policy to the desired status via the activate/deactivate lifecycle endpoint.
 *
 * OKTA_SIGN_ON carries no settings (omitted); PASSWORD / MFA_ENROLL merge the
 * parsed settingsJson into `settings`. Group scoping becomes the condition
 * people.groups.include.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.type && s.name)
  const rollbackState: PolicyRollbackEntry[] = []
  const createdPolicyIds: string[] = []
  const deployed: string[] = []
  // canvas item id -> okta policy id, persisted in rollbackData so the NEXT deploy
  // matches (and can rename) the same policy by id instead of creating a duplicate.
  const resourceIds: Record<string, string> = {}
  const priorResourceIds = await readPriorResourceIds(ctx)

  try {
    for (const spec of specs) {
      const label = `${spec.type}:${spec.name}`

      // Re-parse the JSON blobs here (validated upstream) to build the API body
      // and to fail loudly rather than send malformed content.
      const settings = resolveSettings(spec)
      const rules = resolveRules(spec, label)

      // Match order: (1) the external id stored for this canvas item on the last
      // deploy — RENAME-SAFE: a name change still updates the SAME policy; the
      // fetched policy must be the same (immutable) type. (2) by (type, name) for
      // the first deploy / items with no stored id (or a stale stored id).
      let existing: LivePolicy | null = null
      const priorId = spec.itemId ? priorResourceIds[spec.itemId] : undefined
      if (priorId) {
        existing = await getPolicyById(client, priorId, spec.type)
      }
      if (!existing) {
        existing = await findPolicy(client, spec.type, spec.name)
      }

      let policyId: string
      let priorStatus: string | undefined
      const entry: PolicyRollbackEntry = { type: spec.type, name: spec.name, existed: false, rules: [] }

      if (existing && existing.id) {
        policyId = existing.id
        priorStatus = existing.status
        entry.existed = true
        entry.id = policyId
        // Capture the full prior policy body so rollback can PUT it back.
        entry.priorPolicy = existing as Record<string, unknown>
        entry.priorStatus = existing.status

        const res = await client.request('PUT', `/policies/${policyId}`, {
          body: buildPolicyBody(spec, settings),
        })
        if (!res.ok) {
          throw new Error(`Failed to update policy "${label}": ${oktaErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/policies', {
          body: buildPolicyBody(spec, settings),
        })
        if (!res.ok) {
          throw new Error(`Failed to create policy "${label}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LivePolicy>(res.body)
        if (!created?.id) {
          throw new Error(`Policy "${label}" was created but the API returned no id`)
        }
        policyId = created.id
        priorStatus = created.status
        entry.id = policyId
        createdPolicyIds.push(policyId)
      }

      rollbackState.push(entry)

      // Remember the resolved id for this canvas item (rename-safe next deploy).
      if (spec.itemId) resourceIds[spec.itemId] = policyId

      // Move to the desired status via lifecycle (status transitions are NOT
      // done through the policy body). Compare against the pre-change status.
      await reconcileStatus(client, policyId, priorStatus, spec.status || 'ACTIVE', label)

      // Reconcile rules by name — only when rulesJson was provided.
      if (rules) {
        await reconcileRules(client, policyId, rules, entry, label)
      }

      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} policy(ies) to Okta org at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      // resourceIds carries the item->policy-id identity map forward (rename-safe).
      rollbackData: { previousState: rollbackState, createdPolicyIds, resourceIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      // Carry forward the ids resolved so far so a retry stays rename-safe.
      rollbackData: {
        previousState: rollbackState,
        createdPolicyIds,
        resourceIds: { ...priorResourceIds, ...resourceIds },
      },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/**
 * Find a policy by its (type, name) PAIR; null when absent. Lists every policy
 * of the type (following pagination) and matches the name exactly, so a
 * same-named policy under a different type is never adopted.
 */
export async function findPolicy(
  client: OktaClient,
  type: string,
  name: string,
): Promise<LivePolicy | null> {
  const res = await client.getAll<LivePolicy>(`/policies?type=${encodeURIComponent(type)}`)
  if (!res.ok) {
    throw new Error(
      `Failed to list ${type} policies while resolving "${type}:${name}": ${oktaErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
        nextUrl: null,
      })}`,
    )
  }
  return res.items.find((p) => p.name === name) ?? null
}

/**
 * Read the canvas-item-id -> policy-id map this canvas stored on its last
 * SUCCEEDED deploy (rollbackData.resourceIds), so a rename can update the same
 * policy by id. Best-effort — {} when there is no prior deploy or the read fails.
 */
async function readPriorResourceIds(ctx: DeployContext): Promise<Record<string, string>> {
  try {
    const prior = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const rb = prior?.rollbackData as { resourceIds?: Record<string, string> } | undefined
    return rb?.resourceIds ?? {}
  } catch {
    return {}
  }
}

/**
 * Fetch a policy by id, returning it only when it exists and is the expected
 * (immutable) type. Returns null on 404 / any non-ok / a type mismatch, so a
 * stale or repurposed stored id cleanly falls back to (type, name) matching.
 */
async function getPolicyById(
  client: OktaClient,
  id: string,
  expectedType: string,
): Promise<LivePolicy | null> {
  const res = await client.request('GET', `/policies/${encodeURIComponent(id)}`)
  if (!res.ok) return null
  const policy = parseJson<LivePolicy>(res.body)
  return policy && policy.id && policy.type === expectedType ? policy : null
}

/** List every rule under a policy (following pagination). */
export async function listPolicyRules(client: OktaClient, policyId: string): Promise<LiveRule[]> {
  const res = await client.getAll<LiveRule>(`/policies/${policyId}/rules`)
  if (!res.ok) {
    throw new Error(
      `Failed to list rules for policy ${policyId}: ${oktaErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
        nextUrl: null,
      })}`,
    )
  }
  return res.items
}

/** Parse the per-type settings for the API body; null for OKTA_SIGN_ON / blank. */
function resolveSettings(spec: PolicySpec): Record<string, unknown> | null {
  // OKTA_SIGN_ON has NO settings — always omit them, even if authored.
  if (spec.type === 'OKTA_SIGN_ON') return null
  if (!spec.settingsJson) return null
  const settings = parseSettingsObject(spec.settingsJson)
  if (!settings) {
    throw new Error(`Policy "${spec.type}:${spec.name}": settings are not a valid JSON object`)
  }
  return settings
}

/** Parse the rules array for reconciliation; null when rulesJson is blank. */
function resolveRules(spec: PolicySpec, label: string): Record<string, unknown>[] | null {
  if (!spec.rulesJson) return null
  const rules = parseRulesArray(spec.rulesJson)
  if (!rules) {
    throw new Error(`Policy "${label}": rules are not a valid JSON array`)
  }
  return rules.map((rule, index) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error(`Policy "${label}": rule at index ${index} is not a JSON object`)
    }
    if (!ruleName(rule)) {
      throw new Error(`Policy "${label}": rule at index ${index} has no "name"`)
    }
    return rule as Record<string, unknown>
  })
}

/** Assemble the create/replace policy body (PUT is a full replace). */
export function buildPolicyBody(
  spec: PolicySpec,
  settings: Record<string, unknown> | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: spec.type,
    name: spec.name,
    // status is included so a POST creates in the desired state; the actual
    // transition on an existing policy is driven by reconcileStatus.
    status: spec.status || 'ACTIVE',
  }
  // Always send description so clearing it on the canvas converges the policy.
  body.description = spec.description ?? ''
  const conditions = buildConditions(spec.groupIncludeIds)
  if (conditions) body.conditions = conditions
  if (settings) body.settings = settings
  return body
}

/**
 * Move a policy to the desired status via the lifecycle endpoint, but only when
 * it differs from the current status. Tolerates a 404 (policy already gone).
 */
async function reconcileStatus(
  client: OktaClient,
  policyId: string,
  currentStatus: string | undefined,
  desiredStatus: string,
  label: string,
): Promise<void> {
  const current = (currentStatus ?? '').toUpperCase()
  if (current === desiredStatus) return
  const action = desiredStatus === 'ACTIVE' ? 'activate' : 'deactivate'
  const res = await client.request('POST', `/policies/${policyId}/lifecycle/${action}`)
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to ${action} policy "${label}": ${oktaErrorMessage(res)}`)
  }
}

/**
 * Reconcile the rules under a policy BY NAME:
 *   - a rule whose name matches a live rule is REPLACED (PUT) in place
 *   - a rule with no live match is CREATED (POST)
 *   - rules the canvas does not mention are LEFT ALONE (never pruned)
 *   - a live system:true rule is NEVER deleted (we never delete here anyway)
 * Prior/created state is recorded on the rollback entry.
 */
async function reconcileRules(
  client: OktaClient,
  policyId: string,
  rules: Record<string, unknown>[],
  entry: PolicyRollbackEntry,
  label: string,
): Promise<void> {
  const live = await listPolicyRules(client, policyId)

  for (const rule of rules) {
    const name = ruleName(rule)
    const match = live.find((r) => r.name === name)

    if (match && match.id) {
      // Update in place (allowed even for a system rule — we only ever REPLACE,
      // never DELETE, a system rule). Capture the prior body for rollback.
      entry.rules.push({ id: match.id, name, existed: true, prior: match as Record<string, unknown> })
      const res = await client.request('PUT', `/policies/${policyId}/rules/${match.id}`, { body: rule })
      if (!res.ok) {
        throw new Error(`Failed to update rule "${name}" on policy "${label}": ${oktaErrorMessage(res)}`)
      }
    } else {
      const res = await client.request('POST', `/policies/${policyId}/rules`, { body: rule })
      if (!res.ok) {
        throw new Error(`Failed to create rule "${name}" on policy "${label}": ${oktaErrorMessage(res)}`)
      }
      const created = parseJson<LiveRule>(res.body)
      if (created?.id) {
        entry.rules.push({ id: created.id, name, existed: false })
      }
    }
  }
}
