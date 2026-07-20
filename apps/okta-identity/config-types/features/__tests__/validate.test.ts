import validate, {
  extractFeatureSpecs,
  toBoolean,
  FEATURE_STATUSES,
  type LiveFeature,
} from '../validate'
import {
  findFeature,
  reconcileFeatureStatus,
  type FeatureRollbackData,
} from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'
import type { OktaClient } from '../../../lib/okta'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'features',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'features',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'okta-identity',
    entityType: 'features',
    items: sections,
    sections,
    snapshot: {},
  }
}

// --- A minimal fake OktaClient that records request calls and serves a fixed
//     feature list, so the exported client helpers can be exercised without a
//     network. Cast through `unknown` since only two methods are used here.
interface RecordedCall {
  method: string
  path: string
  opts?: { query?: Record<string, unknown>; body?: unknown }
}

function makeClient(items: LiveFeature[], getAllOk = true): { client: OktaClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const client = {
    request: async (method: string, path: string, opts?: RecordedCall['opts']) => {
      calls.push({ method, path, opts })
      return { status: 200, ok: true, body: '{}', nextUrl: null }
    },
    getAll: async () => ({ ok: getAllOk, items, status: getAllOk ? 200 : 500, body: '[]' }),
  } as unknown as OktaClient
  return { client, calls }
}

describe('Okta Feature Toggles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a full valid config', async () => {
    const result = await validate(
      makeCtx([
        { name: 'Feat', fields: { name: 'Okta ThreatInsight', status: 'ENABLED', forceDependencies: true } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts a lower-case status (normalised to upper-case)', async () => {
    const result = await validate(makeCtx([{ name: 'Feat', fields: { name: 'Some Feature', status: 'disabled' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { status: 'ENABLED' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing status', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'No Status' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('status'))).toBe(true)
  })

  it('rejects an invalid status', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Bad Status', status: 'PAUSED' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('rejects a duplicate feature name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Okta ThreatInsight', status: 'ENABLED' } },
        { name: 'sec2', fields: { name: 'okta threatinsight', status: 'DISABLED' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractFeatureSpecs', () => {
  it('trims the name, upper-cases the status and defaults the force flag', () => {
    const specs = extractFeatureSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: '  Okta ThreatInsight  ', status: ' enabled ' } }]),
    )
    expect(specs[0].name).toBe('Okta ThreatInsight')
    expect(specs[0].status).toBe('ENABLED')
    expect(specs[0].forceDependencies).toBe(false)
  })

  it('leaves the status blank when unset (so validate can flag it required)', () => {
    const specs = extractFeatureSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'X' } }]))
    expect(specs[0].status).toBe('')
  })

  it('coerces a string force flag to a boolean', () => {
    const specs = extractFeatureSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'X', status: 'ENABLED', forceDependencies: 'true' } }]),
    )
    expect(specs[0].forceDependencies).toBe(true)
  })
})

describe('toBoolean', () => {
  it('coerces booleans and strings with a fallback', () => {
    expect(toBoolean(true, false)).toBe(true)
    expect(toBoolean('false', true)).toBe(false)
    expect(toBoolean(undefined, false)).toBe(false)
  })
})

describe('FEATURE_STATUSES', () => {
  it('is exactly ENABLED and DISABLED', () => {
    expect([...FEATURE_STATUSES]).toEqual(['ENABLED', 'DISABLED'])
  })
})

describe('reconcileFeatureStatus', () => {
  it('no-ops when the feature is already at the desired status', async () => {
    const { client, calls } = makeClient([])
    await reconcileFeatureStatus(client, 'f1', 'ENABLED', 'ENABLED', false)
    expect(calls).toHaveLength(0)
  })

  it('POSTs ENABLE with mode=force when enabling with the force flag', async () => {
    const { client, calls } = makeClient([])
    await reconcileFeatureStatus(client, 'f1', 'DISABLED', 'ENABLED', true)
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].path).toBe('/features/f1/ENABLE')
    expect(calls[0].opts?.query?.mode).toBe('force')
  })

  it('POSTs DISABLE without a mode when disabling without the force flag', async () => {
    const { client, calls } = makeClient([])
    await reconcileFeatureStatus(client, 'f1', 'ENABLED', 'DISABLED', false)
    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe('/features/f1/DISABLE')
    expect(calls[0].opts?.query?.mode).toBeUndefined()
  })
})

describe('findFeature', () => {
  const FEATURES: LiveFeature[] = [
    { id: 'f1', name: 'Okta ThreatInsight', status: 'ENABLED' },
    { id: 'f2', name: 'Custom URL Domain', status: 'DISABLED' },
  ]

  it('matches by name case-insensitively', async () => {
    const { client } = makeClient(FEATURES)
    const found = await findFeature(client, '  okta threatinsight  ')
    expect(found).toBeDefined()
    expect(found?.id).toBe('f1')
  })

  it('returns null when no feature matches', async () => {
    const { client } = makeClient(FEATURES)
    const found = await findFeature(client, 'Nonexistent Feature')
    expect(found).toBeNull()
  })
})

// Type-only reference so the rollback data shape stays in sync with deploy.
const _rollbackDataType: FeatureRollbackData | null = null
void _rollbackDataType
