import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { checkXml, hasOssecConfigRoot } from './_shared'

/**
 * Validate the Manager-Configuration singleton: a non-empty body that looks
 * like well-formed XML, warning (not erroring) when the root element isn't the
 * documented `<ossec_config>`. More than one item is a warning (only the first
 * is applied). Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add the Manager Configuration item.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  if (items.length > 1) {
    warnings.push({ field: 'items', message: 'Only the first Manager Configuration item is applied — this is a manager-wide singleton.', code: 'SINGLETON_EXCESS' })
  }

  const ossecConfXml = String(items[0].fields.ossecConfXml ?? '').trim()

  if (!ossecConfXml) {
    errors.push({ field: 'items[0].ossecConfXml', message: 'ossec.conf body is required.', code: 'EMPTY_XML' })
  } else {
    const xml = checkXml(ossecConfXml)
    if (!xml.valid) {
      warnings.push({ field: 'items[0].ossecConfXml', message: `Configuration body may not be well-formed XML (${xml.reason}).`, code: 'MALFORMED_XML' })
    } else if (!hasOssecConfigRoot(ossecConfXml)) {
      warnings.push({ field: 'items[0].ossecConfXml', message: 'Root element is not <ossec_config> — Wazuh may reject this file.', code: 'UNEXPECTED_ROOT' })
    }
    warnings.push({
      field: 'items[0].ossecConfXml',
      message: 'This REPLACES the entire manager configuration file. Any section not included here is removed from the live manager.',
      code: 'WHOLE_FILE_REPLACE',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}
