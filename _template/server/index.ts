// =============================================================================
// App Server Entry Point
//
// This file is loaded by the Veltrix app engine when your app is installed.
// Use it to register custom API routes and event subscriptions.
//
// Pipeline handlers are loaded separately from the pipeline/ directory.
// You don't need to register them here.
// =============================================================================

import type { FastifyInstance } from 'fastify'

interface AppServerContext {
  app: FastifyInstance
  appId: string
  routePrefix: string // e.g. "/api/apps/my-app"
}

export default async function register(ctx: AppServerContext): Promise<void> {
  const { app, routePrefix } = ctx

  // Register custom API routes (beyond what the pipeline provides)
  // These are for app-specific functionality that doesn't go through the canvas.

  app.get(`${routePrefix}/status`, async (request, reply) => {
    return { status: 'ok', appId: ctx.appId }
  })

  // Example: Custom route for app-specific data
  // app.get(`${routePrefix}/dashboard-data`, async (request, reply) => {
  //   // Your custom logic here
  //   return { widgets: [], stats: {} }
  // })
}
