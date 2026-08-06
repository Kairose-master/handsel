'use client'

import { useCallback, useEffect, useState } from 'react'
import { Table2, Plus, Trash2, Loader2, RotateCcw, Save } from 'lucide-react'
import { getCreditRatingPolicy, updateCreditRatingPolicy, resetCreditRatingPolicy } from '@/app/actions/credit-rules'

type Row = { minScore: number; value: string }

export default function CreditRulesPage() {
  const [rating, setRating] = useState<Row[]>([])
  const [risk, setRisk] = useState<Row[]>([])
  const [validRatings, setValidRatings] = useState<string[]>([])
  const [validRiskLevels, setValidRiskLevels] = useState<string[]>([])
  const [customized, setCustomized] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const refresh = useCallback(async () => {
    const data = await getCreditRatingPolicy()
    setRating([...data.rating].sort((a, b) => b.minScore - a.minScore))
    setRisk([...data.risk].sort((a, b) => b.minScore - a.minScore))
    setValidRatings(data.validRatings)
    setValidRiskLevels(data.validRiskLevels)
    setCustomized(data.customized)
  }, [])

  useEffect(() => {
    refresh()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [refresh])

  const save = async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await updateCreditRatingPolicy(rating, risk)
      setSaved(true)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    setBusy(true)
    setError(null)
    try {
      await resetCreditRatingPolicy()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="p-8">Loading…</div>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Table2 className="size-7" /> Credit Rating Policy
        </h1>
        <p className="text-muted-foreground mt-1">
          A decision table: &quot;score ≥ threshold → outcome&quot;. This is what actually decides
          every agent&apos;s rating and risk level — edit it here, no code changes needed.{' '}
          {customized ? (
            <span className="text-warning font-medium">Currently customized (overriding shipped defaults).</span>
          ) : (
            <span className="text-muted-foreground">Currently running the shipped defaults.</span>
          )}
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {saved && !error && (
        <div className="rounded-md border border-success/40 bg-success/10 p-3 text-sm text-success">
          Saved — new recalculations will use this policy immediately.
        </div>
      )}

      <DecisionTable
        title="Rating"
        description="Credit score ≥ threshold → rating"
        rows={rating}
        setRows={setRating}
        validValues={validRatings}
        busy={busy}
      />

      <DecisionTable
        title="Risk Level"
        description="Credit score ≥ threshold → risk level"
        rows={risk}
        setRows={setRisk}
        validValues={validRiskLevels}
        busy={busy}
      />

      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          Save policy
        </button>
        <button
          onClick={reset}
          disabled={busy || !customized}
          className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50"
        >
          <RotateCcw className="size-4" /> Reset to defaults
        </button>
      </div>
    </div>
  )
}

function DecisionTable({
  title,
  description,
  rows,
  setRows,
  validValues,
  busy,
}: {
  title: string
  description: string
  rows: Row[]
  setRows: (rows: Row[]) => void
  validValues: string[]
  busy: boolean
}) {
  const addRow = () => setRows([...rows, { minScore: 0, value: validValues[validValues.length - 1] ?? '' }])
  const removeRow = (i: number) => setRows(rows.filter((_, idx) => idx !== i))
  const update = (i: number, patch: Partial<Row>) =>
    setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  return (
    <div className="glass-card rounded-lg border border-border p-6">
      <h3 className="font-bold text-lg mb-1">{title}</h3>
      <p className="text-sm text-muted-foreground mb-4">{description}</p>

      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground w-16">score ≥</span>
            <input
              type="number"
              min={0}
              max={990}
              value={row.minScore}
              onChange={(e) => update(i, { minScore: parseInt(e.target.value || '0', 10) })}
              className="h-9 w-24 rounded-md border border-border bg-background px-3 text-sm font-mono"
              disabled={busy}
            />
            <span className="text-sm text-muted-foreground">→</span>
            <select
              value={row.value}
              onChange={(e) => update(i, { value: e.target.value })}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
              disabled={busy}
            >
              {validValues.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <button
              onClick={() => removeRow(i)}
              disabled={busy}
              className="ml-auto inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-destructive/15 hover:text-destructive disabled:opacity-50"
              aria-label="Remove row"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
        {rows.length === 0 && <p className="text-sm text-muted-foreground">No rows — add at least one.</p>}
      </div>

      <button
        onClick={addRow}
        disabled={busy}
        className="mt-3 inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-50"
      >
        <Plus className="size-3.5" /> Add row
      </button>
    </div>
  )
}
