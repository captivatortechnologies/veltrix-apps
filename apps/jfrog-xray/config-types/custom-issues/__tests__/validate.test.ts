import validate from '../validate'
import { buildCustomIssueBody, extractCustomIssueSpecs } from '../_shared'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'jfrog-xray',
    customerId: 'cust-1',
    configTypeId: 'custom-issues',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'jfrog-xray',
      entityType: 'custom-issues',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

const validFields = {
  id: 'ACME-2024-001',
  provider: 'acme-secops',
  type: 'Security',
  package_type: 'maven',
  severity: 'High',
  summary: 'Internal library issue',
  description: 'A detailed description of the issue.',
  components_json: JSON.stringify([{ id: 'generic://acme-internal-lib' }]),
}

function item(id: string, fields: Record<string, unknown>): CanvasItemSnapshot {
  return { name: id, fields: { ...validFields, id, ...fields } }
}

describe('JFrog Xray Custom Issues — validate', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed custom issue', async () => {
    const result = await validate(makeCtx([item('ACME-2024-001', {})]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires an id', async () => {
    const result = await validate(makeCtx([{ name: 'x', fields: { ...validFields, id: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_ID')).toBe(true)
  })

  it('rejects an id with a reserved "xray" prefix', async () => {
    const result = await validate(makeCtx([item('Xray-fake-001', {})]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'RESERVED_ID_PREFIX')).toBe(true)
  })

  it('rejects an id containing a slash', async () => {
    const result = await validate(makeCtx([item('bad/id', {})]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_ID')).toBe(true)
  })

  it('rejects duplicate ids', async () => {
    const result = await validate(makeCtx([item('dup-1', {}), item('dup-1', {})]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'DUPLICATE_ID')).toBe(true)
  })

  it('requires a provider', async () => {
    const result = await validate(makeCtx([item('p1', { provider: '' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_PROVIDER')).toBe(true)
  })

  it('rejects the reserved provider "jfrog" (case-insensitive)', async () => {
    const result = await validate(makeCtx([item('p1', { provider: 'JFrog' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'RESERVED_PROVIDER')).toBe(true)
  })

  it('rejects an invalid severity', async () => {
    const result = await validate(makeCtx([item('p1', { severity: 'Extreme' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_SEVERITY')).toBe(true)
  })

  it('accepts a free-form type value not in the suggested list (no enforced enum)', async () => {
    const result = await validate(makeCtx([item('p1', { type: 'SomeCustomCategory' })]))
    expect(result.valid).toBe(true)
  })

  it('requires at least one component', async () => {
    const result = await validate(makeCtx([item('p1', { components_json: '[]' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_COMPONENTS')).toBe(true)
  })

  it('rejects a component with no id', async () => {
    const result = await validate(makeCtx([item('p1', { components_json: '[{"vulnerable_versions":["1.0"]}]' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_COMPONENT')).toBe(true)
  })

  it('rejects invalid components_json', async () => {
    const result = await validate(makeCtx([item('p1', { components_json: '{bad' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })

  it('rejects invalid cves_json / sources_json', async () => {
    const result = await validate(makeCtx([item('p1', { cves_json: '{bad', sources_json: '{bad' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'INVALID_JSON')).toHaveLength(2)
  })
})

describe('JFrog Xray Custom Issues — _shared helpers', () => {
  it('extractCustomIssueSpecs reads and trims canvas fields', () => {
    const specs = extractCustomIssueSpecs(makeCtx([item('  ACME-2024-002  ', {})]).canvas)
    expect(specs[0].id).toBe('ACME-2024-002')
    expect(specs[0].provider).toBe('acme-secops')
    expect(specs[0].packageType).toBe('maven')
  })

  it('buildCustomIssueBody produces the full create/update payload shape', () => {
    const specs = extractCustomIssueSpecs(
      makeCtx([item('ACME-2024-003', { cves_json: JSON.stringify([{ cve: 'CVE-2017-1000386' }]), sources_json: JSON.stringify([{ source_id: 'CVE-2017-1000386' }]) })]).canvas,
    )
    const body = buildCustomIssueBody(specs[0])
    expect(body.id).toBe('ACME-2024-003')
    expect(body.provider).toBe('acme-secops')
    expect(body.package_type).toBe('maven')
    expect(body.severity).toBe('High')
    expect(body.components).toEqual([{ id: 'generic://acme-internal-lib' }])
    expect(body.cves).toEqual([{ cve: 'CVE-2017-1000386' }])
    expect(body.sources).toEqual([{ source_id: 'CVE-2017-1000386' }])
  })

  it('buildCustomIssueBody carries vulnerable_versions/fixed_versions on a component', () => {
    const specs = extractCustomIssueSpecs(
      makeCtx([item('ACME-2024-004', { components_json: JSON.stringify([{ id: 'aero:aero', vulnerable_versions: ['[0.2.3]'], fixed_versions: ['0.2.4'] }]) })]).canvas,
    )
    const body = buildCustomIssueBody(specs[0])
    expect(body.components).toEqual([{ id: 'aero:aero', vulnerable_versions: ['[0.2.3]'], fixed_versions: ['0.2.4'] }])
  })
})
