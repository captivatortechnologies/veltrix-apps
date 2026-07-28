import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList } from '../../lib/falcon'

// --- Flight Control (MSSP) CID Group API constraints -------------------------

export const MAX_GROUP_NAME_LENGTH = 255

/** A CrowdStrike customer ID (CID) is a 32-character hexadecimal string. */
const CID_RE = /^[a-f0-9]{32}$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface CidGroupSpec {
  sectionName: string
  name: string
  description?: string
  /** Member child CIDs, normalized lowercase and de-duplicated. */
  cids: string[]
}

/** A live CID group as returned by GET /mssp/entities/cid-groups/v2. */
export interface LiveCidGroup {
  /** The group's own id — the value used as `cid_group_id` in member/role bodies. */
  id?: string
  cid_group_id?: string
  name?: string
  description?: string
  cids?: string[]
  /** Modifier fields for drift attribution — MSSP entities may not expose these. */
  modified_by?: string
  modified_timestamp?: string
  modified_on?: string
}

/** Lowercase and de-duplicate member CIDs so identity comparisons are stable. */
export function normalizeCids(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const cid = raw.trim().toLowerCase()
    if (cid && !seen.has(cid)) {
      seen.add(cid)
      out.push(cid)
    }
  }
  return out
}

export function isValidCid(cid: string): boolean {
  return CID_RE.test(cid)
}

/** Each canvas section describes one CID group. */
export function extractCidGroupSpecs(canvas: CanvasSnapshot): CidGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description:
        typeof fields.description === 'string' && fields.description.trim()
          ? fields.description.trim()
          : undefined,
      cids: normalizeCids(splitList(fields.cids)),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate MSSP CID group configurations against the Flight Control API:
 * a required unique name within length limits and well-formed member CIDs.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractCidGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name (identity)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'CID group name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_GROUP_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `CID group name must be ${MAX_GROUP_NAME_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate CID group "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    // member CIDs
    for (const cid of spec.cids) {
      if (!isValidCid(cid)) {
        errors.push({
          field: `${prefix}.cids`,
          message: `"${cid}" is not a valid CID — expected 32 hexadecimal characters`,
          code: 'invalid_cid',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
