import { getWorkProof } from '@/lib/work-proof-store'
import { verifyWorkProof, trustedAttester } from '@/lib/attestation'

export const dynamic = 'force-dynamic'

const KIND_LABEL: Record<string, string> = { text: '✍️ 텍스트', image: '🖼️ 이미지', audio: '🔊 음성', code: '💻 코드' }
const short = (s: string) => (s.length > 22 ? `${s.slice(0, 10)}…${s.slice(-8)}` : s)

export default async function ProofPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const stored = await getWorkProof(id)

  if (!stored) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-5xl">🔍</div>
        <h1 className="text-2xl font-bold">증명을 찾을 수 없어요</h1>
        <p className="text-muted-foreground">이 ID의 진위 증명이 존재하지 않습니다.</p>
      </main>
    )
  }

  const v = await verifyWorkProof(stored.proof, stored.signature as `0x${string}`, stored.attester as `0x${string}`)
  const trusted = trustedAttester()
  const signatureValid = v.recovered.toLowerCase() === stored.attester.toLowerCase()
  const attesterTrusted = !!trusted && stored.attester.toLowerCase() === trusted.toLowerCase()
  const ok = signatureValid && attesterTrusted
  const p = stored.proof

  const Row = ({ k, val, mono }: { k: string; val: string; mono?: boolean }) => (
    <div className="flex items-start justify-between gap-4 border-b border-border/50 py-3">
      <span className="text-sm text-muted-foreground">{k}</span>
      <span className={`text-right text-sm font-medium ${mono ? 'font-mono break-all' : ''}`}>{val}</span>
    </div>
  )

  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <div className="mb-6 text-center">
        <div className="text-xs font-semibold uppercase tracking-widest text-emerald-500">Handsel · Proof of Authorship &amp; Grade</div>
        <h1 className="mt-2 text-3xl font-bold">진위 · 품질 증명서</h1>
      </div>

      <div className={`mb-8 rounded-2xl border p-6 text-center ${ok ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-red-500/40 bg-red-500/10'}`}>
        <div className="text-4xl">{ok ? '✅' : '⚠️'}</div>
        <div className="mt-2 text-xl font-bold">{ok ? '검증됨 — 유효한 증명' : '검증 실패'}</div>
        <p className="mt-1 text-sm text-muted-foreground">
          {ok
            ? '이 결과물은 신뢰된 채점 오라클이 서명했고, 서명이 유효합니다.'
            : '서명이 유효하지 않거나 신뢰되지 않은 발급자입니다.'}
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card/40 p-6">
        <Row k="작업" val={p.jobRef} />
        <Row k="유형" val={KIND_LABEL[p.kind] ?? p.kind} />
        <Row k="판정" val={p.verdict === 'pass' ? '✅ 채점 통과' : p.verdict} />
        <Row k="채점 방식" val={p.grader} />
        <Row k="워커(제작자)" val={p.worker} mono />
        <Row k="요청자" val={p.requester} mono />
        <Row k="결과물 지문 (keccak256)" val={short(p.contentHash)} mono />
        <Row k="채점 시각" val={new Date(p.gradedAt * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'} />
        <Row k="발급자(오라클) 서명" val={short(stored.attester)} mono />
        {stored.cid && <Row k="콘텐츠 주소 (IPFS CIDv1)" val={short(stored.cid)} mono />}
        <div className="flex items-center justify-between gap-4 pt-3">
          <span className="text-sm text-muted-foreground">서명 검증</span>
          <span className={`text-sm font-semibold ${signatureValid ? 'text-emerald-500' : 'text-red-500'}`}>
            {signatureValid ? '유효 ✓' : '무효 ✗'}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm text-muted-foreground">신뢰된 발급자</span>
          <span className={`text-sm font-semibold ${attesterTrusted ? 'text-emerald-500' : 'text-red-500'}`}>
            {attesterTrusted ? '오라클 확인 ✓' : '불일치 ✗'}
          </span>
        </div>
      </div>

      <p className="mt-6 text-center text-xs leading-relaxed text-muted-foreground">
        가스 없는 오프체인 서명 증명(EIP-712)입니다. 워커는 자기 작업에 &quot;통과&quot;를 위조할 수 없어요 —
        서명이 신뢰된 채점 오라클 주소로만 복원되기 때문입니다.
        <br />
        <a className="text-emerald-500 underline" href={`/api/proof/${stored.id}`}>원본 JSON으로 직접 검증 →</a>
        {stored.cid && (
          <>
            {' · '}
            <a className="text-emerald-500 underline" href={`https://ipfs.io/ipfs/${stored.cid}`} target="_blank" rel="noreferrer">
              IPFS(콘텐츠 주소) →
            </a>
          </>
        )}
      </p>
    </main>
  )
}
