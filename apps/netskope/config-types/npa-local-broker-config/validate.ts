import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope NPA local broker config constraints ----------------------------
// SINGLETON — backed by /api/v2/infrastructure/lbrokers/brokerconfig. One
// tenant-wide hostname setting applied to every local broker; there is
// nothing to key on, so exactly one canvas item is expected.

/** RFC 1123 hostname/FQDN — letters, digits, hyphens, dot-separated labels. */
const HOSTNAME_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/

export interface LocalBrokerConfigSpec {
  itemId?: string
  hostname: string
}

/** The config as returned by GET /api/v2/infrastructure/lbrokers/brokerconfig
 *  (under a {data:{...}} envelope). */
export interface LiveLocalBrokerConfig {
  hostname?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractLocalBrokerConfigSpec(canvas: CanvasSnapshot): LocalBrokerConfigSpec {
  const items = canvas.items ?? canvas.sections ?? []
  const f = items[0]?.fields ?? {}
  return { itemId: items[0]?.id, hostname: asString(f.hostname) }
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add the local broker config.', code: 'required' })
    return { valid: false, errors, warnings }
  }
  if (items.length > 1) {
    warnings.push({ field: 'items', message: 'NPA local broker config is a singleton; only the first item is applied.', code: 'singleton' })
  }

  const spec = extractLocalBrokerConfigSpec(ctx.canvas)
  if (spec.hostname && !HOSTNAME_RE.test(spec.hostname)) {
    errors.push({ field: 'items[0].hostname', message: 'Hostname must be a valid FQDN (letters, digits, hyphens, dot-separated labels)', code: 'invalid_hostname' })
  }

  return { valid: errors.length === 0, errors, warnings }
}
