// =============================================================================
// Generic engine for Meraki's "ordered whole-list per network" config shape —
// GET returns `{ rules: [...] }`, PUT replaces the WHOLE list, order is
// significant, and (for the four config types built on this engine) there is
// no companion scalar alongside the array.
//
// l3-firewall-rules and l7-firewall-rules (v0.1.0 / v0.2.0) predate this
// engine and each have a genuine per-endpoint quirk (L3's write-only
// `syslogDefaultRule`; L7's country-code / object-shaped `value`), so they
// stay bespoke rather than being retrofitted onto it. One-to-one NAT,
// one-to-many NAT, port forwarding and switch ACLs have NO such quirk — they
// are a plain ordered array, full stop — so their per-type deploy/rollback/
// driftDetect/healthCheck files are thin wrappers over this engine.
//
// Canvas shape is identical across every consumer: `network_id` (identity),
// `comment` (local notes, never sent to Meraki) and `rules` (the ordered
// list, as JSON). See config-types/<type>/_shared.ts for the item-specific
// TypeScript shape and validation.
// =============================================================================

import type {
  CanvasSnapshot,
  DeployContext,
  DeployResult,
  DriftContext,
  DriftDiff,
  DriftResult,
  HealthCheckContext,
  HealthCheckResult,
  RollbackContext,
  RollbackResult,
} from '@veltrixsecops/app-sdk'
import { buildMerakiClient, listOrganizations, type MerakiClient } from './merakiApi'
import { canonicalJson } from './merakiCommon'

export interface OrderedListSpec {
  itemName: string
  networkId: string
  comment: string
  rulesRaw: unknown
}

/** Every ordered-list config type shares this canvas shape: network_id + comment + rules. */
export function extractOrderedListSpecs(canvas: CanvasSnapshot): OrderedListSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      itemName: item.name,
      networkId: str(fields.network_id),
      comment: str(fields.comment),
      rulesRaw: fields.rules,
    }
  })
}

export interface ParsedOrderedList<T> {
  rules: T[] | null
  error: string | null
}

/** Parse the `rules` textarea (JSON): a bare `[ ... ]` array or a `{ "rules": [...] }` object. */
export function parseOrderedListRules<T>(raw: unknown): ParsedOrderedList<T> {
  const text = String(raw ?? '').trim()
  if (!text) return { rules: null, error: 'rules is empty — provide the ordered list as JSON.' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { rules: null, error: `rules is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }

  if (Array.isArray(parsed)) return { rules: parsed as T[], error: null }
  if (!parsed || typeof parsed !== 'object') {
    return { rules: null, error: 'rules must be a JSON array, or an object with a "rules" array.' }
  }
  const rules = (parsed as Record<string, unknown>).rules
  if (!Array.isArray(rules)) return { rules: null, error: 'rules object must contain a "rules" array.' }
  return { rules: rules as T[], error: null }
}

export interface OrderedListRollbackEntry<T> {
  networkId: string
  rules: T[]
}

/** The GET/PUT pair a config type provides to drive this engine, plus a label for messages. */
export interface OrderedListTransport<T> {
  get(client: MerakiClient, networkId: string): Promise<{ rules: T[] }>
  put(client: MerakiClient, networkId: string, rules: T[]): Promise<{ rules: T[] }>
  /** e.g. "one-to-one NAT rules" — used in deploy/rollback messages. */
  resourceLabel: string
}

/**
 * Deploy an ordered list to every declared network: GET the current list
 * (captured for rollback), normalize the declared list, then PUT it whole.
 * Every item is an UPDATE — the resource always exists (even an empty list is
 * valid live state) — never a create/delete.
 */
export async function deployOrderedList<T>(
  ctx: DeployContext,
  transport: OrderedListTransport<T>,
  normalize: (item: Partial<T> | null | undefined) => T,
): Promise<DeployResult> {
  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractOrderedListSpecs(ctx.canvas).filter((s) => s.networkId)
  const previous: OrderedListRollbackEntry<T>[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const { rules: parsedRules, error } = parseOrderedListRules<T>(spec.rulesRaw)
      if (error || !parsedRules) throw new Error(`Network "${spec.networkId}": ${error ?? 'invalid rules'}`)
      const normalized = parsedRules.map((r) => normalize(r))

      const prior = await transport.get(client, spec.networkId)
      previous.push({ networkId: spec.networkId, rules: prior.rules })

      await transport.put(client, spec.networkId, normalized)
      deployed.push(spec.networkId)
    }

    return {
      success: true,
      message: `Applied ${transport.resourceLabel} to ${deployed.length} network(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { baseUrl: 'https://api.meraki.com/api/v1', deployedNetworks: deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `${transport.resourceLabel} deploy failed after ${deployed.length} of ${specs.length} network(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployedNetworks: deployed },
      rollbackData: { previous },
    }
  }
}

/** Restore every network's exact ordered list from `rollbackData.previous`. */
export async function rollbackOrderedList<T>(ctx: RollbackContext, transport: OrderedListTransport<T>): Promise<RollbackResult> {
  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: OrderedListRollbackEntry<T>[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const restored: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      if (!entry.networkId) continue
      await transport.put(client, entry.networkId, entry.rules ?? [])
      restored.push(entry.networkId)
    }
    return { success: true, message: `Rolled back ${transport.resourceLabel} on ${restored.length} network(s): ${restored.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${restored.length} of ${previous.length} network(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Order-sensitive drift: compare the declared list against the live one per network. */
export async function driftOrderedList<T>(
  ctx: DriftContext,
  transport: Pick<OrderedListTransport<T>, 'get'>,
  normalize: (item: Partial<T> | null | undefined) => T,
): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractOrderedListSpecs(ctx.deployedConfig).filter((s) => s.networkId)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  for (const spec of specs) {
    const { rules: parsedRules, error } = parseOrderedListRules<T>(spec.rulesRaw)
    if (error || !parsedRules) continue
    const expectedRules = parsedRules.map((r) => normalize(r))

    try {
      const live = await transport.get(client, spec.networkId)
      const expectedJson = canonicalJson(expectedRules)
      const actualJson = canonicalJson((live.rules ?? []).map((r) => normalize(r)))
      if (expectedJson !== actualJson) {
        diffs.push({ field: `${spec.networkId}.rules`, expected: expectedRules, actual: live.rules ?? [], severity: 'warning' })
      }
    } catch (error) {
      diffs.push({
        field: spec.networkId,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown error'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Health: Dashboard API reachability, then that every declared network's list is still readable. */
export async function healthCheckOrderedList<T>(ctx: HealthCheckContext, transport: Pick<OrderedListTransport<T>, 'get'>): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'meraki_credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const specs = extractOrderedListSpecs(ctx.canvas).filter((s) => s.networkId)

  const reachStarted = Date.now()
  try {
    await listOrganizations(client)
    checks.push({ name: 'meraki_reachable', passed: true, message: 'Meraki Dashboard API reachable and API key accepted.', latencyMs: Date.now() - reachStarted })
  } catch (error) {
    checks.push({
      name: 'meraki_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Meraki Dashboard API unreachable',
      latencyMs: Date.now() - reachStarted,
    })
    return { healthy: false, score: 0, checks }
  }

  for (const spec of specs) {
    const started = Date.now()
    try {
      await transport.get(client, spec.networkId)
      checks.push({ name: `network:${spec.networkId}`, passed: true, message: `Network "${spec.networkId}" ruleset is readable.`, latencyMs: Date.now() - started })
    } catch (error) {
      checks.push({
        name: `network:${spec.networkId}`,
        passed: false,
        message: error instanceof Error ? error.message : `Network "${spec.networkId}" is not reachable`,
        latencyMs: Date.now() - started,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
