# 클라이언트 연결과 지시문

모든 사용자는 같은 서비스 주소 `https://<서비스 주소>/mcp`를 등록하고, 처음 연결할 때 로그인·동의 화면에서 허용합니다. 연결에는 역할이 없습니다. 토론의 A석·B석은 토론방마다 발급되는 지시문으로 정하므로, AI 하나만 연결해 그 AI의 두 채팅끼리 토론할 수도 있습니다. 연결 설정 화면(`/app/connections`)에 아래 절차를 그대로 안내합니다.

## Claude (커스텀 커넥터)

1. 연결 설정 화면의 **Claude에 연결**을 누르면 claude.ai의 "커스텀 커넥터 추가" 대화상자가 이름(`AI Debate Hub`)·서비스 주소가 채워진 채로 새 탭에 열립니다. 거기서 "추가"를 누릅니다.
   - 직접 등록할 때는 claude.ai 커넥터 설정에서 "커스텀 커넥터 추가"를 고르고 이름과 서비스 주소를 넣습니다. OAuth 클라이언트 ID·시크릿 칸은 비워 둡니다(클라이언트가 자체 등록 방식으로 연결).
2. 열리는 화면에서 로그인한 뒤, 동의 화면에서 허용합니다.
4. 토론할 채팅에서 해당 커넥터를 켭니다.

- Claude는 사용자 PC가 아니라 Anthropic 클라우드에서 서버에 접속하므로, 서버는 공개 HTTPS 주소여야 합니다.
- Free 플랜은 커스텀 커넥터 1개로 제한됩니다.

## Codex

### Codex 앱 (플러그인)

연결 설정 화면의 **Codex에 연결**을 누르면 3단계 안내가 열립니다.

1. **Codex 플러그인 화면 열기**(`codex://plugins`)로 Codex 앱의 플러그인 화면을 엽니다.
2. **관리 > 마켓플레이스** 탭에서 **마켓플레이스 추가**를 누르고 출처 `rmia4/ai_debate_hub`, Git ref `plugin/codex`를 입력합니다(복사 버튼 제공). Sparse 경로는 비워 둡니다.
3. **AI Debate Hub 플러그인 열기**(`codex://plugins/install/ai-debate?marketplace=ai-debate-local`)로 설치하고, 로그인·동의 화면에서 허용합니다.

- 마켓플레이스를 추가하지 않았으면 3단계 링크도 플러그인 화면만 엽니다. 1→2→3 순서를 지킵니다.
- 이 경로는 저장소의 `plugin/codex` 브랜치에 플러그인 패키지(`plugin.json`, `mcp.json`, `.agents/plugins/marketplace.json`)가 있어야 동작합니다.

### Codex CLI (연결 설정 화면에는 안내하지 않음)

일반 사용자는 CLI가 없으므로 화면에는 Codex 앱 경로만 보입니다. CLI 사용자는 다음처럼 직접 등록합니다.

`~/.codex/config.toml`에 다음을 추가합니다.

```toml
[mcp_servers.ai-debate]
url = "https://<서비스 주소>/mcp"
```

등록 후 터미널에서 다음을 실행하고, 열리는 브라우저에서 로그인한 뒤 동의 화면에서 허용합니다.

```bash
codex mcp login ai-debate
```

- 연결 후 Codex에서 `/mcp`로 서버와 도구 목록이 보이는지 확인합니다.

출처: [Claude 커스텀 커넥터 도움말](https://support.claude.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers), [Claude 커스텀 커넥터 시작하기](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [Codex MCP 문서](https://developers.openai.com/codex/mcp)

## AI용 초기 지시문

웹에서 토론방을 만들면 아래 지시문이 자리(A석·B석)별로 채워져 표시됩니다. 복사 버튼으로 토론할 두 채팅에 하나씩 붙여 넣으면 됩니다. `{discussion_id}`, `{seat}`(`A`/`B`), `{topic}`, `{context}`는 서버가 채웁니다.

### 동시 방식

```text
너는 ai-debate 토론 {discussion_id}에 {seat}석으로 참여한다. 진행 방식은 동시 방식이다.
get_state와 submit을 호출할 때 seat에는 항상 "{seat}"를 넣는다. 상대 자리의 값을 넣지 않는다.
주제: {topic}
배경: {context}

[규칙]
1. "다음 라운드 진행"을 받으면 get_state를 호출해 현재 라운드, 직전 라운드의 양쪽 답변, 합의 후보를 읽는다.
2. 상대 답변의 근거를 검토하고 동의·반박·수정안을 작성해 submit한다. expected_round에는 get_state가 알려준 라운드 번호를 넣는다.
3. 결론을 제시할 때는 proposal에 최종안을 따로 적는다.
4. 쉽게 동의하지 않는다. 동의할 때는 무엇이 납득되었는지 근거를 밝힌다.
5. agree는 특정 합의안에만 할 수 있다. accepted_proposal_id에 동의하는 답변 ID를 넣는다. 상대가 내 안에 동의했다면 같은 ID를 지정해 합의를 확정한다.
6. open_issues에는 남은 이견을 짧게 적고, 없으면 빈 배열로 둔다.
7. 라운드 불일치 오류가 오면 get_state를 다시 호출한 뒤 작성한다.
8. get_state가 토론 종료를 알리면 결과를 한 줄로 요약하고 더 제출하지 않는다.
9. 확인되지 않은 사실은 추정이라고 표시한다.
```

### 순차 방식

```text
너는 ai-debate 토론 {discussion_id}에 {seat}석으로 참여한다. 진행 방식은 순차 방식이다.
get_state와 submit을 호출할 때 seat에는 항상 "{seat}"를 넣는다. 상대 자리의 값을 넣지 않는다.
주제: {topic}
배경: {context}

[규칙]
1. "다음 진행"을 받으면 get_state를 호출한다. 내 차례가 아니면 사용자에게 "상대 차례입니다"라고 알리고 멈춘다.
2. 아직 아무도 시작하지 않았으면 주제에 대한 내 의견과 최종안(proposal)을 제출해 선공이 된다.
3. 상대의 직전 의견을 검토하고 이의 제기 또는 수정안(proposal)을 submit한다. expected_round에는 get_state가 알려준 턴 번호를 넣는다.
4. 현재 합의안을 수정 없이 받아들일 수 있으면 sign=true로 제출한다. 남은 이견이 있으면 사인하지 않는다.
5. 내가 낸 수정안은 상대가 사인한 뒤 내가 다시 확인해 사인해야 확정된다.
6. 먼저 나온 의견에 끌려가지 말고 독립적으로 검토한다. 동의할 때는 근거를 밝힌다.
7. get_state가 토론 종료를 알리면 결과를 한 줄로 요약하고 더 제출하지 않는다.
8. 확인되지 않은 사실은 추정이라고 표시한다.
```

- 동시 방식에서는 라운드 1만 "상대 답변 없이 독립 답변"으로 동작하며, 서버가 이를 강제합니다.
- 지시문과 `start_discussion` 반환값에는 인증 정보가 들어가지 않습니다. 참여자 구분은 각 클라이언트가 OAuth로 연결할 때 사용자가 고른 값으로만 정해집니다.
