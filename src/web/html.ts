export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// 터미널 테마. 고정폭 글꼴은 기호·라벨·번호·주소에만 쓰고 한글은 일반 글꼴로 둔다(DESIGN_MEMORY.md).
const STYLE = `:root{color-scheme:light dark;--bg:#f4f5f2;--panel:#fff;--fg:#1b1f1a;--mute:#6a7068;--line:#c9cdc4;--acc:#16794a;--hl:#e3f3e9;--b:#a3480b;--dot:#cfd3cb;
--mono:ui-monospace,"Cascadia Code",Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0c0e0c;--panel:#121512;--fg:#d6dcd3;--mute:#7f877c;--line:#2b302a;--acc:#4ade80;--hl:#13261a;--b:#fbbf24;--dot:#1f231e}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:radial-gradient(var(--dot) 1px,transparent 1.2px) 0 0/18px 18px,var(--bg);color:var(--fg);
font-family:system-ui,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;font-size:.95rem;line-height:1.7}
html{scrollbar-gutter:stable}
.wrap{max-width:68rem;margin:0 auto;padding:2.5rem 2rem}
h1{font-size:2rem;font-weight:800;line-height:1.35;letter-spacing:-.02em;margin:0 0 1rem}
h1::before{content:"> ";font-family:var(--mono);color:var(--acc)}
h2{font-size:1.15rem;font-weight:700;margin:2.2rem 0 .9rem}h2::before{content:"## ";font-family:var(--mono);color:var(--mute);font-weight:400}
h3{font-size:1rem;margin:1.6rem 0 .6rem}
a{color:var(--acc)}
nav{font-family:var(--mono);font-size:.85rem;margin-bottom:1.5rem;display:flex;flex-wrap:wrap;gap:.3rem 1rem}
nav a{color:var(--mute);text-decoration:none}nav a::before{content:"[";color:var(--line)}nav a::after{content:"]";color:var(--line)}nav a:hover{color:var(--acc)}
label{display:block;margin:.75rem 0}
input,textarea,select{font:inherit;color:var(--fg);background:var(--panel);border:1px solid var(--line);border-radius:2px;padding:.4rem .6rem;max-width:100%}
input[type=checkbox],input[type=radio]{accent-color:var(--acc)}
input[type=number]{width:8rem}
table{border-collapse:collapse;width:100%;background:var(--panel);border:1px solid var(--line)}
td,th{border-bottom:1px dashed var(--line);padding:.5rem .7rem;text-align:left;vertical-align:top}th{font-family:var(--mono);color:var(--mute);font-weight:500;font-size:.8rem}
button,.btn{display:inline-block;font-family:var(--mono);font-size:.88rem;font-weight:600;padding:.55rem 1rem;min-height:44px;color:var(--acc);border:1px solid var(--acc);border-radius:2px;background:transparent;text-decoration:none;cursor:pointer;transition:background .15s,color .15s}
.btn::after{content:" →"}
button:hover,.btn:hover,.btn.fill{background:var(--acc);color:var(--bg)}
button:focus-visible,.btn:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--acc);outline-offset:3px}
code,pre{font-family:var(--mono);font-size:.85em;background:var(--hl);padding:.05rem .35rem;overflow-wrap:anywhere}
pre{padding:.75rem;overflow-x:auto;white-space:pre-wrap;border:1px solid var(--line);background:var(--panel)}
details{margin:.6rem 0}summary{cursor:pointer;color:var(--mute)}
dialog{background:var(--panel);color:var(--fg);border:1px solid var(--line);max-width:40rem}dialog::backdrop{background:rgba(0,0,0,.45)}
.warn{background:var(--panel);border:1px solid var(--b);padding:.75rem 1rem}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.turn{background:var(--panel);border:1px solid var(--line);padding:.5rem .9rem;margin:.5rem 0;overflow-wrap:anywhere}
.turn.seat-A{border-top:3px solid var(--acc)}.turn.seat-B{border-top:3px solid var(--b)}
.badge{display:inline-block;font-family:var(--mono);font-size:.8em;color:var(--mute)}.badge::before{content:"["}.badge::after{content:"]"}
.badge.ok{color:var(--acc)}
.inline{display:inline}
.note{color:var(--mute);font-size:.88rem}.note::before{content:"# ";font-family:var(--mono)}
.topbar{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem 1rem;padding:.8rem 2rem;background:var(--panel);border-bottom:1px dashed var(--line)}
.topbar .brand{margin-right:auto;font-family:var(--mono);font-weight:700;white-space:nowrap;color:var(--fg);text-decoration:none}.topbar .brand::before{content:"~/";color:var(--acc)}
.topbar nav{margin:0;align-items:center}.topbar form{display:inline}
.topbar nav button{font:inherit;min-height:0;padding:0;border:0;color:var(--mute);background:none}.topbar nav button:hover{background:none;color:var(--acc)}
.topbar nav button::before{content:"[";color:var(--line)}.topbar nav button::after{content:"]";color:var(--line)}
body>main{flex:1 0 auto;width:100%}
footer{flex:none;height:3.2rem;line-height:3.2rem;padding:0 1rem;white-space:nowrap;overflow:hidden;font-family:var(--mono);font-size:.78rem;color:var(--mute);border-top:1px dashed var(--line);text-align:center}footer a{color:inherit}
@media (max-width:640px){.cols{grid-template-columns:1fr}h1{font-size:1.6rem}}
@media (max-width:760px){.topbar{padding:.7rem 1rem}.wrap{padding:1.5rem 1rem}}`;

interface NavSession {
  user: { role: 'user' | 'admin' };
  csrf: string;
}

// bare: 첫 화면처럼 자체 상단 메뉴와 제목을 쓰는 페이지는 기본 폭 제한과 <h1>을 생략한다
// nav: 로그인한 화면이면 세션을 넘겨 상단 메뉴에 공통 메뉴와 로그아웃을 둔다
export const page = (title: string, body: string, opts: { bare?: boolean; head?: string; nav?: NavSession } = {}) => `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · AI Debate Hub</title>
<style>${STYLE}${opts.head ?? ''}</style>
<script src="/static/app.js" defer></script>
</head><body>${opts.bare ? body : `<header class="topbar"><a class="brand" href="/">ai-debate-hub</a>${opts.nav ? appNav(opts.nav) : ''}</header>
<main class="wrap"><h1>${esc(title)}</h1>${body}</main>`}
<footer><a href="/">처음</a> · <a href="/terms">이용약관</a> · <a href="/privacy">개인정보 처리방침</a></footer></body></html>`;

export const csrfField = (csrf: string) => `<input type="hidden" name="csrf" value="${esc(csrf)}">`;

// 로그인한 화면 공통 메뉴와 로그아웃
export const appNav = (web: NavSession) =>
  `<nav><a href="/app">토론 목록</a><a href="/app/new">새 토론</a><a href="/app/connections">연결 설정</a><a href="/app/account">계정</a>${
    web.user.role === 'admin' ? '<a href="/admin">운영자</a>' : ''
  }${logoutForm(web.csrf)}</nav>`;

// 복사 버튼과 대화상자 열기 동작. CSP가 인라인 스크립트를 막으므로 별도 파일로 낸다.
export const APP_JS = `document.addEventListener('click', (e) => {
  const d = e.target.closest('[data-dialog]');
  if (d) document.getElementById(d.dataset.dialog).showModal();
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const label = (b.dataset.label ??= b.textContent);
  navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent).then(
    () => { b.textContent = '복사했습니다'; setTimeout(() => { b.textContent = label; }, 2000); },
    () => { const err = document.getElementById('copy-error'); if (err) err.hidden = false; },
  );
});
// 새 토론방: 고른 진행 방식의 설명과 기본값만 보인다
document.addEventListener('change', (e) => {
  if (e.target.name !== 'mode') return;
  const m = e.target.value;
  for (const el of document.querySelectorAll('[data-mode]')) el.hidden = el.dataset.mode !== m;
  const max = document.querySelector('input[name=max_rounds]');
  max.placeholder = max.dataset[m];
});`;

export const logoutForm = (csrf: string) =>
  `<form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit">로그아웃</button></form>`;

// 정지된 계정에는 정지 안내와 로그아웃만 제공한다
export const suspendedPage = (csrf?: string) =>
  page(
    '이용이 정지된 계정',
    `<p>이 계정은 운영자에 의해 이용이 정지되었습니다. 정지 중에는 웹 화면, MCP 연결, 새 로그인을 쓸 수 없습니다.</p>
    <p>정지가 해제되면 아직 유효한 연결과 로그인은 그대로 다시 쓸 수 있습니다.</p>
    ${csrf ? logoutForm(csrf) : ''}`,
  );
