import validate from '../validate'
import { buildSeverityRecord, NAME_RE, MAX_NAME_LENGTH } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-soar',
    customerId: 'cust-1',
    configTypeId: 'severities',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-soar',
      entityType: 'severities',
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

function fields(overrides: Record<string, unknown> = {}) {
  return { name: 'urgent', color: 'red', is_default: false, ...overrides }
}

describe('Splunk SOAR Severities', () => {
  it('rejects an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed severity', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: fields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects an invalid color', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: fields({ color: 'chartreuse' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID')).toBe(true)
  })

  it('rejects a name with disallowed characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: fields({ name: 'not a valid name!' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID')).toBe(true)
  })

  it('rejects a name over the max length', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: fields({ name: 'a'.repeat(MAX_NAME_LENGTH + 1) }) }]))
    expect(result.valid).toBe(false)
  })

  it('warns on a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: fields() },
        { name: 'sec2', fields: fields() },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_ID')).toBe(true)
  })

  it('buildSeverityRecord returns a body with name/color/is_default', () => {
    const spec = buildSeverityRecord(fields({ is_default: true }))
    expect(spec.error).toBeNull()
    expect(spec.body).toEqual({ name: 'urgent', color: 'red', is_default: true })
  })

  it('buildSeverityRecord skips a blank name without erroring', () => {
    const spec = buildSeverityRecord(fields({ name: '' }))
    expect(spec.id).toBe('')
    expect(spec.error).toBeNull()
  })

  it('NAME_RE matches the documented allowed character set', () => {
    expect(NAME_RE.test('urgent-2_case')).toBe(true)
    expect(NAME_RE.test('has space')).toBe(false)
  })
})
