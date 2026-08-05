import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- OneLogin Account Brands API constraints (Branding API - Early Preview) ------
// https://developers.onelogin.com/api-docs/2/branding
//
// GET/POST       /api/2/branding/brands       - list (bare array) / create
// GET/PUT/DELETE /api/2/branding/brands/{id}  - read / partial update / delete
//
// A brand's logical identity in this config type is its NAME - OneLogin has
// no upsert, so this app matches an existing brand by name. The account's
// MASTER brand (master: true) is never created or deleted here.

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export interface BrandSpec {
  sectionName: string
  name: string
  enabled: boolean
  customColor?: string
  customAccentColor?: string
  customMaskingColor?: string
  customMaskingOpacity?: number
  enableCustomLabelForLoginScreen: boolean
  customLabelTextForLoginScreen?: string
  loginInstructionTitle?: string
  loginInstruction?: string
  hideOneloginFooter: boolean
  mfaEnrollmentMessage?: string
  customSupportEnabled: boolean
}

/** Shape of a brand returned by GET /api/2/branding/brands (list) and GET .../{id}. */
export interface LiveBrand {
  id?: number
  name?: string
  enabled?: boolean
  master?: boolean
  custom_color?: string
  custom_accent_color?: string
  custom_masking_color?: string
  custom_masking_opacity?: number
  enable_custom_label_for_login_screen?: boolean
  custom_label_text_for_login_screen?: string
  login_instruction_title?: string
  login_instruction?: string
  hide_onelogin_footer?: boolean
  mfa_enrollment_message?: string
  custom_support_enabled?: boolean
  [key: string]: unknown
}

function trimmedOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function boolWithDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Each canvas item describes one OneLogin Account Brand. */
export function extractBrandSpecs(canvas: CanvasSnapshot): BrandSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      enabled: boolWithDefault(fields.enabled, true),
      customColor: trimmedOrUndefined(fields.customColor),
      customAccentColor: trimmedOrUndefined(fields.customAccentColor),
      customMaskingColor: trimmedOrUndefined(fields.customMaskingColor),
      customMaskingOpacity: numberOrUndefined(fields.customMaskingOpacity),
      enableCustomLabelForLoginScreen: boolWithDefault(fields.enableCustomLabelForLoginScreen, false),
      customLabelTextForLoginScreen: trimmedOrUndefined(fields.customLabelTextForLoginScreen),
      loginInstructionTitle: trimmedOrUndefined(fields.loginInstructionTitle),
      loginInstruction: trimmedOrUndefined(fields.loginInstruction),
      hideOneloginFooter: boolWithDefault(fields.hideOneloginFooter, false),
      mfaEnrollmentMessage: trimmedOrUndefined(fields.mfaEnrollmentMessage),
      customSupportEnabled: boolWithDefault(fields.customSupportEnabled, false),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate brand configurations against the OneLogin Branding API. Static
 * only:
 *   - name is required and unique across the canvas
 *   - customColor/customAccentColor/customMaskingColor, when present, must
 *     be valid hex colors
 *   - customMaskingOpacity, when present, must be between 0 and 100
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractBrandSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Brand name is required', code: 'required' })
    } else if (seenNames.has(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate brand "${spec.name}" - each brand name may only be declared once per canvas`,
        code: 'duplicate_brand',
      })
    }
    if (spec.name) seenNames.add(spec.name)

    for (const [key, value] of [
      ['customColor', spec.customColor],
      ['customAccentColor', spec.customAccentColor],
      ['customMaskingColor', spec.customMaskingColor],
    ] as const) {
      if (value !== undefined && !HEX_COLOR_RE.test(value)) {
        errors.push({ field: `${prefix}.${key}`, message: `${key} must be a hex color, e.g. #1298b4`, code: 'invalid_color' })
      }
    }

    if (spec.customMaskingOpacity !== undefined && (spec.customMaskingOpacity < 0 || spec.customMaskingOpacity > 100)) {
      errors.push({
        field: `${prefix}.customMaskingOpacity`,
        message: 'Masking Opacity must be between 0 and 100',
        code: 'invalid_opacity',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
