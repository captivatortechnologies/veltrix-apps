import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { objectKey, strList } from '../lib/checkpointShared'

// --- Shared types --------------------------------------------------------------

export interface ApplicationSiteSpec {
  itemId?: string
  /** name — the identity Check Point application-site objects are matched on. */
  name: string
  /** URL / domain patterns this custom app matches, e.g. "*.example.com". */
  urlList: string[]
  urlsDefinedAsRegex: boolean
  primaryCategory: string
  description: string
  comments: string
  color: string
  tags: string[]
}

/** An application-site object as returned by show-application-site(s). */
export interface LiveApplicationSite {
  uid?: string
  name?: string
  'url-list'?: string[]
  'urls-defined-as-regular-expression'?: boolean
  'primary-category'?: string | { name?: string }
  description?: string
  comments?: string
  color?: string
  tags?: Array<string | { name?: string }>
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export const applicationSiteKey = objectKey

export function extractApplicationSiteSpecs(canvas: CanvasSnapshot): ApplicationSiteSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      urlList: strList(f.urlList),
      urlsDefinedAsRegex: asBool(f.urlsDefinedAsRegex, false),
      primaryCategory: asString(f.primaryCategory),
      description: asString(f.description),
      comments: asString(f.comments),
      color: asString(f.color),
      tags: strList(f.tags),
    }
  })
}

/** The live site's primary-category name, whichever shape it comes back as. */
export function livePrimaryCategoryName(value: LiveApplicationSite['primary-category']): string {
  if (!value) return ''
  return typeof value === 'string' ? value : (value.name ?? '')
}

// --- Validate handler -----------------------------------------------------------

/**
 * Validate Check Point custom application-site configurations: a name is
 * required and unique across the canvas (case-insensitive); at least one URL
 * pattern is required — this config type identifies traffic by URL/domain
 * match only (see README: application-signature-based matching is not
 * modeled).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractApplicationSiteSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = applicationSiteKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate application site "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    if (spec.urlList.length === 0) {
      errors.push({
        field: `${prefix}.urlList`,
        message: 'At least one URL/domain pattern is required (e.g. *.example.com)',
        code: 'required',
      })
    }
    if (spec.urlList.some((u) => u.length === 0)) {
      errors.push({ field: `${prefix}.urlList`, message: 'URL patterns must not contain empty values', code: 'invalid_url' })
    }
    if (spec.tags.some((t) => t.length === 0)) {
      errors.push({ field: `${prefix}.tags`, message: 'Tags must not contain empty values', code: 'invalid_tag' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
