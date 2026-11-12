import { capabilityFor } from './capabilities'
import { graphErrorMessage, parseJson, type GraphClient } from './graph'

export async function probeSelectedFeatures(client: GraphClient, selected: string[], targets: Record<string, Record<string,string>> = {}) {
  const checks: Array<{ feature: string; ok: boolean; detail: string }> = []
  for (const id of [...new Set(selected)]) {
    const cap = capabilityFor(id)
    if (!cap) { checks.push({ feature: id, ok: false, detail: `Unknown configuration type: ${id}` }); continue }
    if (!cap.appOnly) { checks.push({ feature: id, ok: false, detail: cap.unsupportedReason! }); continue }
    const missing:string[]=[]
    const probe=cap.probe.replace(/\{(parentId|resourceId)\}/g,(_match,key:string)=>{
      const value=targets[id]?.[key]
      if(!value || !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,511}$/.test(value)){missing.push(key);return ''}
      return encodeURIComponent(value)
    })
    if(missing.length){checks.push({feature:id,ok:false,detail:`${cap.name}: set readiness_targets.${id} with ${missing.join(', ')} to verify this scoped feature`});continue}
    let response = await client.get(probe)
    if (id === 'organizational-branding' && response.ok) {
      const org = parseJson<{ value?: Array<{ id?: string }> }>(response.body)?.value?.[0]?.id
      response = org ? await client.request('GET', `/organization/${encodeURIComponent(org)}/branding?$select=id`, undefined, { headers: { 'Accept-Language': '0' } })
        : { ...response, ok: false, body: 'Organization response missing id' }
    }
    checks.push({ feature: id, ok: response.ok, detail: response.ok
      ? `${cap.name}: read access verified; writes and licensing unverified. Required writes: ${cap.writePermissions.join(', ')}.`
      : `${cap.name}: ${response.stage ?? 'Graph'} HTTP ${response.status}: ${graphErrorMessage(response)}. Check read permission ${cap.readPermissions.join(', ')} and admin consent.` })
  }
  return checks
}
