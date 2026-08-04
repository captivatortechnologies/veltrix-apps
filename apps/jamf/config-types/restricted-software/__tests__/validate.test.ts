import validate, {
  extractRestrictedSoftwareSpecs,
  indexRestrictedSoftwareByName,
  parseRestrictedSoftwareGeneralXml,
  parseRestrictedSoftwareScopeXml,
  readBool,
  restrictedSoftwareKey,
  strList,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'jamf',
    customerId: 'cust-1',
    configTypeId: 'restricted-software',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'jamf',
      entityType: 'restricted-software',
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

const validFields = { name: 'Block Chess', process_name: 'Chess.app', kill_process: true }

describe('Jamf Restricted Software Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid record', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: validFields }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { process_name: 'x' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing process name', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Block X' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('process_name'))).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Block Chess' } },
        { name: 'b', fields: { ...validFields, name: 'block chess' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_restricted_software')).toBe(true)
  })

  it('restrictedSoftwareKey normalizes case and whitespace', () => {
    expect(restrictedSoftwareKey('  Block Chess ')).toBe('block chess')
  })

  it('readBool parses booleans, string booleans and falls back', () => {
    expect(readBool(true, false)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(readBool(undefined, true)).toBe(true)
  })

  it('strList handles arrays, comma strings and blanks', () => {
    expect(strList(['a', ' b ', ''])).toEqual(['a', 'b'])
    expect(strList('a, b ,')).toEqual(['a', 'b'])
  })

  it('extractRestrictedSoftwareSpecs reads every general and scope field', () => {
    const specs = extractRestrictedSoftwareSpecs(
      makeCtx([
        {
          name: 'sec',
          fields: {
            ...validFields,
            match_exact_process_name: true,
            send_notification: true,
            delete_executable: true,
            display_message: 'Not allowed',
            all_computers: true,
            computer_group_names: ['Fleet A'],
            exclusion_computer_group_names: ['Fleet B'],
          },
        },
      ]).canvas,
    )
    const spec = specs[0]
    expect(spec.matchExactProcessName).toBe(true)
    expect(spec.sendNotification).toBe(true)
    expect(spec.killProcess).toBe(true)
    expect(spec.deleteExecutable).toBe(true)
    expect(spec.displayMessage).toBe('Not allowed')
    expect(spec.allComputers).toBe(true)
    expect(spec.computerGroupNames).toEqual(['Fleet A'])
    expect(spec.exclusionComputerGroupNames).toEqual(['Fleet B'])
  })

  it('indexRestrictedSoftwareByName is case-insensitive and first-match-wins on duplicates', () => {
    const byName = indexRestrictedSoftwareByName([
      { id: '1', name: 'Dup' },
      { id: '2', name: 'dup' },
    ])
    expect(byName.get('dup')?.id).toBe('1')
    expect(byName.size).toBe(1)
  })

  describe('live Classic XML parsing', () => {
    it('parseRestrictedSoftwareGeneralXml reads every general leaf', () => {
      const xml =
        '<general><id>1</id><name>Block Chess</name><process_name>Chess.app</process_name>' +
        '<match_exact_process_name>true</match_exact_process_name><send_notification>false</send_notification>' +
        '<kill_process>true</kill_process><delete_executable>false</delete_executable>' +
        '<display_message>Not allowed</display_message></general>'
      const parsed = parseRestrictedSoftwareGeneralXml(xml)
      expect(parsed.name).toBe('Block Chess')
      expect(parsed.processName).toBe('Chess.app')
      expect(parsed.matchExactProcessName).toBe(true)
      expect(parsed.killProcess).toBe(true)
      expect(parsed.deleteExecutable).toBe(false)
      expect(parsed.displayMessage).toBe('Not allowed')
    })

    it('parseRestrictedSoftwareScopeXml reads all_computers, group names and exclusion group names', () => {
      const xml =
        '<scope><all_computers>false</all_computers>' +
        '<computer_groups><computer_group><id>1</id><name>Fleet A</name></computer_group></computer_groups>' +
        '<exclusions><computer_groups><computer_group><id>2</id><name>Fleet B</name></computer_group></computer_groups></exclusions>' +
        '</scope>'
      const parsed = parseRestrictedSoftwareScopeXml(xml)
      expect(parsed.allComputers).toBe(false)
      expect(parsed.groupNames).toEqual(['Fleet A'])
      expect(parsed.exclusionGroupNames).toEqual(['Fleet B'])
    })
  })
})
