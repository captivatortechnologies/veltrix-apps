import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildNetskopeClient, readNetskopeSettings, resolveNetskopeCredential } from '../../lib/netskope'
import { extractAigApplianceSpecs, type LiveAigAppliance } from './validate'

const BASE = '/aig/appliances'

type Diffs = DriftResult['diffs']

function sortedSig(tokens: string[]): string {
  return [...tokens].sort().join(',')
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractAigApplianceSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveAigAppliance>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((a) => a.name).map((a) => [a.name!.toLowerCase(), a]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.host ?? '') !== spec.host) {
      diffs.push({ field: `${spec.name}.host`, expected: spec.host, actual: live.host ?? '', severity: 'warning' })
    }
    if ((live.ports?.http?.enable === true) !== spec.httpEnable || (live.ports?.http?.port ?? 0) !== spec.httpPort) {
      diffs.push({
        field: `${spec.name}.ports.http`,
        expected: `enable=${spec.httpEnable},port=${spec.httpPort}`,
        actual: `enable=${live.ports?.http?.enable === true},port=${live.ports?.http?.port ?? 0}`,
        severity: 'warning',
      })
    }
    if ((live.ports?.https?.enable === true) !== spec.httpsEnable || (live.ports?.https?.port ?? 0) !== spec.httpsPort) {
      diffs.push({
        field: `${spec.name}.ports.https`,
        expected: `enable=${spec.httpsEnable},port=${spec.httpsPort}`,
        actual: `enable=${live.ports?.https?.enable === true},port=${live.ports?.https?.port ?? 0}`,
        severity: 'warning',
      })
    }
    // Declared entries are resolved names; live entries are ids — compare
    // counts only (avoids false positives on the name-vs-id mismatch).
    if (spec.aiProviders.length !== (live.ai_provider_ids ?? []).length) {
      diffs.push({ field: `${spec.name}.ai_provider_ids`, expected: String(spec.aiProviders.length), actual: String((live.ai_provider_ids ?? []).length), severity: 'warning' })
    }
    if (spec.mcpServers.length !== (live.mcp_server_ids ?? []).length) {
      diffs.push({ field: `${spec.name}.mcp_server_ids`, expected: String(spec.mcpServers.length), actual: String((live.mcp_server_ids ?? []).length), severity: 'warning' })
    }
    const expectedSku = sortedSig(spec.skuAddons.map((a) => `${a.productCode}:${a.quantity ?? 1}`))
    const actualSku = sortedSig((live.sku_addons ?? []).map((a) => `${a.product_code ?? ''}:${a.quantity ?? 1}`))
    if (expectedSku !== actualSku) {
      diffs.push({ field: `${spec.name}.sku_addons`, expected: expectedSku, actual: actualSku, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
