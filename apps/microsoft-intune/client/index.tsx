import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'microsoft-intune',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/microsoft-intune/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/microsoft-intune/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/microsoft-intune/connections', label: 'Connections', icon: 'link' },
  ],
}
