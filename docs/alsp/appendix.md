# Technical appendix / 기술 부록

**ALSP v0.1.0 · Proposed data and API profile / 제안 데이터·API 규격**

This appendix is shared by the two language editions. Field names are English and identical in both. It is a design contract, not deployed Solidity, a published x402 extension, or a completed security specification. / 두 언어판이 공통으로 참조한다. 필드명은 동일하며, 현재 배포된 계약·공식 x402 확장·완료된 보안 명세가 아니다.

## A. Layer interfaces / 계층별 인터페이스

| Component | Input | Output | Authority / 권한 |
| --- | --- | --- | --- |
| Owner policy | reviewed provider, token, cap, expiry | scoped signing permission | Cannot be widened by retrieved content / 외부 문서가 확대 불가 |
| Gateway | authenticated request, signed intent | license terms, access decision, response | Can deny its own service, not claim arbitrary debt / 서비스 접근 통제와 채무 생성 구분 |
| Evidence store | signed terms and accepted events | replayable session history | Retention and availability obligation / 원본 보존·제공 |
| Payment adapter | x402 requirements, payload, binding | verified payment evidence and operation state | Explicit trusted attester in P1 / P1의 명시된 신뢰 역할 |
| Registry | typed authorizations and evidence | terms/head/state/events | Validates signatures, sequence, caps and role / 서명·순번·상한·역할 검사 |
| Recovery worker | durable pending operations | applied registry update or review/refund record | Cannot create a fresh debit to repair old failure / 복구를 위한 재청구 금지 |

## B. Canonical representation / 정규 표현

Use UTF-8 JSON canonicalized under RFC 8785, then Keccak-256, **not NIST SHA3-256**. Money and counters that might exceed interoperable JSON integer precision are base-10 strings matching `0|[1-9][0-9]*`; signs, decimals, exponent notation and leading zeros are rejected. Amounts are token base units, never a floating-point USD estimate. Timestamps and bounded window lengths are safe integer Unix seconds.

RFC 8785 방식으로 UTF-8 JSON을 정규화한 뒤 Keccak-256을 사용한다. NIST SHA3-256으로 대체하지 않는다. 금액·큰 카운터는 정규 10진 문자열이며 토큰 최소 단위다. 시간은 안전한 정수 범위의 Unix 초다.

For signed data: reject duplicate object keys, unrecognized fields and versions, invalid Unicode, non-finite numbers, malformed byte strings, and out-of-range integers **before hashing**. Do not normalize Unicode or silently add defaults after signing. Array order remains significant. EVM addresses in this profile are lowercase `0x` plus 40 hex characters; hashes/session IDs are `0x` plus 64 hex characters. Contract address and terms hash are different typed fields.

서명 데이터는 해싱 전에 중복 키·알 수 없는 필드·유효하지 않은 문자열·잘못된 바이트 형식·범위 초과를 거부한다. 서명 후 기본값을 삽입하거나 유니코드를 바꾸지 않는다. 주소와 해시의 길이를 구분한다.

```
H_terms(T) = keccak256(UTF8("ALSP:TERMS:0.1") || 0x00 || UTF8(JCS(T)))
H_payload(P) = keccak256(UTF8("ALSP:PAYLOAD:0.1") || 0x00 || UTF8(JCS(P)))
H_event(E) = keccak256(UTF8("ALSP:EVENT:0.1") || 0x00 || UTF8(JCS(E)))
H_quote(Q) = keccak256(UTF8("ALSP:QUOTE:0.1") || 0x00 || UTF8(JCS(Q)))
H0 = H_terms(T)
```

Signatures and a record's own derived hash are stored outside that record's preimage. / 서명과 자기 자신의 계산된 해시는 그 기록의 해시 입력 밖에 보관한다.

## C. Session terms / 체크인 조건

The following is an **unsigned synthetic fixture**. Repeated-digit addresses and hashes are placeholders, not deployments, payment destinations, computed commitments or real signatures. / 아래 주소와 해시는 합성 예시다. 실제 계약·수신 주소·계산된 해시·서명이 아니다.

```json
{
  "protocol": "ALSP/0.1",
  "domain": {
    "network": "eip155:84532",
    "registry": "0x1111111111111111111111111111111111111111"
  },
  "sessionId": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "buyer": "0x2222222222222222222222222222222222222222",
  "provider": "0x3333333333333333333333333333333333333333",
  "paymentAttester": "0x4444444444444444444444444444444444444444",
  "resource": {
    "id": "knowledge-api:industry-notes",
    "version": "2026-09-30",
    "versionHash": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "license": {
    "policyUri": "https://knowledge.example/licenses/internal-query-v1.json",
    "policyHash": "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "enforcedActions": ["query"],
    "contractualRestrictions": ["no_raw_redistribution", "no_model_training"],
    "audience": "https://knowledge.example"
  },
  "pricing": {
    "profile": "P1_POSTPAID_METERED",
    "token": "0x5555555555555555555555555555555555555555",
    "tokenDecimals": 6,
    "checkInFee": "1000000",
    "unit": "acknowledged_query",
    "unitPrice": "500000",
    "maxCheckoutLiability": "10000000",
    "maxAcceptedUnits": "20"
  },
  "timing": {
    "quoteValidUntil": 1790755800,
    "accessExpiry": 1790841600,
    "activationTimeoutSeconds": 120,
    "evidenceWindowSeconds": 300,
    "paymentWindowSeconds": 3600,
    "resolutionWindowSeconds": 86400
  },
  "terminationPolicyHash": "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "disputePolicyHash": "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "nonce": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
}
```

`quoteValidUntil` is 2026-09-30 08:10:00 UTC and `accessExpiry` is 2026-10-01 08:00:00 UTC. Opening after quote expiry is refused; late activation cannot charge a new fee or silently move the access window. The signed termination/dispute policy documents must be available to both parties, not just their hashes.

견적 만료는 2026-09-30 08:10 UTC, 접근 만료는 2026-10-01 08:00 UTC다. 늦은 개설은 거부하며 지연 활성화를 이유로 다시 과금하거나 기간을 몰래 바꾸지 않는다. 종료·분쟁 정책도 해시뿐 아니라 원문을 양측이 확보해야 한다.

### Typed opening authorization / 구조화 개설 승인

A proposed EIP-712 `OpenAuthorization` binds `sessionId`, `termsHash`, `buyer`, `provider`, `resourceVersionHash`, `policyHash`, `scopeHash`, token, access fee, rate, checkout cap, maximum accepted units, quote deadline, access deadline, activation/evidence/payment/resolution windows, payment attester, termination/dispute hashes, and nonce. Domain fields include name `ALSP`, version `0.1`, the numeric EVM chain ID and verifying registry.

계약이 검사할 모든 값과 원문 해시를 양측 서명에 포함한다. 정책의 원문 해석은 오프체인에 있지만, 금액·기한·권한 검사는 온체인의 명시된 필드에 대해 수행한다. JSON과 구조화 승인 값이 일치하지 않으면 서명·개설하지 않는다. 위 문장은 타입 설계 요구사항이며 배포된 ABI나 완성된 서명 테스트 벡터가 아니다.

## D. Accepted usage and hash progression / 승인 사용과 해시 전진

The reference permits one outstanding metered request per recognized buyer/resource. For each response the provider proposes a cumulative receipt. The buyer may verify it and countersign after receiving the response. The next paid query is blocked until acknowledgment or explicit abandonment. Abandonment is not automatically a debt for an unacknowledged response.

동일 구매자·자원에서는 미승인 요청을 하나만 허용한다. 공급자가 응답과 누적 영수증을 제공하고 구매자가 수령 후 승인한다. 승인 또는 포기 처리 전에 다음 과금 호출을 진행하지 않는다. 미승인 응답의 포기는 자동 채무가 아니다.

Required usage payload fields:

```
requestId, resourceVersionHash, responseHash,
cumulativeAcceptedUnits, cumulativeCheckoutAmount,
issuedBeforeAccessEnd, receiptValidUntil
```

The enclosing signed event is:

```
protocol, domain, sessionId, termsHash,
seq, prevHash, eventType = "USAGE_ACCEPTED", payloadHash
```

Both parties sign the same event hash using the declared typed-signature domain. Counters must advance consistently; cost equals cumulative units times the original unit price and remains within cap. A compact receipt may be submitted with its bounded chain of predecessors; an implementation cannot accept an arbitrary jump solely because two numbers increase.

양측은 같은 이벤트 해시에 서명한다. 순번·누적 사용량·금액이 일치해야 하며 단가와 상한은 최초 조건을 따른다. 이전 체크포인트를 건너뛴 제출은 필요한 연결을 검증해야 한다. 두 숫자가 커졌다는 이유만으로 새 head를 받아들이지 않는다.

### Finalization timing / 최종화 시각

```
endAt = earlier of confirmed permitted termination and accessExpiry
receiptSubmissionDeadline = endAt + evidenceWindowSeconds
amountFinalizedAt >= receiptSubmissionDeadline
settlementDue = amountFinalizedAt + paymentWindowSeconds
```

Requests must be issued before the effective end, and receipts must satisfy the signed receipt window. The implementation must deterministically reject late/new usage while allowing timely acknowledgments already in flight. The freeze and quote occur as one registry transition; a quote valid only in a private database cannot create an on-chain default. Finalization may be called by either party using valid evidence; the provider cannot postpone an invoice and backdate its due time.

종료 전 요청과 종료 후 증거 접수 기간을 구분한다. 금액 확정과 견적 등록은 한 상태 전이로 묶는다. DB 안의 청구서만으로 온체인 미납을 만들지 않는다. 어느 당사자나 유효 증거로 최종화를 요청할 수 있고, 공급자가 청구를 지연한 뒤 기한을 소급할 수 없다.

## E. Checkout and payment binding / 체크아웃과 결제 결박

The checkout payload binds:

```
protocol, domain, sessionId, termsHash,
frozenUsageHead, frozenUsageSeq, acceptedUnits,
checkoutAmount, token, payee,
amountFinalizedAt, settlementDue, quoteNonce
```

`CHECKOUT_QUOTED` is the next event after the frozen usage head. The returned checkout document includes the payload and event, with signatures outside the hashed object. `quoteHash = H_quote(checkoutDocumentWithoutSignaturesAndDerivedHashes)`.

The buyer's separately signed `PaymentBinding` contains:

```
sessionId, termsHash, phase, operationId, quoteHash,
network, token, payer, payee, amount,
paymentAuthorizationNonce, bindingValidUntil
```

`phase` is exactly `CHECKIN` or `CHECKOUT`. Zero checkout takes a no-transfer close path. Unsupported third-party payers are rejected in v0.1. A payment cannot be matched by amount and recipient alone: the signed binding and exact consumed payment operation must be validated.

단계는 체크인·체크아웃 중 하나다. 0원 체크아웃은 무송금 종료 경로를 쓴다. 초기 버전은 제3자 대신 결제를 지원하지 않는다. 금액·수신자가 같다는 사실만으로 결제를 연결하지 않고, 서명된 결박과 고유 결제 작업을 함께 검증한다.

After finality, the adapter attests:

```
network, token, txHash, transferIndex,
payer, payee, amount, operationId, bindingHash,
observedBlock, finalityPolicyId
```

A proposed `paymentId` commits to network, token, transaction hash and transfer index. The registry consumes it once through its explicitly authorized adapter role. Transaction hashes, event indexes and a `success: true` JSON are not self-authenticating: verify ledger state before attesting. The baseline trust in the adapter is stated in both whitepapers.

정산 이벤트는 `paymentId`와 실제 지급액을 체크아웃 head 뒤에 연결한다. 자신의 상태 변경 트랜잭션 해시는 해시 입력에 넣지 않고 외부 종료 영수증에 첨부한다. 무송금 종료에는 결제 참조를 꾸며내지 않는다.

## F. Proposed HTTP surface / 제안 HTTP API

All paths below are **unimplemented proposal paths**, not URLs to submit to a directory. Bearer/session credentials stay in headers, not URLs. Free means no service payment, not zero network gas for any subsequently requested transaction.

| Method and path | Purpose / 목적 | Financial behavior / 금전 동작 |
| --- | --- | --- |
| `GET /alsp/v0/resources` | list supported resources, scopes, policy profiles / 자원·지원 범위 조회 | free; no sensitive licenses leaked |
| `POST /alsp/v0/check-in/quote` | validate and return exact terms / 조건·자격 검증 | free |
| `POST /alsp/v0/check-in` | accept quote and bind payment / 체크인 | x402 fee only for this idempotent operation |
| `POST /alsp/v0/sessions/{id}/query` | gated knowledge call / 이용 | accrue only accepted units; not a third x402 payment in P1 |
| `POST /alsp/v0/sessions/{id}/ack` | submit buyer's receipt signature / 수령·과금 승인 | no token movement |
| `POST /alsp/v0/sessions/{id}/end` | stop new access, start evidence window / 접근 종료 | no debit; preserves accepted obligations |
| `POST /alsp/v0/sessions/{id}/checkout/quote` | freeze accepted amount after evidence window / 정산액 확정 | no debit |
| `POST /alsp/v0/sessions/{id}/checkout` | pay and close / 지급·종결 | x402 checkout, or no-transfer zero close |
| `GET /alsp/v0/sessions/{id}` | access/settlement/operation status / 상태 조회 | free, authenticated |
| `GET /alsp/v0/sessions/{id}/evidence` | retrieve buyer-visible record / 증거 반출 | free, authenticated |
| `POST /alsp/v0/sessions/{id}/disputes` | submit admissible evidence / 이의 제기 | no automatic penalty or debit |
| `POST /alsp/v0/operations/{id}/reconcile` | reapply or inspect existing payment / 복구 | must never create a replacement debit |

A valid unpaid paid-operation request receives HTTP 402 with the selected x402 scheme's `PAYMENT-REQUIRED` response header. The client payment is carried in `PAYMENT-SIGNATURE` and the confirmed result follows the actual supported transport's response conventions. ALSP's license binding is custom application data, not an officially registered x402 extension. Capability support must be tested before advertising.

유효한 결제 작업에 돈이 없으면 x402 표준 신호를 사용한다. ALSP 이용권 결박은 사용자 정의 데이터이며 공식 확장으로 등록됐다는 뜻이 아니다. 지원 여부를 검증하지 않고 판매 목록에 올리지 않는다.

Invalid input: `400`; missing identity: `401`; provider-local ineligibility: `403`; state conflict: `409`; limit exceeded before collecting payment: `429`; unconfigured service before payment: `503`. Known pending payment/application: `202` with stable operation identity. Confirmed completion: `200` or `201`. A provider outage must not be translated into buyer default.

## G. Registry functions and authorization / 레지스트리 함수와 권한

These are logical operations, **not a ready-to-deploy Solidity interface**. Every implementation must specify ABI encoding, signature checks, caller roles and bounded loops.

| Operation | Required checks |
| --- | --- |
| `openSession` | both parties' opening authorizations; unique session/nonce; quote valid; trusted confirmed check-in; no local default; typed terms fixed |
| `checkpointAcceptedUsage` | party signatures; same domain/terms; prior head; sequential link; monotone units; exact rate; cap; valid request/receipt window |
| `endAccess` | authorized terminating party; reason allowed by original terms; earliest effective end retained; no extra future charges |
| `finalizeCheckout` | evidence window elapsed; latest admissible head frozen; charge derived, not arbitrary; payment deadline set prospectively |
| `applyCheckoutPayment` | exact phase/amount/token/parties/quote; authorized verified payment evidence; unconsumed payment ID; terminal state applied once |
| `closeZeroAmount` | evidence finalization valid; amount truly zero; no fictitious transfer |
| `markOverdue` | finalized nonzero obligation; due passed; unpaid; no admissible unresolved dispute or verified payment recovery |
| `recordDispute / resolveDispute` | authenticated evidence and signed policy; no increase above accepted liability; bounded resolution and fresh deadline |
| `getSession / eligibility` | report finalized observations and effective time predicates; do not confuse unknown with paid |

Arbitrary callers must not set `amountPaid` or final heads merely by supplying a hash. A role allowed to pause new access must not acquire withdrawal or debt-increase powers. Existing obligations must stay readable when operations are paused. Claims about an atomic payment router require a separate code path and test profile.

임의 호출자가 해시 하나로 지급액·최종 head를 정하지 못하게 한다. 접근 일시정지 권한은 출금·채무 증가 권한과 분리한다. 중단 중에도 기존 의무를 조회할 수 있어야 한다. 원자적 결제 라우터의 보장은 별도 구현·테스트 대상으로 남긴다.

## H. Required recovery cases / 필수 복구 사례

| Failure point | Required result |
| --- | --- |
| before payment | no activated license, no fee collected |
| payment submitted, response lost | inspect same authorization/transaction; no new debit |
| check-in paid, registry unavailable | `REGISTRY_PENDING`; resume opening or activation-failure refund handling |
| query response delivered, no acknowledgment | not accepted usage; stop next metered call; bounded provider exposure |
| acknowledgment accepted, response lost | idempotent ack retrieval; no second unit |
| checkout paid, registry write fails | pending close, not payable again; reconcile using same confirmed payment |
| same payment on two sessions | one unique consumption; reject second mapping |
| payment proof forged or wrong chain | refuse proof; do not close |
| dispute unresolved by agreed deadline | `UNRESOLVED`, not paid or automatic default |
| late payment after local default | close once and clear only that obligation's restriction contribution |

## I. Validation matrix / 검증 계획

**These are acceptance requirements, not tests already run against a contract. / 아래는 계약 테스트 실행 결과가 아니라 구현 수용 기준이다.**

1. Changing one economic or identity field invalidates opening authorization.
2. Reordered JSON object keys canonicalize equally; reordered arrays do not silently become equivalent.
3. Duplicate keys, floats in money, scientific notation, unknown fields and malformed hashes are rejected.
4. Old signatures fail on a different chain, registry, session or operation phase.
5. The 11-unit fixture bills checkout 5,500,000, not 6,500,000; entry fee is counted once.
6. Usage above the signed cap is refused before incurring new agreed charges.
7. A larger counter without a checked hash path cannot replace the current head.
8. Provider-only usage claims cannot produce automatic buyer default.
9. Expiry stops new queries even if no keeper has written an expiry transaction.
10. A zero-usage close creates no fake second payment.
11. Deadline boundaries and evidence windows are deterministic under duplicate calls.
12. Parallel settlement workers cannot debit or apply the same operation twice.
13. Kill the process after payment finality and before state application; recovery closes without recharging.
14. A new wallet can bypass a wallet-scoped ban in the test; report the limitation rather than hiding it.
15. Banned buyers can still read evidence, reconcile, dispute and pay.
16. One settled debt does not erase another outstanding session.
17. An adapter compromise can falsify its attestation in the threat model; do not report the baseline as trustless.
18. Network outages and verified pending transfers cannot generate automatic false-default labels.
19. Mutating a resource version or license source is detected against the pinned commitment.
20. The gateway treats knowledge text and LLM output as untrusted data, never authorization.

## J. Remaining specification work / 남은 명세 작업

Before implementation, pin concrete EIP-712 type strings, signature-library version, EOA validation rules, x402 scheme/network/asset capabilities, canonicalization implementation, Merkle leaf ordering/padding if used, finality policy, bounded checkpoint batch size, proof availability, dispute admissibility and timing, and activation-failure refund procedure. These details must be supplied with reproducible vectors rather than inferred from this draft.

구현 전에는 구체적 서명 타입·라이브러리·EOA 검증·x402 조합·정규화 구현·머클 순서·확정 기준·배치 상한·증거 가용성·분쟁·환불 절차를 재현 가능한 벡터와 함께 고정해야 한다. 이 백서가 그 작업을 완료했다고 가정하지 않는다.

[English whitepaper](en/whitepaper.md) · [한국어 백서](ko/whitepaper.md) · [References](references.md)
