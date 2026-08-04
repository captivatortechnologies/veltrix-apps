import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { RUBRIK_TIMEZONES, normalizeText, toStringArray } from './_shared'

/**
 * Validate the Global Cluster Settings singleton: exactly one item, a required
 * timezone drawn from Rubrik's supported enum, and a sane cluster-name length.
 * Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add the cluster settings.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }
  if (items.length > 1) {
    errors.push({ field: 'items', message: 'Global Cluster Settings is a cluster singleton — declare exactly one item.', code: 'SINGLETON' })
  }

  items.forEach((item, i) => {
    const timezone = normalizeText(item.fields.timezone)
    if (!timezone) {
      errors.push({ field: `items[${i}].timezone`, message: 'Timezone is required.', code: 'EMPTY_TIMEZONE' })
    } else if (!(RUBRIK_TIMEZONES as readonly string[]).includes(timezone)) {
      errors.push({
        field: `items[${i}].timezone`,
        message: `Timezone "${timezone}" is not one of Rubrik's supported zones.`,
        code: 'INVALID_TIMEZONE',
      })
    }

    const clusterName = normalizeText(item.fields.clusterName)
    if (clusterName.length > 128) {
      errors.push({ field: `items[${i}].clusterName`, message: 'Cluster name must be 128 characters or fewer.', code: 'NAME_TOO_LONG' })
    }

    const dnsServers = toStringArray(item.fields.dnsServers)
    const ntpServers = toStringArray(item.fields.ntpServers)
    const location = normalizeText(item.fields.location)
    const loginBanner = normalizeText(item.fields.loginBanner)
    if (!clusterName && dnsServers.length === 0 && ntpServers.length === 0 && !location && !loginBanner) {
      warnings.push({
        field: `items[${i}]`,
        message: 'Only the timezone is set — deploying will clear any DNS/NTP servers, name, location or login banner not managed here.',
        code: 'MOSTLY_EMPTY',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
