import validate from '../validate'
import { bodiesEqual, buildIgnoreRuleBody, canonicalize, extractIgnoreRuleSpecs, hasObjectiveFilter } from '../_shared'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'jfrog-xray',
    customerId: 'cust-1',
    configTypeId: 'ignore-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'jfrog-xray',
      entityType: 'ignore-rules',
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

function item(id: string, fields: Record<string, unknown>): CanvasItemSnapshot {
  return { id, name: String(fields.notes ?? id), fields }
}

const FUTURE = '2099-01-01T00:00:00Z'
const validFields = { notes: 'ignore CVE-2016-2168 on tstWatch', cve_ids: ['CVE-2016-2168'] }

describe('JFrog Xray Ignore Rules — validate', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a valid CVE-scoped rule', async () => {
    const result = await validate(makeCtx([item('a', validFields)]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires notes', async () => {
    const result = await validate(makeCtx([item('a', { cve_ids: ['CVE-2016-2168'] })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_NOTES')).toBe(true)
  })

  it('rejects an unparseable expiry', async () => {
    const result = await validate(makeCtx([item('a', { ...validFields, expires_at: 'not-a-date' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_EXPIRY')).toBe(true)
  })

  it('rejects an expiry in the past', async () => {
    const result = await validate(makeCtx([item('a', { ...validFields, expires_at: '2000-01-01T00:00:00Z' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EXPIRY_IN_PAST')).toBe(true)
  })

  it('accepts a future expiry', async () => {
    const result = await validate(makeCtx([item('a', { ...validFields, expires_at: FUTURE })]))
    expect(result.valid).toBe(true)
  })

  it('requires at least one objective filter', async () => {
    const result = await validate(makeCtx([item('a', { notes: 'scope-only', watch_names: ['tstWatch'] })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_OBJECTIVE_FILTER')).toBe(true)
  })

  it('accepts an objective filter supplied only via additional_filters_json', async () => {
    const result = await validate(makeCtx([item('a', { notes: 'json-only', additional_filters_json: '{"operational_risk":["any"]}' })]))
    expect(result.valid).toBe(true)
  })

  it('rejects invalid additional_filters_json', async () => {
    const result = await validate(makeCtx([item('a', { ...validFields, additional_filters_json: '{bad' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })
})

describe('JFrog Xray Ignore Rules — _shared helpers', () => {
  it('extractIgnoreRuleSpecs reads the canvas item id as itemId (no natural name)', () => {
    const specs = extractIgnoreRuleSpecs(makeCtx([item('canvas-item-1', validFields)]).canvas)
    expect(specs[0].itemId).toBe('canvas-item-1')
    expect(specs[0].notes).toBe('ignore CVE-2016-2168 on tstWatch')
    expect(specs[0].cveIds).toEqual(['CVE-2016-2168'])
  })

  it('hasObjectiveFilter recognizes typed fields and the JSON escape valve', () => {
    expect(hasObjectiveFilter({ notes: 'x', cveIds: ['CVE-1'], vulnerabilityIds: [], licenseNames: [], watchNames: [], policyNames: [], componentNames: [], gitRepositoryNames: [], dockerLayerShas: [], additionalFiltersJson: '' })).toBe(true)
    expect(hasObjectiveFilter({ notes: 'x', cveIds: [], vulnerabilityIds: [], licenseNames: [], watchNames: ['w'], policyNames: [], componentNames: [], gitRepositoryNames: [], dockerLayerShas: [], additionalFiltersJson: '' })).toBe(false)
    expect(hasObjectiveFilter({ notes: 'x', cveIds: [], vulnerabilityIds: [], licenseNames: [], watchNames: [], policyNames: [], componentNames: [], gitRepositoryNames: [], dockerLayerShas: [], additionalFiltersJson: '{"exposures":{}}' })).toBe(true)
  })

  it('buildIgnoreRuleBody produces the create-request shape', () => {
    const specs = extractIgnoreRuleSpecs(makeCtx([item('a', { ...validFields, expires_at: FUTURE, watch_names: ['tstWatch'] })]).canvas)
    const body = buildIgnoreRuleBody(specs[0])
    expect(body.notes).toBe('ignore CVE-2016-2168 on tstWatch')
    expect(body.expires_at).toBe(FUTURE)
    expect(body.ignore_filters.cves).toEqual(['CVE-2016-2168'])
    expect(body.ignore_filters.watches).toEqual(['tstWatch'])
  })

  it('buildIgnoreRuleBody maps component_names to {name} pairs', () => {
    const specs = extractIgnoreRuleSpecs(makeCtx([item('a', { notes: 'x', component_names: ['npm://lodash'] })]).canvas)
    const body = buildIgnoreRuleBody(specs[0])
    expect(body.ignore_filters.components).toEqual([{ name: 'npm://lodash' }])
  })

  it('buildIgnoreRuleBody lets typed fields win over a colliding additional_filters_json key', () => {
    const specs = extractIgnoreRuleSpecs(
      makeCtx([item('a', { notes: 'x', cve_ids: ['CVE-1'], additional_filters_json: JSON.stringify({ cves: ['CVE-OVERRIDDEN'], operational_risk: ['any'] }) })]).canvas,
    )
    const body = buildIgnoreRuleBody(specs[0])
    expect(body.ignore_filters.cves).toEqual(['CVE-1'])
    expect(body.ignore_filters.operational_risk).toEqual(['any'])
  })

  it('canonicalize sorts object keys and string-array filter sets', () => {
    const a = canonicalize({ b: 1, a: [3, 1, 2] })
    const b = canonicalize({ a: [1, 2, 3], b: 1 })
    expect(a).toBe(b)
  })

  it('canonicalize preserves order for arrays of objects (e.g. components)', () => {
    const a = canonicalize({ components: [{ name: 'z' }, { name: 'a' }] })
    const b = canonicalize({ components: [{ name: 'a' }, { name: 'z' }] })
    expect(a === b).toBe(false)
  })

  it('bodiesEqual is order-insensitive on filter sets but content-sensitive otherwise', () => {
    const a = buildIgnoreRuleBody(extractIgnoreRuleSpecs(makeCtx([item('a', { notes: 'x', cve_ids: ['CVE-1', 'CVE-2'] })]).canvas)[0])
    const b = buildIgnoreRuleBody(extractIgnoreRuleSpecs(makeCtx([item('a', { notes: 'x', cve_ids: ['CVE-2', 'CVE-1'] })]).canvas)[0])
    const c = buildIgnoreRuleBody(extractIgnoreRuleSpecs(makeCtx([item('a', { notes: 'x', cve_ids: ['CVE-3'] })]).canvas)[0])
    expect(bodiesEqual(a, b)).toBe(true)
    expect(bodiesEqual(a, c)).toBe(false)
  })
})
