import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'microsoft-sentinel',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/microsoft-sentinel/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/microsoft-sentinel/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/microsoft-sentinel/connections', label: 'Connections', icon: 'link' },
  ],
}
