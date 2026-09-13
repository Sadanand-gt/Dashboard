import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import AddIcon from '@mui/icons-material/Add'
import EditIcon from '@mui/icons-material/Edit'
import PersonOffIcon from '@mui/icons-material/PersonOff'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Select from '@mui/material/Select'
import Switch from '@mui/material/Switch'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'

import { api } from '../../api/client'
import type { ReportCatalogItem, Role, User, UserCreate, UserUpdate } from '../../api/types'

const ROLES: Role[] = ['admin', 'manager', 'officer', 'branch_user']
const ROLE_COLORS: Record<Role, 'error' | 'warning' | 'info' | 'success'> = {
  admin: 'error', manager: 'warning', officer: 'info', branch_user: 'success',
}
const ROLE_DESC: Record<Role, string> = {
  admin: 'User management and all reports',
  manager: 'MIS role with assigned reports',
  officer: 'MIS role with assigned reports',
  branch_user: 'MIS role with assigned reports',
}
const SCOPE_LABEL: Record<string, string> = {
  ho: 'HO — all data', zone: 'Zone', cluster: 'Cluster', region: 'Region',
  area: 'Area / Unit', branch: 'Branch', lo: 'Loan Officer',
}

type DialogMode = 'create' | 'edit' | null
interface FormState {
  username: string
  role: Role
  is_active: boolean
  all_reports: boolean
  reports: string[]
  can_export: boolean
}
const EMPTY_FORM: FormState = {
  username: '', role: 'officer', is_active: true, all_reports: true, reports: [],
  can_export: false,
}

function errorDetail(error: unknown, fallback: string): string {
  return (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? fallback
}

export function UserManagement() {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<DialogMode>(null)
  const [selected, setSelected] = useState<User | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [error, setError] = useState('')

  const { data: users = [], isLoading } = useQuery<User[]>({
    queryKey: ['users'], queryFn: () => api.get('/auth/users').then((r) => r.data),
  })
  const { data: catalog = [] } = useQuery<ReportCatalogItem[]>({
    queryKey: ['report-catalog'], queryFn: () => api.get('/auth/reports').then((r) => r.data),
  })

  const closeDialog = () => { setMode(null); setSelected(null); setError('') }
  const createMutation = useMutation({
    mutationFn: (body: UserCreate) => api.post('/auth/users', body),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['users'] }); closeDialog() },
    onError: (e) => setError(errorDetail(e, 'Unable to grant MIS access')),
  })
  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: UserUpdate }) => api.put(`/auth/users/${id}`, body),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['users'] }); closeDialog() },
    onError: (e) => setError(errorDetail(e, 'Unable to update MIS access')),
  })
  const deactivateMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/auth/users/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  })

  const openCreate = () => { setForm(EMPTY_FORM); setError(''); setMode('create') }
  const openEdit = (user: User) => {
    const allowed = user.allowed_reports ?? ['*']
    setSelected(user)
    setForm({
      username: user.username, role: user.role, is_active: user.is_active,
      all_reports: allowed.includes('*'), reports: allowed.includes('*') ? [] : allowed,
      can_export: !!user.can_export,
    })
    setError(''); setMode('edit')
  }
  const save = () => {
    if (mode === 'create' && !form.username.trim()) {
      setError('Enter the exact Ananya Sathi username'); return
    }
    if (!form.all_reports && form.reports.length === 0) {
      setError('Select at least one report, or enable All reports'); return
    }
    const reports = form.all_reports ? [] : form.reports
    if (mode === 'create') {
      createMutation.mutate({
        username: form.username.trim(), role: form.role, reports,
        can_export: form.can_export,
      })
    } else if (selected) {
      updateMutation.mutate({
        id: selected.id,
        body: {
          role: form.role, is_active: form.is_active, reports,
          can_export: form.can_export,
        },
      })
    }
  }
  const toggleReport = (key: string) => setForm((previous) => ({
    ...previous,
    reports: previous.reports.includes(key)
      ? previous.reports.filter((item) => item !== key)
      : [...previous.reports, key],
  }))
  const scopeText = (user: User) => {
    const label = SCOPE_LABEL[user.scope_level ?? ''] ?? user.scope_level ?? 'Unknown'
    return user.scope_value ? `${label}: ${user.scope_value}` : label
  }

  return (
    <Box className="space-y-4">
      <Box className="flex items-center justify-between">
        <Box>
          <Box className="text-sm font-semibold text-text-primary">User Management</Box>
          <Box className="text-xs text-text-muted">
            Login and hierarchy come from Ananya Sathi; MIS roles, reports and sessions are separate.
          </Box>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>Grant MIS Access</Button>
      </Box>

      <Box className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {ROLES.map((role) => (
          <Paper key={role} sx={{ p: 2 }}>
            <Chip label={role.replace('_', ' ')} color={ROLE_COLORS[role]} size="small" sx={{ mb: 1, fontWeight: 700 }} />
            <Box className="text-xs text-text-muted">{ROLE_DESC[role]}</Box>
          </Paper>
        ))}
      </Box>

      <Paper sx={{ overflow: 'auto' }}>
        <Table size="small">
          <TableHead><TableRow>
            <TableCell>Name</TableCell><TableCell>Username</TableCell><TableCell>MIS Role</TableCell>
            <TableCell>Sathi Hierarchy</TableCell><TableCell>Reports</TableCell>
            <TableCell>CSV Export</TableCell><TableCell>Status</TableCell>
            <TableCell>Last Login</TableCell><TableCell align="right">Actions</TableCell>
          </TableRow></TableHead>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={9}>Loading users…</TableCell></TableRow>
            ) : users.map((user) => (
              <TableRow key={user.id} sx={{ opacity: user.is_active ? 1 : 0.5 }}>
                <TableCell sx={{ fontWeight: 600 }}>{user.full_name}</TableCell>
                <TableCell>{user.username}</TableCell>
                <TableCell><Chip label={user.role.replace('_', ' ')} color={ROLE_COLORS[user.role]} size="small" /></TableCell>
                <TableCell sx={{ fontSize: '0.75rem' }}>{scopeText(user)}</TableCell>
                <TableCell sx={{ fontSize: '0.75rem' }}>
                  {(user.allowed_reports ?? ['*']).includes('*') ? 'All reports' : `${user.allowed_reports?.length ?? 0} reports`}
                </TableCell>
                <TableCell><Chip label={user.can_export ? 'Allowed' : 'Off'} size="small" color={user.can_export ? 'success' : 'default'} /></TableCell>
                <TableCell><Chip label={user.is_active ? 'Active' : 'Inactive'} size="small" color={user.is_active ? 'success' : 'default'} /></TableCell>
                <TableCell sx={{ fontSize: '0.75rem' }}>{user.last_login ? new Date(user.last_login).toLocaleString('en-IN') : 'Never'}</TableCell>
                <TableCell align="right">
                  <Tooltip title="Edit MIS access"><IconButton size="small" onClick={() => openEdit(user)}><EditIcon fontSize="small" /></IconButton></Tooltip>
                  {user.is_active && <Tooltip title="Deactivate and revoke sessions"><IconButton size="small" color="error" onClick={() => deactivateMutation.mutate(user.id)}><PersonOffIcon fontSize="small" /></IconButton></Tooltip>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>

      <Dialog open={mode !== null} onClose={closeDialog} maxWidth="md" fullWidth>
        <DialogTitle>{mode === 'create' ? 'Grant MIS Access' : `Edit — ${selected?.full_name}`}</DialogTitle>
        <DialogContent sx={{ pt: 3 }}>
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          <Alert severity="info" sx={{ mb: 2 }}>
            Password and hierarchy are read directly from Ananya Sathi and cannot be changed here.
          </Alert>
          <Box className="grid grid-cols-2 gap-3">
            <TextField
              label="Ananya Sathi username" value={form.username} disabled={mode === 'edit'}
              onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))}
              helperText="Use the exact existing Sathi user ID" fullWidth
            />
            <FormControl fullWidth>
              <InputLabel>MIS Role</InputLabel>
              <Select value={form.role} label="MIS Role" onChange={(e) => setForm((p) => ({ ...p, role: e.target.value as Role }))}>
                {ROLES.map((role) => <MenuItem key={role} value={role}>{role.replace('_', ' ')} — {ROLE_DESC[role]}</MenuItem>)}
              </Select>
            </FormControl>
          </Box>
          {mode === 'edit' && (
            <FormControlLabel sx={{ mt: 1 }} control={<Switch checked={form.is_active} onChange={(e) => setForm((p) => ({ ...p, is_active: e.target.checked }))} />} label="MIS access active" />
          )}

          <Divider sx={{ my: 2.5 }} />
          <Box className="flex items-center justify-between">
            <Box><Box sx={{ fontWeight: 700 }}>Report Visibility</Box><Box className="text-xs text-text-muted">Choose the reports available in this application.</Box></Box>
            <FormControlLabel control={<Switch checked={form.all_reports || form.role === 'admin'} disabled={form.role === 'admin'} onChange={(e) => setForm((p) => ({ ...p, all_reports: e.target.checked }))} />} label="All reports" />
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                     mt: 1.5, pt: 1.5, borderTop: '1px solid #E2E8F0' }}>
            <Box>
              <Box sx={{ fontSize: '0.8rem', fontWeight: 700, color: '#0F172A' }}>CSV export</Box>
              <Box sx={{ fontSize: '0.72rem', color: '#64748B' }}>
                Off by default. Once granted, this user can download report data as a file.
              </Box>
            </Box>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={form.can_export}
                  onChange={(e) => setForm((p) => ({ ...p, can_export: e.target.checked }))}
                />
              }
              label={<Box sx={{ fontSize: '0.78rem' }}>Allow export</Box>}
            />
          </Box>
          {!form.all_reports && form.role !== 'admin' && (
            <Box className="grid grid-cols-2 md:grid-cols-3" sx={{ mt: 1 }}>
              {catalog.map((report) => (
                <FormControlLabel key={report.key} control={<Checkbox checked={form.reports.includes(report.key)} onChange={() => toggleReport(report.key)} />} label={report.label} />
              ))}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="contained" onClick={save} disabled={createMutation.isPending || updateMutation.isPending}>
            {mode === 'create' ? 'Grant Access' : 'Save Changes'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
