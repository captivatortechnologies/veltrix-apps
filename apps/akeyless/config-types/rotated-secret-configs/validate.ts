import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { toStringList } from '../../lib/akeyless'

// --- Akeyless Rotated Secrets API constraints ----------------------------------
// https://docs.akeyless.io
//   POST /rotated-secret-create-postgresql|aws
//   POST /rotated-secret-update-postgresql|aws
//   POST /rotated-secret-delete, /rotated-secret-list
// Identity is the config's NAME; TYPE is fixed at creation (immutable).
// There is NO plain "get" endpoint for a rotated secret's configuration -
// see canvas.yaml header for the drift-detection implication.

export const ROTATED_SECRET_TYPES = ['postgresql', 'aws'] as const
export type RotatedSecretType = (typeof ROTATED_SECRET_TYPES)[number]
export const ROTATOR_TYPES_BY_SECRET_TYPE: Record<RotatedSecretType, string[]> = {
  postgresql: ['target', 'password'],
  aws: ['target', 'api-key'],
}

export interface RotatedSecretSpec {
  sectionName: string
  name: string
  type: RotatedSecretType | ''
  targetName: string
  description: string
  deleteProtection: boolean
  rotatorType: string
  authenticationCredentials: string
  autoRotate: boolean
  rotationInterval: string
  rotationHour: string
  passwordLength: string
  rotateAfterDisconnect: boolean
  rotationEventIn: string[]
  tags: string[]
  itemCustomFields: Record<string, string>
  // postgresql
  rotatedUsername: string
  // aws
  apiId: string
  awsRegion: string
  graceRotation: boolean
  graceRotationHour: string
  graceRotationInterval: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}
function bool(v: unknown): boolean {
  return v === true || v === 'true'
}
function keyValue(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = str(val)
  return out
}

/** Each canvas item describes one Akeyless rotated secret config. */
export function extractRotatedSecretSpecs(canvas: CanvasSnapshot): RotatedSecretSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const f = (section.fields ?? {}) as Record<string, unknown>
    return {
      sectionName: section.name,
      name: str(f.name),
      type: (ROTATED_SECRET_TYPES as readonly string[]).includes(str(f.type)) ? (str(f.type) as RotatedSecretType) : '',
      targetName: str(f.targetName),
      description: str(f.description),
      deleteProtection: bool(f.deleteProtection),
      rotatorType: str(f.rotatorType),
      authenticationCredentials: str(f.authenticationCredentials) || 'use-self-creds',
      autoRotate: bool(f.autoRotate),
      rotationInterval: str(f.rotationInterval),
      rotationHour: str(f.rotationHour),
      passwordLength: str(f.passwordLength),
      rotateAfterDisconnect: bool(f.rotateAfterDisconnect),
      rotationEventIn: toStringList(f.rotationEventIn),
      tags: toStringList(f.tags),
      itemCustomFields: keyValue(f.itemCustomFields),
      rotatedUsername: str(f.rotatedUsername),
      apiId: str(f.apiId),
      awsRegion: str(f.awsRegion),
      graceRotation: bool(f.graceRotation),
      graceRotationHour: str(f.graceRotationHour),
      graceRotationInterval: str(f.graceRotationInterval),
    }
  })
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRotatedSecretSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else if (seenNames.has(spec.name)) {
      errors.push({ field: `${prefix}.name`, message: `Duplicate rotated secret config "${spec.name}"`, code: 'duplicate_name' })
    }
    if (spec.name) seenNames.add(spec.name)

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: `Type is required and must be one of: ${ROTATED_SECRET_TYPES.join(', ')}`, code: 'required' })
      continue
    }

    if (!spec.targetName) {
      errors.push({ field: `${prefix}.targetName`, message: 'Target Name is required for every rotated secret config', code: 'required' })
    }

    if (!spec.rotatorType) {
      errors.push({ field: `${prefix}.rotatorType`, message: 'Rotator Type is required', code: 'required' })
    } else if (!ROTATOR_TYPES_BY_SECRET_TYPE[spec.type].includes(spec.rotatorType)) {
      errors.push({
        field: `${prefix}.rotatorType`,
        message: `Rotator Type "${spec.rotatorType}" is not valid for Type "${spec.type}" (allowed: ${ROTATOR_TYPES_BY_SECRET_TYPE[spec.type].join(', ')})`,
        code: 'invalid_value',
      })
    }

    if (spec.autoRotate && spec.rotationInterval) {
      const days = Number(spec.rotationInterval)
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        errors.push({ field: `${prefix}.rotationInterval`, message: 'Rotation Interval must be a whole number of days between 1 and 365', code: 'invalid_value' })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
