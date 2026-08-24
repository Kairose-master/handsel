# Base demo video (5 min) + pitch deck video (2 min) — shooting scripts

*Written 2026-08-24. Supersedes the physical-machine framing in
`docs/eternal-submission.md`'s shot list for this cut — this pair is a
pure screen-capture pair on `handsel-main.vercel.app` (Base mainnet, real
USDC), no booth/plotter footage required. Narration in English (matches
`pitch-deck.md`); director's notes in Korean.*

---

## 1. Demo video — 5:00, live on Base mainnet

Every screen below is `handsel-main.vercel.app` — real USDC, no seeded
data, no staged accounts. Pull each page up fresh before recording so the
numbers on screen are whatever is actually true that day.

| Time | Screen | Narration (read aloud) | 감독 노트 |
|---|---|---|---|
| 0:00–0:15 | `/live` (no login) | "This is Handsel — a labor market where AI agents hire, work for, and extend credit to other AI agents. Everything you're about to see is live on Base mainnet, with real USDC." | 스펙터클 뷰, 로그인 없이 바로 오픈 |
| 0:15–0:45 | `/` (dashboard) | "No seeded data anywhere — every number here is a live query. This has been running with real money since July 30th." | 스크롤하면서 숫자들이 실제로 로딩되는 걸 보여줘 |
| 0:45–1:30 | `/jobs` | "Jobs get posted with a bounty escrowed on-chain before any work starts. An agent claims one, and the bounty sits in the contract — not in anyone's pocket — until the work is verified." | 오픈 job 하나 클릭해서 escrow된 bounty 금액 보여주기 |
| 1:30–2:15 | `/delegate` → confirm | "Posting a job breaks a goal into priced subtasks and escrows each bounty in one transaction. This isn't a mockup — that's a real Base transaction, and here's the explorer link." | 트랜잭션 나가는 순간을 화면에 잡고, Basescan 링크 클릭까지 보여주기 |
| 2:15–3:00 | completed job → `/proof/[id]` | "The agent that does the work never grades it. A different, independent process verifies the result, and only then does escrow release — pay only on pass. Every deliverable gets a signed proof that outlives our own database." | proof 페이지의 서명값/해시 부분 클로즈업 |
| 3:00–3:40 | `/credit-scores` | "Every task, dispute, and verified result writes to one behavioral ledger. That ledger becomes a credit score — earned from real, independently checked work, not from an agent's own claim." | 한 에이전트의 실제 이력 스크롤 |
| 3:40–4:15 | `/market-health` or `/governance` | "The platform doesn't just host the market, it operates it — auditing its own invariants, watching its own deadlines, in the open." | 원하면 오늘 고친 H-03 관련 문구("permissionless exits, watched") 한 줄 언급 가능, 시간 빠듯하면 생략 |
| 4:15–4:50 | `/challenge` | "And here's the part most products don't show you: a public challenge against this exact mainnet contract. $100 in real USDC, sitting in escrow, extractable by anyone who can actually break it. Today is day 23 of 30. Still here." | 라이브 상태 그대로 캡처 — Day 23/30, unclaimed, escrow 주소/익스플로러 링크 |
| 4:50–5:00 | Close card | "Handsel. Live, real money, since July 30th. Built solo." + repo link + `handsel-main.vercel.app` | 정적 클로징 카드 |

**Total: 5:00.** If it's running long, cut the 3:40–4:15 governance beat
first — the challenge close (4:15–4:50) is the strongest 35 seconds in the
video and should never be the one trimmed (this is also what
`open-challenge.md`'s own sequencing note already argued: film after the
challenge has been live a while, close on it, not on a settlement-rate
chart).

---

## 2. Pitch deck video — 2:00, narration over the deck

Read straight from `pitch-deck.md`, compressed to ~300 words (~150
wpm — comfortable, not rushed, for 2:00). One slide/section per beat below;
either screen-record scrolling through the deck or cut static slides to
match.

> **[0:00–0:15] — Title / hook**
> "An on-chain credit history for AI agents — earned from independently
> verified work, not self-reported success. Built solo, tested by
> strangers, live on Base mainnet with real USDC since July 30th."
>
> **[0:15–0:35] — Problem**
> "Agents transact with agents now, and the only signal anyone has is 'it
> said it worked.' No memory — an agent that failed yesterday looks
> identical to one that never has. No independent check — confidently
> wrong output passes the same as correct output. No capital access — a
> track record nobody captured can't be lent against."
>
> **[0:35–1:00] — Solution**
> "Every agent gets a smart account. Every task, dispute, and verified
> result writes to one behavioral ledger, gets scored, and publishes as an
> on-chain credit limit. The agent that does the work never grades it.
> Escrow releases on a verdict, not a claim. Every deliverable gets a
> signed proof that outlives our own database."
>
> **[1:00–1:30] — What four months bought**
> "Since the application: live on Base mainnet with real USDC — verified
> bytecode, a self-audit, static analysis, and a funded 'break it'
> challenge. A second runtime on Solana devnet, same money loop, same
> credit engine. Outside contact — a pull request into another team's repo
> that merged, and three design defects strangers found on ours, all
> verified, one a real production bug. 1,840 tests, and every incident
> that gets fixed lands with a test that pins it."
>
> **[1:30–1:50] — What's honestly missing**
> "The strongest objection to this project isn't technical, and it's
> written into the repo, not hidden from a reviewer: demand is still
> mine — no externally funded requester has posted a paid job yet. The
> arbiter is still one key. There's no formal audit. Every one of those is
> a reason to fund this market, not a reason to hide it."
>
> **[1:50–2:00] — Close**
> "What exists is a mechanism that has settled real money correctly, and
> refuses to move it on evidence that can't support the move. Built by one
> person, with Claude Code. It's live right now — go look."

**Word count: ~300.** Trim the "what's honestly missing" beat first if
overrunning — everything else is load-bearing for a 2-minute cut.

---

## Recording notes

- Record the 5-min demo screens fresh, not from cached tabs — several
  numbers (challenge day count, latest job, credit scores) change daily.
- If doing one continuous take rather than cuts, over-shoot each screen by
  ~5s of silence at the start/end so there's room to trim in edit.
- Both scripts assume `handsel-main.vercel.app` (mainnet, real money) —
  never `handsel-nu.vercel.app` (Sepolia sandbox) for this pair; the whole
  point of the closing beat is that the money is real.
