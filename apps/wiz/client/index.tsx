import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'wiz',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/wiz/overview', label: 'Overview', icon: 'cloud' },
    { path: '/apps/wiz/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/wiz/connections', label: 'Connections', icon: 'link' },
  ],
}
