import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { attachDriftActor, veltrixActorLogins } from '../lib/oktaSystemLog'
import { findPolicy, listPolicyRules } from './deploy'
import { extractPolicySpecs, parseRulesArray, parseSettingsObject, ruleName } from './validate'

/**
 * Detect drift between the deployed policy configuration and the live org.
 * Re-finds each declared policy by (type, name) and diffs the MANAGED fields:
 *   - description, group scoping (people.groups.include), settings — critical
 *   - status — warning
 *   - rules — count + per-name presence — info (kept light)
 *
 * Only the slices this config type manages are compared: the group-include set
 * (not the whole `conditions` object) and the settings keys the canvas declares
 * (a subset check) — so Okta's own server-populated defaults do not read as
 * drift. Server-managed read-only fields (id/created/lastUpdated/system/_links/
 * status) are never compared as body fields. `priority` is not modelled here, so
 * it is not diffed.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.type && s.name)
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  for (const spec of specs) {
    const before = diffs.length
    const label = `${spec.type}:${spec.name}`
    try {
      const live = await findPolicy(client, spec.type, spec.name)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        // Deleted/absent — no live id; attribute by name (best-effort).
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      // description — managed, returned on read.
      const liveDescription = (typeof live.description === 'string' ? live.description : '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${label}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'critical',
        })
      }

      // group scoping — compare only the include set we manage.
      const expectedGroups = [...spec.groupIncludeIds].sort()
      const liveGroups = extractIncludeGroups(live.conditions).sort()
      if (stableStringify(expectedGroups) !== stableStringify(liveGroups)) {
        diffs.push({
          field: `${label}.conditions.people.groups.include`,
          expected: expectedGroups.length ? expectedGroups.join(', ') : 'all users',
          actual: liveGroups.length ? liveGroups.join(', ') : 'all users',
          severity: 'critical',
        })
      }

      // settings — OKTA_SIGN_ON has none; otherwise the declared keys must be a
      // subset of the live settings (so server defaults do not create drift).
      if (spec.type !== 'OKTA_SIGN_ON' && spec.settingsJson) {
        const expected = parseSettingsObject(spec.settingsJson)
        if (expected && !isSubset(expected, live.settings)) {
          diffs.push({
            field: `${label}.settings`,
            expected: stableStringify(expected),
            actual: stableStringify(live.settings ?? {}),
            severity: 'critical',
          })
        }
      }

      // status — managed via lifecycle; compare separately (warning).
      const desiredStatus = spec.status || 'ACTIVE'
      const liveStatus = (typeof live.status === 'string' ? live.status : '').toUpperCase()
      if (desiredStatus !== liveStatus) {
        diffs.push({
          field: `${label}.status`,
          expected: desiredStatus,
          actual: liveStatus || 'not set',
          severity: 'warning',
        })
      }

      // rules — light: count + per-name presence (info).
      if (spec.rulesJson && live.id) {
        const expectedRules = parseRulesArray(spec.rulesJson) ?? []
        const liveRules = await listPolicyRules(client, live.id)
        const liveNames = new Set(liveRules.map((r) => r.name).filter(Boolean))
        for (const rule of expectedRules) {
          const name = ruleName(rule)
          if (name && !liveNames.has(name)) {
            diffs.push({
              field: `${label}.rules.${name}`,
              expected: 'present',
              actual: 'missing',
              severity: 'info',
            })
          }
        }
        if (expectedRules.length !== liveRules.length) {
          diffs.push({
            field: `${label}.rules.count`,
            expected: expectedRules.length,
            actual: liveRules.length,
            severity: 'info',
          })
        }
      }

      // Attribute every diff this policy produced to the last human change (once).
      await attachDriftActor(client, diffs.slice(before), {
        targetId: live.id,
        targetName: spec.name,
        excludeActorLogins,
      })
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Pull people.groups.include out of a policy's conditions, or []. */
function extractIncludeGroups(conditions: Record<string, unknown> | undefined): string[] {
  const people = conditions?.people as Record<string, unknown> | undefined
  const groups = people?.groups as Record<string, unknown> | undefined
  const include = groups?.include
  return Array.isArray(include) ? include.map(String) : []
}

/**
 * True when every key in `expected` is present in `actual` with an equal value.
 * Objects recurse; arrays and primitives compare by stable stringify. Lets a
 * declared settings subset match a live object that also carries server
 * defaults, so those defaults do not read as drift.
 */
function isSubset(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== 'object') {
    return stableStringify(expected) === stableStringify(actual)
  }
  if (Array.isArray(expected)) {
    return stableStringify(expected) === stableStringify(actual)
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false
  const exp = expected as Record<string, unknown>
  const act = actual as Record<string, unknown>
  return Object.keys(exp).every((key) => isSubset(exp[key], act[key]))
}

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
