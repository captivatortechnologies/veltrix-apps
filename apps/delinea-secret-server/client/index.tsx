import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'delinea-secret-server',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/delinea-secret-server/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/delinea-secret-server/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/delinea-secret-server/connections', label: 'Connections', icon: 'link' },
  ],
}
