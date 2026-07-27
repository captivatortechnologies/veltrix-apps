import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Carbon Black device-control approval constraints ------------------------

const HEX_ID_RE = /^0x[0-9a-fA-F]+$/
const MAX_NAME = 150
const MAX_NOTES = 500

export interface ApprovalSpec {
  itemId?: string
  /** A friendly name — the canvas identity and the approval_name sent to CBC. */
  approvalName: string
  notes: string
  /** the device selector — at least one is required; the tuple is the natural key. */
  vendorId: string
  productId: string
  serialNumber: string
}

/** An approval as returned by the device-control _search / get. */
export interface LiveApproval {
  id?: string
  approval_name?: string
  notes?: string
  vendor_id?: string
  product_id?: string
  serial_number?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractApprovalSpecs(canvas: CanvasSnapshot): ApprovalSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      approvalName: asString(f.approvalName) || item.name,
      notes: asString(f.notes),
      vendorId: asString(f.vendorId),
      productId: asString(f.productId),
      serialNumber: asString(f.serialNumber),
    }
  })
}

/** The natural key an approval is matched on (its device selector tuple). */
export function naturalKey(spec: ApprovalSpec): string {
  return `${spec.vendorId.toLowerCase()}|${spec.productId.toLowerCase()}|${spec.serialNumber.toLowerCase()}`
}

/** The natural key of a live approval (mirrors naturalKey for specs). */
export function liveNaturalKey(live: LiveApproval): string {
  return `${(live.vendor_id ?? '').toLowerCase()}|${(live.product_id ?? '').toLowerCase()}|${(live.serial_number ?? '').toLowerCase()}`
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractApprovalSpecs(ctx.canvas)
  const seenNames = new Set<string>()
  const seenKeys = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.approvalName) {
      errors.push({ field: `${prefix}.approvalName`, message: 'Approval name is required', code: 'required' })
    } else {
      if (spec.approvalName.length > MAX_NAME) {
        errors.push({ field: `${prefix}.approvalName`, message: `Approval name must be ≤ ${MAX_NAME} characters`, code: 'name_too_long' })
      }
      const key = spec.approvalName.toLowerCase()
      if (seenNames.has(key)) errors.push({ field: `${prefix}.approvalName`, message: `Duplicate approval "${spec.approvalName}"`, code: 'duplicate_name' })
      seenNames.add(key)
    }

    if (spec.notes.length > MAX_NOTES) {
      errors.push({ field: `${prefix}.notes`, message: `Notes must be ≤ ${MAX_NOTES} characters`, code: 'notes_too_long' })
    }

    // At least one selector must identify the device(s) being approved.
    if (!spec.vendorId && !spec.productId && !spec.serialNumber) {
      errors.push({ field: `${prefix}`, message: 'An approval needs at least one of vendor id, product id or serial number', code: 'missing_selector' })
      return
    }
    if (spec.vendorId && !HEX_ID_RE.test(spec.vendorId)) {
      errors.push({ field: `${prefix}.vendorId`, message: 'Vendor id must be hex, e.g. 0x0781', code: 'invalid_vendor_id' })
    }
    if (spec.productId && !HEX_ID_RE.test(spec.productId)) {
      errors.push({ field: `${prefix}.productId`, message: 'Product id must be hex, e.g. 0x5581', code: 'invalid_product_id' })
    }

    const nk = naturalKey(spec)
    if (seenKeys.has(nk)) {
      errors.push({ field: `${prefix}`, message: `Duplicate approval — another item already targets ${nk}`, code: 'duplicate_approval' })
    }
    seenKeys.add(nk)
  })

  return { valid: errors.length === 0, errors, warnings }
}
