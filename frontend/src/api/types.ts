export type Role = 'admin' | 'manager' | 'analyst' | 'branch_user'

// Data-scope hierarchy levels: HO sees all; others see their slice.
export type ScopeLevel = 'ho' | 'zone' | 'cluster' | 'region' | 'area' | 'branch' | 'lo'

export interface User {
  id: number
  username: string
  full_name: string
  role: Role
  scope_level?: ScopeLevel | null
  scope_value?: string | null          // comma-separated for multi
  allowed_reports?: string[]           // ['*'] = all reports
  cluster_id?: string | null
  region_id?: string | null
  area_id?: string | null
  branch_id?: string | null
  is_active: boolean
  last_login?: string | null
}

export interface ReportCatalogItem {
  key: string
  label: string
  path: string
}

export interface ScopeOption {
  value: string
  label: string
}

export interface LoginRequest {
  username: string
  password: string
}

export interface AuthResponse {
  access_token: string
  token_type: string
  user: User
}

export interface AumKpis {
  total_pos: number
  total_loans: number
  par0_pos: number
  par0_pct: number
  par30_pos: number
  par30_pct: number
  par60_pos: number
  par60_pct: number
  par90_pos: number
  par90_pct: number
  wo_pos: number
  wo_count: number
}

export interface SegmentRow {
  segment: string
  pos: number
  loans: number
  par0_pct: number
  par30_pct: number
  par60_pct: number
  par90_pct: number
}

// Generic group-summary row returned by /aum/group-summary
export interface GroupSummaryRow {
  name: string
  name2?: string        // set when group_by_2 (AP#2) is active
  pos: number
  loans: number
  par0_pct: number
  par30_pct: number
  par60_pct: number
  par90_pct: number
}

export interface BucketByBranch {
  branch_name: string
  dpd_bucket: string
  pos: number
  loans: number
}

export interface ParByBranch {
  branch: string
  total_pos: number
  par0: number
  par30: number
  par90: number
  par0_pct: number
  par30_pct: number
  par90_pct: number
}

export interface AumStatusRow {
  cluster_name: string
  region_name: string
  area_name: string
  branch_name: string
  loan_source: string
  portfolio_type: string
  dpd_bucket: string
  loan_count: number
  total_pos: number
  par0_pos: number
  par30_pos: number
  par60_pos: number
  par90_pos: number
  writeoff_pos: number
}

export interface HierarchyOptions {
  clusters: string[]
  regions: string[]
  areas: string[]
  branches: string[]
}

export interface UserCreate {
  username: string
  password: string
  full_name: string
  role: Role
  scope_level?: ScopeLevel | ''
  scope_value?: string
  reports?: string[]        // undefined/[] = all reports allowed
  cluster_id?: string
  region_id?: string
  area_id?: string
  branch_id?: string
}

export interface UserUpdate {
  full_name?: string
  role?: Role
  is_active?: boolean
  password?: string
  scope_level?: ScopeLevel | ''   // '' or 'ho' clears the scope
  scope_value?: string
  reports?: string[]              // undefined = unchanged; [] = all allowed
  cluster_id?: string
  region_id?: string
  area_id?: string
  branch_id?: string
}
