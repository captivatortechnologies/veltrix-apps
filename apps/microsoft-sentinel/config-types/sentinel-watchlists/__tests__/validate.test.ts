import validate, { extractWatchlistSpecs, watchlistKey, csvHeaderColumns } from '../validate'
import { buildWatchlistBody } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-sentinel',
    customerId: 'cust-1',
    configTypeId: 'sentinel-watchlists',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-sentinel',
      entityType: 'sentinel-watchlists',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {
      tenant_id: '00000000-0000-0000-0000-000000000000',
      subscription_id: '11111111-1111-1111-1111-111111111111',
      resource_group: 'rg-soc',
      workspace_name: 'ws-sentinel',
      azure_cloud: 'commercial',
    },
    platform: stubPlatform,
  }
}

const validWatchlist = {
  alias: 'HighValueAssets',
  display_name: 'High Value Assets',
  provider: 'SOC',
  items_search_key: 'ip',
  items_csv: 'ip,owner\n10.0.0.1,alice\n10.0.0.2,bob',
  number_of_lines_to_skip: 0,
}

describe('Sentinel Watchlists Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete watchlist with inline CSV', async () => {
    const result = await validate(makeCtx([{ name: 'w', fields: { ...validWatchlist } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires alias, display name and search key', async () => {
    const result = await validate(makeCtx([{ name: 'w', fields: { alias: '', display_name: '', items_search_key: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.alias') && e.code === 'required')).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('.display_name') && e.code === 'required')).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('.items_search_key') && e.code === 'required')).toBe(true)
  })

  it('rejects an alias with illegal characters', async () => {
    const result = await validate(makeCtx([{ name: 'w', fields: { ...validWatchlist, alias: 'bad alias!' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_alias')).toBe(true)
  })

  it('rejects a search key that is not a CSV header column', async () => {
    const result = await validate(makeCtx([{ name: 'w', fields: { ...validWatchlist, items_search_key: 'hostname' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'search_key_missing')).toBe(true)
  })

  it('rejects duplicate aliases case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validWatchlist, alias: 'HighValueAssets' } },
        { name: 'b', fields: { ...validWatchlist, alias: 'highvalueassets' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_alias')).toBe(true)
  })

  it('parses CSV header columns and defaults provider to Custom', () => {
    expect(csvHeaderColumns('ip,owner\n10.0.0.1,alice', 0)).toEqual(['ip', 'owner'])
    const specs = extractWatchlistSpecs(makeCtx([{ name: 'w', fields: { ...validWatchlist, provider: '' } }]).canvas)
    expect(specs[0].provider).toBe('Custom')
    expect(watchlistKey('HighValueAssets')).toBe('highvalueassets')
  })

  it('builds a watchlist body with CSV rawContent and Local source', () => {
    const specs = extractWatchlistSpecs(makeCtx([{ name: 'w', fields: { ...validWatchlist } }]).canvas)
    const body = buildWatchlistBody(specs[0]) as { properties: Record<string, unknown> }
    expect(body.properties.displayName).toBe('High Value Assets')
    expect(body.properties.sourceType).toBe('Local')
    expect(body.properties.contentType).toBe('text/csv')
    expect(body.properties.itemsSearchKey).toBe('ip')
    expect(typeof body.properties.rawContent).toBe('string')
  })
})
