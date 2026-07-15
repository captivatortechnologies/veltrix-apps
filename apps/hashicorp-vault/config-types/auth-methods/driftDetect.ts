import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient } from '../../lib/vault'
import { authKey, listAuthMethods, readAuthTune } from './deploy'
import { extractAuthMethodSpecs } from './validate'

/**
 * Detect drift between the deployed auth-method configuration and the live
 * cluster. Reads GET /sys/auth (type/existence) and, per method, GET
 * /sys/auth/{path}/tune (TTLs, token type, listing visibility, description).
 *   - type is IMMUTABLE, so a mismatch is critical (and unfixable in place)
 *   - tune fields are converged, so a mismatch is a warning
 * TTLs are compared in seconds — Vault echoes tune TTLs as a seconds number
 * while the canvas may hold "768h", so both sides are normalized first.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractAuthMethodSpecs(ctx.deployedConfig).filter((s) => s.path && s.type)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let liveMap: Record<string, { type?: string }>
  try {
    liveMap = await listAuthMethods(client)
  } catch (error) {
    // Can't list — surface every managed path as unreachable rather than absent.
    for (const spec of specs) {
      diffs.push({
        field: spec.path,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
    return { hasDrift: diffs.length > 0, diffs }
  }

  for (const spec of specs) {
    try {
      const entry = liveMap[authKey(spec.path)]

      if (!entry) {
        diffs.push({ field: spec.path, expected: 'enabled', actual: 'missing', severity: 'critical' })
        continue
      }

      // type — immutable; a mismatch means it is a different method entirely, so
      // comparing its tuning is meaningless. Flag critical and move on.
      if ((entry.type ?? '') !== spec.type) {
        diffs.push({
          field: `${spec.path}.type`,
          expected: spec.type,
          actual: entry.type ?? 'not set',
          severity: 'critical',
        })
        continue
      }

      const tune = await readAuthTune(client, spec.path)

      // default_lease_ttl / max_lease_ttl — compare in seconds, only when the
      // canvas manages the value (an unset canvas TTL is "inherit", not drift).
      if (spec.defaultLeaseTtl) {
        const expected = ttlToSeconds(spec.defaultLeaseTtl)
        const actual = toSeconds(tune?.default_lease_ttl)
        if (expected !== null && expected !== actual) {
          diffs.push({
            field: `${spec.path}.defaultLeaseTtl`,
            expected: `${expected}s`,
            actual: actual !== null ? `${actual}s` : 'not set',
            severity: 'warning',
          })
        }
      }
      if (spec.maxLeaseTtl) {
        const expected = ttlToSeconds(spec.maxLeaseTtl)
        const actual = toSeconds(tune?.max_lease_ttl)
        if (expected !== null && expected !== actual) {
          diffs.push({
            field: `${spec.path}.maxLeaseTtl`,
            expected: `${expected}s`,
            actual: actual !== null ? `${actual}s` : 'not set',
            severity: 'warning',
          })
        }
      }

      // token_type — only when the canvas sets it.
      if (spec.tokenType && (tune?.token_type ?? '') !== spec.tokenType) {
        diffs.push({
          field: `${spec.path}.tokenType`,
          expected: spec.tokenType,
          actual: tune?.token_type || 'not set',
          severity: 'warning',
        })
      }

      // listing_visibility — only when the canvas sets it.
      if (spec.listingVisibility && (tune?.listing_visibility ?? '') !== spec.listingVisibility) {
        diffs.push({
          field: `${spec.path}.listingVisibility`,
          expected: spec.listingVisibility,
          actual: tune?.listing_visibility || 'not set',
          severity: 'warning',
        })
      }

      // description — always converged on tune, so always compared.
      const liveDescription = (typeof tune?.description === 'string' ? tune.description : '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.path}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'warning',
        })
      }
    } catch (error) {
      diffs.push({
        field: spec.path,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Coerce a live tune value (a seconds number, or a duration string) to seconds. */
function toSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) return ttlToSeconds(value.trim())
  return null
}

/**
 * Parse a Vault duration ("768h", "30m", "1h30m", "7d") or a plain seconds count
 * into a number of seconds. Returns null when the string is not a duration.
 */
function ttlToSeconds(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)

  const token = /(\d+)(d|h|m|s)/g
  let match: RegExpExecArray | null
  let total = 0
  let matched = false
  while ((match = token.exec(s)) !== null) {
    matched = true
    const n = Number(match[1])
    switch (match[2]) {
      case 'd':
        total += n * 86400
        break
      case 'h':
        total += n * 3600
        break
      case 'm':
        total += n * 60
        break
      default:
        total += n
    }
  }
  if (!matched) return null
  // Reject stray characters that are not part of a duration token.
  if (s.replace(/(\d+)(d|h|m|s)/g, '').trim() !== '') return null
  return total
}
