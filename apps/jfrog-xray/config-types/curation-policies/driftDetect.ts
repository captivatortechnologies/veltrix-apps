import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient, parseJson } from '../../lib/xrayApi'
import { curationPolicyPath, listCurationPolicies } from './deploy'
import { buildLabelWaivers, buildWaivers, extractCurationPolicySpecs, findPolicy, type XrayCurationPolicy } from './_shared'

/**
 * Detect drift between the last-deployed curation-policy configuration and
 * the live Xray tenant. Lists policies to find each declared one by name,
 * reads its full detail, and compares:
 *   - existence (a missing policy is CRITICAL drift)
 *   - condition_id, scope, policy_action, waiver_request_config, enabled,
 *     block_from_cache
 *   - the scope's repo_include/repo_exclude/pkg_types_include sets
 *   - notify_emails / decision_owners sets
 *   - waivers / label_waivers (compared as a whole via canonical JSON — small,
 *     order-insensitive exception lists, not worth diffing element-by-element)
 * Best-effort and read-only: any transport failure reports no drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractCurationPolicySpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let list: XrayCurationPolicy[]
  try {
    list = await listCurationPolicies(client)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const spec of specs) {
    const label = spec.name
    const found = findPolicy(list, spec.name)
    if (!found) {
      diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const detailRes = await client.request('GET', curationPolicyPath(found.id))
    if (!detailRes.ok) continue
    const full = parseJson<XrayCurationPolicy>(detailRes.body)
    if (!full) continue

    diffScalar(`${label}.condition_id`, spec.conditionId, full.condition_id ?? '', diffs)
    diffScalar(`${label}.scope`, spec.scope, full.scope ?? '', diffs)
    diffScalar(`${label}.policy_action`, spec.policyAction, full.policy_action ?? '', diffs)
    diffScalar(`${label}.waiver_request_config`, spec.waiverRequestConfig, full.waiver_request_config ?? '', diffs)
    diffBool(`${label}.enabled`, spec.enabled, full.enabled ?? true, diffs)
    diffBool(`${label}.block_from_cache`, spec.blockFromCache, full.block_from_cache ?? false, diffs)

    diffSet(`${label}.repo_include`, spec.repoInclude, full.repo_include ?? [], diffs)
    diffSet(`${label}.repo_exclude`, spec.repoExclude, full.repo_exclude ?? [], diffs)
    diffSet(`${label}.pkg_types_include`, spec.pkgTypesInclude, full.pkg_types_include ?? [], diffs)
    diffSet(`${label}.notify_emails`, spec.notifyEmails, full.notify_emails ?? [], diffs)
    diffSet(`${label}.decision_owners`, spec.decisionOwners, full.decision_owners ?? [], diffs)

    diffCanonical(`${label}.waivers`, buildWaivers(spec), full.waivers ?? [], diffs)
    diffCanonical(`${label}.label_waivers`, buildLabelWaivers(spec), full.label_waivers ?? [], diffs)
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function diffScalar(field: string, desired: string, actual: string, diffs: DriftDiff[]): void {
  if (desired !== actual) diffs.push({ field, expected: desired || '(none)', actual: actual || '(none)', severity: 'warning' })
}

function diffBool(field: string, desired: boolean, actual: boolean, diffs: DriftDiff[]): void {
  if (desired !== actual) diffs.push({ field, expected: String(desired), actual: String(actual), severity: 'warning' })
}

function diffSet(field: string, desired: string[], actual: string[], diffs: DriftDiff[]): void {
  const d = [...desired].sort()
  const a = [...actual].sort()
  if (JSON.stringify(d) !== JSON.stringify(a)) {
    diffs.push({ field, expected: d.join(', ') || '(none)', actual: a.join(', ') || '(none)', severity: 'warning' })
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([k]) => k !== 'id') // ids are server-assigned bookkeeping, not declared content
      .sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function diffCanonical(field: string, desired: unknown[], actual: unknown[], diffs: DriftDiff[]): void {
  const d = [...desired].map(canonical).sort()
  const a = [...actual].map(canonical).sort()
  if (JSON.stringify(d) !== JSON.stringify(a)) {
    diffs.push({ field, expected: `${d.length} entr${d.length === 1 ? 'y' : 'ies'}`, actual: `${a.length} entr${a.length === 1 ? 'y' : 'ies'}`, severity: 'warning' })
  }
}
