import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/**
 * Validate Splunk license pool configurations.
 *
 * Pools are managed through /services/licenser/pools — a REST-only object
 * with no portable .conf file (unlike indexes/roles/apps, which this app
 * authors as .conf files inside a Splunk App).
 *
 * Rules:
 *   - Pool names appear in REST URLs; restricted to letters, digits,
 *     underscores, dots and hyphens (platform guardrail, matches hec-tokens).
 *   - stackId must be one of Splunk's fixed licensing stacks.
 *   - quota must be "MAX" or a number with an optional B/MB/GB/TB suffix.
 *   - peers must be "*" or a comma-separated list of peer ids.
 */

const POOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const MAX_NAME_LENGTH = 80
const QUOTA_PATTERN = /^(?:max|(\d+(?:\.\d+)?)\s*(b|mb|gb|tb)?)$/i
const PEER_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export const STACK_IDS = ['Enterprise', 'download-trial', 'Forwarder', 'Free', 'Lite', 'Lite_Free'] as const

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no license pool definitions', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const poolNames = new Set<string>()
  let maxPoolsByStack = new Map<string, string>()

  for (const section of sections) {
    const fields = section.fields || {}
    const prefix = section.name

    // --- Pool name -----------------------------------------------------------
    const name = fields.name as string | undefined
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      errors.push({ field: `${prefix}.name`, message: 'Pool name is required', code: 'required' })
    } else {
      if (!POOL_NAME_PATTERN.test(name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Pool name may contain only letters, digits, underscores, dots, and hyphens, and must start with a letter or digit',
          code: 'invalid_format',
        })
      }
      if (name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Pool name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'max_length' })
      }
      if (poolNames.has(name)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate pool name: "${name}"`, code: 'duplicate' })
      }
      poolNames.add(name)
    }

    // --- Stack -----------------------------------------------------------------
    const stackId = fields.stackId as string | undefined
    if (!stackId || typeof stackId !== 'string') {
      errors.push({ field: `${prefix}.stackId`, message: 'Licensing stack is required', code: 'required' })
    } else if (!STACK_IDS.includes(stackId as (typeof STACK_IDS)[number])) {
      errors.push({
        field: `${prefix}.stackId`,
        message: `"${stackId}" is not a known Splunk licensing stack (expected one of ${STACK_IDS.join(', ')})`,
        code: 'invalid_stack',
      })
    }

    // --- Quota -------------------------------------------------------------------
    const quota = fields.quota as string | undefined
    if (!quota || typeof quota !== 'string' || quota.trim().length === 0) {
      errors.push({ field: `${prefix}.quota`, message: 'Daily quota is required', code: 'required' })
    } else {
      const match = QUOTA_PATTERN.exec(quota.trim())
      if (!match) {
        errors.push({
          field: `${prefix}.quota`,
          message: 'Quota must be "MAX" or a number with an optional B/MB/GB/TB suffix (e.g. 500GB)',
          code: 'invalid_format',
        })
      } else if (match[1] !== undefined && Number(match[1]) <= 0) {
        errors.push({ field: `${prefix}.quota`, message: 'Quota must be a positive number', code: 'zero_quota' })
      } else if (/^max$/i.test(quota.trim()) && typeof stackId === 'string') {
        const existingMaxPool = maxPoolsByStack.get(stackId)
        if (existingMaxPool) {
          warnings.push({
            field: `${prefix}.quota`,
            message: `Pool "${existingMaxPool}" already claims MAX quota on stack "${stackId}" — Splunk generally allows only one MAX pool per stack`,
            code: 'duplicate_max_pool',
          })
        } else if (name) {
          maxPoolsByStack.set(stackId, name)
        }
      }
    }

    // --- Peers -------------------------------------------------------------------
    const peers = fields.peers as string | undefined
    if (peers !== undefined && peers !== null && typeof peers !== 'string') {
      errors.push({ field: `${prefix}.peers`, message: 'Peers must be text', code: 'invalid_type' })
    } else {
      const trimmed = (peers ?? '').trim()
      if (trimmed === '' || trimmed === '*') {
        if (trimmed === '') {
          warnings.push({
            field: `${prefix}.peers`,
            message: 'No peers assigned — no indexer can draw from this pool until peers are set (use "*" for all peers)',
            code: 'no_peers',
          })
        }
      } else {
        const ids = trimmed.split(',').map((p) => p.trim())
        for (const id of ids) {
          if (!PEER_ID_PATTERN.test(id)) {
            errors.push({
              field: `${prefix}.peers`,
              message: `"${id}" is not a valid peer id (letters, digits, underscores, hyphens)`,
              code: 'invalid_format',
            })
          }
        }
      }
    }

    // --- Append peers ------------------------------------------------------------
    const appendPeers = fields.appendPeers as boolean | undefined
    if (appendPeers !== undefined && typeof appendPeers !== 'boolean') {
      errors.push({ field: `${prefix}.appendPeers`, message: 'Append peers must be a boolean', code: 'invalid_type' })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
