# References / 참고문헌

**Consulted / 확인 기준: 2026-09-30.** Moving documentation and repository branches can change. These links identify consulted primary sources; they are not endorsements, integrations, code audits or proof that a feature is deployed on a chosen network. For implementation, pin exact SDK/specification commits and test capabilities.

공식 문서와 이동하는 브랜치는 이후 바뀔 수 있다. 링크는 참고 출처이며 보증·협업·연동 완료·코드 감사·특정 네트워크 배포를 뜻하지 않는다. 구현에서는 정확한 버전과 커밋을 고정하고 지원 여부를 시험해야 한다.

| ID | Primary source | Why cited / 참고 범위 |
| --- | --- | --- |
| R1 | W3C, [ODRL Information Model 2.2](https://www.w3.org/TR/odrl-model/), Recommendation, 2018 | Existing permissions, prohibitions, constraints and duties / 권리·의무 표현의 선행 |
| R2 | Ethereum, [ERC-20: Token Standard](https://eips.ethereum.org/EIPS/eip-20) | Token transfer and allowance model / 전송·allowance와 예치의 구분 |
| R3 | Ethereum, [ERC-3009: Transfer With Authorization](https://eips.ethereum.org/EIPS/eip-3009) | Authorized transfers, validity windows and nonces / 지급 승인·유효기간·nonce |
| R4 | Ethereum, [Introduction to smart contracts](https://ethereum.org/en/developers/docs/smart-contracts/) | Contract state and execution / 상태 변경에는 실행이 필요 |
| R5 | RFC Editor, [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785), 2020 | Deterministic JSON representation / JSON 정규 표현 |
| R6 | Ethereum, [EIP-712: Typed structured data hashing and signing](https://eips.ethereum.org/EIPS/eip-712) | Typed signing and domain separation; application replay policy still required / 구조화 서명·도메인 분리 |
| R7 | RFC Editor, [RFC 9162: Certificate Transparency Version 2.0](https://www.rfc-editor.org/rfc/rfc9162), 2021 | Merkle inclusion/consistency; not semantic truth / 포함·일관성 증명과 내용의 진실성 구분 |
| R8 | x402 Foundation, [x402 v2 core specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md) | Payment messages and facilitator responsibility; application session scope / 결제 형식·책임 범위 |
| R9 | x402 Foundation, [`upto` scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto.md) | Capped actual-use settlement comparator / 상한 기반 사후 정산 선행 |
| R10 | x402 Foundation, [`batch-settlement` scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement.md) | Deferred commitments and later settlement comparator / 반복 이용·지연 정산 비교 |
| R11 | XRPL, [Credentials](https://xrpl.org/docs/concepts/decentralized-storage/credentials) | Credential issuer, subject, expiry and deletion / 자격 발급·만료·삭제 |
| R12 | XRPL, [Escrow](https://xrpl.org/docs/concepts/payment-types/escrow) | Native escrow conditions and execution / 기본 예치·지급·취소의 조건 |
| R13 | T54, [XRPL x402 Facilitator](https://docs.t54.ai/docs/xrpl/x402-facilitator) | Documented XRPL `exact` payment boundary / 현재 설명된 결제 어댑터 범위 |
| R14 | XRPL, [Known Amendments](https://xrpl.org/resources/known-amendments) | SmartEscrow listed as in development when consulted; not a runtime dependency / 개발 중 표시를 배포 완료로 해석하지 않음 |
| R15 | Yang Xiao, Ning Zhang, Jin Li, Wenjing Lou, Y. Thomas Hou, [PrivacyGuard: Enforcing Private Data Usage Control with Blockchain and Attested Off-chain Contract Execution](https://arxiv.org/abs/1904.07275), 2019; [HTML full text](https://arxiv.org/html/1904.07275) | Blockchain policy and TEE-based data-use/completion protocol; compare different trust assumptions / 가까운 학술 선행과 신뢰 가정 비교 |
| R16 | LICENSE402 authors, [Project description](https://www.hackquest.io/projects/LICENSE402) | Creator-described x402 licensing and rights checks; no full code audit performed / 제작자 공개 설명 수준의 비교 |

## Publication references / 게시 참고자료

- GitBook, [Migrate to GitBook](https://gitbook.com/docs/getting-started/import): Markdown and multi-page ZIP import. Import rendering should be checked rather than assumed.
- GitBook, [Localize docs with variants](https://gitbook.com/docs/guides/content-organization-and-localization/localize-your-docs-with-variants-in-gitbook): dedicated language spaces can be linked as variants. This package itself does not create those spaces.
- GitBook, [Git Sync](https://www.gitbook.com/features/git-sync): synchronization requires a configured connection; it is not implied by a GitHub commit.

GitBook는 Markdown·ZIP 가져오기를 지원하고 언어별 공간을 variant로 연결할 수 있다. 이 원고 작성 자체가 공간·동기화·게시를 생성하지는 않는다.

## Source hierarchy and limits / 자료 위계와 한계

Standards and RFCs establish definitions, not performance of ALSP. Paper claims belong to the paper's stated model and evaluation. Project documentation is evidence of what its authors describe, not verified customer adoption. ALSP diagrams, formulas, states, and APIs are the present proposal unless explicitly attributed otherwise.

표준은 개념을 정의할 뿐 ALSP 성능을 증명하지 않는다. 논문의 보장은 해당 모델·평가 범위에 속한다. 프로젝트 문서는 제작자의 설명이며 실제 고객 채택의 독립 검증이 아니다. 별도 출처를 표시하지 않은 ALSP 도식·공식·상태·API는 현재 제안이다.

No exhaustive patent search, freedom-to-operate review, cryptographic proof, contract security audit, or legal opinion is included. Do not promote this draft as the first-ever implementation of its broad ingredients.

전체 특허 조사·실시 자유 검토·암호학적 증명·계약 보안 감사·법률 의견은 포함하지 않는다. 이 초안을 광범위한 구성요소의 세계 최초 구현이라고 홍보해서는 안 된다.
