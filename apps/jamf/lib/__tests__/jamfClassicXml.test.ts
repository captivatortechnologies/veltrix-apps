import {
  classicErrorMessage,
  extractAll,
  extractElement,
  extractText,
  indexRefsByName,
  parseIdNameList,
  refXml,
  replaceTopLevelElement,
  setLeaf,
  tag,
  xmlEscape,
  xmlUnescape,
} from '../jamfClassicXml'

describe('jamfClassicXml', () => {
  describe('xmlEscape / xmlUnescape', () => {
    it('escapes the five XML special characters', () => {
      expect(xmlEscape(`<a> & "b" 'c'`)).toBe('&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;')
    })

    it('round-trips escape/unescape', () => {
      const original = `Tom & Jerry's <show> "live"`
      expect(xmlUnescape(xmlEscape(original))).toBe(original)
    })
  })

  describe('tag', () => {
    it('builds a leaf element and escapes its value', () => {
      expect(tag('name', 'A & B')).toBe('<name>A &amp; B</name>')
      expect(tag('enabled', true)).toBe('<enabled>true</enabled>')
      expect(tag('priority', 7)).toBe('<priority>7</priority>')
    })
  })

  describe('extractElement', () => {
    it('finds a simple element', () => {
      expect(extractElement('<a><name>X</name></a>', 'name')).toBe('<name>X</name>')
    })

    it('returns null when the tag is absent', () => {
      expect(extractElement('<a><other>X</other></a>', 'name')).toBeNull()
    })

    it('handles a self-closing element', () => {
      expect(extractElement('<a><name/></a>', 'name')).toBe('<name/>')
    })

    it('matches to the FIRST balanced close, not an inner text collision', () => {
      const xml = '<general><name>Policy</name><enabled>true</enabled></general>'
      expect(extractElement(xml, 'general')).toBe(xml)
    })

    it('returns the first of two sibling occurrences (scoped extraction is the caller\'s job)', () => {
      const xml = '<scope><computer_groups><computer_group><id>1</id></computer_group></computer_groups></scope>' +
        '<exclusions><computer_groups><computer_group><id>2</id></computer_group></computer_groups></exclusions>'
      const first = extractElement(xml, 'computer_groups')
      expect(first).toContain('<id>1</id>')
      expect((first ?? '').includes('<id>2</id>')).toBeFalsy()
    })
  })

  describe('extractText', () => {
    it('returns unescaped, trimmed inner text', () => {
      expect(extractText('<name>  Tom &amp; Jerry  </name>', 'name')).toBe('Tom & Jerry')
    })

    it('returns empty string for a self-closing element', () => {
      expect(extractText('<is_smart/>', 'is_smart')).toBe('')
    })

    it('returns empty string when absent', () => {
      expect(extractText('<a></a>', 'missing')).toBe('')
    })
  })

  describe('extractAll', () => {
    it('collects every top-level occurrence in document order', () => {
      const xml = '<criteria><criterion><name>A</name></criterion><criterion><name>B</name></criterion></criteria>'
      const all = extractAll(xml, 'criterion')
      expect(all).toHaveLength(2)
      expect(extractText(all[0], 'name')).toBe('A')
      expect(extractText(all[1], 'name')).toBe('B')
    })

    it('returns an empty array when the tag never occurs', () => {
      expect(extractAll('<criteria></criteria>', 'criterion')).toEqual([])
    })
  })

  describe('setLeaf', () => {
    it('replaces an existing leaf in place', () => {
      const block = '<general><name>Old</name><enabled>false</enabled></general>'
      const updated = setLeaf(block, 'name', 'New', '</general>')
      expect(updated).toBe('<general><name>New</name><enabled>false</enabled></general>')
    })

    it('appends a missing leaf just before the container close tag', () => {
      const block = '<general><name>Policy</name></general>'
      const updated = setLeaf(block, 'frequency', 'Ongoing', '</general>')
      expect(updated).toBe('<general><name>Policy</name><frequency>Ongoing</frequency></general>')
    })
  })

  describe('replaceTopLevelElement', () => {
    it('replaces an existing top-level element, leaving siblings untouched', () => {
      const xml = '<policy><general><name>A</name></general><scope><all_computers>false</all_computers></scope></policy>'
      const updated = replaceTopLevelElement(xml, 'scope', '<scope><all_computers>true</all_computers></scope>', '</policy>')
      expect(updated).toBe(
        '<policy><general><name>A</name></general><scope><all_computers>true</all_computers></scope></policy>',
      )
    })

    it('inserts a missing element before the root close tag', () => {
      const xml = '<policy><general><name>A</name></general></policy>'
      const updated = replaceTopLevelElement(xml, 'scripts', '<scripts></scripts>', '</policy>')
      expect(updated).toBe('<policy><general><name>A</name></general><scripts></scripts></policy>')
    })
  })

  describe('parseIdNameList / indexRefsByName / refXml', () => {
    const listXml =
      '<computer_groups><size>2</size>' +
      '<computer_group><id>1</id><name>Fleet A</name><is_smart>true</is_smart></computer_group>' +
      '<computer_group><id>2</id><name>Fleet B</name><is_smart>false</is_smart></computer_group>' +
      '</computer_groups>'

    it('parses every item into {id, name}', () => {
      const refs = parseIdNameList(listXml, 'computer_group')
      expect(refs).toEqual([
        { id: '1', name: 'Fleet A' },
        { id: '2', name: 'Fleet B' },
      ])
    })

    it('indexes refs by name case-insensitively, first match wins', () => {
      const byName = indexRefsByName([
        { id: '1', name: 'Dup' },
        { id: '2', name: 'dup' },
      ])
      expect(byName.get('dup')?.id).toBe('1')
      expect(byName.size).toBe(1)
    })

    it('builds a resolved reference element', () => {
      expect(refXml('computer_group', { id: '9', name: 'Fleet & Co' })).toBe(
        '<computer_group><id>9</id><name>Fleet &amp; Co</name></computer_group>',
      )
    })
  })

  describe('classicErrorMessage', () => {
    it('strips HTML tags and collapses whitespace', () => {
      const html = '<html><head><title>Error</title></head><body>  Unauthorized \n access  </body></html>'
      expect(classicErrorMessage(401, html)).toBe('HTTP 401: Error Unauthorized access')
    })

    it('falls back to a bare status when the body is empty', () => {
      expect(classicErrorMessage(500, '')).toBe('HTTP 500')
    })

    it('truncates a very long body', () => {
      const long = 'x'.repeat(400)
      const msg = classicErrorMessage(400, long)
      expect(msg.length <= 320).toBeTruthy()
      expect(msg).toContain('...')
    })
  })
})
