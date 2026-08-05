import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractFirewallPolicySpecs, parseNetworkRules } from './_shared'

/**
 * Validate firewall-policy items: a non-empty unique name, and well-formed
 * inbound/outbound network-rule JSON (see _shared.ts's parseNetworkRules).
 * Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractFirewallPolicySpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one firewall policy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    if (!spec.name) {
      errors.push({ field: `items[${i}].name`, message: 'Policy name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > 128) {
      errors.push({ field: `items[${i}].name`, message: 'Policy name must be 128 characters or fewer.', code: 'NAME_TOO_LONG' })
    } else if (seen.has(spec.name)) {
      warnings.push({ field: `items[${i}].name`, message: `Policy name "${spec.name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(spec.name)
    }

    const inbound = parseNetworkRules(spec.inboundNetworksJson)
    if (inbound.error) {
      errors.push({ field: `items[${i}].inboundNetworksJson`, message: `Inbound rules JSON ${inbound.error}.`, code: 'INVALID_INBOUND_JSON' })
    }
    const outbound = parseNetworkRules(spec.outboundNetworksJson)
    if (outbound.error) {
      errors.push({ field: `items[${i}].outboundNetworksJson`, message: `Outbound rules JSON ${outbound.error}.`, code: 'INVALID_OUTBOUND_JSON' })
    }

    if (!inbound.error && !outbound.error && inbound.rules.length === 0 && outbound.rules.length === 0 && !spec.blockIcmpPing && !spec.blockMetadataService) {
      warnings.push({ field: `items[${i}]`, message: 'This policy has no rules and no baseline protections enabled — it will have no effect.', code: 'NO_OP_POLICY' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
