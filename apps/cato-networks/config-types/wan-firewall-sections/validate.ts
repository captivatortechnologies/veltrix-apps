import type { CanvasSnapshot, PipelineContext, ValidationError, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { items, type SectionPosition } from '../lib/catoPolicy'
import type { SectionSpec } from '../lib/catoSectionPipeline'

const VALID_POSITIONS: SectionPosition[] = ['LAST_IN_POLICY', 'BEFORE_SECTION', 'AFTER_SECTION']

export interface WanFirewallSectionSpec extends SectionSpec {
  itemId?: string
}

/** Extract one WAN Firewall section spec per canvas item. */
export function extractSectionSpecs(canvas: CanvasSnapshot): WanFirewallSectionSpec[] {
  return items(canvas).map((item) => {
    const fields = item.fields ?? {}
    const position = (typeof fields.position === 'string' ? fields.position : 'LAST_IN_POLICY') as SectionPosition
    return {
      itemId: item.id,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      position: VALID_POSITIONS.includes(position) ? position : 'LAST_IN_POLICY',
      positionSectionName: typeof fields.positionSectionName === 'string' ? fields.positionSectionName.trim() : undefined,
    }
  })
}

/**
 * Validate WAN Firewall section items. Static only - no target access:
 *   - name is required, <= 255 chars, and unique within the canvas
 *   - positionSectionName is required when position is BEFORE_SECTION/AFTER_SECTION
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractSectionSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Section name is required.', code: 'EMPTY_NAME' })
      return
    }
    if (spec.name.length > 255) {
      errors.push({ field: `${prefix}.name`, message: 'Section name must be 255 characters or fewer.', code: 'MAX_LENGTH' })
    }
    const key = spec.name.toLowerCase()
    if (seen.has(key)) {
      errors.push({ field: `${prefix}.name`, message: `Duplicate section "${spec.name}" - each section may only be declared once.`, code: 'DUPLICATE_NAME' })
    }
    seen.add(key)

    if ((spec.position === 'BEFORE_SECTION' || spec.position === 'AFTER_SECTION') && !spec.positionSectionName) {
      errors.push({
        field: `${prefix}.positionSectionName`,
        message: 'Relative To Section is required when Position is "Before another section" or "After another section".',
        code: 'MISSING_POSITION_REF',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
