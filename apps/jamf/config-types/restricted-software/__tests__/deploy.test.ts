import { buildRestrictedSoftwareCreateXml, mergeRestrictedSoftwareXml } from '../deploy'
import { extractRestrictedSoftwareSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function specFrom(fields: Record<string, unknown>) {
  const canvas: PipelineContext['canvas'] = {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'jamf',
    entityType: 'restricted-software',
    items: [{ name: 'sec', fields }],
    sections: [{ name: 'sec', fields }],
    snapshot: {},
  }
  return extractRestrictedSoftwareSpecs(canvas)[0]
}

const groupByName = new Map([['fleet a', { id: '10', name: 'Fleet A' }]])

function expectThrows(fn: () => void, pattern: RegExp): void {
  let thrown: unknown = null
  try {
    fn()
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeTruthy()
  expect(thrown instanceof Error ? thrown.message : String(thrown)).toMatch(pattern)
}

describe('Jamf Restricted Software deploy — XML builders', () => {
  it('buildRestrictedSoftwareCreateXml renders general and scope with resolved group ids', () => {
    const spec = specFrom({
      name: 'Block Chess',
      process_name: 'Chess.app',
      kill_process: true,
      computer_group_names: ['Fleet A'],
    })
    const xml = buildRestrictedSoftwareCreateXml(spec, groupByName)
    expect(xml).toContain('<name>Block Chess</name>')
    expect(xml).toContain('<process_name>Chess.app</process_name>')
    expect(xml).toContain('<kill_process>true</kill_process>')
    expect(xml).toContain('<computer_group><id>10</id><name>Fleet A</name></computer_group>')
  })

  it('buildRestrictedSoftwareCreateXml throws a clear error when a referenced group is missing', () => {
    const spec = specFrom({ name: 'X', process_name: 'x', computer_group_names: ['Ghost Group'] })
    expectThrows(() => buildRestrictedSoftwareCreateXml(spec, groupByName), /computer group "Ghost Group" was not found/)
  })

  it('mergeRestrictedSoftwareXml preserves unmanaged fields (id, site) untouched', () => {
    const priorXml =
      '<restricted_software>' +
      '<general><id>77</id><name>Old</name><process_name>Old.app</process_name>' +
      '<match_exact_process_name>false</match_exact_process_name><send_notification>false</send_notification>' +
      '<kill_process>false</kill_process><delete_executable>false</delete_executable><display_message></display_message>' +
      '<site><id>2</id><name>Branch Office</name></site></general>' +
      '<scope><all_computers>true</all_computers><computer_groups/><exclusions><computer_groups/></exclusions></scope>' +
      '</restricted_software>'

    const spec = specFrom({ name: 'Block Chess', process_name: 'Chess.app', kill_process: true, computer_group_names: ['Fleet A'] })
    const merged = mergeRestrictedSoftwareXml(priorXml, spec, groupByName)

    expect(merged).toContain('<name>Block Chess</name>')
    expect(merged).toContain('<process_name>Chess.app</process_name>')
    expect(merged).toContain('<kill_process>true</kill_process>')
    expect(merged).toContain('<computer_group><id>10</id><name>Fleet A</name></computer_group>')
    // Unmanaged fields preserved.
    expect(merged).toContain('<id>77</id>')
    expect(merged).toContain('<site><id>2</id><name>Branch Office</name></site>')
  })
})
