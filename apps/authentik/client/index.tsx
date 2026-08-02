import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))
const BYOLPage = React.lazy(() => import('./pages/BYOLPage'))

export default {
  id: 'authentik',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage, BYOLPage },
  sidebarItems: [
    { path: '/apps/authentik/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/authentik/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/authentik/connections', label: 'Connections', icon: 'link' },
    { path: '/apps/authentik/byol', label: 'Infrastructure', icon: 'server' },
  ],
}
