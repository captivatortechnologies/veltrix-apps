import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'tines',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/tines/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/tines/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/tines/connections', label: 'Connections', icon: 'link' },
  ],
}
