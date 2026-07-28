import validate, { extractWorkbookSpecs, workbookKey, isJsonParseable, WORKBOOK_CATEGORY, WORKBOOK_KIND, WORKBOOK_VERSION } from '../validate'
import {
  buildWorkbookBody,
  findWorkbookByDisplayName,
  resourceGroupScope,
  workbooksCollectionPath,
  workbookResourcePath,
  workspaceSourceId,
  type LiveWorkbook,
} from '../deploy'
import { serializedDataHash, canonicalizeSerializedData, serializedDataContains } from '../driftDetect'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-sentinel',
    customerId: 'cust-1',
    configTypeId: 'sentinel-workbooks',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-sentinel',
      entityType: 'sentinel-workbooks',
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

// A minimal client stub exposing only workspacePath() for the path helpers.
const WORKSPACE_ID = '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-soc/providers/Microsoft.OperationalInsights/workspaces/ws-sentinel'
const stubClient = { workspacePath: () => WORKSPACE_ID }

const validWorkbook = {
  display_name: 'SOC Overview',
  serialized_data: JSON.stringify({ version: 'Notebook/1.0', items: [{ type: 1, content: { json: 'Hello' } }] }),
}

describe('Sentinel Workbooks Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete workbook', async () => {
    const result = await validate(makeCtx([{ name: 'w', fields: { ...validWorkbook } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a display name and serialized data', async () => {
    const result = await validate(makeCtx([{ name: 'w', fields: { display_name: '', serialized_data: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.display_name') && e.code === 'required')).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('.serialized_data') && e.code === 'required')).toBe(true)
  })

  it('rejects serialized data that is not valid JSON', async () => {
    const result = await validate(makeCtx([{ name: 'w', fields: { ...validWorkbook, serialized_data: '{ not valid json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects duplicate display names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validWorkbook, display_name: 'SOC Overview' } },
        { name: 'b', fields: { ...validWorkbook, display_name: 'soc overview' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_workbook')).toBe(true)
  })

  it('extracts fields and derives the reconciliation key', () => {
    const specs = extractWorkbookSpecs(makeCtx([{ name: 'w', fields: { ...validWorkbook, display_name: '  SOC Overview  ' } }]).canvas)
    expect(specs[0].displayName).toBe('SOC Overview')
    expect(specs[0].serializedData).toBe(validWorkbook.serialized_data)
    expect(workbookKey('SOC Overview')).toBe('soc overview')
    expect(isJsonParseable('{"a":1}')).toBe(true)
    expect(isJsonParseable('nope')).toBe(false)
  })
})

describe('Sentinel Workbooks deploy helpers', () => {
  it('builds a Microsoft.Insights workbook body with derived location + sourceId', () => {
    const specs = extractWorkbookSpecs(makeCtx([{ name: 'w', fields: { ...validWorkbook } }]).canvas)
    const body = buildWorkbookBody(specs[0], 'eastus', WORKSPACE_ID) as {
      kind: string
      location: string
      properties: Record<string, unknown>
    }
    expect(body.kind).toBe(WORKBOOK_KIND)
    expect(body.kind).toBe('shared')
    expect(body.location).toBe('eastus')
    expect(body.properties.displayName).toBe('SOC Overview')
    expect(body.properties.category).toBe(WORKBOOK_CATEGORY)
    expect(body.properties.category).toBe('sentinel')
    expect(body.properties.sourceId).toBe(WORKSPACE_ID)
    expect(body.properties.version).toBe(WORKBOOK_VERSION)
    expect(typeof body.properties.serializedData).toBe('string')
  })

  it('derives the resource-group scope and Microsoft.Insights path from the workspace path', () => {
    expect(resourceGroupScope(stubClient)).toBe('/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-soc')
    expect(workbooksCollectionPath(stubClient)).toBe(
      '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-soc/providers/Microsoft.Insights/workbooks',
    )
    expect(workbookResourcePath(stubClient, 'abc-guid')).toBe(
      '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-soc/providers/Microsoft.Insights/workbooks/abc-guid',
    )
    expect(workspaceSourceId(stubClient)).toBe(WORKSPACE_ID)
  })

  it('reconciles a workbook by display name scoped to category sentinel + this workspace', () => {
    const live: LiveWorkbook[] = [
      { name: 'guid-match', properties: { displayName: 'SOC Overview', category: 'sentinel', sourceId: WORKSPACE_ID } },
      { name: 'guid-other-source', properties: { displayName: 'SOC Overview', category: 'sentinel', sourceId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.OperationalInsights/workspaces/other' } },
      { name: 'guid-wrong-category', properties: { displayName: 'SOC Overview', category: 'workbook', sourceId: WORKSPACE_ID } },
    ]
    const match = findWorkbookByDisplayName(live, 'soc overview', WORKSPACE_ID)
    expect(match).toBeDefined()
    expect(match!.name).toBe('guid-match')

    const none = findWorkbookByDisplayName(live, 'Nonexistent', WORKSPACE_ID)
    expect(none).toBeUndefined()
  })
})

describe('Sentinel Workbooks serializedData hash (drift is hash-compared)', () => {
  it('is stable across key reordering and whitespace', () => {
    const a = JSON.stringify({ version: 'Notebook/1.0', items: [1, 2], name: 'x' })
    const b = '  { "name": "x", "items": [1, 2], "version": "Notebook/1.0" }  '
    expect(serializedDataHash(a)).toBe(serializedDataHash(b))
  })

  it('changes when the workbook content changes', () => {
    const a = JSON.stringify({ items: [{ content: 'A' }] })
    const b = JSON.stringify({ items: [{ content: 'B' }] })
    expect(serializedDataHash(a) === serializedDataHash(b)).toBe(false)
  })

  it('falls back to the trimmed raw string when serializedData does not parse', () => {
    expect(canonicalizeSerializedData('  not json  ')).toBe('not json')
    expect(serializedDataHash('not json')).toBe(serializedDataHash('  not json  '))
  })
})

describe('Sentinel Workbooks serializedData containment (ignores Azure server-added defaults)', () => {
  it('is NOT drift when the live blob only ADDS default properties (top-level + per-item)', () => {
    const declared = JSON.stringify({ version: 'Notebook/1.0', items: [{ type: 1, content: { query: 'X' } }] })
    // Azure adds $schema / isLocked / styleSettings and per-item defaults on save.
    const live = JSON.stringify({
      $schema: 'https://github.com/Microsoft/Application-Insights-Workbooks/blob/master/schema/workbook.json',
      version: 'Notebook/1.0',
      isLocked: false,
      styleSettings: {},
      items: [{ type: 1, content: { query: 'X' }, conditionalVisibility: null, showPin: false }],
    })
    expect(serializedDataContains(declared, live)).toBe(true)
  })

  it('IS drift when a declared value changes', () => {
    const declared = JSON.stringify({ items: [{ content: { query: 'A' } }] })
    const live = JSON.stringify({ items: [{ content: { query: 'B' }, showPin: false }] })
    expect(serializedDataContains(declared, live)).toBe(false)
  })

  it('IS drift when a declared key is removed from the live blob', () => {
    const declared = JSON.stringify({ title: 'Ops', items: [1, 2] })
    const live = JSON.stringify({ items: [1, 2], isLocked: false }) // title removed
    expect(serializedDataContains(declared, live)).toBe(false)
  })

  it('IS drift when an item is added or removed (order + length are significant)', () => {
    const declared = JSON.stringify({ items: [{ id: 'a' }, { id: 'b' }] })
    expect(serializedDataContains(declared, JSON.stringify({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }))).toBe(false)
    expect(serializedDataContains(declared, JSON.stringify({ items: [{ id: 'a' }] }))).toBe(false)
  })

  it('falls back to canonical-hash equality when a blob is not JSON', () => {
    expect(serializedDataContains('not json', '  not json  ')).toBe(true)
    expect(serializedDataContains('not json', 'different')).toBe(false)
  })
})
