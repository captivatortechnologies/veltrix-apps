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
}
