import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { readIllumioSettings, resolveIllumioCredential, buildIllumioBaseUrl, orgPath, secPolicyDraftPath, basicAuthHeader, getJson } from '../../lib/illumioApi'
import { extractRuleSetSpecs, resolveRuleSet, liveRuleSignature, labelIdentity, type Resolvers } from './_shared'

type Diffs = DriftResult['diffs']
const LIST_MAX_RESULTS = 10000

interface LiveLabel {
  href?: string
  key?: string
  value?: string
}
interface LiveNamed {
  href?: string
  name?: string
}
interface LiveRuleSet extends LiveNamed {
  scopes?: unknown
  enabled?: boolean
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>
    return `{${Object.keys(obj).sort().map((k) => `${k}:${stableStringify(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/**
 * See config-types/ip-lists/driftDetect.ts — compares against draft, which
 * this app keeps in lockstep with active via provisioning on every deploy.
 * An unresolvable scope/rule reference (e.g. a referenced label was deleted
 * out from under this ruleset) is itself reported as drift rather than
 * silently skipped.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  const cred = resolveIllumioCredential(ctx.credential)
  if (!base || !cred) return { hasDrift: false, diffs: [] }

  const headers = basicAuthHeader(cred)
  const opts = { timeoutMs: settings.timeoutMs, verifyTls: settings.verifyTls }
  const specs = extractRuleSetSpecs(ctx.deployedConfig).filter((s) => s.name && !s.scopeLabelsError && !s.rulesError)
  const diffs: Diffs = []
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let liveLabels: LiveLabel[]
  let liveIpLists: LiveNamed[]
  let liveServices: LiveNamed[]
  let liveRuleSets: LiveRuleSet[]
  try {
    ;[liveLabels, liveIpLists, liveServices, liveRuleSets] = await Promise.all([
      getJson<LiveLabel[]>(`${base}${orgPath(settings, 'labels')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LiveNamed[]>(`${base}${secPolicyDraftPath(settings, 'ip_lists')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LiveNamed[]>(`${base}${secPolicyDraftPath(settings, 'services')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LiveRuleSet[]>(`${base}${secPolicyDraftPath(settings, 'rule_sets')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
    ])
  } catch {
    return { hasDrift: false, diffs: [] }
  }

  const resolvers: Resolvers = {
    labelHrefByIdentity: new Map(
      liveLabels.filter((l) => l.key !== undefined && l.value !== undefined && l.href).map((l) => [labelIdentity(l.key!, l.value!), l.href!]),
    ),
    ipListHrefByName: new Map(liveIpLists.filter((l) => l.name && l.href).map((l) => [l.name!.toLowerCase(), l.href!])),
    serviceHrefByName: new Map(liveServices.filter((s) => s.name && s.href).map((s) => [s.name!.toLowerCase(), s.href!])),
  }
  const ruleSetByName = new Map(liveRuleSets.filter((r) => r.name).map((r) => [r.name!.toLowerCase(), r]))

  for (const spec of specs) {
    let resolved
    try {
      resolved = resolveRuleSet(spec, resolvers)
    } catch (err) {
      diffs.push({ field: `${spec.name}.references`, expected: 'resolved', actual: err instanceof Error ? err.message : 'unresolved reference', severity: 'critical' })
      continue
    }

    const live = ruleSetByName.get(spec.name.toLowerCase())
    if (!live?.href) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    if ((live.enabled ?? true) !== spec.enabled) {
      diffs.push({ field: `${spec.name}.enabled`, expected: spec.enabled, actual: live.enabled ?? true, severity: 'warning' })
    }
    const wantScopes = stableStringify(resolved.scopes)
    const haveScopes = stableStringify(live.scopes ?? [])
    if (wantScopes !== haveScopes) {
      diffs.push({ field: `${spec.name}.scopes`, expected: wantScopes, actual: haveScopes, severity: 'critical' })
    }

    let liveRules: Array<Record<string, unknown>>
    try {
      liveRules = await getJson<Array<Record<string, unknown>>>(`${base}${live.href}/sec_rules?max_results=${LIST_MAX_RESULTS}`, headers, opts)
    } catch {
      continue
    }
    const liveSignatures = new Set(liveRules.map((r) => liveRuleSignature(r)))
    const desiredSignatures = new Set(resolved.rules.map((r) => r.signature))

    for (const sig of desiredSignatures) {
      if (!liveSignatures.has(sig)) {
        diffs.push({ field: `${spec.name}.rules`, expected: 'declared rule present', actual: 'missing in the PCE', severity: 'critical' })
      }
    }
    for (const sig of liveSignatures) {
      if (!desiredSignatures.has(sig)) {
        diffs.push({ field: `${spec.name}.rules`, expected: 'not declared', actual: 'extra rule present in the PCE', severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
