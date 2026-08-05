import validate, { extractNativeDashboardSpecs, parseFilters } from '../validate'
import { dashboardBody, dashboardIdOf } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const GLOBAL_FILTER = JSON.stringify([
  { id: 'GlobalTimeFilter', displayName: 'Global Time Filter', dataSource: 'GLOBAL', isStandardTimeRangeFilter: true, isStandardTimeRangeFilterEnabled: true },
])

describe('native-dashboards validate', () => {
  it('accepts a valid dashboard', () => {
    const r = validate(ctxWith([{ name: 'd1', fields: { displayName: 'SOC Overview', description: 'd', access: 'DASHBOARD_PRIVATE', filters: GLOBAL_FILTER } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a display name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid access level', () => {
    const r = validate(ctxWith([{ name: 'd1', fields: { displayName: 'x', access: 'EVERYONE' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_access')).toBe(true)
  })

  it('rejects malformed filters JSON', () => {
    const r = validate(ctxWith([{ name: 'd1', fields: { displayName: 'x', filters: '{not an array}' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects a filter missing an id', () => {
    const r = validate(ctxWith([{ name: 'd1', fields: { displayName: 'x', filters: JSON.stringify([{ dataSource: 'GLOBAL' }]) } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects a duplicate filter id', () => {
    const dup = JSON.stringify([{ id: 'f1' }, { id: 'f1' }])
    const r = validate(ctxWith([{ name: 'd1', fields: { displayName: 'x', filters: dup } }]))
    expect(r.errors.some((e) => e.code === 'duplicate_filter_id')).toBe(true)
  })

  it('rejects an invalid filter dataSource', () => {
    const bad = JSON.stringify([{ id: 'f1', dataSource: 'NOT_A_SOURCE' }])
    const r = validate(ctxWith([{ name: 'd1', fields: { displayName: 'x', filters: bad } }]))
    expect(r.errors.some((e) => e.code === 'invalid_data_source')).toBe(true)
  })

  it('rejects an invalid filterOperator', () => {
    const bad = JSON.stringify([{ id: 'f1', filterOperatorAndFieldValues: [{ filterOperator: 'LIKE', fieldValues: ['x'] }] }])
    const r = validate(ctxWith([{ name: 'd1', fields: { displayName: 'x', filters: bad } }]))
    expect(r.errors.some((e) => e.code === 'invalid_filter_operator')).toBe(true)
  })

  it('rejects duplicate dashboard names', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { displayName: 'dup' } },
        { name: 'b', fields: { displayName: 'dup' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractNativeDashboardSpecs / parseFilters / dashboardBody', () => {
  it('maps items to specs and defaults access to DASHBOARD_PRIVATE', () => {
    const specs = extractNativeDashboardSpecs(ctxWith([{ id: 'i1', name: 'd', fields: { displayName: 'SOC Overview' } }]).canvas)
    expect(specs[0].itemId).toBe('i1')
    expect(specs[0].access).toBe('DASHBOARD_PRIVATE')
    expect(specs[0].isPinned).toBe(false)
    expect(specs[0].filters).toEqual([])
  })

  it('parses a valid filters array', () => {
    const filters = parseFilters(GLOBAL_FILTER)
    expect(filters).toHaveLength(1)
    expect(filters?.[0].id).toBe('GlobalTimeFilter')
  })

  it('treats malformed filters JSON as null', () => {
    expect(parseFilters('{not json')).toBeNull()
  })

  it('builds a create/update body nesting isPinned and filters under the wire-format keys', () => {
    const body = dashboardBody({
      itemId: 'i1',
      displayName: 'SOC Overview',
      description: 'd',
      access: 'DASHBOARD_PUBLIC',
      isPinned: true,
      filtersRaw: '',
      filters: [],
    }) as { displayName: string; type: string; dashboardUserData: { isPinned: boolean }; definition: { filters: unknown[] } }
    expect(body.displayName).toBe('SOC Overview')
    expect(body.type).toBe('CUSTOM')
    expect(body.dashboardUserData.isPinned).toBe(true)
    expect(body.definition.filters).toEqual([])
    expect(dashboardIdOf('projects/p/locations/us/instances/i/nativeDashboards/db-9')).toBe('db-9')
  })
})
