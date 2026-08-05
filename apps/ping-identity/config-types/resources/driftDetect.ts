import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient } from '../../lib/pingOne'
import { listResources, listScopes } from './deploy'
import {
  DEFAULT_ACCESS_TOKEN_VALIDITY_SECONDS,
  DEFAULT_INTROSPECT_AUTH_METHOD,
  buildScopeBody,
  extractResourceSpecs,
  findResourceByName,
  isCustomResource,
  parseScopesJson,
  resolvedAudience,
  scopeKey,
  type LiveScope,
  type RawScopeJson,
} from './_shared'

/**
 * Detect drift between the deployed Resources + Scopes configuration and the
 * live PingOne environment. A resource whose live `type !== 'CUSTOM'` (a
 * built-in) is reported as an INFO diff only - never compared field by field
 * or scope by scope, since this app never manages its content.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractResourceSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let liveResources
  try {
    liveResources = await listResources(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'pingone',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  const diffs: DriftDiff[] = []

  for (const spec of specs) {
    const label = spec.name
    const found = findResourceByName(liveResources, spec.name)
    if (!found || !found.id) {
      diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    if (!isCustomResource(found)) {
      diffs.push({
        field: label,
        expected: 'CUSTOM (managed)',
        actual: `${found.type ?? 'unknown'} (built-in, protected - not compared)`,
        severity: 'info',
      })
      continue
    }

    const liveDescription = typeof found.description === 'string' ? found.description : ''
    if (spec.description !== liveDescription) {
      diffs.push({ field: `${label}.description`, expected: spec.description, actual: liveDescription, severity: 'warning' })
    }

    const expectedAudience = resolvedAudience(spec)
    const liveAudience = typeof found.audience === 'string' ? found.audience : ''
    if (expectedAudience !== liveAudience) {
      diffs.push({ field: `${label}.audience`, expected: expectedAudience, actual: liveAudience, severity: 'warning' })
    }

    const declaredValidity = spec.accessTokenValiditySeconds ?? DEFAULT_ACCESS_TOKEN_VALIDITY_SECONDS
    const liveValidity =
      typeof found.accessTokenValiditySeconds === 'number' ? found.accessTokenValiditySeconds : DEFAULT_ACCESS_TOKEN_VALIDITY_SECONDS
    if (declaredValidity !== liveValidity) {
      diffs.push({ field: `${label}.accessTokenValiditySeconds`, expected: declaredValidity, actual: liveValidity, severity: 'warning' })
    }

    const liveClaimEnabled = found.applicationPermissionsSettings?.claimEnabled ?? false
    if (spec.applicationPermissionsClaimEnabled !== liveClaimEnabled) {
      diffs.push({
        field: `${label}.applicationPermissionsSettings.claimEnabled`,
        expected: spec.applicationPermissionsClaimEnabled,
        actual: liveClaimEnabled,
        severity: 'warning',
      })
    }

    const declaredIntrospect = spec.introspectEndpointAuthMethod || DEFAULT_INTROSPECT_AUTH_METHOD
    const liveIntrospect =
      typeof found.introspectEndpointAuthMethod === 'string' ? found.introspectEndpointAuthMethod : DEFAULT_INTROSPECT_AUTH_METHOD
    if (declaredIntrospect !== liveIntrospect) {
      diffs.push({ field: `${label}.introspectEndpointAuthMethod`, expected: declaredIntrospect, actual: liveIntrospect, severity: 'warning' })
    }

    let liveScopes: LiveScope[]
    try {
      liveScopes = await listScopes(client, found.id)
    } catch (error) {
      diffs.push({
        field: `${label}.scopes`,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'warning',
      })
      continue
    }

    const scopesParsed = parseScopesJson(spec.scopesRaw)
    const declaredScopes = (scopesParsed.ok ? scopesParsed.value ?? [] : []) as RawScopeJson[]
    const liveByKey = new Map(liveScopes.filter((s) => s.name).map((s) => [scopeKey(s.name as string), s]))
    const declaredKeys = new Set<string>()

    for (const raw of declaredScopes) {
      const name = typeof raw.name === 'string' ? raw.name.trim() : ''
      if (!name) continue
      const key = scopeKey(name)
      declaredKeys.add(key)
      const live = liveByKey.get(key)
      if (!live) {
        diffs.push({ field: `${label}.scopes.${name}`, expected: 'exists', actual: 'missing', severity: 'warning' })
        continue
      }
      const declaredBody = buildScopeBody(raw)
      const liveDescriptionScope = typeof live.description === 'string' ? live.description : ''
      if (declaredBody.description !== liveDescriptionScope) {
        diffs.push({
          field: `${label}.scopes.${name}.description`,
          expected: declaredBody.description,
          actual: liveDescriptionScope,
          severity: 'warning',
        })
      }
    }

    for (const [key, live] of liveByKey) {
      if (!declaredKeys.has(key)) {
        diffs.push({ field: `${label}.scopes.${live.name ?? key}`, expected: 'removed', actual: 'still present', severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
