import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Prisma Cloud collection constraints -------------------------------------

export const MAX_NAME_LENGTH = 255
export const MAX_DESC_LENGTH = 2000

export interface CollectionAssetGroups {
  accountGroupIds: string[]
  accountIds: string[]
  repositoryIds: string[]
}

export interface CollectionSpec {
  itemId?: string
  /** name — the identity (Prisma matches collections by name). */
  name: string
  description: string
  assetGroups: CollectionAssetGroups
}

/** A collection as returned by GET /entitlement/api/v1/collection. */
export interface LiveCollection {
  id?: string
  name?: string
  description?: string | null
  assetGroups?: Partial<CollectionAssetGroups>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function splitIds(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => String(x).trim()) : asString(v).split(/[\n,]/).map((t) => t.trim())
  return [...new Set(raw.filter((t) => t.length > 0))]
}

export function extractCollectionSpecs(canvas: CanvasSnapshot): CollectionSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      assetGroups: {
        accountGroupIds: splitIds(f.accountGroupIds),
        accountIds: splitIds(f.accountIds),
        repositoryIds: splitIds(f.repositoryIds),
      },
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractCollectionSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate collection "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.description.length > MAX_DESC_LENGTH) {
      errors.push({ field: `${prefix}.description`, message: `Description must be ${MAX_DESC_LENGTH} characters or fewer`, code: 'too_long' })
    }

    const ag = spec.assetGroups
    if (ag.accountGroupIds.length === 0 && ag.accountIds.length === 0 && ag.repositoryIds.length === 0) {
      errors.push({ field: `${prefix}.assetGroups`, message: 'A collection must scope at least one account group, cloud account or repository', code: 'empty_asset_groups' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
