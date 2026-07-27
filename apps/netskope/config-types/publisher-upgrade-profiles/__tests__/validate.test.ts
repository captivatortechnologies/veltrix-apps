import validate, { extractUpgradeProfileSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const valid = { name: 'Weekly', docker_tag: 'v123', release_type: 'Latest', frequency: '0 0 1 * TUE', timezone: 'US/Eastern' }

describe('publisher-upgrade-profiles validate', () => {
  it('accepts a valid profile', () => {
    const r = validate(ctxWith([{ name: 'Weekly', fields: { ...valid } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name and docker tag', () => {
    const r = validate(ctxWith([{ name: '', fields: { release_type: 'Latest', frequency: '0 0 1 * TUE', timezone: 'US/Eastern' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.docker_tag'))).toBe(true)
  })

  it('rejects an invalid release type', () => {
    const r = validate(ctxWith([{ name: 'W', fields: { ...valid, release_type: 'Nightly' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_release_type')).toBe(true)
  })

  it('rejects a non-5-field cron', () => {
    const r = validate(ctxWith([{ name: 'W', fields: { ...valid, frequency: '0 0 1' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_cron')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { ...valid, name: 'Dup' } },
        { name: 'Dup', fields: { ...valid, name: 'Dup' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractUpgradeProfileSpecs', () => {
  it('reads fields and defaults release type and enabled', () => {
    const specs = extractUpgradeProfileSpecs({
      items: [{ id: 'i1', name: 'F', fields: { name: ' Weekly ', docker_tag: 'v1', frequency: '0 0 1 * TUE', timezone: 'US/Eastern' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('Weekly')
    expect(specs[0].releaseType).toBe('Latest')
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].timezoneId).toBe(0)
  })
})
