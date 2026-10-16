export type Currency = 'USD' | 'CNY'

/** One entry of DeepSeek's GET /user/balance `balance_infos`, as numbers. */
export type Balance = {
  currency: Currency
  total: number
  granted: number
  toppedUp: number
  isAvailable: boolean
}

export type ModelCost = { name: string; cost: number; share: number }

export type KeyView = {
  label: string
  spend: number
  limit: number
  period: 'day' | 'month' | 'total'
  total: number
}

export type ViewStatus = 'loading' | 'ok' | 'no-key' | 'unauthorized' | 'unavailable' | 'error'

/** Everything the status line and the pane draw from. */
export type View = {
  status: ViewStatus
  message: string
  currency: Currency
  balance: Balance | null
  gauge: number | null
  gaugeFull: number | null
  todayReal: number | null
  todayTracked: number
  sinceAt: number | null
  models: ModelCost[]
  key: KeyView | null
  updatedAt: number | null
}

/** The live context window: the last response's input tokens against the window. */
export type ContextView = {
  tokens: number | null
  window: number
  percent: number | null
  /** Recent token readings, oldest first: what the per-prompt bars are drawn from. */
  history: number[]
}

declare module 'claude-code' {
  interface PluginState {
    'deepseek-balance': { view: View | null; context: ContextView | null }
  }
}
