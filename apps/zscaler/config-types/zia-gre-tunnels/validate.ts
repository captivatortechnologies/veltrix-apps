import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA GRE Tunnels constraints ---------------------------------------------

/** ZIA caps a GRE tunnel comment at 10240 characters. */
export const MAX_COMMENT_LENGTH = 10_240

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface GreTunnelSpec {
  sectionName: string
  /** The provisioned static source IP — the tunnel's logical identity (list + match). */
  sourceIp: string
  comment?: string
  /**
   * Raw advanced-tunnel object (gre_json). A JSON object string carrying the
   * many optional GRE fields (primaryDestVip / secondaryDestVip objects,
   * withinCountry, ipUnnumbered, …). Empty string when the author left it blank.
   */
  greJson: string
}

/** Shape of a GRE tunnel returned by GET /greTunnels. */
export interface LiveGreTunnel {
  id?: number
  sourceIp?: string
  comment?: string
  primaryDestVip?: unknown
  secondaryDestVip?: unknown
  withinCountry?: boolean
  ipUnnumbered?: boolean
}

/**
 * Result of parsing gre_json. Deliberately NOT a discriminated union: the
 * platform's handler loader compiles handlers in a mode that does not narrow
 * `{ ok: true } | { ok: false }` unions, so `value` and `error` are
 * always-present nullable fields instead (value is set on success, error on
 * failure — never both). Accessing either needs no control-flow narrowing.
 */
export interface GreObjectResult {
  value: Record<string, unknown> | null
  error: string | null
}

/**
 * Parse the advanced GRE tunnel object (gre_json), mirroring the JSON escape
 * hatch other ZIA types use. A blank value yields an empty object; a non-blank
 * value must parse to a JSON object (not an array or a scalar).
 */
export function parseGreObject(raw: string | undefined): GreObjectResult {
  const text = (raw ?? '').trim()
  if (!text) return { value: {}, error: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { value: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      value: null,
      error: 'must be a JSON object (e.g. { "primaryDestVip": { "id": 12345 }, "withinCountry": true })',
    }
  }
  return { value: parsed as Record<string, unknown>, error: null }
}

/** Each canvas item describes one ZIA GRE tunnel. */
export function extractGreTunnelSpecs(canvas: CanvasSnapshot): GreTunnelSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const comment =
      typeof fields.comment === 'string' && fields.comment.trim() ? fields.comment.trim() : undefined
    return {
      sectionName: section.name,
      sourceIp: typeof fields.source_ip === 'string' ? fields.source_ip.trim() : '',
      comment,
      greJson: typeof fields.gre_json === 'string' ? fields.gre_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate GRE tunnel configurations against ZIA constraints: a source IP is
 * required and is the tunnel's logical identity, so it must be unique across the
 * canvas (matched case-insensitively, since IPv6 literals may differ only in
 * case). The optional comment is capped at 10240 chars, and the advanced-tunnel
 * escape hatch (gre_json), when present, must parse to a JSON object.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractGreTunnelSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.sourceIp) {
      errors.push({ field: `${prefix}.source_ip`, message: 'GRE tunnel source IP is required', code: 'required' })
    } else {
      const key = spec.sourceIp.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.source_ip`,
          message: `Duplicate GRE tunnel source IP "${spec.sourceIp}" — each source IP may only be declared once per canvas`,
          code: 'duplicate_gre_tunnel',
        })
      }
      seen.add(key)
    }

    if (spec.comment && spec.comment.length > MAX_COMMENT_LENGTH) {
      errors.push({
        field: `${prefix}.comment`,
        message: `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    if (spec.greJson.trim()) {
      const parsed = parseGreObject(spec.greJson)
      if (parsed.error) {
        errors.push({
          field: `${prefix}.gre_json`,
          message: `Advanced tunnel settings (gre_json) ${parsed.error}`,
          code: 'invalid_json',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
