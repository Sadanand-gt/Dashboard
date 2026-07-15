import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import TextField from '@mui/material/TextField'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import Chip from '@mui/material/Chip'
import Tooltip from '@mui/material/Tooltip'
import Alert from '@mui/material/Alert'
import Autocomplete from '@mui/material/Autocomplete'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import Switch from '@mui/material/Switch'
import Divider from '@mui/material/Divider'
import AddIcon from '@mui/icons-material/Add'
import EditIcon from '@mui/icons-material/Edit'
import PersonOffIcon from '@mui/icons-material/PersonOff'
import { api } from '../../api/client'
import type {
  User, UserCreate, UserUpdate, Role, ScopeLevel, ReportCatalogItem, ScopeOption,
} from '../../api/types'

const ROLES: Role[] = ['admin', 'manager', 'analyst', 'branch_user']

const ROLE_COLORS: Record<Role, 'error' | 'warning' | 'info' | 'success'> = {
  admin: 'error',
  manager: 'warning',
  analyst: 'info',
  branch_user: 'success',
}

const ROLE_DESC: Record<Role, string> = {
  admin: 'Full access + user management',
  manager: 'Reports & data as assigned below',
  analyst: 'Reports & data as assigned below',
  branch_user: 'Reports & data as assigned below',
}

// Data-scope hierarchy (top → bottom). HO = unrestricted.
const SCOPE_LEVELS: { value: ScopeLevel; label: string }[] = [
  { value: 'ho',      label: 'HO — full organisation' },
  { value: 'zone',    label: 'Zone' },
  { value: 'cluster', label: 'Cluster' },
  { value: 'region',  label: 'Region' },
  { value: 'area',    label: 'Area / Unit' },
  { value: 'branch',  label: 'Branch' },
  { value: 'lo',      label: 'Loan Officer (LO)' },
]

const SCOPE_LABEL: Record<string, string> = {
  zone: 'Zone', cluster: 'Cluster', region: 'Region',
  area: 'Area', branch: 'Branch', lo: 'LO',
}

type DialogMode = 'create' | 'edit' | null

interface FormState {
  username: string
  password: string
  full_name: string
  role: Role
  scope_level: ScopeLevel
  scope_values: string[]
  all_reports: boolean
  reports: string[]
}

const EMPTY_FORM: FormState = {
  username: '', password: '', full_name: '', role: 'analyst',
  scope_level: 'ho', scope_values: [], all_reports: true, reports: [],
}

export function UserManagement() {
  const qc = useQueryClient()
  const [mode, setMode] = useState<DialogMode>(null)
  const [selected, setSelected] = useState<User | null>(null)
  const [error, setError] = useState('')
  const [form, setForm] = useState<FormState>(EMPTY_FORM)

  const { data: users = [], isLoading } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: () => api.get('/auth/users').then((r) => r.data),
  })

  const { data: catalog = [] } = useQuery<ReportCatalogItem[]>({
    queryKey: ['report-catalog'],
    queryFn: () => api.get('/auth/reports').then((r) => r.data),
  })

  // Scope value options for the currently selected level
  const { data: scopeOptions = [], isLoading: loadingOptions } = useQuery<ScopeOption[]>({
    queryKey: ['scope-options', form.scope_level],
    queryFn: () => api.get(`/auth/scope-options?level=${form.scope_level}`).then((r) => r.data),
    enabled: mode !== null && form.scope_level !== 'ho',
  })

  const createMut = useMutation({
    mutationFn: (body: UserCreate) => api.post('/auth/users', body).then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); closeDialog() },
    onError: (e: unknown) => setError((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Error creating user'),
  })

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: number; body: UserUpdate }) =>
      api.put(`/auth/users/${id}`, body).then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); closeDialog() },
    onError: (e: unknown) => setError((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Error updating user'),
  })

  const deactivateMut = useMutation({
    mutationFn: (id: number) => api.delete(`/auth/users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })

  const openCreate = () => {
    setForm(EMPTY_FORM)
    setError(''); setMode('create')
  }

  const openEdit = (user: User) => {
    setSelected(user)
    const allowed = user.allowed_reports ?? ['*']
    setForm({
      username: user.username,
      password: '',
      full_name: user.full_name,
      role: user.role,
      scope_level: (user.scope_level as ScopeLevel) || 'ho',
      scope_values: user.scope_value ? user.scope_value.split(',').map((v) => v.trim()).filter(Boolean) : [],
      all_reports: allowed.includes('*'),
      reports: allowed.includes('*') ? [] : allowed,
    })
    setError(''); setMode('edit')
  }

  const closeDialog = () => { setMode(null); setSelected(null); setError('') }

  const validate = (): string => {
    if (mode === 'create' && (!form.username || !form.password || !form.full_name))
      return 'Username, password, and full name are required'
    if (form.scope_level !== 'ho' && form.scope_values.length === 0)
      return `Select at least one ${SCOPE_LABEL[form.scope_level] ?? 'scope'} value`
    if (!form.all_reports && form.reports.length === 0)
      return 'Select at least one report (or enable "All reports")'
    return ''
  }

  const handleSave = () => {
    const problem = validate()
    if (problem) { setError(problem); return }
    const scope: Pick<UserUpdate, 'scope_level' | 'scope_value' | 'reports'> = {
      scope_level: form.scope_level === 'ho' ? '' : form.scope_level,
      scope_value: form.scope_level === 'ho' ? '' : form.scope_values.join(','),
      reports: form.all_reports ? [] : form.reports,
    }
    if (mode === 'create') {
      createMut.mutate({
        username: form.username, password: form.password,
        full_name: form.full_name, role: form.role, ...scope,
      })
    } else if (mode === 'edit' && selected) {
      updateMut.mutate({
        id: selected.id,
        body: {
          full_name: form.full_name || undefined,
          role: form.role,
          password: form.password || undefined,
          ...scope,
        },
      })
    }
  }

  const toggleReport = (key: string) =>
    setForm((p) => ({
      ...p,
      reports: p.reports.includes(key)
        ? p.reports.filter((k) => k !== key)
        : [...p.reports, key],
    }))

  const scopeText = (u: User): string => {
    if (u.role === 'admin') return 'All data'
    if (u.scope_level && u.scope_value) {
      const n = u.scope_value.split(',').length
      const label = SCOPE_LABEL[u.scope_level] ?? u.scope_level
      return n === 1 ? `${label}: ${u.scope_value}` : `${label}: ${n} selected`
    }
    if (u.branch_id) return `Branch: ${u.branch_id}` // legacy scope
    return 'All data'
  }

  const reportsText = (u: User): string => {
    const a = u.allowed_reports ?? ['*']
    return a.includes('*') ? 'All reports' : `${a.length} of ${catalog.length || 17}`
  }

  return (
    <Box className="space-y-4">
      <Box className="flex items-center justify-between">
        <Box>
          <Box className="text-sm font-semibold text-text-primary">User Management</Box>
          <Box className="text-xs text-text-muted">
            Control who sees which data (hierarchy scope) and which reports
          </Box>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={openCreate}
          sx={{ fontWeight: 600, fontSize: '0.8rem' }}
        >
          Add User
        </Button>
      </Box>

      {/* RBAC info */}
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
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Username</TableCell>
              <TableCell>Role</TableCell>
              <TableCell>Data Scope</TableCell>
              <TableCell>Reports</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Last Login</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {isLoading
              ? [1, 2, 3].map((i) => (
                  <TableRow key={i}>
                    {[...Array(8)].map((_, j) => <TableCell key={j}><Box sx={{ height: 16, background: 'rgba(46,125,204,0.07)', borderRadius: 1 }} /></TableCell>)}
                  </TableRow>
                ))
              : users.map((user) => (
                  <TableRow key={user.id} sx={{ '&:hover': { backgroundColor: 'rgba(46,125,204,0.06)' }, opacity: user.is_active ? 1 : 0.5 }}>
                    <TableCell sx={{ fontWeight: 600 }}>{user.full_name}</TableCell>
                    <TableCell sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem' }}>{user.username}</TableCell>
                    <TableCell>
                      <Chip label={user.role.replace('_', ' ')} color={ROLE_COLORS[user.role]} size="small" sx={{ fontWeight: 700, fontSize: '0.7rem' }} />
                    </TableCell>
                    <TableCell sx={{ fontSize: '0.75rem', color: '#7FA8D4' }}>{scopeText(user)}</TableCell>
                    <TableCell sx={{ fontSize: '0.75rem', color: '#7FA8D4' }}>{reportsText(user)}</TableCell>
                    <TableCell>
                      <Chip
                        label={user.is_active ? 'Active' : 'Inactive'}
                        size="small"
                        sx={{ height: 18, fontSize: '0.68rem', fontWeight: 700, background: user.is_active ? 'rgba(29,184,122,0.15)' : 'rgba(232,69,69,0.15)', color: user.is_active ? '#1DB87A' : '#E84545' }}
                      />
                    </TableCell>
                    <TableCell sx={{ fontSize: '0.75rem', color: '#7FA8D4' }}>
                      {user.last_login ? new Date(user.last_login).toLocaleDateString('en-IN') : 'Never'}
                    </TableCell>
                    <TableCell align="right">
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={() => openEdit(user)} sx={{ color: '#7FA8D4' }}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      {user.is_active && (
                        <Tooltip title="Deactivate">
                          <IconButton size="small" onClick={() => deactivateMut.mutate(user.id)} sx={{ color: '#E84545' }}>
                            <PersonOffIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </Paper>

      {/* Create / Edit Dialog */}
      <Dialog open={mode !== null} onClose={closeDialog} maxWidth="md" fullWidth
        PaperProps={{ sx: { background: '#112845', border: '1px solid rgba(46,125,204,0.25)' } }}
      >
        <DialogTitle sx={{ borderBottom: '1px solid rgba(46,125,204,0.15)', fontWeight: 700 }}>
          {mode === 'create' ? 'Add New User' : `Edit — ${selected?.full_name}`}
        </DialogTitle>
        <DialogContent sx={{ pt: 3 }}>
          {error && <Alert severity="error" sx={{ mb: 2, fontSize: '0.8rem' }}>{error}</Alert>}

          {/* Identity */}
          <Box className="grid grid-cols-2 gap-3">
            <TextField label="Full Name" value={form.full_name} onChange={(e) => setForm((p) => ({ ...p, full_name: e.target.value }))} fullWidth />
            <TextField label="Username" value={form.username} onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))} fullWidth disabled={mode === 'edit'} />
            <TextField label={mode === 'edit' ? 'New Password (leave blank to keep)' : 'Password'} type="password" value={form.password} onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))} fullWidth required={mode === 'create'} />
            <FormControl fullWidth size="small" sx={{ mt: 0.5 }}>
              <InputLabel>Role</InputLabel>
              <Select value={form.role} label="Role" onChange={(e) => setForm((p) => ({ ...p, role: e.target.value as Role }))}>
                {ROLES.map((r) => <MenuItem key={r} value={r} sx={{ fontSize: '0.875rem' }}>{r.replace('_', ' ')} — {ROLE_DESC[r]}</MenuItem>)}
              </Select>
            </FormControl>
          </Box>

          {/* Data scope */}
          <Divider sx={{ my: 2.5, borderColor: 'rgba(46,125,204,0.15)' }} />
          <Box sx={{ fontSize: '0.8rem', fontWeight: 700, mb: 0.5 }}>Data Scope</Box>
          <Box sx={{ fontSize: '0.72rem', color: '#7FA8D4', mb: 1.5 }}>
            The user only sees data belonging to this level of the hierarchy
            (LO → Branch → Area/Unit → Region → Cluster → Zone → HO). Admins always see everything.
          </Box>
          <Box className="grid grid-cols-2 gap-3">
            <FormControl fullWidth size="small">
              <InputLabel>Scope Level</InputLabel>
              <Select
                value={form.scope_level}
                label="Scope Level"
                disabled={form.role === 'admin'}
                onChange={(e) => setForm((p) => ({ ...p, scope_level: e.target.value as ScopeLevel, scope_values: [] }))}
              >
                {SCOPE_LEVELS.map((l) => (
                  <MenuItem key={l.value} value={l.value} sx={{ fontSize: '0.875rem' }}>{l.label}</MenuItem>
                ))}
              </Select>
            </FormControl>
            {form.scope_level !== 'ho' && form.role !== 'admin' && (
              <Autocomplete
                multiple
                size="small"
                options={scopeOptions}
                loading={loadingOptions}
                getOptionLabel={(o) => o.label}
                isOptionEqualToValue={(o, v) => o.value === v.value}
                value={scopeOptions.filter((o) => form.scope_values.includes(o.value))}
                onChange={(_, sel) => setForm((p) => ({ ...p, scope_values: sel.map((s) => s.value) }))}
                renderInput={(params) => (
                  <TextField {...params} label={`${SCOPE_LABEL[form.scope_level]} value(s)`} placeholder="Search…" />
                )}
              />
            )}
          </Box>

          {/* Report visibility */}
          <Divider sx={{ my: 2.5, borderColor: 'rgba(46,125,204,0.15)' }} />
          <Box className="flex items-center justify-between" sx={{ mb: 0.5 }}>
            <Box>
              <Box sx={{ fontSize: '0.8rem', fontWeight: 700 }}>Report Visibility</Box>
              <Box sx={{ fontSize: '0.72rem', color: '#7FA8D4' }}>
                Choose which reports appear for this user. Admins always see all.
              </Box>
            </Box>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={form.all_reports || form.role === 'admin'}
                  disabled={form.role === 'admin'}
                  onChange={(e) => setForm((p) => ({ ...p, all_reports: e.target.checked }))}
                />
              }
              label={<Box sx={{ fontSize: '0.78rem' }}>All reports</Box>}
            />
          </Box>
          {!form.all_reports && form.role !== 'admin' && (
            <Box className="grid grid-cols-2 md:grid-cols-3" sx={{ mt: 1 }}>
              {catalog.map((r) => (
                <FormControlLabel
                  key={r.key}
                  control={
                    <Checkbox
                      size="small"
                      checked={form.reports.includes(r.key)}
                      onChange={() => toggleReport(r.key)}
                    />
                  }
                  label={<Box sx={{ fontSize: '0.78rem' }}>{r.label}</Box>}
                />
              ))}
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5, borderTop: '1px solid rgba(46,125,204,0.15)' }}>
          <Button onClick={closeDialog} sx={{ color: '#7FA8D4' }}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={createMut.isPending || updateMut.isPending}
            sx={{ fontWeight: 700 }}
          >
            {mode === 'create' ? 'Create User' : 'Save Changes'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
