import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'akeyless',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/akeyless/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/akeyless/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/akeyless/connections', label: 'Connections', icon: 'link' },
  ],
}
