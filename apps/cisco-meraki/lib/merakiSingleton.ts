import type { CanvasSnapshot, DeployContext, DeployResult, DriftContext, DriftResult, HealthCheckContext, HealthCheckResult, PipelineContext, RollbackContext, RollbackResult, ValidationResult } from '@veltrixsecops/app-sdk'
import { buildMerakiClient, checkMerakiReachable, type MerakiClient } from './merakiApi'
import { canonicalJson, looksLikeKnownNetworkId, NETWORK_ID_RE, parseJsonObject } from './merakiCommon'

export interface SingletonSpec { networkId: string; settingsRaw: unknown }
export interface SingletonTransport<T> {
  label: string
  get(client: MerakiClient, networkId: string): Promise<T>
  put(client: MerakiClient, networkId: string, settings: T): Promise<T>
  validate?: (settings: T, field: string, errors: ValidationResult['errors'], warnings: ValidationResult['warnings']) => void
}

export function extractSingletonSpecs(canvas: CanvasSnapshot): SingletonSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => ({
    networkId: String(item.fields?.network_id ?? '').trim(),
    settingsRaw: item.fields?.settings,
  }))
}

function parseSettings<T>(raw: unknown): { value: T | null; error: string | null } {
  const parsed = parseJsonObject(raw, 'settings')
  return { value: parsed.value as T | null, error: parsed.error }
}

function projectDeclared(expected: unknown, actual: unknown): unknown {
  if (Array.isArray(expected)) return expected.map((v, i) => projectDeclared(v, Array.isArray(actual) ? actual[i] : undefined))
  if (expected && typeof expected === 'object') return Object.keys(expected as Record<string, unknown>).reduce<Record<string, unknown>>((out, key) => { out[key] = projectDeclared((expected as Record<string, unknown>)[key], actual && typeof actual === 'object' ? (actual as Record<string, unknown>)[key] : undefined); return out }, {})
  return actual
}

export async function validateSingleton<T>(ctx: PipelineContext, transport: SingletonTransport<T>): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractSingletonSpecs(ctx.canvas)
  if (specs.length === 0) return { valid: false, errors: [{ field: 'items', message: `Add at least one ${transport.label} item.`, code: 'EMPTY' }], warnings }
  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`
    if (!spec.networkId) errors.push({ field: `${prefix}.network_id`, message: 'Meraki network id is required.', code: 'REQUIRED' })
    else if (!NETWORK_ID_RE.test(spec.networkId)) errors.push({ field: `${prefix}.network_id`, message: 'Network id may contain only letters, digits, underscore and hyphen.', code: 'INVALID_NETWORK_ID' })
    else {
      if (!looksLikeKnownNetworkId(spec.networkId)) warnings.push({ field: `${prefix}.network_id`, message: `Network id "${spec.networkId}" has an unusual prefix.`, code: 'UNUSUAL_NETWORK_ID' })
      if (seen.has(spec.networkId)) errors.push({ field: `${prefix}.network_id`, message: `Network "${spec.networkId}" is declared more than once.`, code: 'DUPLICATE_NETWORK_ID' })
      seen.add(spec.networkId)
    }
    const parsed = parseSettings<T>(spec.settingsRaw)
    if (parsed.error || !parsed.value) errors.push({ field: `${prefix}.settings`, message: parsed.error ?? 'Settings are required.', code: 'INVALID_SETTINGS' })
    else transport.validate?.(parsed.value, `${prefix}.settings`, errors, warnings)
  })
  return { valid: errors.length === 0, errors, warnings }
}

export async function deploySingleton<T>(ctx: DeployContext, transport: SingletonTransport<T>): Promise<DeployResult> {
  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const previous: Array<{ networkId: string; settings: T }> = []
  const applied: string[] = []
  try {
    for (const spec of extractSingletonSpecs(ctx.canvas).filter((s) => s.networkId)) {
      const parsed = parseSettings<T>(spec.settingsRaw)
      if (parsed.error || !parsed.value) throw new Error(`Network "${spec.networkId}": ${parsed.error ?? 'invalid settings'}`)
      previous.push({ networkId: spec.networkId, settings: await transport.get(built.client, spec.networkId) })
      await transport.put(built.client, spec.networkId, parsed.value)
      applied.push(spec.networkId)
    }
    return { success: true, message: `Applied ${transport.label} to ${applied.length} network(s).`, rollbackData: { previous }, artifacts: { deployedNetworks: applied } }
  } catch (error) {
    return { success: false, message: `${transport.label} deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`, rollbackData: { previous }, artifacts: { deployedNetworks: applied } }
  }
}

export async function rollbackSingleton<T>(ctx: RollbackContext, transport: SingletonTransport<T>): Promise<RollbackResult> {
  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const previous = (ctx.rollbackData as { previous?: Array<{ networkId: string; settings: T }> } | undefined)?.previous
  if (!previous?.length) return { success: false, message: 'No previous state available for rollback' }
  try {
    for (const entry of [...previous].reverse()) await transport.put(built.client, entry.networkId, entry.settings)
    return { success: true, message: `Rolled back ${transport.label} on ${previous.length} network(s).` }
  } catch (error) { return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` } }
}

export async function driftSingleton<T>(ctx: DriftContext, transport: SingletonTransport<T>): Promise<DriftResult> {
  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const diffs: DriftResult['diffs'] = []
  for (const spec of extractSingletonSpecs(ctx.deployedConfig).filter((s) => s.networkId)) {
    const parsed = parseSettings<T>(spec.settingsRaw)
    if (!parsed.value) continue
    try {
      const live = await transport.get(built.client, spec.networkId)
      const managedLive = projectDeclared(parsed.value, live)
      if (canonicalJson(parsed.value) !== canonicalJson(managedLive)) diffs.push({ field: `${spec.networkId}.settings`, expected: parsed.value, actual: managedLive, severity: 'warning' })
    } catch (error) { diffs.push({ field: spec.networkId, expected: 'reachable', actual: error instanceof Error ? error.message : 'unreachable', severity: 'critical' }) }
  }
  return { hasDrift: diffs.length > 0, diffs }
}

export async function healthSingleton<T>(ctx: HealthCheckContext, transport: SingletonTransport<T>): Promise<HealthCheckResult> {
  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { healthy: false, score: 0, checks: [{ name: 'meraki_credential', passed: false, message: built.error }] }
  const checks: HealthCheckResult['checks'] = [await checkMerakiReachable(built.client)]
  if (!checks[0].passed) return { healthy: false, score: 0, checks }
  for (const spec of extractSingletonSpecs(ctx.canvas).filter((s) => s.networkId)) {
    try { await transport.get(built.client, spec.networkId); checks.push({ name: `network:${spec.networkId}`, passed: true, message: `${transport.label} is readable.` }) }
    catch (error) { checks.push({ name: `network:${spec.networkId}`, passed: false, message: error instanceof Error ? error.message : 'Unreadable' }) }
  }
  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: Math.round((passed / checks.length) * 100), checks }
}
