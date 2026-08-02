import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'checkpoint',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/checkpoint/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/checkpoint/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/checkpoint/connections', label: 'Connections', icon: 'link' },
  ],
}
