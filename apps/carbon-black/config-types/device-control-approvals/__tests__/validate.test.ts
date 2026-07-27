import validate, { extractApprovalSpecs, naturalKey, liveNaturalKey } from '../validate'
import { buildBody, definitionEquals } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('device-control-approvals validate', () => {
  it('accepts a valid vendor/product approval', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { approvalName: 'Sandisk', vendorId: '0x0781', productId: '0x5581' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires an approval name', () => {
    const r = validate(ctxWith([{ name: '', fields: { vendorId: '0x0781' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires at least one device selector', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { approvalName: 'A' } }]))
    expect(r.errors.some((e) => e.code === 'missing_selector')).toBe(true)
  })

  it('rejects a non-hex vendor or product id', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { approvalName: 'A', vendorId: '781', productId: 'zz' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_vendor_id')).toBe(true)
    expect(r.errors.some((e) => e.code === 'invalid_product_id')).toBe(true)
  })

  it('rejects two items targeting the same device tuple', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { approvalName: 'A', vendorId: '0x0781', productId: '0x5581' } },
        { name: 'B', fields: { approvalName: 'B', vendorId: '0x0781', productId: '0x5581' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_approval')).toBe(true)
  })
})

describe('naturalKey / buildBody / definitionEquals', () => {
  it('produces matching keys for a spec and its live form', () => {
    const spec = extractApprovalSpecs(
      ctxWith([{ name: 'A', fields: { approvalName: 'A', vendorId: '0x0781', productId: '0x5581', serialNumber: 'SN1' } }]).canvas
    )[0]
    expect(naturalKey(spec)).toBe('0x0781|0x5581|sn1')
    expect(liveNaturalKey({ vendor_id: '0x0781', product_id: '0x5581', serial_number: 'SN1' })).toBe('0x0781|0x5581|sn1')
    const body = buildBody(spec) as { approval_name: string; vendor_id: string; product_id: string; serial_number: string }
    expect(body.approval_name).toBe('A')
    expect(body.vendor_id).toBe('0x0781')
    expect(definitionEquals({ approval_name: 'A', vendor_id: '0x0781' }, spec)).toBe(true)
    expect(definitionEquals({ approval_name: 'Other', vendor_id: '0x0781' }, spec)).toBe(false)
  })
})
