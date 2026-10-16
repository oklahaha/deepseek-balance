import type { Balance, ContextView, Currency, KeyView, ModelCost, View } from '../types'
import { contextLine } from './context'

/** DeepSeek list prices per 1M tokens (deepseek-chat and deepseek-reasoner, V3.2). */
const PRICES: Record<Currency, { hit: number; miss: number; out: number }> = {
  USD: { hit: 0.028, miss: 0.28, out: 0.42 },
  CNY: { hit: 0.2, miss: 2, out: 3 },
}

const EPSILON = 0.005

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type KeySpend = {
  day: string
  today: number
  month: string
  thisMonth: number
  total: number
}

/** What the mod keeps in `$.store` across sessions. */
export type Ledger = {
  day: string
  currency: Currency
  /** First balance read today: the base "today's spend" is measured from. */
  dayOpen: number | null
  dayOpenAt: number | null
  /** Balance increases seen today (top-ups, grants), added back to the spend. */
  topUps: number
  last: number | null
  /** Balance right after the latest top-up: what fills the gauge by default. */
  peak: number | null
  /** Tracked cost today by the model that answered. */
  models: Record<string, number>
  keys: Record<string, KeySpend>
  warned: { low?: string; limit?: string }
}

export const emptyLedger = (day: string): Ledger => ({
  day,
  currency: 'USD',
  dayOpen: null,
  dayOpenAt: null,
  topUps: 0,
  last: null,
  peak: null,
  models: {},
  keys: {},
  warned: {},
})

const pad = (n: number) => String(n).padStart(2, '0')

export const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Starts a new day: today's figures reset, the balance history stays. */
export const rollover = (ledger: Ledger, day: string): Ledger =>
  ledger.day === day
    ? ledger
    : { ...ledger, day, dayOpen: null, dayOpenAt: null, topUps: 0, models: {} }

/** Reads DeepSeek's /user/balance body; picks the currency asked for or the funded one. */
export const parseBalance = (text: string, want: string): Balance | null => {
  const body = JSON.parse(text) as {
    is_available?: boolean
    balance_infos?: {
      currency?: string
      total_balance?: string | number
      granted_balance?: string | number
      topped_up_balance?: string | number
    }[]
  }
  const all = (body.balance_infos ?? [])
    .filter(info => info.currency === 'USD' || info.currency === 'CNY')
    .map(info => ({
      currency: info.currency as Currency,
      total: Number(info.total_balance ?? 0),
      granted: Number(info.granted_balance ?? 0),
      toppedUp: Number(info.topped_up_balance ?? 0),
      isAvailable: body.is_available !== false,
    }))
  return (
    all.find(one => one.currency === want) ??
    all.find(one => one.total > 0) ??
    all[0] ??
    null
  )
}

export const applyBalance = (ledger: Ledger, balance: Balance, now: number): Ledger => {
  let next = rollover(ledger, dayKey(now))
  if (next.currency !== balance.currency) {
    // Tracked costs were priced in the other currency: start them over.
    next = { ...emptyLedger(next.day), currency: balance.currency, warned: next.warned }
  }
  const total = balance.total
  let { topUps, peak } = next
  if (next.last !== null && total > next.last + EPSILON) {
    // A top-up: the gauge refills, and today's spend is not reduced by it.
    if (next.dayOpen !== null) topUps += total - next.last
    peak = total
  }
  if (peak === null || total > peak) {
    peak = total
  }
  return {
    ...next,
    dayOpen: next.dayOpen ?? total,
    dayOpenAt: next.dayOpenAt ?? now,
    topUps,
    peak,
    last: total,
  }
}

export const costOf = (usage: Usage, currency: Currency) => {
  const price = PRICES[currency]
  const miss = usage.input_tokens + usage.cache_creation_input_tokens
  return (
    (usage.cache_read_input_tokens * price.hit + miss * price.miss + usage.output_tokens * price.out) /
    1_000_000
  )
}

export const applyUsage = (
  ledger: Ledger,
  model: string,
  usage: Usage,
  keyId: string | null,
  now: number,
): Ledger => {
  const day = dayKey(now)
  const next = rollover(ledger, day)
  const cost = costOf(usage, next.currency)
  const models = { ...next.models, [model]: (next.models[model] ?? 0) + cost }
  if (keyId === null) {
    return { ...next, models }
  }
  const month = day.slice(0, 7)
  const was = next.keys[keyId]
  const spend: KeySpend = {
    day,
    today: (was?.day === day ? was.today : 0) + cost,
    month,
    thisMonth: (was?.month === month ? was.thisMonth : 0) + cost,
    total: (was?.total ?? 0) + cost,
  }
  return { ...next, models, keys: { ...next.keys, [keyId]: spend } }
}

export const keySpendFor = (
  spend: KeySpend | undefined,
  period: KeyView['period'],
  now: number,
) => {
  if (spend === undefined) return 0
  const day = dayKey(now)
  if (period === 'day') return spend.day === day ? spend.today : 0
  if (period === 'month') return spend.month === day.slice(0, 7) ? spend.thisMonth : 0
  return spend.total
}

export type ViewInput = {
  ledger: Ledger
  balance: Balance | null
  status: View['status']
  message: string
  gaugeFull: number
  key: { id: string; label: string } | null
  keyLimit: number
  keyLimitPeriod: KeyView['period']
  now: number
}

export const buildView = (input: ViewInput): View => {
  const { ledger, balance, now } = input
  const current = rollover(ledger, dayKey(now))
  const tracked = Object.values(current.models).reduce((sum, cost) => sum + cost, 0)
  const models: ModelCost[] = Object.entries(current.models)
    .map(([name, cost]) => ({ name, cost, share: tracked > 0 ? cost / tracked : 0 }))
    .sort((a, b) => b.cost - a.cost)
  const full = input.gaugeFull > 0 ? input.gaugeFull : current.peak
  const gauge =
    balance !== null && full !== null && full > 0
      ? Math.max(0, Math.min(1, balance.total / full))
      : null
  const todayReal =
    balance !== null && current.dayOpen !== null && current.last !== null
      ? Math.max(0, current.dayOpen + current.topUps - current.last)
      : null
  const key: KeyView | null =
    input.key === null
      ? null
      : {
          label: input.key.label,
          spend: keySpendFor(current.keys[input.key.id], input.keyLimitPeriod, now),
          limit: input.keyLimit,
          period: input.keyLimitPeriod,
          total: current.keys[input.key.id]?.total ?? 0,
        }
  return {
    status: input.status,
    message: input.message,
    currency: balance?.currency ?? current.currency,
    balance,
    gauge,
    gaugeFull: balance === null ? null : full,
    todayReal,
    todayTracked: tracked,
    sinceAt: current.dayOpenAt,
    models,
    key,
    updatedAt: now,
  }
}

export const money = (amount: number, currency: Currency) => {
  const sign = currency === 'CNY' ? '¥' : '$'
  const digits = Math.abs(amount) >= 0.1 || amount === 0 ? 2 : 3
  return `${sign}${amount.toFixed(digits)}`
}

export const bar = (fraction: number, cells: number) => {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * cells)
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled)
}

/** The one-line summary `/deepseek refresh` prints. */
export const statusLine = (view: View, context: ContextView | null = null) => {
  const cur = view.currency
  // Same order as the band: context, balance, today, top model, key.
  const parts: string[] = ['DeepSeek']
  if (context !== null && context.percent !== null) {
    parts.push(contextLine(context))
  }
  if (view.balance !== null) {
    const gauge =
      view.gauge === null ? '' : ` ${bar(view.gauge, 10)} ${Math.round(view.gauge * 100)}%`
    const dry = view.balance.isAvailable ? '' : ' (insufficient)'
    parts.push(`${money(view.balance.total, cur)}${gauge}${dry}`)
  } else {
    parts.push(view.status === 'loading' ? '…' : view.message)
  }
  if (view.todayReal !== null) {
    parts.push(`today ${money(view.todayReal, cur)}`)
  } else if (view.todayTracked > 0) {
    parts.push(`today ≈${money(view.todayTracked, cur)}`)
  }
  const top = view.models[0]
  if (top !== undefined && top.cost > 0) {
    parts.push(`mostly ${top.name} ${Math.round(top.share * 100)}%`)
  }
  if (view.key !== null) {
    const limit = view.key.limit > 0 ? `/${money(view.key.limit, cur)} ${view.key.period}` : ''
    parts.push(`key ${view.key.label} ${money(view.key.spend, cur)}${limit}`)
  }
  return parts.join(' │ ')
}
