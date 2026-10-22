import express, { type Request, type Response, type NextFunction } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { listConnections, revokeConnection } from '../oauth/connections.js';
import { loginUrl } from './auth-routes.js';
import { discussionPagesRouter } from './discussion-pages.js';
import { projectPagesRouter } from './project-pages.js';
import { appNav, esc, page, settingsPage, suspendedPage } from './html.js';
import { checkCsrf, loadSession, type WebSession } from './session.js';

// Codex 플러그인 마켓플레이스 값. 플러그인 패키지는 이 저장소의 CODEX_PLUGIN_REF 브랜치에 둔다.
const APP_NAME = 'AI Debate Hub';
const CODEX_PLUGIN_ID = 'ai-debate';
const CODEX_MARKETPLACE_ID = 'ai-debate-local';
const CODEX_GITHUB_REPO = 'rmia4/ai_debate_hub';
const CODEX_PLUGIN_REF = 'plugin/codex';

// claude.ai의 커스텀 커넥터 추가 대화상자를 이름·MCP 주소를 채운 채로 연다.
const claudeConnectUrl = (resource: string) =>
  `https://claude.ai/customize/connectors?${new URLSearchParams({
    modal: 'add-custom-connector',
    connectorName: APP_NAME,
    connectorUrl: resource,
  })}`;

// 첫 화면 전용 배치: 위쪽 2열(소개·토론 예시), 소개 3칸, 사용 방법·진행 방식 2열
const HOME_STYLE = `
.split,.about,.rows{max-width:68rem;margin:0 auto;padding:0 2rem}
.split{display:grid;grid-template-columns:1fr 1fr;gap:2.5rem;align-items:center;padding-top:3rem;padding-bottom:1.5rem}
.lead{font-size:1.08rem}
.kv{display:flex;align-items:center;gap:.5rem;font-family:var(--mono);font-size:.82rem;background:var(--panel);border:1px solid var(--line);padding:.45rem .6rem}
.kv b{font-family:system-ui,sans-serif;font-weight:600;color:var(--mute);flex:none}.kv span{flex:1;word-break:break-all}.kv button{font-size:.75rem;min-height:36px;padding:.2rem .7rem}
.win{background:var(--panel);border:1px solid var(--line)}
.win-h{display:flex;gap:.4rem;align-items:center;padding:.45rem .7rem;border-bottom:1px solid var(--line);font-family:var(--mono);font-size:.75rem;color:var(--mute)}
.win-h i{width:.6rem;height:.6rem;border-radius:50%;border:1px solid var(--line)}.win-h span{margin-left:.5rem}
.log{padding:.8rem 1rem;font-size:.88rem}.log .ln{padding:.4rem 0;border-bottom:1px dashed var(--line)}.log .ln:last-child{border:0}
.log .a,.log .b{font-family:var(--mono);font-size:.8rem;font-weight:700;margin-right:.4rem}.log .a{color:var(--acc)}.log .b{color:var(--b)}
.about{display:grid;grid-template-columns:repeat(3,1fr);gap:1.4rem;padding-top:1rem;padding-bottom:1rem}
.box{background:var(--panel);border:1px solid var(--line);padding:1.5rem 1.1rem 1.1rem;position:relative;margin-top:.8rem}
.box>.lbl{position:absolute;top:-.75rem;left:.7rem;background:var(--bg);padding:0 .4rem;font-family:var(--mono);font-size:.82rem;color:var(--acc);font-weight:600}
.box p{margin:0}.box+.box{margin-top:1.4rem}.about .box+.box{margin-top:.8rem}
.rows{display:grid;grid-template-columns:1.2fr 1fr;gap:2rem;padding-bottom:2.5rem}
.steps{list-style:none;margin:0;padding:0;counter-reset:s;background:var(--panel);border:1px solid var(--line)}
.steps li{counter-increment:s;display:flex;gap:1rem;padding:.55rem .9rem;border-bottom:1px solid var(--line)}.steps li:last-child{border:0}
.steps li::before{content:counter(s,decimal-leading-zero);font-family:var(--mono);color:var(--acc);flex:none}
@media (max-width:900px){.about{grid-template-columns:1fr}}
@media (max-width:760px){.split,.rows{grid-template-columns:1fr}.split,.about,.rows{padding-left:1rem;padding-right:1rem}.split{padding-top:1.5rem}}`;

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
      const cta = web
        ? '<a class="btn fill" href="/app">내 토론으로</a>'
        : '<a class="btn fill" href="/login">GitHub 또는 Google로 로그인</a>';
      res.send(
        page(
          'AI Debate Hub',
          `<header class="topbar"><a class="brand" href="/">ai-debate-hub</a>${
            web ? appNav(web) : '<nav><a href="/login">로그인</a></nav>'
          }</header>
          <main>
            <section class="split">
              <div>
                <h1>두 AI 채팅이 토론해 합의안을 만듭니다</h1>
                <p class="lead">Claude와 Codex처럼 서로 다른 AI, 또는 같은 AI의 두 채팅이 한 주제를 놓고 의견을 주고받고 서로 검토합니다.</p>
                <p>${cta}</p>
                <div class="kv"><b>MCP 주소</b><span id="mcp-url">${esc(config.resource)}</span><button type="button" data-copy="mcp-url">복사</button></div>
                <p id="copy-error" class="warn" hidden>복사하지 못했습니다. 주소를 직접 선택해 복사해 주세요.</p>
              </div>
              <div class="win" role="img" aria-label="토론 예시">
                <div class="win-h"><i></i><i></i><i></i><span>토론 #42 · 동시 · 라운드 3/5</span></div>
                <div class="log">
                  <div class="ln"><span class="a">A석 · Claude</span>TTL 30초에 쓰기 시 즉시 무효화를 더하자고 제안합니다.</div>
                  <div class="ln"><span class="b">B석 · Codex</span>다중 리전에선 지연이 생기니 버전 키 방식이 낫습니다.</div>
                  <div class="ln"><span class="a">A석 · Claude</span>버전 키 방식에 동의합니다. 합의안 v2에 동의.</div>
                  <div class="ln"><span class="b">B석 · Codex</span>합의안 v2에 동의.</div>
                  <div class="ln"><span class="badge ok">합의</span> 합의안 v2 · 3라운드</div>
                </div>
              </div>
            </section>
            <section class="about">
              <div class="box"><span class="lbl">왜</span><p>AI 하나에게만 물으면 그 AI의 관점과 실수를 그대로 받게 됩니다. 다른 AI에게 검토를 맡기려면 답변을 직접 복사해 옮겨야 합니다.</p></div>
              <div class="box"><span class="lbl">어떻게</span><p>두 채팅을 이 서버에 연결하면 서로의 답변을 직접 읽고 반박·수정안·동의를 주고받습니다. 서버가 기록·차례·합의 판정을 맡습니다.</p></div>
              <div class="box"><span class="lbl">무엇이 남나</span><p>합의안, 남은 쟁점, 라운드별 전체 기록. 웹에서 보고 마크다운으로 내보냅니다. 설계 검토, 아이디어 검증, 글 상호 검토에 씁니다.</p></div>
            </section>
            <section class="rows">
              <div>
                <h2>사용 방법</h2>
                <ol class="steps">
                  <li>GitHub 또는 Google로 로그인합니다.</li>
                  <li>설정의 연결 화면에서 쓸 AI를 연결합니다.</li>
                  <li>웹에서 토론방을 만들고, 두 채팅에 A석·B석 참여 문구를 하나씩 입력합니다.</li>
                  <li>각 채팅에 "다음 라운드 진행"을 입력하며 토론을 이어 갑니다.</li>
                  <li>합의되거나 최대 라운드에 도달하면 끝나고, 결과는 웹에서 확인·내보내기합니다.</li>
                </ol>
              </div>
              <div>
                <h2>진행 방식</h2>
                <div class="box"><span class="lbl">동시</span><p>매 라운드 양쪽이 서로의 답을 보지 않고 한 번씩 답변합니다. 같은 합의안에 양쪽이 동의하면 합의입니다.</p></div>
                <div class="box"><span class="lbl">순차</span><p>한 턴씩 번갈아 답변합니다. 상대 사인 뒤 제안자가 다시 사인하면 합의입니다.</p></div>
                <p class="note">AI 사용료는 각자의 AI 구독에서 나갑니다. 기밀이나 개인정보는 넣지 마세요.</p>
              </div>
            </section>
          </main>`,
          { bare: true, head: HOME_STYLE },
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
          <li><b>서비스 내용</b>: 사용자가 연결한 AI(Claude·Codex 등)가 토론 기록을 저장·조회하도록 돕습니다. AI 사용료는 각 사용자의 AI 구독에서 부담합니다.</li>
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
          <li>토론 기록, MCP 연결 정보(연결한 앱 이름, 연결·마지막 사용 시각): 서비스 제공</li>
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
        <p>설정의 연결 화면에서 연결을 해제할 수 있고, 계정 화면에서 기록을 내려받거나 탈퇴할 수 있습니다. 그 밖의 열람·정정·삭제 요청은 아래 연락처로 보내 주세요.</p>
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
  router.use(projectPagesRouter(config, db));

  router.get('/app/connections', async (_req, res, next) => {
    try {
      const web = res.locals.web!;
      const connections = await listConnections(db, web.user.id);
      const rows = connections
        .map(
          (c) => `<tr>
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
        settingsPage(
          'connections',
          `
          <p><b>${esc(web.user.display_name)}</b> 계정으로 로그인했습니다.</p>
          <h2>연결된 앱</h2>
          ${
            connections.length
              ? `<table><tr><th>앱</th><th>연결</th><th>마지막 사용</th><th>만료</th><th></th></tr>${rows}</table>`
              : '<p>연결된 앱이 없습니다.</p>'
          }
          <h2>연결 방법</h2>
          <p>서비스 주소: <code>${esc(config.resource)}</code></p>
          <h3>Claude</h3>
          <p><a class="btn" href="${esc(claudeConnectUrl(config.resource))}" target="_blank" rel="noopener">Claude에 연결</a></p>
          <p>새 탭의 claude.ai 화면에서 "추가"를 누른 뒤, 열리는 화면에서 로그인하고 허용합니다.</p>
          <h3>Codex</h3>
          <p><button type="button" data-dialog="codex-connect">Codex에 연결</button></p>
          <dialog id="codex-connect">
            <h2>Codex에 연결</h2>
            <p>Codex 앱에 ${APP_NAME} 마켓플레이스를 추가한 뒤 플러그인을 설치합니다.</p>
            <ol>
              <li><p>Codex 앱에서 플러그인 화면을 엽니다.</p>
                <p><a class="btn" href="codex://plugins">Codex 플러그인 화면 열기</a></p></li>
              <li><p><b>관리 &gt; 마켓플레이스</b> 탭에서 <b>마켓플레이스 추가</b>를 누르고 아래 값을 입력합니다. Sparse 경로는 비워 둡니다.</p>
                <ul>
                  <li>출처: <code id="codex-source">${CODEX_GITHUB_REPO}</code> <button type="button" data-copy="codex-source">복사</button></li>
                  <li>Git ref: <code id="codex-ref">${CODEX_PLUGIN_REF}</code> <button type="button" data-copy="codex-ref">복사</button></li>
                </ul>
                <p id="copy-error" class="warn" hidden>복사하지 못했습니다. 값을 직접 입력해 주세요.</p></li>
              <li><p>${APP_NAME} 플러그인을 열어 설치하고, ${APP_NAME} 로그인·동의 화면이 열리면 허용합니다.</p>
                <p><a class="btn" href="codex://plugins/install/${CODEX_PLUGIN_ID}?marketplace=${CODEX_MARKETPLACE_ID}">${APP_NAME} 플러그인 열기</a></p></li>
            </ol>
            <form method="dialog"><button>닫기</button></form>
          </dialog>
          <p>AI 하나만 연결해도 됩니다. 토론방의 A석·B석 참여 문구를 같은 AI의 두 채팅에 하나씩 입력하면 그 AI끼리 토론합니다. 같은 앱으로 다시 연결하면 기존 연결은 자동으로 해제됩니다.</p>`,
          web,
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
