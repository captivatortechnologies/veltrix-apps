import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGithubClient, parseJson } from '../../lib/githubApi'
import { desiredFromItem, buildRulesetBody, stableStringify, type LiveRuleset } from './_shared'

/**
 * Drift for rulesets: compare each declared ruleset against its live state.
 * Read-only — list the scope's rulesets, match by name, then GET the full
 * ruleset and compare target / enforcement + the JSON of rules / conditions /
 * bypass_actors. Best-effort: a scope that can't be listed is skipped rather than
 * raising false drift; a declared ruleset with unparseable JSON is skipped.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const listCache = new Map<string, LiveRuleset[] | null>()

  for (const item of items) {
    const desired = desiredFromItem(item.fields)
    if (!desired.owner || !desired.name) continue
    const { body, errors } = buildRulesetBody(desired)
    if (errors.length > 0) continue

    const scopeLabel = desired.repository ? `${desired.owner}/${desired.repository}` : desired.owner
    const fullName = `${scopeLabel} · ${desired.name}`
    const key = `${desired.owner} ${desired.repository}`

    if (!listCache.has(key)) {
      const res = await client.listRulesets(desired.owner, desired.repository || null)
      listCache.set(key, res.ok ? parseJson<LiveRuleset[]>(res.body) ?? [] : null)
    }
    const rulesets = listCache.get(key)
    if (rulesets == null) continue

    const summary = rulesets.find((r) => (r.name ?? '') === desired.name)
    if (!summary || summary.id == null) {
      diffs.push({ field: `${fullName}.exists`, expected: true, actual: false, severity: 'warning' })
      continue
    }

    const fullRes = await client.getRuleset(desired.owner, desired.repository || null, summary.id)
    if (!fullRes.ok) continue
    const live = parseJson<LiveRuleset>(fullRes.body) ?? summary

    compare(diffs, fullName, 'target', body.target, live.target)
    compare(diffs, fullName, 'enforcement', body.enforcement, live.enforcement)
    compareJson(diffs, fullName, 'rules', body.rules, live.rules ?? [])
    compareJson(diffs, fullName, 'conditions', body.conditions ?? null, live.conditions ?? null)
    compareJson(diffs, fullName, 'bypass_actors', body.bypass_actors ?? [], live.bypass_actors ?? [])
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function compare(diffs: DriftDiff[], name: string, field: string, expected: unknown, actual: unknown): void {
  if (String(expected ?? '') !== String(actual ?? '')) {
    diffs.push({ field: `${name}.${field}`, expected: expected ?? null, actual: actual ?? null, severity: 'warning' })
  }
}

function compareJson(diffs: DriftDiff[], name: string, field: string, expected: unknown, actual: unknown): void {
  if (stableStringify(expected) !== stableStringify(actual)) {
    diffs.push({ field: `${name}.${field}`, expected, actual, severity: 'warning' })
  }
}
