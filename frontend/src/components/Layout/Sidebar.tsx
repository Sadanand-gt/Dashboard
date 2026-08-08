import { useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import { useFilterStore } from '../../store/filterStore'
import { canSeePath } from '../../lib/reportAccess'
import Box from '@mui/material/Box'
import Tooltip from '@mui/material/Tooltip'
import Divider from '@mui/material/Divider'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'

import DashboardIcon from '@mui/icons-material/Dashboard'
import AccountBalanceIcon from '@mui/icons-material/AccountBalance'
import CalendarTodayIcon from '@mui/icons-material/CalendarToday'
import BarChartIcon from '@mui/icons-material/BarChart'
import AttachMoneyIcon from '@mui/icons-material/AttachMoney'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import PeopleIcon from '@mui/icons-material/People'
import LogoutIcon from '@mui/icons-material/Logout'
import BoltIcon from '@mui/icons-material/Bolt'
import SwapVertIcon from '@mui/icons-material/SwapVert'
import ReportProblemIcon from '@mui/icons-material/ReportProblem'
import CategoryIcon from '@mui/icons-material/Category'
import MoveDownIcon from '@mui/icons-material/MoveDown'
import CreditCardIcon from '@mui/icons-material/CreditCard'
import ShowChartIcon from '@mui/icons-material/ShowChart'
import GppMaybeIcon from '@mui/icons-material/GppMaybe'
import HandshakeIcon from '@mui/icons-material/Handshake'
import PieChartIcon from '@mui/icons-material/PieChart'
import FactCheckIcon from '@mui/icons-material/FactCheck'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import MenuIcon from '@mui/icons-material/Menu'

// Sidebar colours — soft grey shell (NBFC-standard, pairs with white content)
const BG      = '#E2E7EE'
const BG_DARK = '#D8DEE8'
const ACTIVE  = 'rgba(21,101,192,0.12)'   // blue tint for active item
const HOVER   = 'rgba(15,23,42,0.05)'
const TEXT    = '#334155'                  // slate-700
const MUTED   = '#64748B'                  // slate-500
const BORDER  = 'rgba(15,23,42,0.10)'

interface NavItem {
  label: string
  path: string
  icon: React.ReactNode
  roles?: string[]
}

// Page access is controlled per user by the report whitelist (canSeePath) —
// NOT by role. Roles only gate the Administration section below.
const NAV_ITEMS: NavItem[] = [
  { label: 'Executive Summary',   path: '/dashboard',                icon: <DashboardIcon fontSize="small" /> },
  { label: 'Current Outstanding', path: '/dashboard/aum',            icon: <AccountBalanceIcon fontSize="small" /> },
  { label: 'AUM — DPD Detail',    path: '/dashboard/aum-live',       icon: <BoltIcon fontSize="small" /> },
  { label: 'Ageing Analysis',     path: '/dashboard/ageing',         icon: <ShowChartIcon fontSize="small" /> },
  { label: 'OD Status',           path: '/dashboard/od-status',      icon: <ReportProblemIcon fontSize="small" /> },
  { label: 'OD Slippage',         path: '/dashboard/od-slippage',    icon: <MoveDownIcon fontSize="small" /> },
  { label: 'DQ Category',         path: '/dashboard/dq-category',    icon: <CategoryIcon fontSize="small" /> },
  { label: 'T-1 Collection',      path: '/dashboard/daily',          icon: <CalendarTodayIcon fontSize="small" /> },
  { label: 'MTD Collection',      path: '/dashboard/mtd',            icon: <BarChartIcon fontSize="small" /> },
  { label: 'Cashless Collection', path: '/dashboard/cashless',       icon: <CreditCardIcon fontSize="small" /> },
  { label: 'Disbursement',        path: '/dashboard/disbursement',   icon: <AttachMoneyIcon fontSize="small" /> },
  { label: 'POS & PAR',           path: '/dashboard/pos-par',        icon: <TrendingUpIcon fontSize="small" /> },
  { label: 'Delinquencies',       path: '/dashboard/delinquencies',  icon: <ReportProblemIcon fontSize="small" /> },
  { label: 'Bucket Movement',     path: '/dashboard/bucket-movement',icon: <SwapVertIcon fontSize="small" /> },
  { label: 'Case Movement',       path: '/dashboard/case-movement',  icon: <MoveDownIcon fontSize="small" /> },
  { label: 'Write-Off',           path: '/dashboard/writeoff',       icon: <WarningAmberIcon fontSize="small" /> },
  { label: 'Monthly Trend',       path: '/dashboard/trend',          icon: <ShowChartIcon fontSize="small" /> },
  { label: 'AML Risk Category',   path: '/dashboard/aml',            icon: <GppMaybeIcon fontSize="small" /> },
  { label: 'OTS & Recovery',      path: '/dashboard/ots',            icon: <HandshakeIcon fontSize="small" /> },
  { label: 'Portfolio Cuts',      path: '/dashboard/portfolio-cuts', icon: <PieChartIcon fontSize="small" /> },
  { label: 'Credit Bureau',       path: '/dashboard/credit-bureau',  icon: <FactCheckIcon fontSize="small" /> },
]

const ADMIN_ITEMS: NavItem[] = [
  { label: 'User Management', path: '/dashboard/admin/users', icon: <PeopleIcon fontSize="small" />, roles: ['admin'] },
]

// Badge shows the user's DATA SCOPE (what slice of the organisation they
// see), not their app role — a CEO with HO-wide access reads "HO User".
type BadgeColor = 'error' | 'warning' | 'info' | 'success' | 'default'
const SCOPE_BADGE: Record<string, { label: string; color: BadgeColor }> = {
  ho:      { label: 'HO User',      color: 'info' },
  zone:    { label: 'Zone User',    color: 'warning' },
  cluster: { label: 'Cluster User', color: 'warning' },
  region:  { label: 'Region User',  color: 'warning' },
  area:    { label: 'Area User',    color: 'success' },
  branch:  { label: 'Branch User',  color: 'success' },
  lo:      { label: 'LO User',      color: 'default' },
}

function scopeBadge(user: { scope_level?: string | null; role: string } | null) {
  if (!user) return null
  const lvl = (user.scope_level || '').toLowerCase()
  return SCOPE_BADGE[lvl] ?? SCOPE_BADGE.ho   // no scope (or admin) = HO-wide
}

export function Sidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, clearAuth } = useAuthStore()
  const { sidebarOpen, setSidebarOpen } = useFilterStore()

  const isActive = (path: string) =>
    path === '/dashboard'
      ? location.pathname === '/dashboard'
      : location.pathname.startsWith(path)

  // Visible = role allows it AND the report is enabled for this user
  const visibleItems = NAV_ITEMS.filter(
    (item) =>
      (!item.roles || (user && item.roles.includes(user.role))) &&
      canSeePath(user, item.path),
  )
  const visibleAdmin = ADMIN_ITEMS.filter(
    (item) => !item.roles || (user && item.roles.includes(user.role)),
  )

  // ── Collapsed (icon-only) mode ──────────────────────────────────────────────
  if (!sidebarOpen) {
    return (
      <Box
        component="aside"
        sx={{
          width: 56,
          minWidth: 56,
          flexShrink: 0,
          background: `linear-gradient(180deg, ${BG} 0%, ${BG_DARK} 100%)`,
          borderRight: `1px solid ${BORDER}`,
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
        }}
      >
        {/* Expand toggle */}
        <Box sx={{ p: 1, display: 'flex', justifyContent: 'center', borderBottom: `1px solid ${BORDER}` }}>
          <Tooltip title="Expand sidebar" placement="right">
            <IconButton size="small" onClick={() => setSidebarOpen(true)} sx={{ color: TEXT }}>
              <ChevronRightIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>

        {/* Icon-only nav */}
        <Box sx={{ flex: 1, overflowY: 'auto', py: 1 }}>
          {visibleItems.map((item) => (
            <Tooltip key={item.path} title={item.label} placement="right">
              <Box
                onClick={() => navigate(item.path)}
                sx={{
                  display: 'flex',
                  justifyContent: 'center',
                  py: 1.2,
                  cursor: 'pointer',
                  color: isActive(item.path) ? TEXT : MUTED,
                  background: isActive(item.path) ? ACTIVE : 'transparent',
                  borderLeft: isActive(item.path) ? '3px solid #1565C0' : '3px solid transparent',
                  '&:hover': { background: HOVER, color: TEXT },
                }}
              >
                {item.icon}
              </Box>
            </Tooltip>
          ))}
        </Box>

        {/* User avatar */}
        <Box sx={{ p: 1, display: 'flex', justifyContent: 'center', borderTop: `1px solid ${BORDER}` }}>
          <Tooltip title={`${user?.full_name} — Sign out`} placement="right">
            <Box
              onClick={() => { clearAuth(); navigate('/login') }}
              sx={{
                width: 32, height: 32, borderRadius: '50%', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                background: 'rgba(21,101,192,0.12)', color: '#1565C0',
                fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer',
                '&:hover': { background: 'rgba(21,101,192,0.2)' },
              }}
            >
              {user?.full_name?.[0]?.toUpperCase() ?? 'U'}
            </Box>
          </Tooltip>
        </Box>
      </Box>
    )
  }

  // ── Expanded mode ───────────────────────────────────────────────────────────
  const roleBadge = scopeBadge(user)

  return (
    <Box
      component="aside"
      className="flex flex-col h-full"
      sx={{
        width: 220,
        minWidth: 220,
        flexShrink: 0,
        background: `linear-gradient(180deg, ${BG} 0%, ${BG_DARK} 100%)`,
        borderRight: `1px solid ${BORDER}`,
      }}
    >
      {/* Logo + collapse toggle */}
      <Box
        className="flex items-center justify-between px-4 py-4"
        sx={{ borderBottom: `1px solid ${BORDER}` }}
      >
        <Box>
          <Box sx={{ fontSize: '0.78rem', fontWeight: 700, letterSpacing: '0.12em', color: TEXT, textTransform: 'uppercase' }}>
            Ananya Finance
          </Box>
          <Box sx={{ fontSize: '0.68rem', color: MUTED, mt: 0.3 }}>MIS Dashboard</Box>
        </Box>
        <Tooltip title="Collapse sidebar">
          <IconButton size="small" onClick={() => setSidebarOpen(false)} sx={{ color: MUTED, '&:hover': { color: TEXT } }}>
            <ChevronLeftIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Main nav */}
      <Box className="flex-1 py-2 overflow-y-auto">
        <Box sx={{ px: 3, pb: 1, fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.1em', color: MUTED, textTransform: 'uppercase' }}>
          Reports
        </Box>
        {visibleItems.map((item) => (
          <NavLink
            key={item.path}
            item={item}
            active={isActive(item.path)}
            onClick={() => navigate(item.path)}
          />
        ))}

        {visibleAdmin.length > 0 && (
          <>
            <Divider sx={{ borderColor: BORDER, my: 1.5, mx: 2 }} />
            <Box sx={{ px: 3, pb: 1, fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.1em', color: MUTED, textTransform: 'uppercase' }}>
              Administration
            </Box>
            {visibleAdmin.map((item) => (
              <NavLink
                key={item.path}
                item={item}
                active={isActive(item.path)}
                onClick={() => navigate(item.path)}
              />
            ))}
          </>
        )}
      </Box>

      <Divider sx={{ borderColor: BORDER }} />

      {/* User footer */}
      <Box sx={{ px: 3, py: 3 }}>
        <Box className="flex items-center gap-2 mb-3">
          <Box
            sx={{
              width: 32, height: 32, borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(21,101,192,0.12)', color: '#1565C0',
              fontSize: '0.8rem', fontWeight: 700,
            }}
          >
            {user?.full_name?.[0]?.toUpperCase() ?? 'U'}
          </Box>
          <Box className="min-w-0">
            <Box sx={{ fontSize: '0.78rem', fontWeight: 600, color: TEXT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.full_name}
            </Box>
            {roleBadge && (
              <Chip
                label={roleBadge.label}
                color={roleBadge.color}
                size="small"
                sx={{ height: 16, fontSize: '0.6rem', mt: 0.3 }}
              />
            )}
          </Box>
        </Box>
        <Box
          onClick={() => { clearAuth(); navigate('/login') }}
          className="flex items-center gap-2 cursor-pointer py-1 transition-colors"
          sx={{ fontSize: '0.72rem', color: MUTED, '&:hover': { color: TEXT } }}
        >
          <LogoutIcon sx={{ fontSize: 14 }} />
          Sign out
        </Box>
      </Box>
    </Box>
  )
}

function NavLink({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  return (
    <Box
      onClick={onClick}
      className="flex items-center gap-3 cursor-pointer transition-all duration-150"
      sx={{
        px: 3, py: 1.1, mx: 1, my: 0.2, borderRadius: 1.5,
        fontSize: '0.8rem',
        color: active ? TEXT : MUTED,
        backgroundColor: active ? ACTIVE : 'transparent',
        borderLeft: active ? '3px solid #1565C0' : '3px solid transparent',
        fontWeight: active ? 600 : 400,
        '&:hover': { backgroundColor: HOVER, color: TEXT },
      }}
    >
      <Box sx={{ display: 'flex', opacity: active ? 1 : 0.8 }}>{item.icon}</Box>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
    </Box>
  )
}
