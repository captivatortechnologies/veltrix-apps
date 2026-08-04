import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseServersRaw, readDataCenterFields } from './_shared'

/**
 * Validate data center items: a numeric Site ID, a non-empty name (≤255 chars),
 * and at least one origin server with a plausible address. Static — no target
 * access required. The name is the identity WITHIN a site (a duplicate is
 * flagged); a server address is the identity WITHIN a data center (a duplicate
 * within the same item is flagged).
 */
const SITE_ID_RE = /^[0-9]+$/
const ADDRESS_RE = /^[0-9a-zA-Z.\-:]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one data center.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const f = readDataCenterFields(item.fields)
    const p = (field: string) => `items[${i}].${field}`

    if (!f.siteId) {
      errors.push({ field: p('siteId'), message: 'Site ID is required.', code: 'EMPTY_SITE_ID' })
    } else if (!SITE_ID_RE.test(f.siteId)) {
      errors.push({ field: p('siteId'), message: `Site ID "${f.siteId}" must be numeric.`, code: 'INVALID_SITE_ID' })
    }

    if (!f.name) {
      errors.push({ field: p('name'), message: 'Data center name is required.', code: 'EMPTY_NAME' })
    } else if (f.name.length > 255) {
      errors.push({ field: p('name'), message: 'Data center name must be 255 characters or fewer.', code: 'NAME_TOO_LONG' })
    } else if (f.siteId) {
      const key = `${f.siteId}::${f.name.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({ field: p('name'), message: `Data center "${f.name}" is listed more than once for site ${f.siteId}; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    const rawServers = parseServersRaw(item.fields.servers)
    if (rawServers.length === 0) {
      errors.push({ field: p('servers'), message: 'At least one origin server is required — the first server is created together with the data center.', code: 'EMPTY_SERVERS' })
    } else {
      const addresses = new Set<string>()
      rawServers.forEach((server, si) => {
        const sp = `${p('servers')}[${si}]`
        if (!server.address) {
          errors.push({ field: sp, message: 'Each server needs an address (IP or hostname).', code: 'EMPTY_SERVER_ADDRESS' })
        } else if (!ADDRESS_RE.test(server.address)) {
          warnings.push({ field: sp, message: `"${server.address}" does not look like an IP or hostname.`, code: 'SUSPICIOUS_ADDRESS' })
        }
        const key = server.address.toLowerCase()
        if (key) {
          if (addresses.has(key)) {
            errors.push({ field: sp, message: `Server address "${server.address}" is listed more than once in this data center.`, code: 'DUPLICATE_SERVER_ADDRESS' })
          } else {
            addresses.add(key)
          }
        }
      })
      if (rawServers.length > 0 && rawServers.every((s) => !s.isEnabled)) {
        warnings.push({ field: p('servers'), message: `Every server in "${f.name || i}" is disabled — the data center will have no active origin.`, code: 'ALL_SERVERS_DISABLED' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
