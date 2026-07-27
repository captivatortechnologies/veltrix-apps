import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- IBM QRadar calculated custom event property constraints -----------------

export const OPERATORS = ['ADD', 'SUBTRACT', 'MULTIPLY', 'DIVIDE'] as const
export const OPERAND_TYPES = ['STATIC', 'PROPERTY'] as const

export interface Operand {
  /** STATIC (numeric_value) or PROPERTY (property_name). */
  type: string
  /** the literal (STATIC) or referenced property name (PROPERTY). */
  value: string
}

export interface CalculatedPropertySpec {
  itemId?: string
  /** name — the calculated property's natural identity. */
  name: string
  description: string
  enabled: boolean
  operator: string
  firstOperand: Operand
  secondOperand: Operand
}

/** An operand as returned by the API. */
export interface LiveOperand {
  type?: string
  numeric_value?: number
  property_name?: string
}

/** A calculated property as returned by GET .../calculated_properties. */
export interface LiveCalculatedProperty {
  id?: number
  name?: string
  description?: string
  enabled?: boolean
  operator?: string
  first_operand?: LiveOperand
  second_operand?: LiveOperand
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function readOperand(type: unknown, value: unknown): Operand {
  return { type: (asString(type) || 'PROPERTY').toUpperCase(), value: asString(value) }
}

export function extractCalculatedPropertySpecs(canvas: CanvasSnapshot): CalculatedPropertySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      enabled: f.enabled !== false,
      operator: (asString(f.operator) || 'ADD').toUpperCase(),
      firstOperand: readOperand(f.firstOperandType, f.firstOperandValue),
      secondOperand: readOperand(f.secondOperandType, f.secondOperandValue),
    }
  })
}

function validateOperand(errors: ValidationResult['errors'], prefix: string, op: Operand): void {
  if (!(OPERAND_TYPES as readonly string[]).includes(op.type)) {
    errors.push({ field: `${prefix}.type`, message: `Operand type must be one of: ${OPERAND_TYPES.join(', ')}`, code: 'invalid_operand_type' })
    return
  }
  if (op.type === 'STATIC') {
    if (!/^-?\d+(\.\d+)?$/.test(op.value)) errors.push({ field: `${prefix}.value`, message: 'A STATIC operand needs a numeric value', code: 'invalid_operand_value' })
  } else if (!op.value) {
    errors.push({ field: `${prefix}.value`, message: 'A PROPERTY operand needs a property name', code: 'required' })
  }
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractCalculatedPropertySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate calculated property "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(OPERATORS as readonly string[]).includes(spec.operator)) {
      errors.push({ field: `${prefix}.operator`, message: `Operator must be one of: ${OPERATORS.join(', ')}`, code: 'invalid_operator' })
    }

    validateOperand(errors, `${prefix}.firstOperand`, spec.firstOperand)
    validateOperand(errors, `${prefix}.secondOperand`, spec.secondOperand)
  })

  return { valid: errors.length === 0, errors, warnings }
}
