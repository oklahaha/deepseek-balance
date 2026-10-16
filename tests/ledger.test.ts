import { describe, expect, test } from 'claude-code/testing'

import {
  applyBalance,
  applyUsage,
  buildView,
  costOf,
  emptyLedger,
  parseBalance,
  statusLine,
} from '../hooks/ledger'
import type { Balance } from '../types'

const near = (got: number | null | undefined, want: number) =>
  expect(Math.abs((got ?? NaN) - want) < 1e-6 ? want : got).toBe(want)

const T0 = new Date(2026, 9, 16, 9, 0).getTime()
const HOUR = 3_600_000
const usd = (total: number): Balance => ({
  currency: 'USD',
  total,
  granted: 0,
  toppedUp: total,
  isAvailable: true,
})
const usage = (input: number, output: number, cached = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cached,
  cache_creation_input_tokens: 0,
})
const viewOf = (ledger: ReturnType<typeof emptyLedger>, balance: Balance | null, now: number) =>
  buildView({
    ledger,
    balance,
    status: balance ? 'ok' : 'unavailable',
    message: balance ? '' : 'balance unavailable (403)',
    gaugeFull: 0,
    key: { id: 'k1', label: 'sk-…ab12' },
    keyLimit: 1,
    keyLimitPeriod: 'day',
    now,
  })

describe('ledger', () => {
  test('parses the balance endpoint and picks the funded currency', () => {
    const body = JSON.stringify({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
        { currency: 'USD', total_balance: '9.50', granted_balance: '1.50', topped_up_balance: '8.00' },
      ],
    })
    expect(parseBalance(body, 'auto')).toEqual({
      currency: 'USD', total: 9.5, granted: 1.5, toppedUp: 8, isAvailable: true,
    })
    expect(parseBalance(body, 'CNY')?.currency).toBe('CNY')
    expect(parseBalance('{"balance_infos":[]}', 'auto')).toBe(null)
  })

  test("today's real spend is the balance drop, top-ups added back", () => {
    let l = applyBalance(emptyLedger('x'), usd(10), T0)
    l = applyBalance(l, usd(9), T0 + HOUR)
    l = applyBalance(l, usd(19), T0 + 2 * HOUR) // topped up 10
    l = applyBalance(l, usd(18.5), T0 + 3 * HOUR)
    const v = viewOf(l, usd(18.5), T0 + 3 * HOUR)
    near(v.todayReal, 1.5)
    expect(v.gaugeFull).toBe(19)
    near(v.gauge, 18.5 / 19)
  })

  test('a new day starts its spend from the first reading', () => {
    let l = applyBalance(emptyLedger('x'), usd(10), T0)
    l = applyBalance(l, usd(8), T0 + HOUR)
    l = applyBalance(l, usd(7.9), T0 + 24 * HOUR)
    expect(viewOf(l, usd(7.9), T0 + 24 * HOUR).todayReal).toBe(0)
  })

  test('the top model and the key spend come from tracked usage', () => {
    let l = applyBalance(emptyLedger('x'), usd(10), T0)
    l = applyUsage(l, 'deepseek-chat', usage(1_000_000, 1_000_000), 'k1', T0)
    l = applyUsage(l, 'deepseek-reasoner', usage(0, 0, 1_000_000), 'k1', T0)
    near(costOf(usage(1_000_000, 1_000_000), 'USD'), 0.7)
    const v = viewOf(l, usd(9.3), T0)
    expect(v.models[0]?.name).toBe('deepseek-chat')
    near(v.models[0]?.share, 0.7 / 0.728)
    near(v.key?.spend, 0.728)
    // the day limit resets the next day; the total stays
    const tomorrow = viewOf(l, usd(9.3), T0 + 24 * HOUR)
    expect(tomorrow.key?.spend).toBe(0)
    near(tomorrow.key?.total, 0.728)
  })

  test('the status line carries balance, gauge, today, top model and key', () => {
    let l = applyBalance(emptyLedger('x'), usd(10), T0)
    l = applyUsage(l, 'deepseek-chat', usage(1_000_000, 0), 'k1', T0)
    l = applyBalance(l, usd(9.72), T0 + HOUR)
    expect(statusLine(viewOf(l, usd(9.72), T0 + HOUR))).toBe(
      'DeepSeek │ $9.72 ▰▰▰▰▰▰▰▰▰▰ 97% │ today $0.28 │ mostly deepseek-chat 100% │ key sk-…ab12 $0.28/$1.00 day',
    )
    // no balance: the tracked estimate still shows
    expect(statusLine(viewOf(l, null, T0 + HOUR))).toBe(
      'DeepSeek │ balance unavailable (403) │ today ≈$0.28 │ mostly deepseek-chat 100% │ key sk-…ab12 $0.28/$1.00 day',
    )
  })
})
