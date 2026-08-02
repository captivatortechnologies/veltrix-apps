import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { isValidIp, looksLikeInterfaceToken } from '../lib/pfsenseShared'
import { VIP_MODES, MAX_DESCRIPTION_LENGTH, isValidVipSubnet, specFromItem, vipKey } from './_shared'

/**
 * Validate virtual-IP items against pfSense's own rules (schema-only, no
 * live API calls — see lib/pfsenseApi.ts's module doc):
 *   - mode/interface/subnet/subnet_bits required
 *   - subnet must be a valid IP; subnet_bits 1-128, and <=32 for an IPv4 subnet
 *     (mirrors VirtualIP::validate_subnet_bits())
 *   - `type: network` is rejected for ipalias/carp modes (mirrors validate_type())
 *   - CARP mode requires vhid (1-255) and a password; ucast CARP additionally
 *     requires a valid carp_peer IP
 *   - subnet (identity) must be unique per canvas
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one virtual IP.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  items.forEach((item, i) => {
    const spec = specFromItem(item)
    const prefix = `items[${i}]`

    if (!spec.mode) {
      errors.push({ field: `${prefix}.mode`, message: `Mode is required and must be one of: ${VIP_MODES.join(', ')}.`, code: 'INVALID_MODE' })
    }

    if (!spec.interface) {
      errors.push({ field: `${prefix}.interface`, message: 'Interface is required.', code: 'EMPTY_INTERFACE' })
    } else if (!looksLikeInterfaceToken(spec.interface)) {
      errors.push({ field: `${prefix}.interface`, message: `"${spec.interface}" is not a valid interface value.`, code: 'INVALID_INTERFACE' })
    }

    if ((spec.mode === 'ipalias' || spec.mode === 'carp') && spec.type === 'network') {
      errors.push({
        field: `${prefix}.type`,
        message: '"Network" scope is not valid when Mode is IP Alias or CARP — only Proxy ARP and Other support it.',
        code: 'NETWORK_TYPE_NOT_SUPPORTED',
      })
    }

    if (!spec.subnet) {
      errors.push({ field: `${prefix}.subnet`, message: 'Subnet (Address) is required.', code: 'EMPTY_SUBNET' })
    } else if (!isValidVipSubnet(spec.subnet)) {
      errors.push({ field: `${prefix}.subnet`, message: `"${spec.subnet}" is not a valid IPv4/IPv6 address.`, code: 'INVALID_SUBNET' })
    } else {
      const key = vipKey(spec.subnet)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.subnet`, message: `Duplicate subnet "${spec.subnet}" — each virtual IP address may only be declared once per canvas.`, code: 'DUPLICATE_SUBNET' })
      }
      seen.add(key)
    }

    if (spec.subnetBits === null) {
      errors.push({ field: `${prefix}.subnet_bits`, message: 'Subnet Bits is required.', code: 'EMPTY_SUBNET_BITS' })
    } else if (spec.subnetBits < 1 || spec.subnetBits > 128) {
      errors.push({ field: `${prefix}.subnet_bits`, message: 'Subnet Bits must be between 1 and 128.', code: 'INVALID_SUBNET_BITS' })
    } else if (spec.subnet && isValidIp(spec.subnet) && !spec.subnet.includes(':') && spec.subnetBits > 32) {
      errors.push({ field: `${prefix}.subnet_bits`, message: 'Subnet Bits cannot exceed 32 for an IPv4 subnet.', code: 'IPV4_SUBNET_BITS_EXCEEDED' })
    }

    if (spec.mode === 'carp') {
      if (spec.vhid === null) {
        errors.push({ field: `${prefix}.vhid`, message: 'VHID Group is required for CARP mode.', code: 'EMPTY_VHID' })
      } else if (spec.vhid < 1 || spec.vhid > 255) {
        errors.push({ field: `${prefix}.vhid`, message: 'VHID Group must be between 1 and 255.', code: 'INVALID_VHID' })
      }
      if (spec.advbase < 1 || spec.advbase > 254) {
        errors.push({ field: `${prefix}.advbase`, message: 'Advertisement Base must be between 1 and 254.', code: 'INVALID_ADVBASE' })
      }
      if (spec.advskew < 0 || spec.advskew > 254) {
        errors.push({ field: `${prefix}.advskew`, message: 'Advertisement Skew must be between 0 and 254.', code: 'INVALID_ADVSKEW' })
      }
      if (!spec.password) {
        errors.push({ field: `${prefix}.password`, message: 'A VHID Group Password is required for CARP mode.', code: 'EMPTY_PASSWORD' })
      }
      if (spec.carpMode === 'ucast') {
        if (!spec.carpPeer) {
          errors.push({ field: `${prefix}.carp_peer`, message: 'CARP Peer is required when CARP Mode is Unicast.', code: 'EMPTY_CARP_PEER' })
        } else if (!isValidIp(spec.carpPeer)) {
          errors.push({ field: `${prefix}.carp_peer`, message: `"${spec.carpPeer}" is not a valid IP address.`, code: 'INVALID_CARP_PEER' })
        }
      }
    }

    if (spec.descr.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.descr`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer (got ${spec.descr.length}).`,
        code: 'DESCRIPTION_TOO_LONG',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
