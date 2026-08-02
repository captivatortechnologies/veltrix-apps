import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  readIllumioSettings,
  resolveIllumioCredential,
  buildIllumioBaseUrl,
  orgPath,
  secPolicyDraftPath,
  basicAuthHeader,
  getJson,
  sendJson,
  provisionChanges,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/illumioApi'
import {
  extractRuleSetSpecs,
  resolveRuleSet,
  buildRuleSetBody,
  snapshotLiveRuleSet,
  liveRuleSignature,
  labelIdentity,
  type Resolvers,
  type RuleSetRollbackEntry,
  type RuleEntry,
} from './_shared'

/** See config-types/labels/deploy.ts — same generous cap, same reasoning. */
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
  description?: string
  enabled?: boolean
  scopes?: unknown
  external_data_set?: string
  external_data_reference?: string
}

async function loadPriorEntries(ctx: DeployContext): Promise<RuleSetRollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RuleSetRollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RuleSetRollbackEntry[]) : []
  } catch {
    return []
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Deploy Illumio rulesets — the DRAFT → PROVISION model at its fullest here:
 *   1. List labels, IP lists and services once (the reference universe every
 *      rule/scope resolves against) plus the org's rule_sets.
 *   2. Per ruleset item: resolve its scope + every rule to PCE hrefs. ANY
 *      unresolved reference FAILS CLOSED — this item is skipped entirely
 *      (nothing partial is applied) and reported as a failure.
 *   3. Upsert the rule_set object itself (name-keyed, like ip-lists/services).
 *   4. Reconcile its nested rules by CONTENT SIGNATURE — rules have no
 *      natural identity in the PCE — creating missing ones and deleting ones
 *      this app previously created that are no longer declared.
 *   5. Provision every ruleset href touched (create/update/rule-change/delete)
 *      — POST /orgs/{org}/sec_policy { change_subset: { rule_sets: [...] } }.
 *      Rule changes ride along with their parent ruleset's href; the PCE's
 *      change_subset has no separate field for individual rules (confirmed:
 *      SecurityPolicyChangeSubset only has ip_lists/services/rule_sets/
 *      label_groups/virtual_services/enforcement_boundaries/firewall_settings).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  if (!base) return { success: false, message: 'No PCE host is configured — set the "PCE host" app setting.' }
  const cred = resolveIllumioCredential(ctx.credential)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const headers = basicAuthHeader(cred)
  const opts = { timeoutMs: settings.timeoutMs, verifyTls: settings.verifyTls }
  const ruleSetsUrl = `${base}${secPolicyDraftPath(settings, 'rule_sets')}`

  const allSpecs = extractRuleSetSpecs(ctx.canvas)
  const specs = allSpecs.filter((s) => s.name && !s.scopeLabelsError && !s.rulesError)
  const failures: string[] = []
  const entries: RuleSetRollbackEntry[] = []
  const changedHrefs = new Set<string>()

  let liveLabels: LiveLabel[]
  let liveIpLists: LiveNamed[]
  let liveServices: LiveNamed[]
  let liveRuleSets: LiveRuleSet[]
  try {
    ;[liveLabels, liveIpLists, liveServices, liveRuleSets] = await Promise.all([
      getJson<LiveLabel[]>(`${base}${orgPath(settings, 'labels')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LiveNamed[]>(`${base}${secPolicyDraftPath(settings, 'ip_lists')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LiveNamed[]>(`${base}${secPolicyDraftPath(settings, 'services')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LiveRuleSet[]>(`${ruleSetsUrl}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
    ])
  } catch (err) {
    return { success: false, message: `Failed to list PCE policy objects: ${errorMessage(err)}` }
  }

  const resolvers: Resolvers = {
    labelHrefByIdentity: new Map(
      liveLabels
        .filter((l) => l.key !== undefined && l.value !== undefined && l.href)
        .map((l) => [labelIdentity(l.key!, l.value!), l.href!]),
    ),
    ipListHrefByName: new Map(liveIpLists.filter((l) => l.name && l.href).map((l) => [l.name!.toLowerCase(), l.href!])),
    serviceHrefByName: new Map(liveServices.filter((s) => s.name && s.href).map((s) => [s.name!.toLowerCase(), s.href!])),
  }
  const ruleSetByName = new Map(liveRuleSets.filter((r) => r.name).map((r) => [r.name!.toLowerCase(), r]))
  const prior = await loadPriorEntries(ctx)
  const priorByName = new Map(prior.map((p) => [p.name.toLowerCase(), p]))

  for (const spec of specs) {
    let resolved
    try {
      resolved = resolveRuleSet(spec, resolvers)
    } catch (err) {
      // Fail closed: skip this ruleset entirely rather than apply a partial,
      // possibly under-scoped or under-restricted policy.
      failures.push(`${spec.name}: ${errorMessage(err)}`)
      continue
    }

    const liveMatch = ruleSetByName.get(spec.name.toLowerCase()) ?? null
    let href: string
    let existed: boolean
    let priorBody: Record<string, unknown> | undefined
    try {
      if (liveMatch?.href) {
        await sendJson('PUT', `${base}${liveMatch.href}`, headers, buildRuleSetBody(spec, resolved.scopes), opts)
        href = liveMatch.href
        existed = true
        priorBody = snapshotLiveRuleSet(liveMatch as unknown as Record<string, unknown>)
      } else {
        const created = await sendJson<LiveRuleSet>('POST', ruleSetsUrl, headers, buildRuleSetBody(spec, resolved.scopes), opts)
        if (!created?.href) throw new Error('create succeeded but the PCE returned no href')
        href = created.href
        existed = false
      }
    } catch (err) {
      failures.push(`${spec.name}: ${errorMessage(err)}`)
      continue
    }
    changedHrefs.add(href)

    // Reconcile rules under this ruleset by content signature (rules have no natural identity).
    let liveRules: Array<Record<string, unknown>>
    try {
      liveRules = await getJson<Array<Record<string, unknown>>>(`${base}${href}/sec_rules?max_results=${LIST_MAX_RESULTS}`, headers, opts)
    } catch (err) {
      failures.push(`${spec.name}: failed to list existing rules — ${errorMessage(err)}`)
      entries.push({ itemId: spec.itemId, name: spec.name, existed, href, prior: priorBody, rules: priorByName.get(spec.name.toLowerCase())?.rules ?? [] })
      continue
    }
    const liveSigToHref = new Map(liveRules.filter((r) => typeof r.href === 'string').map((r) => [liveRuleSignature(r), r.href as string]))
    const ourPriorRules = priorByName.get(spec.name.toLowerCase())?.rules ?? []
    const ourPriorHrefSet = new Set(ourPriorRules.map((r) => r.href))
    const desiredSignatures = new Set(resolved.rules.map((r) => r.signature))
    const newRuleEntries: RuleEntry[] = []

    for (const { body, signature } of resolved.rules) {
      const liveHref = liveSigToHref.get(signature)
      if (liveHref) {
        // Already present live with this exact shape. Only claim ownership
        // (for future reconcile-delete) if we already owned it — never adopt
        // a rule we did not create just because it happens to match.
        if (ourPriorHrefSet.has(liveHref)) newRuleEntries.push({ href: liveHref, signature })
        continue
      }
      try {
        const created = await sendJson<{ href?: string }>('POST', `${base}${href}/sec_rules`, headers, body, opts)
        if (!created?.href) throw new Error('rule create succeeded but the PCE returned no href')
        newRuleEntries.push({ href: created.href, signature })
        changedHrefs.add(href)
      } catch (err) {
        failures.push(`${spec.name}: rule create failed — ${errorMessage(err)}`)
      }
    }
    for (const r of ourPriorRules) {
      if (desiredSignatures.has(r.signature)) continue
      try {
        await sendJson('DELETE', `${base}${r.href}`, headers, undefined, opts)
        changedHrefs.add(href)
      } catch (err) {
        failures.push(`${spec.name}: rule delete failed — ${errorMessage(err)}`)
      }
    }

    entries.push({ itemId: spec.itemId, name: spec.name, existed, href, prior: priorBody, rules: newRuleEntries })
  }

  // Reconcile: delete rulesets THIS app created previously but no longer
  // declared AT ALL. A ruleset present in the canvas that merely failed to
  // resolve this round is left untouched, not reconciled away.
  const allCurrentNames = new Set(allSpecs.filter((s) => s.name).map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (p.existed || !p.href) continue
    if (allCurrentNames.has(p.name.toLowerCase())) continue
    try {
      await sendJson('DELETE', `${base}${p.href}`, headers, undefined, opts)
      changedHrefs.add(p.href)
    } catch (err) {
      failures.push(`delete ${p.name}: ${errorMessage(err)}`)
    }
  }

  let provisionNote = ''
  if (changedHrefs.size > 0) {
    try {
      await provisionChanges(base, settings, headers, `Veltrix: deploy rulesets (${changedHrefs.size} change(s))`, {
        rule_sets: [...changedHrefs].map((href) => ({ href })),
      })
      provisionNote = `; provisioned ${changedHrefs.size} change(s)`
    } catch (err) {
      failures.push(`provision failed: ${errorMessage(err)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some rulesets failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} ruleset(s)${provisionNote}`, rollbackData: { entries } }
}
