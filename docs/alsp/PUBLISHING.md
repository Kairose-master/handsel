# GitBook publication / GitBook 게시 안내

## Current delivery state / 현재 전달 상태

These are completed draft manuscripts, not a confirmed GitBook publication. The existing Handsel GitBook is independently curated and not synchronized from the repository, as stated in `docs/README.md`. The GitBook connection must be authorized before an assistant can edit its spaces or publish there. Do not assume a docs PR updates that site.

원고 초안은 작성됐지만 GitBook 게시 완료를 뜻하지 않는다. 기존 Handsel GitBook은 `docs/README.md`에 따르면 레포와 자동 동기화되지 않는다. GitBook 연결을 승인해야 공간을 읽고 수정·게시할 수 있다. 문서 PR만으로 기존 사이트가 갱신됐다고 가정하지 않는다.

## Recommended structure / 권장 구성

Use a new ALSP section or separate draft space. Preserve existing Handsel documentation. This source package contains a bilingual home, full Korean and English whitepapers, a shared technical appendix and a bibliography. The language editions are parallel manuscripts, not an automatically billed translation workflow.

새 ALSP 섹션 또는 별도 초안 공간을 사용하고 기존 Handsel 문서는 보존한다. 한·영 홈, 전체 한국어·영어 백서, 공통 기술 부록과 출처를 제공한다. 두 언어판은 직접 작성한 원고이며 유료 자동 번역 워크플로를 생성하지 않는다.

## Import path / 가져오기

GitBook supports Markdown and multi-page Markdown ZIP imports. Import this folder's Markdown files into a new space, then use `SUMMARY.md` as the intended page order. Confirm links, code fences, tables and Mermaid rendering in the editor. If diagrams import as code, keep the source and convert the block to a supported diagram representation; do not delete the trust labels to simplify it.

GitBook의 Markdown·다중 페이지 ZIP 가져오기를 이용하고 `SUMMARY.md` 순서로 배치한다. 편집기에서 링크·코드·표·Mermaid 표시를 점검한다. 자동 정리 기능이 서명 필드나 MUST 문장을 바꾸지 않도록 검토한다. 그림이 코드로 들어오면 원본을 유지한 채 지원하는 도식 블록으로 변환한다.

## Optional language variants / 선택적 언어 variant

For a language selector, create or select two dedicated spaces, one for Korean and one for English, and link them as variants of the same docs site. Copy the shared appendix and bibliography to both or maintain explicit common links. Recheck relative URLs after moving pages. Creating two folders in GitHub alone does not create GitBook language variants.

언어 선택기가 필요하면 한국어·영어 공간을 각각 구성한 뒤 같은 사이트의 variant로 연결한다. 공통 부록·출처는 두 공간에 복사하거나 명확한 공통 링크로 유지하고 상대경로를 다시 점검한다. GitHub 폴더 두 개만 만든다고 variant가 생기지는 않는다.

## Optional Git Sync / 선택적 Git 동기화

A new ALSP space may be connected to a chosen branch and `docs/alsp` content root after checking current GitBook settings. Existing GitBook content must not be overwritten or replaced by this repository without a deliberate migration decision. No root `.gitbook.yaml` is added by this draft, because it could change unrelated documentation routing.

새 ALSP 공간은 현재 설정을 확인한 뒤 선택한 브랜치·`docs/alsp` 루트와 연결할 수 있다. 기존 GitBook 내용을 임의로 덮어쓰거나 레포 전체를 가져오지 않는다. 이 초안은 무관한 문서 구성을 바꿀 수 있는 루트 `.gitbook.yaml`을 추가하지 않는다.

## Publication checklist / 게시 체크리스트

- Both language versions display v0.1.0 and the same draft status / 양 언어판 버전·초안 상태 일치.
- All example addresses and hashes remain labelled synthetic / 예시 주소·해시의 합성 표기 유지.
- Access expiry and debt default remain separate / 접근 만료와 미납 분리.
- P1 postpayment is not described as guaranteed collection / P1을 회수 보장처럼 설명하지 않음.
- Payment-adapter trust is visible in the diagram and text / 결제 어댑터 신뢰 경계 노출.
- No claims of production deployment, audited security or first-ever novelty / 배포·감사·최초성 허위 주장 없음.
- Links and diagrams are checked in the actual GitBook rendering / 실제 GitBook 렌더링 점검.
- Save as a draft or change request; record the actual page URL only after creation / 생성 후 실제 URL을 기록하고 초안·변경 요청으로 검토.

Official instructions: [Markdown import](https://gitbook.com/docs/getting-started/import) · [Language variants](https://gitbook.com/docs/guides/content-organization-and-localization/localize-your-docs-with-variants-in-gitbook) · [Git Sync](https://www.gitbook.com/features/git-sync).
