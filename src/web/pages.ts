import express, { type Request, type Response, type NextFunction } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { listConnections, revokeConnection } from '../oauth/connections.js';
import { loginUrl } from './auth-routes.js';
import { discussionPagesRouter } from './discussion-pages.js';
import { appNav, esc, logoutForm, page, suspendedPage } from './html.js';
import { checkCsrf, loadSession, type WebSession } from './session.js';

const PARTICIPANT_LABEL = { claude: 'Claude용', codex: 'Codex용' } as const;

const formatTime = (d: Date | null) =>
  d ? new Date(d).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }) : '없음';

declare module 'express-serve-static-core' {
  interface Locals {
    web?: WebSession;
  }
}

export function pagesRouter(config: Config, db: Db) {
  const router = express.Router();
  const contact = config.contactEmail ? esc(config.contactEmail) : '(운영자 연락처 미기재)';

  router.get('/', async (req, res, next) => {
    try {
      const web = await loadSession(config, db, req);
      res.send(
        page(
          'AI Debate Hub',
          `<p>내 Claude와 Codex를 같은 서버에 연결해, 하나의 아이디어를 두 AI가 토론·상호 검토하게 하는 무료 서비스입니다.
          두 AI 사이에서 답변을 복사해 옮길 필요 없이, 서버가 기록·차례·합의 판정을 맡습니다.</p>
          <h2>사용 방법</h2>
          <ol>
            <li>GitHub 또는 Google로 로그인합니다.</li>
            <li>Claude와 Codex에 MCP 주소 <code>${esc(config.resource)}</code>를 등록하고, 동의 화면에서 각각 "Claude용"·"Codex용"을 고릅니다.</li>
            <li>웹에서 토론방을 만들고, 발급된 지시문을 양쪽 채팅에 붙여 넣습니다.</li>
            <li>각 채팅에 "다음 라운드 진행"을 입력하며 토론을 이어 갑니다.</li>
            <li>합의되거나 최대 라운드에 도달하면 끝나고, 결과는 웹에서 확인·내보내기합니다.</li>
          </ol>
          <h2>진행 방식</h2>
          <ul>
            <li><b>동시</b>: 매 라운드 양쪽이 서로의 답을 보지 않고 한 번씩 답변합니다. 같은 합의안에 양쪽이 동의하면 합의입니다.</li>
            <li><b>순차</b>: 한 턴씩 번갈아 답변합니다. 상대 사인 뒤 제안자가 다시 사인하면 합의입니다.</li>
          </ul>
          <p>AI 사용료는 각자의 Claude·Codex 구독에서 나갑니다. 기밀이나 개인정보는 넣지 마세요.</p>
          <p>${web ? '<a class="btn" href="/app">내 토론으로</a>' : '<a class="btn" href="/login">로그인</a>'}</p>`,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.get('/terms', (_req, res) => {
    res.send(
      page(
        '이용약관',
        `<p>AI Debate Hub(이하 "서비스")는 개인이 비상업적으로 운영하는 무료 서비스입니다.</p>
        <ol>
          <li><b>가입</b>: GitHub 또는 Google 계정으로 처음 로그인하면 가입되며, 이때 이 약관과 개인정보 처리방침에 동의한 것으로 봅니다.</li>
          <li><b>서비스 내용</b>: 사용자가 연결한 AI(Claude·Codex)가 토론 기록을 저장·조회하도록 돕습니다. AI 사용료는 각 사용자의 AI 구독에서 부담합니다.</li>
          <li><b>이용자의 의무</b>: 기밀이나 타인의 개인정보를 토론에 넣지 않습니다. 서비스를 공격하거나 다른 사용자의 이용을 방해하지 않습니다.</li>
          <li><b>이용 제한</b>: 운영자는 남용이나 약관 위반이 확인되면 계정을 정지할 수 있습니다. 정지 중에는 웹·MCP 접근이 차단됩니다.</li>
          <li><b>사용량 한도</b>: 무료 운영을 위해 토론 개수·용량·횟수에 한도를 둡니다.</li>
          <li><b>책임의 한계</b>: 서비스는 있는 그대로 제공되며, 운영자는 서비스 중단이나 AI가 만든 내용의 정확성에 대해 보증하지 않습니다.</li>
          <li><b>탈퇴</b>: 언제든 탈퇴할 수 있으며, 탈퇴하면 계정과 토론 기록을 즉시 삭제합니다.</li>
          <li><b>변경</b>: 약관을 바꾸면 이 페이지에 게시합니다.</li>
        </ol>
        <p>문의: ${contact}</p>`,
      ),
    );
  });

  router.get('/privacy', (_req, res) => {
    res.send(
      page(
        '개인정보 처리방침',
        `<h2>수집 항목과 목적</h2>
        <ul>
          <li>소셜 계정 식별자(GitHub·Google), 이메일, 표시 이름: 회원 식별과 로그인</li>
          <li>토론 기록, MCP 연결 정보(연결한 앱 이름, 역할, 연결·마지막 사용 시각): 서비스 제공</li>
          <li>IP 주소 기반 횟수 제한 기록: 남용 방지</li>
        </ul>
        <h2>보존 기간과 파기</h2>
        <ul>
          <li>회원 정보·연결 정보·토론 기록: 탈퇴 시 즉시 삭제</li>
          <li>종료된 토론: 종료 후 180일이 지나면 자동 삭제</li>
          <li>로그인 세션: 7일, 연결 토큰: 최대 30일. 만료 후 정리 작업에서 삭제</li>
          <li>횟수 제한 기록: 짧은 기간만 보관하고 정리 작업에서 삭제</li>
        </ul>
        <p>삭제한 정보는 복구할 수 없는 방법으로 DB에서 지웁니다.</p>
        <h2>제3자 제공과 국외 이전</h2>
        <p>개인정보를 제3자에게 제공하지 않습니다. 서비스는 국외 클라우드에서 운영되어 정보가 국외에 저장됩니다:
        Vercel(웹 서버, 미국 등), Neon(데이터베이스, 배포 시 선택한 지역). 서비스 이용 중 상시 전송되며, 보존 기간은 위와 같습니다.</p>
        <h2>이용자의 권리</h2>
        <p>연결 설정 화면에서 연결을 해제할 수 있고, 계정 화면에서 기록을 내려받거나 탈퇴할 수 있습니다. 그 밖의 열람·정정·삭제 요청은 아래 연락처로 보내 주세요.</p>
        <h2>개인정보 보호책임자</h2>
        <p>서비스 운영자, ${contact}</p>`,
      ),
    );
  });

  // /app 아래는 로그인 필수. 정지 계정은 정지 안내와 로그아웃만 보인다.
  router.use('/app', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const web = await loadSession(config, db, req);
      if (!web) {
        res.redirect(303, loginUrl(req.originalUrl));
        return;
      }
      if (web.user.status === 'suspended') {
        res.status(403).send(suspendedPage(web.csrf));
        return;
      }
      res.locals.web = web;
      next();
    } catch (e) {
      next(e);
    }
  });

  router.use(discussionPagesRouter(config, db));

  router.get('/app/connections', async (_req, res, next) => {
    try {
      const web = res.locals.web!;
      const connections = await listConnections(db, web.user.id);
      const rows = connections
        .map(
          (c) => `<tr>
            <td>${PARTICIPANT_LABEL[c.participant]}</td>
            <td>${esc(c.client_name)}</td>
            <td>${formatTime(c.created_at)}</td>
            <td>${formatTime(c.last_used_at)}</td>
            <td>${c.expired ? '만료됨 · 앱에서 다시 연결하세요' : formatTime(c.expires_at)}</td>
            <td><form method="post" action="/app/connections/${esc(c.id)}/revoke">
              <input type="hidden" name="csrf" value="${esc(web.csrf)}"><button type="submit">연결 해제</button></form></td>
          </tr>`,
        )
        .join('');
      res.send(
        page(
          '연결 설정',
          `${appNav(web.user.role)}
          <p><b>${esc(web.user.display_name)}</b> 계정으로 로그인했습니다.</p>
          <h2>연결된 앱</h2>
          ${
            connections.length
              ? `<table><tr><th>역할</th><th>앱</th><th>연결</th><th>마지막 사용</th><th>만료</th><th></th></tr>${rows}</table>`
              : '<p>연결된 앱이 없습니다.</p>'
          }
          <h2>연결 방법</h2>
          <p>서비스 주소: <code>${esc(config.resource)}</code></p>
          <h3>Claude</h3>
          <ol><li>claude.ai 커넥터 설정에서 "커스텀 커넥터 추가"를 고릅니다.</li>
          <li>이름(예: <code>ai-debate</code>)과 위 서비스 주소를 넣고 연결합니다. OAuth 클라이언트 ID·시크릿 칸은 비워 둡니다.</li>
          <li>열리는 화면에서 로그인한 뒤 "Claude용"을 고르고 허용합니다.</li></ol>
          <h3>Codex</h3>
          <p><code>~/.codex/config.toml</code>에 다음을 넣고 <code>codex mcp login ai-debate</code>를 실행한 뒤, 열리는 화면에서 "Codex용"을 고릅니다.</p>
          <pre>[mcp_servers.ai-debate]\nurl = "${esc(config.resource)}"</pre>
          <p>같은 역할로 다시 연결하면 기존 연결은 자동으로 해제됩니다.</p>
          ${logoutForm(web.csrf)}`,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.post('/app/connections/:id/revoke', express.urlencoded({ extended: false, limit: '10kb' }), async (req, res, next) => {
    try {
      const web = res.locals.web!;
      if (!checkCsrf(config, web, req.body?.csrf)) {
        res.status(403).send(page('요청 거부', '<p>보안 토큰이 맞지 않습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.</p>'));
        return;
      }
      if (!/^\d{1,18}$/.test(req.params.id) || !(await revokeConnection(db, web.user.id, req.params.id))) {
        res.status(404).send(page('없는 연결', '<p>연결을 찾을 수 없습니다.</p>'));
        return;
      }
      res.redirect(303, '/app/connections');
    } catch (e) {
      next(e);
    }
  });

  return router;
}
