import validate, { parseRegions, parseDefaultRegion, extractIntegrationSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const REGIONS = '[{"name":"AWS Virginia","apiIdentifier":"us-east-1"}]'

describe('integrations validate', () => {
  it('accepts a valid aws_security_hub integration', () => {
    const r = validate(
      ctxWith([{ name: 'sechub', fields: { name: 'sechub', integrationType: 'aws_security_hub', accountId: '123456789012', regions: REGIONS } }])
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a valid google_cscc integration', () => {
    const r = validate(ctxWith([{ name: 'gcscc', fields: { name: 'gcscc', integrationType: 'google_cscc', orgId: 'org-1', sourceId: 'src-1' } }]))
    expect(r.valid).toBe(true)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { integrationType: 'google_cscc', orgId: 'o', sourceId: 's' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('rejects an out-of-scope integration type', () => {
    const r = validate(ctxWith([{ name: 'x', fields: { name: 'x', integrationType: 'slack' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('requires accountId and regions for aws_security_hub', () => {
    const r = validate(ctxWith([{ name: 'x', fields: { name: 'x', integrationType: 'aws_security_hub' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.accountId'))).toBe(true)
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.regions'))).toBe(true)
  })

  it('requires orgId and sourceId for google_cscc', () => {
    const r = validate(ctxWith([{ name: 'x', fields: { name: 'x', integrationType: 'google_cscc' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.orgId'))).toBe(true)
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.sourceId'))).toBe(true)
  })

  it('rejects malformed regions JSON', () => {
    const r = validate(
      ctxWith([{ name: 'x', fields: { name: 'x', integrationType: 'aws_security_hub', accountId: '1', regions: '{not json' } }])
    )
    expect(r.errors.some((e) => e.code === 'invalid_regions')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', integrationType: 'google_cscc', orgId: 'o', sourceId: 's' } },
        { name: 'Dup', fields: { name: 'Dup', integrationType: 'google_cscc', orgId: 'o', sourceId: 's' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('parseRegions', () => {
  it('parses a JSON array of regions', () => {
    expect(parseRegions(REGIONS).regions).toEqual([{ name: 'AWS Virginia', apiIdentifier: 'us-east-1' }])
  })

  it('flags a non-array value', () => {
    expect(parseRegions('{"a":1}').error).toBeTruthy()
  })

  it('flags a region missing required keys', () => {
    expect(parseRegions('[{"name":"x"}]').error).toBeTruthy()
  })
})

describe('parseDefaultRegion', () => {
  it('parses a single region object', () => {
    expect(parseDefaultRegion('{"name":"AWS Virginia","apiIdentifier":"us-east-1"}').defaultRegion).toEqual({
      name: 'AWS Virginia',
      apiIdentifier: 'us-east-1',
    })
  })

  it('treats blank as unset', () => {
    expect(parseDefaultRegion('').defaultRegion).toBeNull()
  })
})

describe('extractIntegrationSpecs', () => {
  it('defaults enabled to true', () => {
    const specs = extractIntegrationSpecs({
      items: [{ id: 'i1', name: 'x', fields: { name: 'x', integrationType: 'google_cscc', orgId: 'o', sourceId: 's' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].enabled).toBe(true)
  })
})
