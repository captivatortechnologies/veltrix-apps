// =============================================================================
// App Server Entry Point
//
// This file is loaded by the Veltrix app engine when your app is installed.
// The platform mounts it as a Fastify plugin under /api/apps/<your-app-id>
// with authentication and app-enabled checks already applied.
//
// Pipeline handlers are loaded separately from the pipeline/ directory.
// You don't need to register them here.
// =============================================================================

import type { FastifyInstance } from 'fastify'
import type { AppRouteContext } from '@veltrixsecops/app-sdk'

export default async function registerRoutes(
  fastify: FastifyInstance,
  ctx: AppRouteContext,
): Promise<void> {
  // Routes are relative to the app's prefix (/api/apps/<your-app-id>).

  fastify.get('/status', async (_request, _reply) => {
    return { status: 'ok', appId: ctx.appId }
  })

  // Example: a route guarded by an app permission you declared in manifest.yaml
  // fastify.get('/dashboard-data', {
  //   preHandler: [ctx.hasPermission('configs', 'read')],
  //   handler: async (request, reply) => {
  //     // Read your app's own (prefixed) tables via ctx.db
  //     // const rows = await ctx.db.$queryRawUnsafe('SELECT ... FROM app_myapp_widgets')
  //     return { widgets: [], stats: {} }
  //   },
  // })

  // ---------------------------------------------------------------------------
  // CRUD for an app-MANAGED entity (NOT a pipeline configuration type).
  //
  // Pipeline configuration types are authored in the platform's Configuration
  // Canvas and deployed through validate → deploy → … handlers — your client
  // pages only *list* them. But some apps also own plain records that are NOT
  // deployed to a component (templates, defaults, catalogs, infra inventory).
  // Those you manage yourself with ordinary write routes + an editable page.
  //
  // The pattern (see apps/splunk-enterprise for a real example):
  //   - Gate every route with ctx.hasPermission(<resource>, <action>) using a
  //     resource+actions pair declared under permissions.app in manifest.yaml.
  //   - ALWAYS scope by the caller's customerId — apps are multi-tenant.
  //   - Verify ownership (findFirst by { id, customerId }) before update/delete
  //     so one tenant can never touch another's row.
  //   - Coerce + validate the body yourself; return 400 on bad input.
  //
  // const customerOf = (req: any) => req.user?.customerId ?? null
  //
  // fastify.post('/widgets', {
  //   preHandler: [ctx.hasPermission('widgets', 'write')],
  //   handler: async (request, reply) => {
  //     const customerId = customerOf(request)
  //     if (!customerId) return reply.status(401).send({ error: 'Authentication required' })
  //     const name = String((request.body as any)?.name ?? '').trim()
  //     if (!name) return reply.status(400).send({ error: 'Name is required' })
  //     const created = await ctx.db.appMyappWidget.create({ data: { name, customerId } })
  //     return reply.status(201).send(created)
  //   },
  // })
  //
  // fastify.put('/widgets/:id', {
  //   preHandler: [ctx.hasPermission('widgets', 'write')],
  //   handler: async (request, reply) => {
  //     const customerId = customerOf(request)
  //     const { id } = request.params as { id: string }
  //     const existing = await ctx.db.appMyappWidget.findFirst({ where: { id, customerId } })
  //     if (!existing) return reply.status(404).send({ error: 'Not found' })
  //     const updated = await ctx.db.appMyappWidget.update({ where: { id }, data: { /* ... */ } })
  //     return reply.send(updated)
  //   },
  // })
  //
  // fastify.delete('/widgets/:id', {
  //   preHandler: [ctx.hasPermission('widgets', 'delete')],
  //   handler: async (request, reply) => {
  //     const customerId = customerOf(request)
  //     const { id } = request.params as { id: string }
  //     const existing = await ctx.db.appMyappWidget.findFirst({ where: { id, customerId } })
  //     if (!existing) return reply.status(404).send({ error: 'Not found' })
  //     await ctx.db.appMyappWidget.delete({ where: { id } })
  //     return reply.status(204).send()
  //   },
  // })
}
