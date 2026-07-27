import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type GraphClient,
} from '../../lib/graph'
import {
  desiredEnabledRules,
  extractPimPolicySpecs,
  RULE_IDS,
  RULE_ODATA_TYPES,
  type LivePimRule,
  type PimPolicySpec,
} from './validate'

const POLICIES = '/policies/roleManagementPolicies'

export interface RollbackEntry {
  itemId?: string
  /** roleDefinitionId — the logical identity. */
  name: string
  existed: boolean
  policyId?: string
  /** Prior rule bodies, keyed by rule id, for restore. */
  priorRules?: Record<string, Record<string, unknown>>
}

/** Resolve the Directory-scope policy id governing a role via its assignment. */
export async function resolvePolicyId(client: GraphClient, roleDefinitionId: string): Promise<string | null> {
  const filter = `scopeId eq '/' and scopeType eq 'Directory' and roleDefinitionId eq '${roleDefinitionId}'`
  const path = `/policies/roleManagementPolicyAssignments?$filter=${encodeURIComponent(filter)}&$select=policyId,roleDefinitionId`
  const res = await client.get(path)
  if (!res.ok) return null
  const parsed = parseJson<{ value?: Array<{ policyId?: string }> }>(res.body)
  return parsed?.value?.[0]?.policyId ?? null
}

function buildEnablementBody(spec: PimPolicySpec): Record<string, unknown> {
  return { '@odata.type': RULE_ODATA_TYPES.enablement, id: RULE_IDS.enablement, enabledRules: desiredEnabledRules(spec) }
}

function buildExpirationBody(spec: PimPolicySpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    '@odata.type': RULE_ODATA_TYPES.expiration,
    id: RULE_IDS.expiration,
    isExpirationRequired: spec.activationExpirationRequired,
  }
  if (spec.activationMaximumDuration) body.maximumDuration = spec.activationMaximumDuration
  return body
}

/** Merge the desired isApprovalRequired into the live setting so stages survive. */
function buildApprovalBody(spec: PimPolicySpec, live: LivePimRule | undefined): Record<string, unknown> {
  const setting = { ...(live?.setting ?? {}), isApprovalRequired: spec.requireApprovalToActivate }
  return { '@odata.type': RULE_ODATA_TYPES.approval, id: RULE_IDS.approval, setting }
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const specs = extractPimPolicySpecs(ctx.canvas).filter((s) => s.roleDefinitionId)
  // Loaded for parity with sibling handlers; PIM rules are never created/deleted.
  await loadPriorEntries(ctx)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const policyId = await resolvePolicyId(client, spec.roleDefinitionId)
    if (!policyId) {
      failures.push(`${spec.roleDefinitionId}: no Directory-scope role management policy found`)
      continue
    }

    const rulesRes = await client.getAll<LivePimRule>(`${POLICIES}/${policyId}/rules`)
    if (!rulesRes.ok) {
      failures.push(`${spec.roleDefinitionId}: ${graphErrorMessage(rulesRes.lastError!)}`)
      continue
    }
    const rulesById = new Map<string, LivePimRule>()
    for (const r of rulesRes.items) if (r.id) rulesById.set(r.id, r)

    const liveEnablement = rulesById.get(RULE_IDS.enablement)
    const liveExpiration = rulesById.get(RULE_IDS.expiration)
    const liveApproval = rulesById.get(RULE_IDS.approval)

    const targets: Array<{ id: string; body: Record<string, unknown> }> = [
      { id: RULE_IDS.enablement, body: buildEnablementBody(spec) },
      { id: RULE_IDS.expiration, body: buildExpirationBody(spec) },
      { id: RULE_IDS.approval, body: buildApprovalBody(spec, liveApproval) },
    ]

    let failed = false
    for (const t of targets) {
      const resp = await client.patch(`${POLICIES}/${policyId}/rules/${t.id}`, t.body)
      if (!resp.ok) {
        failures.push(`${spec.roleDefinitionId} (${t.id}): ${graphErrorMessage(resp)}`)
        failed = true
        break
      }
    }
    if (failed) continue

    const priorRules: Record<string, Record<string, unknown>> = {
      [RULE_IDS.enablement]: {
        '@odata.type': RULE_ODATA_TYPES.enablement,
        id: RULE_IDS.enablement,
        enabledRules: liveEnablement?.enabledRules ?? [],
      },
      [RULE_IDS.expiration]: {
        '@odata.type': RULE_ODATA_TYPES.expiration,
        id: RULE_IDS.expiration,
        isExpirationRequired: liveExpiration?.isExpirationRequired ?? false,
        maximumDuration: liveExpiration?.maximumDuration ?? 'PT8H',
      },
      [RULE_IDS.approval]: {
        '@odata.type': RULE_ODATA_TYPES.approval,
        id: RULE_IDS.approval,
        setting: liveApproval?.setting ?? { isApprovalRequired: false },
      },
    }
    entries.push({ itemId: spec.itemId, name: spec.roleDefinitionId, existed: true, policyId, priorRules })
  }

  // PIM rules are system-provisioned per scope+role — never created or deleted,
  // so there is no reconcile-delete. Removing a role leaves its rules as last set.

  if (failures.length) {
    return {
      success: false,
      message: `Some PIM role policies failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Updated PIM activation rules for ${entries.length} role(s)`,
    rollbackData: { entries },
  }
}
