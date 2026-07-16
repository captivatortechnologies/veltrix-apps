import validate from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-cloud',
    customerId: 'cust-1',
    configTypeId: 'limits',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-cloud',
      entityType: 'limits',
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

describe('Splunk Cloud limits.conf Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid limits.conf setting', async () => {
    const result = await validate(
      makeCtx([{ name: 'l1', fields: { stanza: 'join', setting: 'subsearch_maxout', value: 40000 } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('rejects a missing stanza', async () => {
    const result = await validate(makeCtx([{ name: 'l', fields: { setting: 'subsearch_maxout', value: 40000 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a missing setting', async () => {
    const result = await validate(makeCtx([{ name: 'l', fields: { stanza: 'join', value: 40000 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a missing value', async () => {
    const result = await validate(makeCtx([{ name: 'l', fields: { stanza: 'join', setting: 'subsearch_maxout' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a stanza outside the ACS-editable subset', async () => {
    const result = await validate(makeCtx([{ name: 'l', fields: { stanza: 'search', setting: 'maxout', value: 100 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_stanza')).toBe(true)
  })

  it('rejects a setting that does not belong to the stanza', async () => {
    // maxout is a subsearch setting, not a join setting.
    const result = await validate(makeCtx([{ name: 'l', fields: { stanza: 'join', setting: 'maxout', value: 100 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_setting')).toBe(true)
  })

  it('rejects a duplicate stanza/setting across items', async () => {
    const result = await validate(
      makeCtx([
        { name: 'l1', fields: { stanza: 'join', setting: 'subsearch_maxout', value: 40000 } },
        { name: 'l2', fields: { stanza: 'join', setting: 'subsearch_maxout', value: 40000 } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_setting')).toBe(true)
  })

  it('rejects a non-integer value', async () => {
    // A finite but fractional value — limits.conf settings are integers.
    const result = await validate(
      makeCtx([{ name: 'l', fields: { stanza: 'join', setting: 'subsearch_maxout', value: 40000.5 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects values outside the ACS-permitted range', async () => {
    const result = await validate(
      makeCtx([
        // below min (kv.maxchars min is 1)
        { name: 'l1', fields: { stanza: 'kv', setting: 'maxchars', value: 0 } },
        // above max (subsearch.maxout max is 10400)
        { name: 'l2', fields: { stanza: 'subsearch', setting: 'maxout', value: 20000 } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'value_out_of_range')).toHaveLength(2)
  })

  it('warns (does not block) when a value is above Splunk\'s default', async () => {
    // join.subsearch_maxout default 50000, max 100000
    const result = await validate(
      makeCtx([{ name: 'l', fields: { stanza: 'join', setting: 'subsearch_maxout', value: 60000 } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'above_default')).toBe(true)
  })

  it('warns (does not block) when a value is at the ACS ceiling', async () => {
    // join.subsearch_maxout max is 100000
    const result = await validate(
      makeCtx([{ name: 'l', fields: { stanza: 'join', setting: 'subsearch_maxout', value: 100000 } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'at_ceiling')).toBe(true)
  })

  it('accepts a numeric-string value', async () => {
    // join.subsearch_maxtime default 60 — a plain valid value with no warning
    const result = await validate(
      makeCtx([{ name: 'l', fields: { stanza: 'join', setting: 'subsearch_maxtime', value: '60' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })
})
