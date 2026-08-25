'use client'

/**
 * /office/orders — the ONLY place a real order can be placed. Deliberately
 * separate from the delegation/job pipeline: see lib/kis-orders.ts's header
 * for why order placement isn't an MCP tool an agent can be wired to. The
 * Rebalance Planner's draft (shown below, read-only) is reference material
 * a human reads — it never pre-fills the order form.
 */
import { useEffect, useState } from 'react'
import { Loader2, AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  kisCredentialsStatus,
  saveKisPaperCredentials,
  removeKisPaperCredentials,
  kisBalance,
  placeKisOrder,
} from '@/app/actions/kis-orders'
import { getMyDelegations } from '@/app/actions/delegate'

type CredStatus = { configured: boolean; appKeyLast4: string | null }
type Holding = { pdno: string; prdtName: string; qty: string; avgCost: string; currentValue: string }
type DelegationRow = Awaited<ReturnType<typeof getMyDelegations>>[number]

function CredentialsCard({ status, onChanged }: { status: CredStatus | null; onChanged: () => void }) {
  const [appKey, setAppKey] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [cano, setCano] = useState('')
  const [prdtCd, setPrdtCd] = useState('01')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await saveKisPaperCredentials({ appKey, appSecret, cano, prdtCd })
      setAppKey('')
      setAppSecret('')
      setCano('')
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">KIS paper-trading credentials</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          From KIS Developers' <strong>모의투자 (paper trading)</strong> application — a separate app key/secret pair
          from any real-account key you may have. Never paste a real-account key here.
        </p>
        {status?.configured ? (
          <div className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
            <span>Configured — app key ends in •••{status.appKeyLast4}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await removeKisPaperCredentials()
                onChanged()
              }}
            >
              Remove
            </Button>
          </div>
        ) : (
          <form onSubmit={save} className="space-y-3">
            <div>
              <Label htmlFor="kis-appkey">App key (paper)</Label>
              <Input id="kis-appkey" value={appKey} onChange={(e) => setAppKey(e.target.value)} autoComplete="off" />
            </div>
            <div>
              <Label htmlFor="kis-appsecret">App secret (paper)</Label>
              <Input id="kis-appsecret" type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} autoComplete="off" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="kis-cano">Account number (8 digits, e.g. 12345678)</Label>
                <Input id="kis-cano" value={cano} onChange={(e) => setCano(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="kis-prdt">Product code (2 digits, default 01)</Label>
                <Input id="kis-prdt" value={prdtCd} onChange={(e) => setPrdtCd(e.target.value)} />
              </div>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy || !appKey.trim() || !appSecret.trim() || !cano.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save (encrypted)'}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  )
}

function ProcedureGuide() {
  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Before you place anything
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>This is your <strong>paper account</strong> only — there is no live/real-money mode anywhere in this feature.</li>
          <li>An order placed here fills for real against KIS's real paper matching engine. There is no undo.</li>
          <li>
            No agent, job, or delegation can reach this page's order action — it only ever fires from you clicking
            "Place" below, with numbers you typed yourself.
          </li>
          <li>
            The Rebalance Planner's draft further down is reference text a worker agent wrote — read it, then type
            the order yourself. It never pre-fills the form.
          </li>
          <li>Review the confirmation summary carefully before the second click — ticker, side, quantity, and price.</li>
        </ol>
      </CardContent>
    </Card>
  )
}

function BalanceCard() {
  const [holdings, setHoldings] = useState<Holding[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    const res = await kisBalance()
    if ('error' in res) setError(res.error)
    else setHoldings(res)
    setLoading(false)
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Paper account holdings</CardTitle>
        <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
          <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {holdings && holdings.length === 0 && <p className="text-sm text-muted-foreground">No holdings.</p>}
        {holdings && holdings.length > 0 && (
          <ul className="divide-y divide-border text-sm">
            {holdings.map((h) => (
              <li key={h.pdno} className="flex justify-between py-1.5">
                <span>{h.pdno} {h.prdtName}</span>
                <span className="text-muted-foreground">qty {h.qty} · avg {h.avgCost} · value {h.currentValue}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function RebalanceReference({ delegations }: { delegations: DelegationRow[] }) {
  const relevant = delegations.filter((d) => d.task.startsWith('Securities Office:'))
  if (relevant.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Rebalance drafts (reference only — not auto-applied)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {relevant.map((d) => (
          <div key={d.id} className="rounded-md border border-border p-3">
            <div className="mb-2 text-sm font-medium">{d.task}</div>
            {(d.subtasks as Array<{ title: string; output?: string | null }>).map((st) => (
              <div key={st.title} className="mb-2 text-xs">
                <div className="font-semibold text-muted-foreground">{st.title}</div>
                <pre className="mt-1 whitespace-pre-wrap rounded bg-muted/50 p-2">{st.output || '(no output yet)'}</pre>
              </div>
            ))}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function OrderForm() {
  const [krxCode, setKrxCode] = useState('')
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [orderType, setOrderType] = useState<'limit' | 'market'>('limit')
  const [quantity, setQuantity] = useState('')
  const [priceKrw, setPriceKrw] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ orderNo: string; orderTime: string } | null>(null)

  const canReview = /^\d{6}$/.test(krxCode.trim()) && Number(quantity) > 0 && (orderType === 'market' || Number(priceKrw) > 0)

  const place = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await placeKisOrder({
        krxCode,
        side,
        quantity: Number(quantity),
        orderType,
        priceKrw: orderType === 'limit' ? Number(priceKrw) : undefined,
      })
      if ('error' in res) setError(res.error)
      else {
        setResult(res)
        setReviewing(false)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Place an order (paper account)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {result ? (
          <div className="rounded-md border border-border bg-muted/50 p-3 text-sm">
            <div className="font-semibold">Order placed</div>
            <div className="text-muted-foreground">Order #{result.orderNo} at {result.orderTime}</div>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => {
                setResult(null)
                setKrxCode('')
                setQuantity('')
                setPriceKrw('')
              }}
            >
              Place another
            </Button>
          </div>
        ) : reviewing ? (
          <div className="space-y-3">
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              <div className="font-semibold">Confirm — this fires for real against your paper account</div>
              <div className="mt-1 text-muted-foreground">
                {side.toUpperCase()} {quantity} × {krxCode} — {orderType === 'limit' ? `limit @ ${priceKrw} KRW` : 'market'}
              </div>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button onClick={place} disabled={busy} className="flex-1">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Place order'}
              </Button>
              <Button variant="outline" onClick={() => setReviewing(false)} disabled={busy}>
                Back
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <Label htmlFor="order-krx">KRX 6-digit ticker</Label>
              <Input id="order-krx" value={krxCode} onChange={(e) => setKrxCode(e.target.value)} placeholder="005930" />
            </div>
            <div className="flex gap-2">
              <Button type="button" variant={side === 'buy' ? 'default' : 'outline'} size="sm" onClick={() => setSide('buy')}>
                Buy
              </Button>
              <Button type="button" variant={side === 'sell' ? 'default' : 'outline'} size="sm" onClick={() => setSide('sell')}>
                Sell
              </Button>
              <Button type="button" variant={orderType === 'limit' ? 'default' : 'outline'} size="sm" onClick={() => setOrderType('limit')}>
                Limit
              </Button>
              <Button type="button" variant={orderType === 'market' ? 'default' : 'outline'} size="sm" onClick={() => setOrderType('market')}>
                Market
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="order-qty">Quantity</Label>
                <Input id="order-qty" type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              </div>
              {orderType === 'limit' && (
                <div>
                  <Label htmlFor="order-price">Limit price (KRW)</Label>
                  <Input id="order-price" type="number" min={1} value={priceKrw} onChange={(e) => setPriceKrw(e.target.value)} />
                </div>
              )}
            </div>
            <Button disabled={!canReview} onClick={() => setReviewing(true)} className="w-full">
              Review order
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function KisOrdersPage() {
  const [status, setStatus] = useState<CredStatus | null>(null)
  const [delegations, setDelegations] = useState<DelegationRow[]>([])
  const [loading, setLoading] = useState(true)

  const refreshStatus = () => {
    kisCredentialsStatus().then(setStatus)
  }

  useEffect(() => {
    Promise.all([kisCredentialsStatus(), getMyDelegations()])
      .then(([s, d]) => {
        setStatus(s)
        setDelegations(d)
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-bold">Paper orders</h1>
        <p className="mt-1 text-sm text-muted-foreground">Review, then place — real fills, paper money, never automated.</p>
      </div>

      <ProcedureGuide />
      <CredentialsCard status={status} onChanged={refreshStatus} />
      {status?.configured && (
        <>
          <BalanceCard />
          <RebalanceReference delegations={delegations} />
          <OrderForm />
        </>
      )}
    </div>
  )
}
