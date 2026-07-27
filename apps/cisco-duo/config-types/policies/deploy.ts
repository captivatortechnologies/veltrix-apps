import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildDuoClient,
  duoErrorMessage,
  readDuoSettings,
  resolveDuoCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/duo'
import { extractPolicySpecs, parseSections, type LivePolicy } from './validate'

const BASE = '/admin/v2/policies'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** The Global Policy is update-only — never created or deleted. */
  isGlobal: boolean
  /** Whether the policy existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** Duo policy_key assigned to the policy. */
  policyKey?: string
  /** Prior name + sections, captured before an update so rollback can restore them. */
  prior?: { policyName: string; sections: Record<string, unknown> }
  /** Section names this deploy set, so rollback can clear ones the prior lacked. */
  appliedSectionKeys?: string[]
}

/** Section names present in `from` but not in `to`. */
function missingKeys(from: Record<string, unknown>, to: Record<string, unknown>): string[] {
  return Object.keys(from).filter((k) => !(k in to))
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

/** Read a single policy's authoritative sections (the list omits them). */
async function readPolicySections(
  client: ReturnType<typeof buildDuoClient>,
  policyKey: string
): Promise<{ ok: boolean; policy?: LivePolicy; message?: string }> {
  const res = await client.getV5(`${BASE}/${policyKey}`)
  if (!res.ok) return { ok: false, message: duoErrorMessage(res) }
  return { ok: true, policy: (res.response as LivePolicy | null) ?? {} }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildDuoClient(cred, settings)

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAllV5<LivePolicy>(BASE)
  if (!listed.ok) {
    return { success: false, message: `Failed to list policies: ${duoErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LivePolicy>()
  const liveById = new Map<string, LivePolicy>()
  for (const p of listed.items) {
    if (p.policy_name) liveByName.set(p.policy_name.toLowerCase(), p)
    if (p.policy_key) liveById.set(p.policy_key, p)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const parsed = parseSections(spec.sectionsRaw)
    if (!parsed.ok || !parsed.value) {
      failures.push(`${spec.name}: invalid sections (${parsed.error ?? 'parse error'})`)
      continue
    }
    const desired = parsed.value
    const desiredKeys = Object.keys(desired)

    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const liveMatch =
      (priorEntry?.policyKey ? liveById.get(priorEntry.policyKey) : undefined) ??
      liveByName.get(spec.name.toLowerCase()) ??
      null

    if (liveMatch?.policy_key) {
      const detail = await readPolicySections(client, liveMatch.policy_key)
      if (!detail.ok) {
        failures.push(`${spec.name}: ${detail.message}`)
        continue
      }
      const priorSections = (detail.policy?.sections ?? {}) as Record<string, unknown>
      const body: Record<string, unknown> = { sections: desired }
      if (!spec.isGlobal) {
        body.policy_name = spec.name
        const toDelete = missingKeys(priorSections, desired)
        if (toDelete.length) body.sections_to_delete = toDelete
      }
      const resp = await client.putV5(`${BASE}/${liveMatch.policy_key}`, body)
      if (!resp.ok) {
        failures.push(`${spec.name}: ${duoErrorMessage(resp)}`)
        continue
      }
      entries.push({
        itemId: spec.itemId,
        name: spec.name,
        isGlobal: spec.isGlobal,
        existed: true,
        policyKey: liveMatch.policy_key,
        prior: { policyName: detail.policy?.policy_name ?? '', sections: priorSections },
        appliedSectionKeys: desiredKeys,
      })
    } else {
      if (spec.isGlobal) {
        failures.push(`${spec.name}: the Global Policy cannot be created via the API — it must already exist`)
        continue
      }
      const created = await client.postV5(BASE, { name: spec.name })
      if (!created.ok) {
        failures.push(`${spec.name}: ${duoErrorMessage(created)}`)
        continue
      }
      const key = (created.response as LivePolicy | null)?.policy_key
      if (!key) {
        failures.push(`${spec.name}: create returned no policy_key`)
        continue
      }
      const entry: RollbackEntry = {
        itemId: spec.itemId,
        name: spec.name,
        isGlobal: false,
        existed: false,
        policyKey: key,
        appliedSectionKeys: desiredKeys,
      }
      if (desiredKeys.length) {
        const resp = await client.putV5(`${BASE}/${key}`, { policy_name: spec.name, sections: desired })
        if (!resp.ok) failures.push(`${spec.name}: created but failed to apply sections: ${duoErrorMessage(resp)}`)
      }
      entries.push(entry)
    }
  }

  // Reconcile: delete policies THIS app created previously but no longer declares.
  // The Global Policy is never a candidate (it always existed / is never app-created).
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptKeys = new Set(entries.map((e) => e.policyKey).filter(Boolean) as string[])
  for (const p of prior) {
    if (p.existed || p.isGlobal || !p.policyKey) continue
    if (keptKeys.has(p.policyKey) || declaredNames.has(p.name.toLowerCase())) continue
    const resp = await client.deleteV5(`${BASE}/${p.policyKey}`)
    if (!resp.ok) failures.push(`delete ${p.name}: ${duoErrorMessage(resp)}`)
  }

  if (failures.length) {
    return { success: false, message: `Some policies failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} policy(ies)`, rollbackData: { entries } }
}
