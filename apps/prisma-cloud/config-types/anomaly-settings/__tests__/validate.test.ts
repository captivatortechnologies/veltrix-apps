import validate, { buildOverlay, extractAnomalySettingsSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('anomaly-settings validate', () => {
  it('accepts a valid setting', () => {
    const r = validate(ctxWith([{ name: 'pol-1', fields: { policyId: 'pol-1', alertDisposition: 'Aggressive' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a policy id', () => {
    const r = validate(ctxWith([{ name: '', fields: { alertDisposition: 'Aggressive' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.policyId'))).toBe(true)
  })

  it('rejects an invalid alert disposition', () => {
    const r = validate(ctxWith([{ name: 'pol-1', fields: { policyId: 'pol-1', alertDisposition: 'Extreme' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_alert_disposition')).toBe(true)
  })

  it('rejects an invalid training model threshold', () => {
    const r = validate(ctxWith([{ name: 'pol-1', fields: { policyId: 'pol-1', trainingModelThreshold: 'Extreme' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_training_model_threshold')).toBe(true)
  })

  it('rejects duplicate policy ids', () => {
    const r = validate(
      ctxWith([
        { name: 'pol-1', fields: { policyId: 'pol-1', alertDisposition: 'Aggressive' } },
        { name: 'pol-1', fields: { policyId: 'pol-1', alertDisposition: 'Moderate' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_policy_id')).toBe(true)
  })

  it('warns when neither field is set', () => {
    const r = validate(ctxWith([{ name: 'pol-1', fields: { policyId: 'pol-1' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty')).toBe(true)
  })
})

describe('buildOverlay', () => {
  it('includes only declared (non-blank) fields', () => {
    expect(buildOverlay({ policyId: 'p', alertDisposition: 'Aggressive', trainingModelThreshold: '' })).toEqual({ alertDisposition: 'Aggressive' })
    expect(buildOverlay({ policyId: 'p', alertDisposition: '', trainingModelThreshold: '' })).toEqual({})
  })
})

describe('extractAnomalySettingsSpecs', () => {
  it('extracts fields with blanks as leave-unchanged', () => {
    const specs = extractAnomalySettingsSpecs({
      items: [{ id: 'i1', name: 'pol-1', fields: { policyId: 'pol-1', trainingModelThreshold: 'High' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].alertDisposition).toBe('')
    expect(specs[0].trainingModelThreshold).toBe('High')
  })
})
