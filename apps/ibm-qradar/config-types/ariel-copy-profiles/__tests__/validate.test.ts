import validate, { extractArielCopyProfileSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('ariel-copy-profiles validate', () => {
  it('accepts a valid profile', () => {
    const r = validate(ctxWith([{
      name: 'DR to secondary site',
      fields: { name: 'DR to secondary site', hostId: 53, destinationHostIp: '10.0.0.5', enabled: true },
    }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { hostId: 53, destinationHostIp: '10.0.0.5' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('requires a host id', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', destinationHostIp: '10.0.0.5' } }]))
    expect(r.errors.some((e) => e.field.endsWith('.hostId'))).toBe(true)
  })

  it('requires a destination host ip', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', hostId: 1 } }]))
    expect(r.errors.some((e) => e.field.endsWith('.destinationHostIp'))).toBe(true)
  })

  it('rejects a duplicate host id', () => {
    const r = validate(ctxWith([
      { name: 'A', fields: { name: 'A', hostId: 5, destinationHostIp: '10.0.0.1' } },
      { name: 'B', fields: { name: 'B', hostId: 5, destinationHostIp: '10.0.0.2' } },
    ]))
    expect(r.errors.some((e) => e.code === 'duplicate_host')).toBe(true)
  })

  it('rejects an end date before the start date', () => {
    const r = validate(ctxWith([{
      name: 'P',
      fields: { name: 'P', hostId: 1, destinationHostIp: '10.0.0.1', startDate: 2000, endDate: 1000 },
    }]))
    expect(r.errors.some((e) => e.code === 'invalid_range')).toBe(true)
  })

  it('rejects a destination port out of range', () => {
    const r = validate(ctxWith([{
      name: 'P',
      fields: { name: 'P', hostId: 1, destinationHostIp: '10.0.0.1', destinationPort: 70000 },
    }]))
    expect(r.errors.some((e) => e.field.endsWith('.destinationPort'))).toBe(true)
  })

  it('warns when disabled', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', hostId: 1, destinationHostIp: '10.0.0.1' } }]))
    expect(r.warnings.some((w) => w.code === 'disabled')).toBe(true)
  })
})

describe('extractArielCopyProfileSpecs', () => {
  it('parses exclude bucket name lists', () => {
    const specs = extractArielCopyProfileSpecs({
      items: [{
        id: 'i1',
        name: 'P',
        fields: { name: 'P', hostId: 1, destinationHostIp: '10.0.0.1', excludeEventRetentionBucketNames: 'Default\nArchive' },
      }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].excludeEventRetentionBucketNames).toEqual(['Default', 'Archive'])
  })
})
