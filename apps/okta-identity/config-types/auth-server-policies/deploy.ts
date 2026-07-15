import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  buildClientConditions,
  extractAuthServerPolicySpecs,
  parseRulesArray,
  policiesPath,
  ruleName,
  ruleStatus,
  rulesPath,
  stripReadOnly,
  POLICY_TYPE,
  RULE_TYPE,
  type AuthServerPolicySpec,
  type LiveAuthServerPolicy,
  type LiveAuthServerRule,
} from './validate'

/** Prior state of one reconciled rule, captured so rollback can revert it. */
export interface AuthServerRuleRollback {
  id: string
  name: string
  /** True when the rule existed before this deploy (updated), false when created. */
  existed: boolean
  /** Prior rule body (for an updated rule), restored via PUT on rollback. */
  prior?: Record<string, unknown>
  /** Prior rule status, restored via the lifecycle endpoint on rollback. */
  priorStatus?: string
}

/** Prior state of one policy (and its reconciled rules), captured for rollback. */
export interface AuthServerPolicyRollbackEntry {
  /** Parent authorization server id — needed to rebuild child endpoints. */
  authServerId: string
  name: string
  /** True when the policy existed before this deploy (updated), false when created. */
  existed: boolean
  id?: string
  /** Full prior policy body, captured for an updated policy. */
  priorPolicy?: Record<string, unknown>
  /** Prior status, restored via the lifecycle endpoint on rollback. */
  priorStatus?: string
  rules: AuthServerRuleRollback[]
}

/**
 * Deploy Okta authorization-server policies (and their rules) via the Okta
 * Management API. A policy is a CHILD of a custom authorization server, so every
 * endpoint hangs off /authorizationServers/{authServerId}/policies and the
 * logical identity is the (authServerId, name) PAIR.
 *
 * Okta has NO upsert. For each declared policy:
 *   - GET  .../policies              — list, then match on (authServerId, name)
 *   - PUT  .../policies/{id}         — replace an existing policy (capture prior body)
 *   - POST .../policies              — create a missing policy (capture new id)
 * then reconcile its rules BY NAME (PUT same-name / POST new; never delete a
 * system rule; never prune rules the canvas does not mention — the built-in
 * default rule lives here too), and move the policy AND each rule to the desired
 * status via the activate/deactivate lifecycle endpoints (not the PUT body).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractAuthServerPolicySpecs(ctx.canvas).filter((s) => s.authServerId && s.name)
  const rollbackState: AuthServerPolicyRollbackEntry[] = []
  const createdPolicyIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = `${spec.authServerId}:${spec.name}`

      // Re-parse the rules blob here (validated upstream) to build the API
      // bodies and to fail loudly rather than send malformed content.
      const rules = resolveRules(spec, label)

      const existing = await findAuthServerPolicy(client, spec.authServerId, spec.name)

      let policyId: string
      let priorStatus: string | undefined
      const entry: AuthServerPolicyRollbackEntry = {
        authServerId: spec.authServerId,
        name: spec.name,
        existed: false,
        rules: [],
      }

      if (existing && existing.id) {
        policyId = existing.id
        priorStatus = existing.status
        entry.existed = true
        entry.id = policyId
        // Capture the full prior policy body so rollback can PUT it back. A
        // system:true policy (the built-in Default Policy) is UPDATED in place —
        // never deleted/recreated.
        entry.priorPolicy = existing as Record<string, unknown>
        entry.priorStatus = existing.status

        const res = await client.request('PUT', `${policiesPath(spec.authServerId)}/${policyId}`, {
          body: buildPolicyBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to update authorization-server policy "${label}": ${oktaErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', policiesPath(spec.authServerId), {
          body: buildPolicyBody(spec),
        })
        if (!res.ok) {
          throw new Error(`Failed to create authorization-server policy "${label}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveAuthServerPolicy>(res.body)
        if (!created?.id) {
          throw new Error(`Authorization-server policy "${label}" was created but the API returned no id`)
        }
        policyId = created.id
        priorStatus = created.status
        entry.id = policyId
        createdPolicyIds.push(policyId)
      }

      rollbackState.push(entry)

      // Move to the desired status via lifecycle (status transitions are NOT done
      // through the policy body). Compare against the pre-change status.
      await reconcilePolicyStatus(client, spec.authServerId, policyId, priorStatus, spec.status || 'ACTIVE', label)

      // Reconcile rules by name — only when rulesJson was provided.
      if (rules) {
        await reconcileRules(client, spec.authServerId, policyId, rules, entry, label)
      }

      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} authorization-server policy(ies) to Okta org at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState, createdPolicyIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Authorization-server policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdPolicyIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/**
 * Find a policy by its (authServerId, name) PAIR; null when absent. Lists every
 * policy under the auth server (following pagination) and matches the name
 * exactly, so a same-named policy under a different auth server is never adopted.
 */
export async function findAuthServerPolicy(
  client: OktaClient,
  authServerId: string,
  name: string,
): Promise<LiveAuthServerPolicy | null> {
  const res = await client.getAll<LiveAuthServerPolicy>(policiesPath(authServerId))
  if (!res.ok) {
    throw new Error(
      `Failed to list policies for authorization server "${authServerId}" while resolving "${authServerId}:${name}": ${oktaErrorMessage(
        { status: res.status, ok: res.ok, body: res.body, nextUrl: null },
      )}`,
    )
  }
  return res.items.find((p) => p.name === name) ?? null
}

/** List every rule under a policy (following pagination). */
export async function listPolicyRules(
  client: OktaClient,
  authServerId: string,
  policyId: string,
): Promise<LiveAuthServerRule[]> {
  const res = await client.getAll<LiveAuthServerRule>(rulesPath(authServerId, policyId))
  if (!res.ok) {
    throw new Error(
      `Failed to list rules for authorization-server policy ${policyId}: ${oktaErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
        nextUrl: null,
      })}`,
    )
  }
  return res.items
}

/** Parse the rules array for reconciliation; null when rulesJson is blank. */
function resolveRules(spec: AuthServerPolicySpec, label: string): Record<string, unknown>[] | null {
  if (!spec.rulesJson) return null
  const rules = parseRulesArray(spec.rulesJson)
  if (!rules) {
    throw new Error(`Authorization-server policy "${label}": rules are not a valid JSON array`)
  }
  return rules.map((rule, index) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error(`Authorization-server policy "${label}": rule at index ${index} is not a JSON object`)
    }
    if (!ruleName(rule)) {
      throw new Error(`Authorization-server policy "${label}": rule at index ${index} has no "name"`)
    }
    return rule as Record<string, unknown>
  })
}

/** Assemble the create/replace policy body (PUT is a full replace). */
export function buildPolicyBody(spec: AuthServerPolicySpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: POLICY_TYPE,
    name: spec.name,
    // status is included so a POST creates in the desired state; the actual
    // transition on an existing policy is driven by reconcilePolicyStatus.
    status: spec.status || 'ACTIVE',
    // Always send description so clearing it on the canvas converges the policy.
    description: spec.description ?? '',
    // conditions.clients.include always defaults to ["ALL_CLIENTS"].
    conditions: buildClientConditions(spec.clientInclude),
  }
  if (spec.priority !== undefined && Number.isFinite(spec.priority)) body.priority = spec.priority
  return body
}

/**
 * Build a rule request body from an authored rule object: strip server-managed
 * read-only fields (incl. status — driven via lifecycle) and force the only
 * valid rule type, RESOURCE_ACCESS.
 */
export function buildRuleBody(rule: Record<string, unknown>): Record<string, unknown> {
  return { ...stripReadOnly(rule), type: RULE_TYPE }
}

/**
 * Move a policy to the desired status via the lifecycle endpoint, but only when
 * it differs from the current status. Tolerates a 404 (policy already gone).
 */
async function reconcilePolicyStatus(
  client: OktaClient,
  authServerId: string,
  policyId: string,
  currentStatus: string | undefined,
  desiredStatus: string,
  label: string,
): Promise<void> {
  const current = (currentStatus ?? '').toUpperCase()
  if (current === desiredStatus) return
  const action = desiredStatus === 'ACTIVE' ? 'activate' : 'deactivate'
  const res = await client.request('POST', `${policiesPath(authServerId)}/${policyId}/lifecycle/${action}`)
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to ${action} authorization-server policy "${label}": ${oktaErrorMessage(res)}`)
  }
}

/** Move a rule to the desired status via its lifecycle endpoint (tolerate 404). */
async function reconcileRuleStatus(
  client: OktaClient,
  authServerId: string,
  policyId: string,
  ruleId: string,
  currentStatus: string | undefined,
  desiredStatus: string,
  name: string,
  label: string,
): Promise<void> {
  const current = (currentStatus ?? '').toUpperCase()
  if (current === desiredStatus) return
  const action = desiredStatus === 'ACTIVE' ? 'activate' : 'deactivate'
  const res = await client.request('POST', `${rulesPath(authServerId, policyId)}/${ruleId}/lifecycle/${action}`)
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `Failed to ${action} rule "${name}" on authorization-server policy "${label}": ${oktaErrorMessage(res)}`,
    )
  }
}

/**
 * Reconcile the rules under a policy BY NAME:
 *   - a rule whose name matches a live rule is REPLACED (PUT) in place
 *   - a rule with no live match is CREATED (POST)
 *   - rules the canvas does not mention are LEFT ALONE (never pruned) — the
 *     built-in system default rule stays put
 *   - a live system:true rule is NEVER deleted (we never delete here anyway; a
 *     same-name system rule is only ever REPLACED)
 *   - each rule is moved to its desired status via the rule lifecycle endpoint
 * Prior/created state is recorded on the rollback entry.
 */
async function reconcileRules(
  client: OktaClient,
  authServerId: string,
  policyId: string,
  rules: Record<string, unknown>[],
  entry: AuthServerPolicyRollbackEntry,
  label: string,
): Promise<void> {
  const live = await listPolicyRules(client, authServerId, policyId)

  for (const rule of rules) {
    const name = ruleName(rule)
    const desiredStatus = ruleStatus(rule)
    const body = buildRuleBody(rule)
    const match = live.find((r) => r.name === name)

    if (match && match.id) {
      // Update in place (allowed even for a system rule — we only ever REPLACE,
      // never DELETE, a system rule). Capture the prior body/status for rollback.
      entry.rules.push({
        id: match.id,
        name,
        existed: true,
        prior: match as Record<string, unknown>,
        priorStatus: match.status,
      })
      const res = await client.request('PUT', `${rulesPath(authServerId, policyId)}/${match.id}`, { body })
      if (!res.ok) {
        throw new Error(
          `Failed to update rule "${name}" on authorization-server policy "${label}": ${oktaErrorMessage(res)}`,
        )
      }
      await reconcileRuleStatus(client, authServerId, policyId, match.id, match.status, desiredStatus, name, label)
    } else {
      const res = await client.request('POST', rulesPath(authServerId, policyId), { body })
      if (!res.ok) {
        throw new Error(
          `Failed to create rule "${name}" on authorization-server policy "${label}": ${oktaErrorMessage(res)}`,
        )
      }
      const created = parseJson<LiveAuthServerRule>(res.body)
      if (created?.id) {
        entry.rules.push({ id: created.id, name, existed: false })
        await reconcileRuleStatus(client, authServerId, policyId, created.id, created.status, desiredStatus, name, label)
      }
    }
  }
}
