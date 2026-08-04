import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { SIGN_ALGORITHMS, ZONE_TYPES, normalizeZoneType, parseAdvanced, parseStringList } from './_shared'

/**
 * Validate DNS Zone items: a non-empty zone name (≤255 chars), a known type
 * (PRIMARY/SECONDARY/ALIAS), a contract id, masters required for SECONDARY,
 * a target required for ALIAS, a known signing algorithm when DNSSEC is
 * enabled, and well-formed `advanced` JSON. Static — no target access
 * required. The zone name is the identity, so a duplicate is flagged.
 */

// Loose hostname/domain check: labels of letters/digits/hyphens, dot-separated.
const ZONE_RE = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+\.?$/
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const IPV6_RE = /^[0-9a-fA-F:]+$/

function isValidMaster(value: string): boolean {
  const m = IPV4_RE.exec(value)
  if (m) return [m[1], m[2], m[3], m[4]].every((o) => Number(o) <= 255)
  return value.includes(':') && IPV6_RE.test(value)
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one DNS zone.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const zone = String(item.fields.zone ?? '').trim().toLowerCase()
    const rawType = String(item.fields.type ?? '').trim().toUpperCase()
    const type = normalizeZoneType(item.fields.type)
    const contractId = String(item.fields.contractId ?? '').trim()

    if (!zone) {
      errors.push({ field: `items[${i}].zone`, message: 'Zone name is required.', code: 'EMPTY_ZONE' })
    } else if (zone.length > 255) {
      errors.push({ field: `items[${i}].zone`, message: 'Zone name must be 255 characters or fewer.', code: 'ZONE_TOO_LONG' })
    } else if (!ZONE_RE.test(zone)) {
      errors.push({ field: `items[${i}].zone`, message: `"${zone}" is not a valid domain zone (e.g. example.com).`, code: 'INVALID_ZONE' })
    } else if (seen.has(zone)) {
      warnings.push({ field: `items[${i}].zone`, message: `Zone "${zone}" is listed more than once; the last one wins.`, code: 'DUPLICATE_ZONE' })
    } else {
      seen.add(zone)
    }

    if (!ZONE_TYPES.has(rawType)) {
      errors.push({ field: `items[${i}].type`, message: `Type must be PRIMARY, SECONDARY or ALIAS (got "${rawType || '(empty)'}").`, code: 'INVALID_TYPE' })
    }

    if (!contractId) {
      errors.push({ field: `items[${i}].contractId`, message: 'Contract ID is required to create or update a zone.', code: 'EMPTY_CONTRACT' })
    }

    if (type === 'SECONDARY') {
      const masters = parseStringList(item.fields.masters)
      if (masters.length === 0) {
        errors.push({ field: `items[${i}].masters`, message: 'SECONDARY zones require at least one master name server IP.', code: 'EMPTY_MASTERS' })
      }
      masters.forEach((m, j) => {
        if (!isValidMaster(m)) {
          errors.push({ field: `items[${i}].masters[${j}]`, message: `Master "${m}" is not a valid IP address.`, code: 'INVALID_MASTER' })
        }
      })
    }

    if (type === 'ALIAS' && !String(item.fields.target ?? '').trim()) {
      errors.push({ field: `items[${i}].target`, message: 'ALIAS zones require a target zone.', code: 'EMPTY_TARGET' })
    }

    if (item.fields.signAndServe === true) {
      const algo = String(item.fields.signAndServeAlgorithm ?? '').trim().toUpperCase()
      if (!SIGN_ALGORITHMS.has(algo)) {
        errors.push({ field: `items[${i}].signAndServeAlgorithm`, message: `"${algo || '(empty)'}" is not a supported DNSSEC signing algorithm.`, code: 'INVALID_ALGORITHM' })
      }
    }

    try {
      parseAdvanced(item.fields.advanced)
    } catch (error) {
      errors.push({ field: `items[${i}].advanced`, message: error instanceof Error ? error.message : 'Invalid advanced options.', code: 'INVALID_ADVANCED_JSON' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
