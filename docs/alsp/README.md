# ALSP Whitepaper / ALSP 백서

**Agent License Session Protocol**  
**에이전트용 지식·도구 이용권의 체크인과 체크아웃 정산**  
**v0.1.0 · Design draft / 설계 초안 · 2026-09-30**

**Author / 저자:** Jinwoo Jang / 장진우

ALSP binds a buyer's license terms, accepted usage, and checkout settlement into one hash-linked session. Access expiry is separate from unpaid obligations. The first proposed profile uses a check-in access fee and separately authorized x402 checkout payment; a provider-local restriction is not a universal ban or guaranteed debt recovery.

ALSP는 구매자의 이용 조건, 승인 사용량, 체크아웃 정산을 해시로 연결된 하나의 세션으로 관리하는 제안이다. 접근 만료와 미정산 의무를 구분한다. 첫 모델은 체크인 접근료와 별도 승인된 체크아웃 결제이며, 공급자 내부 제한이 보편적인 밴이나 채권 회수 보장을 의미하지 않는다.

## Read / 읽기

- [한국어 백서](ko/whitepaper.md)
- [English whitepaper](en/whitepaper.md)
- [Technical appendix / 데이터·API·검증 부록](appendix.md)
- [References / 참고문헌](references.md)
- [GitBook publication / 게시 안내](PUBLISHING.md)

## Status / 상태

The two editions describe the same proposal; neither language can override explicit signed wire terms. The shared appendix defines the draft interface vocabulary. Any translation conflict must be resolved explicitly before implementation, not by choosing whichever text allows a charge.

양 언어판은 같은 제안을 설명한다. 어느 언어판도 명시적으로 서명한 데이터 조건을 덮어쓰지 않는다. 번역 충돌이 발견되면 구현 전에 해소해야 하며 과금에 유리한 표현을 임의 선택해서는 안 된다.

**Not implemented, not audited, no live collection enabled.** Existing Handsel job and payment code is not represented as an ALSP implementation. The draft proposes no new token. It includes no revenue, throughput, novelty, or legal-enforceability guarantee.

**미구현·미감사 설계 초안이며 실결제를 활성화하지 않는다.** 기존 Handsel 작업·결제 코드를 ALSP 구현이라고 주장하지 않는다. 신규 토큰을 제안하지 않고 매출·처리량·최초성·법적 효력을 보장하지 않는다.

## Revision / 개정

| Version | Date | Scope |
| --- | --- | --- |
| 0.1.0 | 2026-09-30 | First bilingual whitepaper; explicit payment-adapter trust; separate postpaid/prefunded profiles; failure-aware checkout and provider-local default rules |

This folder is a GitBook-ready source package. The existing Handsel GitBook is independently curated according to the repository documentation. Adding these files or merging a PR does **not** establish that the GitBook site has been updated.

이 폴더는 GitBook용 원고 패키지다. 기존 Handsel GitBook은 레포 문서와 별도로 관리된다. 파일 추가·PR 병합만으로 GitBook 게시가 완료된 것은 아니다.
