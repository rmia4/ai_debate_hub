# 디자인 구현 계획: 첫 화면 + 사이트 테마

## 요약
- **범위:** 사이트 전체 테마(공통 스타일) + 첫 화면(`GET /`) 개편
- **대상 파일:** `src/web/html.ts`(공통 `page()` 스타일), `src/web/pages.ts`(첫 화면)
- **선택한 시안:** 테마는 "터미널", 구조는 B "좌우 분할 + 토론 기록 미리보기"
- **바뀌는 점**
  - 브라우저 기본 스타일 수준이던 화면에 공통 테마를 적용합니다. 라이트·다크 모두 시스템 설정을 따릅니다.
  - 첫 화면은 한 줄 소개와 토론 기록 예시를 먼저 보여 줍니다. 이어서 "왜 / 어떻게 / 무엇이 남나"로 사이트를 설명하고, 그다음에 사용 방법과 진행 방식을 보여 줍니다.

## 디자인 랩에서 정한 것
- 고정폭 글꼴은 기호(`>`, `##`, `~/`, `[ ]`), 영문 라벨, 번호, 주소·코드에만 씁니다. **한글 제목과 본문은 일반 글꼴**을 씁니다. 한글을 고정폭 글꼴로 쓰면 보기 나쁘다는 피드백을 받았습니다.
- 제목 뒤의 깜빡이는 커서는 쓰지 않습니다.
- 글래스(그라데이션), 말랑 카드, 네오 브루탈리즘, 두 색 대칭, 편집(명조) 방향은 모두 탈락했습니다.
- "터미널 세션" 구조(페이지 전체를 명령과 출력으로 꾸미는 방식)는 탈락했습니다.

## 바꿀 파일
- [ ] `src/web/html.ts`: `page()`의 `<style>` 교체, 공통 내비게이션과 푸터 정리, 첫 화면처럼 기본 `<h1>`을 쓰지 않는 페이지를 위한 옵션 추가
- [ ] `src/web/pages.ts`: `GET /` 본문을 B 구조로 교체
- [ ] `test/stage4-criteria.test.ts`: 현재 테스트는 `사용 방법`과 `href="/login"`이 있는지만 봅니다. 둘 다 유지되므로 수정할 필요는 없을 것으로 예상합니다. 구현 후 `npm test`로 확인합니다.

## 구현 단계
1. **테마 CSS를 `page()`에 넣기**
   - 아래 "디자인 토큰"과 "공통 요소" CSS를 `<style>`에 넣습니다.
   - CSP가 `style-src 'self' 'unsafe-inline'`이므로 인라인 스타일을 그대로 써도 됩니다.
   - 외부 폰트는 쓰지 않습니다.
2. **기존 클래스 연결**
   - 이미 여러 화면에서 쓰는 클래스(`.warn`, `.cols`, `.turn`, `.badge`, `.ok`, `.inline`, `table`, `label`, `button`, `.btn`, `code`, `pre`, `dialog`)를 테마 토큰으로 다시 정의합니다.
   - 클래스 이름은 바꾸지 않습니다. 사용처가 27곳 이상이므로, 바꾸면 다른 화면이 깨집니다.
3. **`page()`에 옵션 추가**
   - 지금 `page()`는 제목을 항상 `<h1>`으로 출력합니다. 첫 화면은 자체 `<h1>`과 상단 내비게이션을 쓰므로 `page(title, body, { bare: true })` 같은 옵션을 둡니다.
   - 옵션을 쓰면 본문 폭 제한(`max-width`)과 기본 `<h1>`을 생략합니다.
   - 다른 화면은 지금처럼 호출하고 새 테마만 받습니다.
4. **첫 화면 마크업 교체**: 아래 "첫 화면 구조"를 따릅니다.
   - 로그인했으면 주 버튼이 `내 토론으로`(`/app`), 아니면 `GitHub 또는 Google로 로그인`(`/login`)입니다.
   - MCP 주소 복사는 기존 `data-copy` 동작(`/static/app.js`)을 재사용합니다. 주소에 `id`를 주고, 복사 실패 안내(`#copy-error`)도 둡니다.
   - 토론 기록 창은 고정된 예시입니다. 실제 데이터를 쓰지 않습니다. `aria-label="토론 예시"`로 예시임을 밝힙니다.
5. **반응형**
   - 900px 미만: "왜 / 어떻게 / 무엇이 남나" 세 칸을 1열로 접습니다. 미리보기에서 760px 근처에서 세 칸이 눌려 보였습니다.
   - 760px 미만: 위쪽 분할, 아래쪽 두 칸, 기존 `.cols`를 1열로 접습니다.
6. **다른 화면 확인**
   - 토론 목록, 토론 상세(동시 2열, 순차 타임라인), 연결 설정(Codex 대화상자), MCP 동의 화면, 운영자 화면을 라이트·다크로 열어 깨지는 곳이 없는지 봅니다.
   - 이번 범위에서는 구조를 바꾸지 않고 테마만 적용합니다.
7. **검증**: `npm run typecheck`, `npm test`, `npm run dev`로 첫 화면과 위 화면들을 실제로 확인합니다.

## 첫 화면 구조 (B)
```
nav            ~/ai-debate-hub ........................ [이용약관] [개인정보] [로그인]
split (2열)    왼쪽: h1.prompt "두 AI 채팅이 토론해 합의안을 만듭니다"
                     p.lead "Claude와 Codex처럼 서로 다른 AI, 또는 같은 AI의 두 채팅이
                             한 주제를 놓고 의견을 주고받고 서로 검토합니다. 무료입니다."
                     a.btn.fill (로그인 / 내 토론으로)
                     .kv  MCP 주소 + [복사]
               오른쪽: .win 토론 기록 예시 (창 머리: "토론 #42 · 동시 · 라운드 3/5")
                       A석 · Claude / B석 · Codex 답변 4줄 + [합의] 합의안 v2 · 3라운드
about (3칸)    .box[왜]         AI 하나에게만 물으면 그 AI의 관점과 실수를 그대로 받게 됩니다.
                                다른 AI에게 검토를 맡기려면 답변을 직접 복사해 옮겨야 합니다.
               .box[어떻게]     두 채팅을 이 서버에 연결하면 서로의 답변을 직접 읽고
                                반박·수정안·동의를 주고받습니다. 서버가 기록·차례·합의 판정을 맡습니다.
               .box[무엇이 남나] 합의안, 남은 쟁점, 라운드별 전체 기록. 웹에서 보고 마크다운으로
                                내보냅니다. 설계 검토, 아이디어 검증, 글 상호 검토에 씁니다.
rows (2열)     왼쪽: h2 "사용 방법" + ol.steps (지금 5단계 문구 그대로)
               오른쪽: h2 "진행 방식" + .box[동시] + .box[순차] (지금 문구 그대로)
                       + p.note "AI 사용료는 각자의 AI 구독에서 나갑니다. 기밀이나 개인정보는 넣지 마세요."
footer         처음 · 이용약관 · 개인정보 처리방침
```

## 디자인 토큰
라이트는 `:root`에 두고, 다크는 `@media (prefers-color-scheme: dark)`로 덮어씁니다.

| 토큰 | 라이트 | 다크 | 용도 |
| --- | --- | --- | --- |
| `--bg` | `#f4f5f2` | `#0c0e0c` | 페이지 바탕 |
| `--panel` | `#fff` | `#121512` | 상자, 표, 내비게이션 바탕 |
| `--fg` | `#1b1f1a` | `#d6dcd3` | 본문 |
| `--mute` | `#6a7068` | `#7f877c` | 보조 글자 |
| `--line` | `#c9cdc4` | `#2b302a` | 선 |
| `--acc` | `#16794a` | `#4ade80` | 강조, 링크, 버튼, A석 |
| `--hl` | `#e3f3e9` | `#13261a` | 코드 바탕, 강조 바탕 |
| `--b` | `#a3480b` | `#fbbf24` | B석 |
| `--dot` | `#cfd3cb` | `#1f231e` | 점 격자 배경 |
| `--mono` | `ui-monospace,"Cascadia Code",Consolas,monospace` | | 기호·라벨·번호·주소 |

## 공통 요소 CSS (랩 최종본에서 옮김)
```css
body{background:radial-gradient(var(--dot) 1px,transparent 1.2px) 0 0/18px 18px,var(--bg);color:var(--fg);
  font-family:system-ui,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;font-size:.95rem;line-height:1.7}
nav{display:flex;align-items:center;gap:1.1rem;padding:.8rem 2rem;font-family:var(--mono);font-size:.85rem;border-bottom:1px dashed var(--line);background:var(--panel)}
nav .brand{margin-right:auto;font-weight:700}nav .brand::before{content:"~/";color:var(--acc)}
nav a{color:var(--mute);text-decoration:none}nav a::before{content:"[";color:var(--line)}nav a::after{content:"]";color:var(--line)}
h1{font-size:2rem;font-weight:800;line-height:1.35;letter-spacing:-.02em}
h1.prompt::before{content:"> ";font-family:var(--mono);color:var(--acc)}
h2{font-size:1.15rem;font-weight:700}h2::before{content:"## ";font-family:var(--mono);color:var(--mute);font-weight:400}
a{color:var(--acc)}
code{font-family:var(--mono);font-size:.85em;background:var(--hl);color:var(--acc);padding:.05rem .35rem;word-break:break-all}
.btn{display:inline-block;font-family:var(--mono);font-size:.88rem;font-weight:600;padding:.6rem 1.1rem;min-height:44px;color:var(--acc);border:1px solid var(--acc);border-radius:2px;text-decoration:none;background:transparent}
.btn::after{content:" →"}.btn:hover,.btn.fill{background:var(--acc);color:var(--bg)}
.btn:focus-visible,button:focus-visible{outline:2px solid var(--acc);outline-offset:3px}
.steps{list-style:none;padding:0;counter-reset:s;background:var(--panel);border:1px solid var(--line)}
.steps li{counter-increment:s;display:flex;gap:1rem;padding:.55rem .9rem;border-bottom:1px solid var(--line)}.steps li:last-child{border:0}
.steps li::before{content:counter(s,decimal-leading-zero);font-family:var(--mono);color:var(--acc);flex:none}
.box{background:var(--panel);border:1px solid var(--line);padding:1.5rem 1.1rem 1.1rem;position:relative}
.box>.lbl{position:absolute;top:-.75rem;left:.7rem;background:var(--bg);padding:0 .4rem;font-family:var(--mono);font-size:.82rem;color:var(--acc);font-weight:600}
.note{color:var(--mute);font-size:.88rem}.note::before{content:"# ";font-family:var(--mono)}
table{border-collapse:collapse;width:100%;background:var(--panel);border:1px solid var(--line)}
th,td{text-align:left;padding:.55rem .8rem;border-bottom:1px dashed var(--line)}th{font-family:var(--mono);color:var(--mute);font-weight:500;font-size:.8rem}
.tag{font-family:var(--mono);font-size:.78rem;color:var(--mute)}.tag::before{content:"["}.tag::after{content:"]"}.tag.ok{color:var(--acc)}
.kv{display:flex;align-items:center;gap:.5rem;font-family:var(--mono);font-size:.82rem;background:var(--panel);border:1px solid var(--line);padding:.45rem .6rem}
.win{background:var(--panel);border:1px solid var(--line)}
.win-h{display:flex;gap:.4rem;align-items:center;padding:.45rem .7rem;border-bottom:1px solid var(--line);font-family:var(--mono);font-size:.75rem;color:var(--mute)}
.win-h i{width:.6rem;height:.6rem;border-radius:50%;border:1px solid var(--line)}
.log .ln{padding:.4rem 0;border-bottom:1px dashed var(--line)}.log .a{color:var(--acc)}.log .b{color:var(--b)}
footer{font-family:var(--mono);font-size:.78rem;color:var(--mute);border-top:1px dashed var(--line)}
```
기존 클래스 대응 (2단계):
- `.warn`: `--b` 테두리, `--panel` 바탕
- `.badge`: `.tag` 모양
- `.ok`: `--hl` 바탕
- `.turn`: `--panel` 바탕에 `--line` 테두리
- 동시 방식 2열의 A석 쪽은 `--acc`, B석 쪽은 `--b`로 위쪽 3px 선
- `button`(폼 제출): `.btn`과 같은 모양이고 `::after` 화살표는 없음
- `dialog`: `--panel` 바탕에 `--line` 테두리

## 필요한 화면 상태
- **로그인 전·후:** 주 버튼의 문구와 링크만 다릅니다(`/login` 또는 `/app`).
- **복사 실패:** 기존처럼 `#copy-error` 안내를 보입니다.
- **다크 모드:** 시스템 설정을 따릅니다. 수동 전환 버튼은 두지 않습니다.
- **동작 줄이기:** 애니메이션이 없으므로 따로 처리할 것이 없습니다. 버튼 색 전환만 0.15초입니다.

## 접근성 체크리스트
- [ ] 버튼·링크·복사 버튼은 키보드로 이동할 수 있고, 2px 포커스 링이 보입니다.
- [ ] 클릭 영역은 최소 44px입니다(복사 버튼은 32px이므로 구현 때 키울지 판단).
- [ ] 라이트·다크에서 본문 대비 4.5:1 이상인지 확인합니다. 특히 `--mute`와 다크의 `--acc` 위 글자.
- [ ] 토론 예시 창은 `aria-label`로 예시임을 밝힙니다.
- [ ] `nav`, `main`, `footer` 등 의미 있는 태그를 씁니다.

## 테스트 체크리스트
- [ ] `npm run typecheck`
- [ ] `npm test`: 소개 페이지 테스트(`사용 방법`, `href="/login"`) 통과
- [ ] `npm run dev`로 첫 화면, 토론 목록·상세, 연결 설정, 동의 화면을 라이트·다크로 직접 확인

---

*Design & Refine 플러그인으로 정한 결과*
