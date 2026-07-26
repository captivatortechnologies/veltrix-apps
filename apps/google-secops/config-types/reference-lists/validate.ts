import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Google SecOps reference list constraints --------------------------------

/** referenceListId: starts with a letter, letters/digits/underscore, < 256. */
const REF_LIST_ID_RE = /^[A-Za-z][A-Za-z0-9_]{0,254}$/
export const SYNTAX_TYPES = ['plain', 'regex', 'cidr'] as const
export const MAX_ENTRY_LENGTH = 512

/** Map the canvas syntax choice to the Graph enum. */
export function mapSyntaxType(syntax: string): string {
  switch (syntax) {
    case 'regex':
      return 'REFERENCE_LIST_SYNTAX_TYPE_REGEX'
    case 'cidr':
      return 'REFERENCE_LIST_SYNTAX_TYPE_CIDR'
    default:
      return 'REFERENCE_LIST_SYNTAX_TYPE_PLAIN_TEXT_STRING'
  }
}

export interface ReferenceListSpec {
  itemId?: string
  /** name = referenceListId — the immutable identity. */
  name: string
  description: string
  /** plain | regex | cidr. */
  syntax: string
  entries: string[]
}

/** A reference list as returned by the SecOps API. */
export interface LiveReferenceList {
  name?: string
  displayName?: string
  description?: string
  syntaxType?: string
  entries?: Array<{ value?: string }>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function splitEntries(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => String(x).trim()) : asString(v).split(/\n/).map((t) => t.trim())
  return raw.filter((t) => t.length > 0)
}

export function extractReferenceListSpecs(canvas: CanvasSnapshot): ReferenceListSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      syntax: (asString(f.syntax) || 'plain').toLowerCase(),
      entries: splitEntries(f.entries),
    }
  })
}

const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractReferenceListSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (!REF_LIST_ID_RE.test(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Name must start with a letter and contain only letters, digits and underscores (max 255)',
          code: 'invalid_name',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate reference list "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(SYNTAX_TYPES as readonly string[]).includes(spec.syntax)) {
      errors.push({ field: `${prefix}.syntax`, message: `Syntax must be one of: ${SYNTAX_TYPES.join(', ')}`, code: 'invalid_syntax' })
    }

    spec.entries.forEach((e, ei) => {
      if (e.length > MAX_ENTRY_LENGTH) {
        errors.push({ field: `${prefix}.entries[${ei}]`, message: `Each entry must be ${MAX_ENTRY_LENGTH} characters or fewer`, code: 'entry_too_long' })
      }
      if (spec.syntax === 'cidr' && !IPV4_CIDR.test(e)) {
        errors.push({ field: `${prefix}.entries[${ei}]`, message: `"${e}" is not a valid IPv4 CIDR`, code: 'invalid_cidr' })
      }
    })

    if (spec.entries.length === 0) {
      warnings.push({ field: `${prefix}.entries`, message: 'This reference list is empty', code: 'empty_list' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
