import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ContextView, KeyView, View } from '../types'
import {
  applyBalance,
  applyUsage,
  buildView,
  clockTime,
  dayKey,
  emptyLedger,
  money,
  parseBalance,
  statusLine,
} from './ledger'
import { pushReading, tokensShort, trendOf, turnBars, weatherOf } from './context'
import type { Ledger } from './ledger'

const PANE = 'deepseek-balance'
const LEDGER = 'ledger'
const view = atom({ plugin: 'deepseek-balance', key: 'view' } as const, null)
const context = atom({ plugin: 'deepseek-balance', key: 'context' } as const, null)

type Key = { secret: string; id: string; label: string }

// The OpenRouter line's colors: a blue name and a solid yellow gauge.
const BRAND = '#869cff'
const GAUGE = '#fbd800'
// Between the band's views, as on the Token Weather line.
const SEPARATOR = ' │ '

// The gauge stays yellow until it is nearly empty.
const gaugeColor = (fraction: number) => (fraction < 0.1 ? 'error' : GAUGE)
const filledCells = (fraction: number, cells: number) =>
  Math.round(Math.max(0, Math.min(1, fraction)) * cells)

let apiBase = 'https://api.deepseek.com'
let refreshMs = 120_000
let gaugeFull = 0
let keyLimit = 0
let keyLimitPeriod: KeyView['period'] = 'day'
let currency = 'auto'
let contextWindow = 0
let apiKeyOption = ''

let key: Key | null = null
let timer: Timer | undefined
let lastRefresh = 0
// Store writes from a refresh and from a model step must not interleave.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)
  return run
}

async function loadLedger($: EngineInterface): Promise<Ledger> {
  const stored = (await $.store.get(LEDGER)) as Ledger | undefined
  return stored ?? emptyLedger(dayKey(await $.clock.now()))
}

async function resolveKey($: EngineInterface): Promise<Key | null> {
  const settingsEnv = ((await $.settings.read()).env ?? {}) as Record<string, string>
  const baseUrl = (await $.env.get('ANTHROPIC_BASE_URL')) ?? settingsEnv.ANTHROPIC_BASE_URL ?? ''
  const isDeepSeek = /deepseek/i.test(baseUrl)
  const secret =
    apiKeyOption ||
    (await $.env.get('DEEPSEEK_API_KEY')) ||
    settingsEnv.DEEPSEEK_API_KEY ||
    // Claude Code's own credential goes to DeepSeek only when it already does.
    (isDeepSeek
      ? (await $.env.get('ANTHROPIC_AUTH_TOKEN')) ||
        settingsEnv.ANTHROPIC_AUTH_TOKEN ||
        (await $.env.get('ANTHROPIC_API_KEY')) ||
        settingsEnv.ANTHROPIC_API_KEY
      : '')
  if (!secret) return null
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  const id = [...new Uint8Array(digest).slice(0, 6)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
  return { secret, id, label: `sk-…${secret.slice(-4)}` }
}

async function readContext($: EngineInterface) {
  const usage = await $.session.usage()
  const held = await read($, context)
  const next: ContextView = pushReading(held, usage.context.tokens, usage.context.window, contextWindow)
  await update($, context, () => next)
}

async function publish($: EngineInterface, next: View) {
  await update($, view, () => next)
}

async function warn($: EngineInterface, ledger: Ledger, shown: View): Promise<Ledger> {
  const warned = { ...ledger.warned }
  if (shown.gauge !== null && shown.gauge < 0.1 && warned.low !== ledger.day) {
    warned.low = ledger.day
    $.ui.toast(`DeepSeek balance is low: ${money(shown.balance?.total ?? 0, shown.currency)} left`)
  }
  const k = shown.key
  if (k !== null && k.limit > 0 && k.spend >= k.limit) {
    const period =
      k.period === 'day' ? ledger.day : k.period === 'month' ? ledger.day.slice(0, 7) : 'total'
    if (warned.limit !== period) {
      warned.limit = period
      $.ui.toast(
        `DeepSeek key ${k.label} passed its ${k.period} limit: ${money(k.spend, shown.currency)} of ${money(k.limit, shown.currency)}`,
      )
    }
  }
  return { ...ledger, warned }
}

function refresh($: EngineInterface) {
  return serial(async () => {
    const now = await $.clock.now()
    lastRefresh = now
    let ledger = await loadLedger($)
    const viewOf = (balance: View['balance'], status: View['status'], message: string) =>
      buildView({
        ledger,
        balance,
        status,
        message,
        gaugeFull,
        key: key && { id: key.id, label: key.label },
        keyLimit,
        keyLimitPeriod,
        now,
      })

    if (key === null) {
      await publish($, viewOf(null, 'no-key', 'no API key (set DEEPSEEK_API_KEY or /config)'))
      return
    }
    let shown: View
    try {
      const res = await $.http.fetch(`${apiBase}/user/balance`, {
        headers: { Authorization: `Bearer ${key.secret}`, Accept: 'application/json' },
      })
      const balance = res.ok ? parseBalance(res.text, currency) : null
      if (balance !== null) {
        ledger = applyBalance(ledger, balance, now)
        shown = viewOf(balance, 'ok', '')
      } else if (res.status === 401) {
        shown = viewOf(null, 'unauthorized', 'key rejected (401)')
      } else if (res.ok) {
        shown = viewOf(null, 'unavailable', 'no balance on this account')
      } else {
        shown = viewOf(null, 'unavailable', `balance unavailable (${res.status})`)
      }
    } catch (error) {
      shown = viewOf(null, 'error', `balance unreachable`)
      $.ui.log(`deepseek-balance: ${String(error)}`, { to: 'debug' })
    }
    ledger = await warn($, ledger, shown)
    await $.store.set(LEDGER, ledger)
    await publish($, shown)
  })
}

export const register: Register = (on, options) => {
  apiBase = String(options.apiBase || 'https://api.deepseek.com').replace(/\/+$/, '')
  refreshMs = Math.max(30, Number(options.refreshSeconds) || 120) * 1000
  gaugeFull = Number(options.gaugeFull) || 0
  keyLimit = Number(options.keyLimit) || 0
  keyLimitPeriod = String(options.keyLimitPeriod || 'day') as KeyView['period']
  currency = String(options.currency || 'auto')
  apiKeyOption = String(options.apiKey || '')
  contextWindow = Number(options.contextWindow) || 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'deepseek',
      description: 'DeepSeek balance, today\'s spend and top model (args: refresh)',
    })
    key = await resolveKey($)
    await publish(
      $,
      buildView({
        ledger: await loadLedger($),
        balance: null,
        status: 'loading',
        message: '',
        gaugeFull,
        key: key && { id: key.id, label: key.label },
        keyLimit,
        keyLimitPeriod,
        now: await $.clock.now(),
      }),
    )
    await readContext($)
    timer?.cancel()
    timer = $.clock.every(refreshMs, () => void refresh($))
    void refresh($)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    // The main conversation's window; a subagent's steps have windows of their own.
    if (e.agentId === undefined) await readContext($)
    const usage = result.usage
    if (usage !== null) {
      await serial(async () => {
        const now = await $.clock.now()
        const ledger = applyUsage(await loadLedger($), usage.model || e.model, usage, key?.id ?? null, now)
        await $.store.set(LEDGER, ledger)
        const held = await read($, view)
        if (held !== null) {
          await publish(
            $,
            buildView({
              ledger,
              balance: held.balance,
              status: held.status,
              message: held.message,
              gaugeFull,
              key: key && { id: key.id, label: key.label },
              keyLimit,
              keyLimitPeriod,
              now,
            }),
          )
        }
      })
    }
    return result
  })

  // The balance moves as turns finish; read it again then, at most every 30 s.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await readContext($)
    if ((await $.clock.now()) - lastRefresh > 30_000) void refresh($)
    return next(e)
  })

  // A compaction drops the context now, not at the next reply.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.trigger === 'precompute' || 'skip' in result) return result
    const held = await read($, context)
    if (held !== null && result.tokensAfter !== undefined && result.tokensAfter > 0) {
      await update($, context, () => pushReading(held, result.tokensAfter, held.window, 0))
    } else {
      await readContext($)
    }
    return result
  })

  on('command.run', { command: 'deepseek' }, async ($, e) => {
    if (e.args.trim() === 'refresh') {
      await refresh($)
      const shown = await read($, view)
      const window = await read($, context)
      return { text: shown === null ? 'DeepSeek: no reading yet.' : statusLine(shown, window) }
    }
    await $.ui.open({ id: PANE, title: 'DeepSeek balance' })
    return { text: 'DeepSeek balance pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = await read($, view)
    if (shown === null) {
      return <Text dimColor>Reading the DeepSeek balance…</Text>
    }
    const cur = shown.currency
    const cells = Math.max(10, Math.min(30, (e.props.bodyColumns ?? 40) - 16))
    const b = shown.balance
    const k = shown.key
    const keyShare = k !== null && k.limit > 0 ? k.spend / k.limit : null
    const ctx = await read($, context)

    return (
      <Box flexDirection="column">
        {b === null ? (
          <Text color="warning">Balance: {shown.message}</Text>
        ) : (
          <Box flexDirection="column">
            <Text>
              <Text bold>Balance </Text>
              {money(b.total, cur)} {cur}
              <Text dimColor>
                {' '}
                (topped up {money(b.toppedUp, cur)} · granted {money(b.granted, cur)})
              </Text>
              {b.isAvailable ? '' : <Text color="error"> insufficient</Text>}
            </Text>
            {shown.gauge !== null && (
              <Text>
                <Text backgroundColor={gaugeColor(shown.gauge)}>
                  {' '.repeat(filledCells(shown.gauge, cells))}
                </Text>
                <Text dimColor>{'▁'.repeat(cells - filledCells(shown.gauge, cells))}</Text>{' '}
                {Math.round(shown.gauge * 100)}%
                <Text dimColor> of {money(shown.gaugeFull ?? 0, cur)}</Text>
              </Text>
            )}
          </Box>
        )}
        <Text>
          <Text bold>Today   </Text>
          {shown.todayReal !== null
            ? `${money(shown.todayReal, cur)} spent`
            : `≈${money(shown.todayTracked, cur)} (estimated)`}
          <Text dimColor>
            {shown.sinceAt !== null && shown.todayReal !== null
              ? ` since ${clockTime(shown.sinceAt)}`
              : ''}
            {shown.todayReal !== null ? ` · tracked here ≈${money(shown.todayTracked, cur)}` : ''}
          </Text>
        </Text>
        {ctx !== null && (
          <Box flexDirection="column">
            <Text>
              <Text bold>Context </Text>
              {ctx.tokens === null || ctx.percent === null ? (
                <Text dimColor>fills after the next reply · {tokensShort(ctx.window)} window</Text>
              ) : (
                <Text>
                  <Text color={weatherOf(ctx.percent).color} bold>
                    {weatherOf(ctx.percent).icon} {weatherOf(ctx.percent).word}
                  </Text>
                  {'  '}
                  {tokensShort(ctx.tokens)} of {tokensShort(ctx.window)} tokens
                </Text>
              )}
            </Text>
            {ctx.percent !== null && (
              <Text>
                <Text backgroundColor={weatherOf(ctx.percent).color}>
                  {' '.repeat(filledCells(ctx.percent / 100, cells))}
                </Text>
                <Text dimColor>{'▁'.repeat(cells - filledCells(ctx.percent / 100, cells))}</Text>{' '}
                {ctx.percent}% used
              </Text>
            )}
            {ctx.history.length >= 2 && (
              <Text>
                <Text dimColor>  last prompts </Text>
                <Text dimColor>{turnBars(ctx.history).slice(0, -1)}</Text>
                <Text color={weatherOf(ctx.percent ?? 0).color}>{turnBars(ctx.history).slice(-1)}</Text>
                <Text dimColor> {trendOf(ctx.history)}</Text>
              </Text>
            )}
          </Box>
        )}
        <Text bold>Where it went today</Text>
        {shown.models.length === 0 && <Text dimColor>  no model calls tracked yet today</Text>}
        {shown.models.slice(0, 6).map(m => (
          <Text>
            {'  '}
            {m.name.padEnd(22)} {money(m.cost, cur).padStart(8)}{' '}
            <Text dimColor>{String(Math.round(m.share * 100)).padStart(3)}%</Text>
          </Text>
        ))}
        {k !== null && (
          <Box flexDirection="column">
            <Text>
              <Text bold>This key </Text>
              {k.label} {money(k.spend, cur)}{' '}
              {k.period === 'day' ? 'today' : k.period === 'month' ? 'this month' : 'all time'}
              {k.limit > 0 ? ` of ${money(k.limit, cur)} limit` : ' (no limit set)'}
            </Text>
            {keyShare !== null && (
              <Text>
                <Text backgroundColor={gaugeColor(1 - keyShare)}>
                  {' '.repeat(filledCells(keyShare, cells))}
                </Text>
                <Text dimColor>{'▁'.repeat(cells - filledCells(keyShare, cells))}</Text>{' '}
                {Math.round(keyShare * 100)}% used
              </Text>
            )}
            <Text dimColor>  all time {money(k.total, cur)}</Text>
          </Box>
        )}
        <Box flexDirection="row">
          <Text dimColor>
            {shown.updatedAt !== null ? `Updated ${clockTime(shown.updatedAt)} ` : ''}
          </Text>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void refresh($)} />
        </Box>
      </Box>
    )
  })

  // The band above the prompt: the gauge in color, then what is left and today's spend.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, view)
    if (e.props.hasSurvey || shown === null) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const cur = shown.currency
    const b = shown.balance
    const k = shown.key
    const keyLeft = k !== null && k.limit > 0 ? Math.max(0, k.limit - k.spend) : null
    // The account balance when DeepSeek gives it, else what is left of this key's limit.
    const fill = shown.gauge ?? (keyLeft !== null && k !== null ? keyLeft / k.limit : null)
    const top = shown.models[0]
    const today = shown.todayReal ?? (shown.todayTracked > 0 ? shown.todayTracked : null)
    const isWide = (e.props.bodyColumns ?? 80) >= 90
    const ctx = await read($, context)

    // Each view of the band, left to right: context, balance, today, top model, key.
    const views: JSX.Element[] = []
    if (ctx !== null && ctx.tokens !== null && ctx.percent !== null) {
      const sky = weatherOf(ctx.percent)
      const bars = turnBars(ctx.history)
      views.push(
        <Text>
          <Text color={sky.color} bold>{sky.icon}</Text> <Text bold>{tokensShort(ctx.tokens)}</Text>
          {ctx.history.length >= 2 && (
            <Text>
              {' '}
              <Text dimColor>{bars.slice(0, -1)}</Text>
              <Text color={sky.color}>{bars.slice(-1)}</Text>
              <Text dimColor> {trendOf(ctx.history)}</Text>
            </Text>
          )}
          {isWide && <Text dimColor> {ctx.percent}%</Text>}
        </Text>,
      )
    }
    views.push(
      <Text>
        {fill !== null && (
          <Text>
            <Text backgroundColor={gaugeColor(fill)}>{' '.repeat(filledCells(fill, 10))}</Text>
            <Text dimColor>{'▁'.repeat(10 - filledCells(fill, 10))}</Text>{' '}
          </Text>
        )}
        {b !== null ? (
          <Text>
            <Text color={gaugeColor(fill ?? 1)} bold>{money(b.total, cur)}</Text>
            <Text dimColor>
              {shown.gaugeFull !== null ? ` of ${money(shown.gaugeFull, cur)}` : ''} left
            </Text>
            {b.isAvailable ? '' : <Text color="error"> insufficient</Text>}
          </Text>
        ) : keyLeft !== null && k !== null ? (
          <Text>
            <Text color={gaugeColor(fill ?? 1)} bold>{money(keyLeft, cur)}</Text>
            <Text dimColor> of {money(k.limit, cur)} key limit left</Text>
          </Text>
        ) : (
          <Text color="warning">{shown.status === 'loading' ? 'reading balance…' : shown.message}</Text>
        )}
      </Text>,
    )
    if (today !== null) {
      views.push(
        <Text>
          <Text bold>{shown.todayReal === null ? '≈' : ''}{money(today, cur)}</Text>
          <Text dimColor> today</Text>
        </Text>,
      )
    }
    if (top !== undefined && top.cost > 0) {
      views.push(
        <Text>
          <Text dimColor>mostly </Text>
          {top.name}
          {isWide && <Text dimColor> {Math.round(top.share * 100)}%</Text>}
        </Text>,
      )
    }
    if (b !== null && k !== null && isWide) {
      views.push(
        <Text>
          <Text dimColor>key </Text>
          {keyLeft !== null ? (
            <Text>
              <Text bold>{money(keyLeft, cur)}</Text>
              <Text dimColor> of {money(k.limit, cur)} left</Text>
            </Text>
          ) : (
            <Text>
              <Text bold>{money(k.spend, cur)}</Text>
              <Text dimColor> spent</Text>
            </Text>
          )}
        </Text>,
      )
    }

    return (
      <Box flexDirection="row">
        <Text wrap="truncate">
          <Text color={BRAND} bold>◆ DeepSeek</Text>
          {views.map(one => (
            <Text>
              <Text dimColor>{SEPARATOR}</Text>
              {one}
            </Text>
          ))}
        </Text>
      </Box>
    )
  })
}
