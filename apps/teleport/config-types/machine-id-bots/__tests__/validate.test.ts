import validate, { extractBotSpecs, traitsFromKeyValue, durationToSeconds } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'teleport',
    customerId: 'cust-1',
    configTypeId: 'machine-id-bots',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'teleport',
      entityType: 'machine-id-bots',
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
    toolType: 'teleport',
    entityType: 'machine-id-bots',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Teleport Machine ID Bots Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal bot', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { botName: 'ci-bot', roles: ['access'] } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing bot name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { roles: ['access'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('botName'))).toBe(true)
  })

  it('rejects a bot with no roles', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { botName: 'ci-bot', roles: [] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('roles'))).toBe(true)
  })

  it('rejects a duplicate bot name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { botName: 'ci-bot', roles: ['access'] } },
        { name: 'sec2', fields: { botName: 'ci-bot', roles: ['editor'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_bot')).toBe(true)
  })

  it('rejects an invalid max session TTL', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { botName: 'ci-bot', roles: ['access'], maxSessionTtl: '1 day' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_duration')).toBe(true)
  })

  it('accepts a valid max session TTL', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { botName: 'ci-bot', roles: ['access'], maxSessionTtl: '12h' } }]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('traitsFromKeyValue', () => {
  it('splits comma-separated values into an array per trait', () => {
    const traits = traitsFromKeyValue({ logins: 'ubuntu, root', aws_role_arns: 'arn:aws:iam::1:role/x' })
    expect(traits).toEqual([
      { name: 'logins', values: ['ubuntu', 'root'] },
      { name: 'aws_role_arns', values: ['arn:aws:iam::1:role/x'] },
    ])
  })

  it('returns an empty array for non-object input', () => {
    expect(traitsFromKeyValue(undefined)).toEqual([])
    expect(traitsFromKeyValue(null)).toEqual([])
  })
})

describe('extractBotSpecs', () => {
  it('trims fields and defaults optional values', () => {
    const specs = extractBotSpecs(
      makeCanvas([{ name: 'sec1', fields: { botName: '  ci-bot  ', roles: ['access', ''], description: '  ' } }]),
    )
    expect(specs[0].botName).toBe('ci-bot')
    expect(specs[0].roles).toEqual(['access'])
    expect(specs[0].description).toBeNull()
    expect(specs[0].maxSessionTtl).toBeNull()
  })
})

describe('durationToSeconds', () => {
  it('parses this app\'s single-unit input format', () => {
    expect(durationToSeconds('12h')).toBe(43200)
    expect(durationToSeconds('30m')).toBe(1800)
    expect(durationToSeconds('45s')).toBe(45)
  })

  it('parses the protobuf-JSON canonical Duration form', () => {
    expect(durationToSeconds('43200s')).toBe(43200)
    expect(durationToSeconds('43200.5s')).toBe(43200.5)
  })

  it('returns null for unrecognized input', () => {
    expect(durationToSeconds('1 day')).toBeNull()
  })
})
