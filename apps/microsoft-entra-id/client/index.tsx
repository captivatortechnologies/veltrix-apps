// =============================================================================
// App Client Entry Point
//
// Export one component per page declared in manifest.yaml (`client.pages[].component`).
// The platform renders the chrome around them — breadcrumb, app header, sidebar
// entry / tabs, permission gating, loading and error states — so every app
// navigates predictably. Your components render the page body.
//
// Build page bodies from @veltrixsecops/ui so they inherit the tenant's theme
// (light/dark) automatically. Never import platform internals.
// =============================================================================

import React from 'react'

const Dashboard = React.lazy(() => import('./pages/Dashboard'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'microsoft-entra-id',
  pages: { Dashboard, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/microsoft-entra-id/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/microsoft-entra-id/connections', label: 'Connections', icon: 'link' },
  ],
}
