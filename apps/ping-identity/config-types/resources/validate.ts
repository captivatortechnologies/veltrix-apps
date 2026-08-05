import type { PipelineContext, ValidationError, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { buildPingOneClient } from '../../lib/pingOne'
import { listResources } from './deploy'
import {
  INTROSPECT_AUTH_METHODS,
  MAX_ACCESS_TOKEN_VALIDITY_SECONDS,
  MAX_NAME_LENGTH,
  MIN_ACCESS_TOKEN_VALIDITY_SECONDS,
  extractResourceSpecs,
  findResourceByName,
  isCustomResource,
  isJsonObject,
  parseScopesJson,
  resourceKey,
  scopeKey,
  type ResourceSpec,
} from './_shared'

/** A declared audience must not collide with PingOne's own reserved identifier namespace. */
const RESERVED_AUDIENCE_SUBSTRINGS = ['pingone', 'pingidentity']

/** Bounds the worst-case latency of the live protected-resource pre-flight below. */
const MAX_LIVE_RESOURCE_CHECKS = 50

/**
 * Validate Resource + Scope items - static, no network access by default:
 *   - name required, <= 100 chars, unique across the canvas (matched
 *     case-insensitively - resources are reconciled by name)
 *   - audience, when set, must not contain "pingone" or "pingidentity"
 *   - accessTokenValiditySeconds, when set, must be an integer 300-2,592,000
 *   - introspectEndpointAuthMethod, when set, one of CLIENT_SECRET_BASIC |
 *     CLIENT_SECRET_POST | NONE
 *   - scopesJson, when non-blank, must parse to a JSON array of objects each
 *     with a required "name", unique within that resource
 *
 * When a connection is available (validate now receives the resolved
 * credential + component best-effort), a live pre-flight also flags any
 * declared name that matches a BUILT-IN (non-CUSTOM) PingOne resource - a
 * warning, not an error, since deploy still succeeds by simply leaving that
 * resource alone.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Resource.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractResourceSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    validateOne(spec, i, errors)
    if (spec.name) {
      const key = resourceKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `items[${i}].name`,
          message: `Duplicate resource name "${spec.name}" - each name may only be declared once (resources are matched by name).`,
          code: 'DUPLICATE_RESOURCE_NAME',
        })
      }
      seen.add(key)
    }
  })

  await flagProtectedResources(ctx, specs, warnings)

  return { valid: errors.length === 0, errors, warnings }
}

function validateOne(spec: ResourceSpec, i: number, errors: ValidationError[]): void {
  const prefix = `items[${i}]`

  if (!spec.name) {
    errors.push({ field: `${prefix}.name`, message: 'Resource name is required.', code: 'EMPTY_NAME' })
  } else if (spec.name.length > MAX_NAME_LENGTH) {
    errors.push({
      field: `${prefix}.name`,
      message: `Resource name must be ${MAX_NAME_LENGTH} characters or fewer.`,
      code: 'NAME_TOO_LONG',
    })
  }

  if (spec.audience) {
    const lower = spec.audience.toLowerCase()
    if (RESERVED_AUDIENCE_SUBSTRINGS.some((s) => lower.includes(s))) {
      errors.push({
        field: `${prefix}.audience`,
        message: 'Audience must not contain "pingone" or "pingidentity" - these substrings are reserved by PingOne\'s own built-in resources.',
        code: 'RESERVED_AUDIENCE',
      })
    }
  }

  if (spec.accessTokenValiditySeconds !== undefined) {
    const v = spec.accessTokenValiditySeconds
    if (!Number.isInteger(v) || v < MIN_ACCESS_TOKEN_VALIDITY_SECONDS || v > MAX_ACCESS_TOKEN_VALIDITY_SECONDS) {
      errors.push({
        field: `${prefix}.accessTokenValiditySeconds`,
        message: `Access token validity must be an integer between ${MIN_ACCESS_TOKEN_VALIDITY_SECONDS} and ${MAX_ACCESS_TOKEN_VALIDITY_SECONDS} seconds.`,
        code: 'INVALID_TOKEN_VALIDITY',
      })
    }
  }

  if (spec.introspectEndpointAuthMethod && !(INTROSPECT_AUTH_METHODS as readonly string[]).includes(spec.introspectEndpointAuthMethod)) {
    errors.push({
      field: `${prefix}.introspectEndpointAuthMethod`,
      message: `Introspection endpoint auth method must be one of ${INTROSPECT_AUTH_METHODS.join(', ')}.`,
      code: 'INVALID_INTROSPECT_AUTH_METHOD',
    })
  }

  if (!spec.scopesRaw) return
  const parsed = parseScopesJson(spec.scopesRaw)
  if (!parsed.ok) {
    errors.push({ field: `${prefix}.scopesJson`, message: 'Scopes must be a valid JSON array.', code: 'INVALID_SCOPES_JSON' })
    return
  }

  const seenScopeKeys = new Set<string>()
  ;(parsed.value ?? []).forEach((s, si) => {
    if (!isJsonObject(s)) {
      errors.push({ field: `${prefix}.scopesJson[${si}]`, message: 'Each scope must be a JSON object.', code: 'INVALID_SCOPE' })
      return
    }
    const name = typeof s.name === 'string' ? s.name.trim() : ''
    if (!name) {
      errors.push({ field: `${prefix}.scopesJson[${si}].name`, message: 'Each scope needs a "name".', code: 'EMPTY_SCOPE_NAME' })
      return
    }
    const key = scopeKey(name)
    if (seenScopeKeys.has(key)) {
      errors.push({
        field: `${prefix}.scopesJson[${si}].name`,
        message: `Duplicate scope name "${name}" within this resource.`,
        code: 'DUPLICATE_SCOPE_NAME',
      })
    }
    seenScopeKeys.add(key)
  })
}

/**
 * Live pre-flight: when a connection is available, warn on any declared name
 * that matches a live BUILT-IN (non-CUSTOM) resource - deploy will skip it
 * entirely, so the author should know up front. Skipped without a connection
 * (static-only validate). Any network/auth failure is swallowed - deploy's
 * own checks (and healthCheck) remain the source of truth.
 */
async function flagProtectedResources(
  ctx: PipelineContext,
  specs: ResourceSpec[],
  warnings: ValidationWarning[],
): Promise<void> {
  if (!ctx.credential || !ctx.component?.hostname) return
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return

  try {
    const liveResources = await listResources(built.client)
    let checked = 0
    for (const spec of specs) {
      if (!spec.name) continue
      if (checked >= MAX_LIVE_RESOURCE_CHECKS) break
      checked++
      const found = findResourceByName(liveResources, spec.name)
      if (found && !isCustomResource(found)) {
        warnings.push({
          field: 'name',
          message: `"${spec.name}" matches a built-in PingOne resource (type ${found.type ?? 'unknown'}) - it is protected: this app will never create, alter or delete it or its scopes.`,
          code: 'PROTECTED_RESOURCE',
        })
      }
    }
  } catch {
    // Unreachable / auth failure during validate - never block on it here.
  }
}
