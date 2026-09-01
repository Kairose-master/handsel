import { pool } from '@/lib/db'
import {
  contentHashOf,
  evidenceHashOf,
  signWorkProof,
  trustedAttester,
  EVIDENCE_SCHEMA,
  WORK_PROOF_SCHEMA,
  WORK_PROOF_SCHEMA_V2,
  type EvidenceBundle,
  type WorkProof,
} from '@/lib/attestation'
import { cidOfJson, pinBytes } from '@/lib/ipfs'

/**
 * Persistence + issuance for Proof of Authorship & Grade. Self-migrating: the
 * table is created on first use so it ships without a separate migration.
 *
 * Every row is a gas-free, independently verifiable certificate that a specific
 * deliverable (by keccak256 fingerprint) was produced by a worker for a job and
 * passed grading — signed by the platform oracle (the trusted attester).
 */
export interface StoredProof {
  id: string
  proof: WorkProof
  signature: string
  attester: string
  /** Content-addressed id (CIDv1) of the {proof, signature, attester} record —
   *  an ipfs:// identity that resolves on any gateway once pinned. */
  cid: string | null
  /** v2 only: the bundle whose hash the signature commits to (spec +
   *  deliverable + grader class). Null on v1 proofs — provenance only. */
  evidence: EvidenceBundle | null
}

async function ensureTable(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS work_proofs (
       id text PRIMARY KEY,
       job_ref text NOT NULL,
       content_hash text NOT NULL,
       attester text NOT NULL,
       signature text NOT NULL,
       proof jsonb NOT NULL,
       cid text,
       created_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
  await pool.query(`CREATE INDEX IF NOT EXISTS work_proofs_job_ref_idx ON work_proofs (job_ref)`)
  // Additive migration for tables created before the cid column existed.
  await pool.query(`ALTER TABLE work_proofs ADD COLUMN IF NOT EXISTS cid text`)
  await pool.query(`ALTER TABLE work_proofs ADD COLUMN IF NOT EXISTS evidence jsonb`)
}

/**
 * Build → sign → store a proof for a graded-pass deliverable. Best-effort: any
 * failure (no oracle key, DB down) returns null instead of throwing, so proof
 * issuance never blocks settlement. `verdict` should already be a pass.
 */
export async function issueWorkProof(input: {
  jobRef: string
  kind: string
  worker: string
  requester: string
  grader: string
  deliverable: { base64?: string | null; dataUrl?: string | null; text?: string | null }
  gradedAt?: number
  /** When present, the proof is issued as schema v2 with the evidence bundle
   *  bound into the signature — the caller is choosing to make spec +
   *  deliverable PUBLIC so third parties can re-derive the verdict. */
  evidence?: { spec: string; graderClass: EvidenceBundle['graderClass'] }
}): Promise<StoredProof | null> {
  try {
    // The evidence bundle stores the deliverable as it will be re-hashed by a
    // verifier: dataUrl payloads normalize to base64 so contentHashOf(bundle
    // .deliverable) reproduces the proof's contentHash byte-for-byte.
    let evidence: EvidenceBundle | null = null
    if (input.evidence) {
      const deliverable = input.deliverable.dataUrl
        ? { base64: input.deliverable.dataUrl.slice(input.deliverable.dataUrl.indexOf(',') + 1) }
        : input.deliverable.base64
          ? { base64: input.deliverable.base64 }
          : { text: input.deliverable.text ?? '' }
      evidence = {
        schema: EVIDENCE_SCHEMA,
        spec: input.evidence.spec,
        deliverable,
        grader: input.grader,
        graderClass: input.evidence.graderClass,
      }
    }

    const proof: WorkProof = {
      schema: evidence ? WORK_PROOF_SCHEMA_V2 : WORK_PROOF_SCHEMA,
      jobRef: input.jobRef,
      kind: input.kind,
      contentHash: contentHashOf(input.deliverable),
      worker: input.worker,
      requester: input.requester,
      verdict: 'pass',
      grader: input.grader,
      gradedAt: input.gradedAt ?? Math.floor(Date.now() / 1000),
      ...(evidence ? { evidenceHash: evidenceHashOf(evidence) } : {}),
    }
    const signed = await signWorkProof(proof)
    if (!signed) return null

    // Content-address the whole signed record (IPFS + ENS pattern). The CID is
    // derived locally with no deps; pinning is best-effort (only if configured).
    const record = { proof, signature: signed.signature, attester: signed.attester }
    const cid = cidOfJson(record)
    void pinBytes(Buffer.from(JSON.stringify(record), 'utf8')) // fire-and-forget

    const id = crypto.randomUUID()
    await ensureTable()
    await pool.query(
      `INSERT INTO work_proofs (id, job_ref, content_hash, attester, signature, proof, cid, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, proof.jobRef, proof.contentHash, signed.attester, signed.signature, JSON.stringify(proof), cid,
       evidence ? JSON.stringify(evidence) : null],
    )
    return { id, proof, signature: signed.signature, attester: signed.attester, cid, evidence }
  } catch {
    return null
  }
}

/**
 * Issue a proof for a REAL labor-market job that just passed grading and paid
 * out. Resolves the actual deliverable (inline/blob artifact for image/audio,
 * task output for text/code) so the fingerprint matches the paid-for bytes.
 * Best-effort like issueWorkProof — never blocks settlement.
 */
export async function issueProofForJobSpec(spec: {
  onchainJobId: number | null
  agentTaskId: string | null
  deliverableKind: string | null
  testCode: string | null
  workerAgentId: string | null
  requesterAgentId: string | null
}): Promise<StoredProof | null> {
  try {
    if (spec.onchainJobId === null || !spec.agentTaskId || !spec.workerAgentId || !spec.requesterAgentId) return null
    const { db } = await import('@/lib/db')
    const { agentTask, artifact } = await import('@/lib/db/schema')
    const { eq } = await import('drizzle-orm')

    const kind = spec.deliverableKind ?? (spec.testCode ? 'code' : 'text')
    const grader = kind === 'image' ? 'vision' : kind === 'audio' ? 'transcription' : spec.testCode ? 'pytest' : 'llm'

    let deliverable: { base64?: string | null; text?: string | null } | null = null
    if (kind === 'image' || kind === 'audio') {
      const arts = await db.select().from(artifact).where(eq(artifact.taskId, spec.agentTaskId))
      const art = arts.find((a) => a.dataBase64) ?? arts[0]
      if (art?.dataBase64) deliverable = { base64: art.dataBase64 }
      else if (art?.url) {
        const res = await fetch(art.url, { signal: AbortSignal.timeout(20_000) })
        if (res.ok) deliverable = { base64: Buffer.from(await res.arrayBuffer()).toString('base64') }
      }
    } else {
      const [task] = await db.select().from(agentTask).where(eq(agentTask.id, spec.agentTaskId))
      if (task?.output) deliverable = { text: task.output }
    }
    if (!deliverable) return null

    return await issueWorkProof({
      jobRef: `#${spec.onchainJobId}`,
      kind,
      worker: spec.workerAgentId,
      requester: spec.requesterAgentId,
      grader,
      deliverable,
    })
  } catch {
    return null
  }
}

export async function getWorkProof(id: string): Promise<StoredProof | null> {
  try {
    await ensureTable()
    const { rows } = await pool.query<{ id: string; proof: WorkProof; signature: string; attester: string; cid: string | null; evidence: EvidenceBundle | null }>(
      `SELECT id, proof, signature, attester, cid, evidence FROM work_proofs WHERE id = $1`,
      [id],
    )
    if (!rows[0]) return null
    return { id: rows[0].id, proof: rows[0].proof, signature: rows[0].signature, attester: rows[0].attester, cid: rows[0].cid ?? null, evidence: rows[0].evidence ?? null }
  } catch {
    return null
  }
}

/** Latest proof for a job reference (jobs can be re-graded / re-posted). */
export async function getLatestProofForJob(jobRef: string): Promise<StoredProof | null> {
  try {
    await ensureTable()
    const { rows } = await pool.query<{ id: string; proof: WorkProof; signature: string; attester: string; cid: string | null; evidence: EvidenceBundle | null }>(
      `SELECT id, proof, signature, attester, cid, evidence FROM work_proofs WHERE job_ref = $1 ORDER BY created_at DESC LIMIT 1`,
      [jobRef],
    )
    if (!rows[0]) return null
    return { id: rows[0].id, proof: rows[0].proof, signature: rows[0].signature, attester: rows[0].attester, cid: rows[0].cid ?? null, evidence: rows[0].evidence ?? null }
  } catch {
    return null
  }
}

export { trustedAttester }

/**
 * May this proof's EVIDENCE bundle go out on an unauthenticated surface?
 *
 * The proof itself — hashes, parties, verdict, signature — is public by
 * design: commitments leak nothing. The evidence bundle is different: it
 * carries the sealed spec text and the deliverable so third parties can
 * re-derive the verdict, and for an office-scoped job (lib/office.ts) those
 * are exactly the bytes the visibility split keeps off the public board.
 * A proof id must not be a way around it. Unresolvable reads answer FALSE —
 * withholding evidence from a public page costs a re-fetch; leaking a scoped
 * brief cannot be taken back.
 */
export async function evidencePubliclyVisible(jobRef: string | null | undefined): Promise<boolean> {
  const m = /^#(\d+)$/.exec((jobRef ?? '').trim())
  if (!m) return true // not a market job reference — nothing to scope
  try {
    const { db } = await import('@/lib/db')
    const { jobSpec } = await import('@/lib/db/schema')
    const { eq } = await import('drizzle-orm')
    const [spec] = await db
      .select({ officeOwnerId: jobSpec.officeOwnerId })
      .from(jobSpec)
      .where(eq(jobSpec.onchainJobId, Number(m[1])))
    return !spec?.officeOwnerId
  } catch {
    return false
  }
}
