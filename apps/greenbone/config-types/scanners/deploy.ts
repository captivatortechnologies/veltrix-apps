import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, parseGmpStatus, parseCreatedId, GmpError, type GmpSession } from '../../lib/greenboneApi'
import { buildGetScannersFullCommand, buildCreateScannerCommand, buildModifyScannerCommand, parseScannersFull } from '../../lib/gmp/scanners'
import { buildScannerInput, findScannerByName } from './_shared'

/**
 * Deploy Greenbone scanners over GMP (XML over TLS, 9390):
 *   read:   <get_scanners filter="rows=-1"/>            → find by name
 *   create: <create_scanner>…</create_scanner>          → new id on the response
 *   update: <modify_scanner scanner_id="…">…             (always resends every
 *           field — see lib/gmp/scanners.ts's FLAG on modify_scanner's RNC)
 *
 * The scanner NAME is the stable identity used to upsert. rollbackData
 * records, per scanner, whether we CREATED it (rollback deletes it) or
 * MODIFIED an existing one (recording the prior fields so rollback can
 * restore them).
 */
interface Prior {
  name: string
  scannerId: string
  created: boolean
  restore: { name: string; host: string; port: number; type: string; caPub: string; credentialId: string; comment: string } | null
}

async function listScanners(session: GmpSession) {
  return parseScannersFull(await session.send(buildGetScannersFullCommand()))
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential || !credential.username || !credential.password) {
    return { success: false, message: 'Greenbone deploy needs a connection credential with a username and password.' }
  }

  const previous: Prior[] = []
  const applied: string[] = []

  try {
    return await withGmpSession(
      { host: resolveGmpHost(component, connectivity), port: resolveGmpPort(component) },
      { username: credential.username, password: credential.password },
      async (session) => {
        const live = await listScanners(session)

        for (const item of items) {
          const input = buildScannerInput(item.fields)
          if (!input.name || !input.host || !input.credentialId) continue

          const existing = findScannerByName(live, input.name)
          if (existing) {
            const st = parseGmpStatus(await session.send(buildModifyScannerCommand(existing.id, input)))
            if (!st.ok) throw new GmpError(`modify_scanner "${input.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            previous.push({
              name: input.name,
              scannerId: existing.id,
              created: false,
              restore: {
                name: existing.name,
                host: existing.host,
                port: Number(existing.port) || input.port,
                type: existing.type,
                caPub: existing.caPub,
                credentialId: existing.credentialId,
                comment: existing.comment,
              },
            })
          } else {
            const raw = await session.send(buildCreateScannerCommand(input))
            const st = parseGmpStatus(raw)
            const newId = parseCreatedId(raw)
            if (!st.ok || !newId) throw new GmpError(`create_scanner "${input.name}" failed (status ${st.status}: ${st.statusText})`, st.status, st.statusText)
            previous.push({ name: input.name, scannerId: newId, created: true, restore: null })
          }
          applied.push(input.name)
        }

        return {
          success: true,
          message: `Applied ${applied.length} scanner(s): ${applied.join(', ') || '(none)'}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      },
    )
  } catch (error) {
    return {
      success: false,
      message: `Scanner deploy failed after ${applied.length} scanner(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
