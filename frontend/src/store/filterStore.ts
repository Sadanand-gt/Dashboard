import { useMemo } from 'react'
import { create } from 'zustand'

export interface FilterState {
  selections: Record<string, string[]>
  panelOpen: boolean
  sidebarOpen: boolean
  setSelection: (id: string, values: string[]) => void
  toggleValue: (id: string, value: string) => void
  clearSlicer: (id: string) => void
  clearAll: () => void
  setPanelOpen: (open: boolean) => void
  setSidebarOpen: (open: boolean) => void
  activeCount: () => number
}

export const useFilterStore = create<FilterState>((set, get) => ({
  selections: {},
  panelOpen: true,
  sidebarOpen: true,

  setSelection: (id, values) =>
    set((s) => {
      const next = { ...s.selections }
      if (values.length) next[id] = values
      else delete next[id]
      return { selections: next }
    }),

  toggleValue: (id, value) =>
    set((s) => {
      const cur = s.selections[id] ?? []
      const has = cur.includes(value)
      const values = has ? cur.filter((v) => v !== value) : [...cur, value]
      const next = { ...s.selections }
      if (values.length) next[id] = values
      else delete next[id]
      return { selections: next }
    }),

  clearSlicer: (id) =>
    set((s) => {
      const next = { ...s.selections }
      delete next[id]
      return { selections: next }
    }),

  clearAll: () => set({ selections: {} }),

  setPanelOpen: (open) => set({ panelOpen: open }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  activeCount: () =>
    Object.values(get().selections).filter((v) => v.length > 0).length,
}))

// Maps global slicer ids → API query params (comma-joined multi-select).
const SLICER_TO_PARAM: Record<string, string> = {
  segment:         'segment',
  zone:            'zone',
  cluster:         'cluster',
  region:          'region',
  unit:            'area',
  branch:          'branch',
  prod_class:      'prod_class',
  od_status:       'od_status',
  od_bucket:       'od_bucket',
  od_movement:     'od_movement',
  bucket_movement: 'bucket_movement',
  loan_status:     'loan_status',
  branch_state:    'branch_state',
  district:        'district',
  disb_year:       'disb_year',
  cycle:           'cycle',
  purpose:         'purpose',
  facility:        'facility',
  lender:          'lender',
  caste:           'caste',
  religion:        'religion',
}

/** Build the common API filter params from the active global slicers. */
export function useSlicerParams(): Record<string, string> {
  const selections = useFilterStore((s) => s.selections)
  return useMemo(() => {
    const p: Record<string, string> = {}
    for (const [id, param] of Object.entries(SLICER_TO_PARAM)) {
      const vals = selections[id]
      if (vals && vals.length) p[param] = vals.join(',')
    }
    return p
  }, [selections])
}
