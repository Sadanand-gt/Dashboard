import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import { PrivateRoute } from './auth/PrivateRoute'
import { AppShell } from './components/Layout/AppShell'
import { Login } from './pages/Login'
import { AumStatus } from './pages/AumStatus'
import { DailyCollection } from './pages/DailyCollection'
import { MtdCollection } from './pages/MtdCollection'
import { Disbursement } from './pages/Disbursement'
import { Ageing } from './pages/Ageing'
import { OdStatus } from './pages/OdStatus'
import { DqCategory } from './pages/DqCategory'
import { OdSlippage } from './pages/OdSlippage'
import { PosPar } from './pages/PosPar'
import { WriteOff } from './pages/WriteOff'
import { AumLive } from './pages/AumLive'
import { BucketMovement } from './pages/BucketMovement'
import { Delinquencies } from './pages/Delinquencies'
import { CaseMovement } from './pages/CaseMovement'
import { Cashless } from './pages/Cashless'
import { TrendMonthly } from './pages/TrendMonthly'
import { AmlRiskCategory } from './pages/AmlRiskCategory'
import { Ots } from './pages/Ots'
import { PortfolioCuts } from './pages/PortfolioCuts'
import { CreditBureau } from './pages/CreditBureau'
import { UserManagement } from './pages/admin/UserManagement'
import { Summary } from './pages/Summary'

export default function App() {
  const { isAuthenticated } = useAuthStore()

  return (
    <Routes>
      {/* Public */}
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <Login />}
      />

      {/* All authenticated users — page access is governed per user by the
          report whitelist (AppShell's canSeePath guard), NOT by role. */}
      <Route element={<PrivateRoute />}>
        <Route element={<AppShell />}>
          <Route path="/dashboard" element={<Summary />} />
          <Route path="/dashboard/aum" element={<AumStatus />} />
          <Route path="/dashboard/daily" element={<DailyCollection />} />
          <Route path="/dashboard/mtd" element={<MtdCollection />} />
          <Route path="/dashboard/disbursement" element={<Disbursement />} />
          <Route path="/dashboard/ageing" element={<Ageing />} />
          <Route path="/dashboard/od-status" element={<OdStatus />} />
          <Route path="/dashboard/dq-category" element={<DqCategory />} />
          <Route path="/dashboard/od-slippage" element={<OdSlippage />} />
          <Route path="/dashboard/pos-par" element={<PosPar />} />
          <Route path="/dashboard/writeoff" element={<WriteOff />} />
          <Route path="/dashboard/aum-live" element={<AumLive />} />
          <Route path="/dashboard/bucket-movement" element={<BucketMovement />} />
          <Route path="/dashboard/delinquencies" element={<Delinquencies />} />
          <Route path="/dashboard/case-movement" element={<CaseMovement />} />
          <Route path="/dashboard/cashless" element={<Cashless />} />
          <Route path="/dashboard/trend" element={<TrendMonthly />} />
          <Route path="/dashboard/aml" element={<AmlRiskCategory />} />
          <Route path="/dashboard/ots" element={<Ots />} />
          <Route path="/dashboard/portfolio-cuts" element={<PortfolioCuts />} />
          <Route path="/dashboard/credit-bureau" element={<CreditBureau />} />
        </Route>
      </Route>

      {/* Admin only */}
      <Route element={<PrivateRoute allowedRoles={['admin']} />}>
        <Route element={<AppShell />}>
          <Route path="/dashboard/admin/users" element={<UserManagement />} />
        </Route>
      </Route>

      {/* Fallback */}
      <Route
        path="/"
        element={<Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />}
      />
      <Route
        path="*"
        element={<Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />}
      />
    </Routes>
  )
}
