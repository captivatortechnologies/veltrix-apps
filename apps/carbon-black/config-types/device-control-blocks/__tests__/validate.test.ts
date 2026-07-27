import validate, { extractBlockSpecs } from '../validate'
import { buildBody, definitionEquals } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('device-control-blocks validate', () => {
  it('accepts a valid block', () => {
    const r = validate(ctxWith([{ name: 'B', fields: { policyName: 'Standard', allowWrite: true, allowExecute: false } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a policy name', () => {
    const r = validate(ctxWith([{ name: '', fields: { allowWrite: true } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('flags two blocks for the same policy', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { policyName: 'Standard', allowWrite: true } },
        { name: 'B', fields: { policyName: 'standard', allowExecute: true } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_policy')).toBe(true)
  })
})

describe('buildBody / definitionEquals', () => {
  it('builds the nested windows.approved_devices body', () => {
    const spec = extractBlockSpecs(
      ctxWith([{ name: 'B', fields: { policyName: 'Standard', allowWrite: true, allowExecute: false } }]).canvas
    )[0]
    const body = buildBody(spec, '123') as { policy_id: string; windows: { approved_devices: { allow_write: boolean; allow_execute: boolean } } }
    expect(body.policy_id).toBe('123')
    expect(body.windows.approved_devices.allow_write).toBe(true)
    expect(body.windows.approved_devices.allow_execute).toBe(false)
    expect(definitionEquals({ windows: { approved_devices: { allow_write: true, allow_execute: false } } }, spec)).toBe(true)
    expect(definitionEquals({ windows: { approved_devices: { allow_write: false, allow_execute: false } } }, spec)).toBe(false)
  })
})
