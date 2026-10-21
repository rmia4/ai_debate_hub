export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const page = (title: string, body: string) => `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · AI Debate Hub</title>
<style>body{font-family:system-ui,sans-serif;max-width:56rem;margin:3rem auto;padding:0 1rem;line-height:1.6}
label{display:block;margin:.75rem 0}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.4rem;text-align:left}
.warn{background:#fff4e5;border:1px solid #f0b000;padding:.75rem}button,.btn{padding:.5rem 1rem;display:inline-block}
code,pre{background:#f4f4f4;padding:.1rem .3rem}pre{padding:.75rem;overflow-x:auto;white-space:pre-wrap}footer{margin-top:3rem;font-size:.9em;color:#666}
nav{margin-bottom:1rem}nav a{margin-right:.75rem}.cols{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.turn{border:1px solid #ddd;padding:.5rem .75rem;margin:.5rem 0;overflow-wrap:anywhere}.badge{display:inline-block;padding:0 .4rem;border-radius:.3rem;background:#eef;font-size:.85em}
.ok{background:#e6f6e6}.inline{display:inline}@media (max-width:640px){.cols{grid-template-columns:1fr}}</style>
<script src="/static/app.js" defer></script>
</head><body><h1>${esc(title)}</h1>${body}
<footer><a href="/">처음</a> · <a href="/terms">이용약관</a> · <a href="/privacy">개인정보 처리방침</a></footer></body></html>`;

export const csrfField = (csrf: string) => `<input type="hidden" name="csrf" value="${esc(csrf)}">`;

// 로그인한 화면 공통 메뉴
export const appNav = (role: 'user' | 'admin') =>
  `<nav><a href="/app">토론 목록</a><a href="/app/new">새 토론</a><a href="/app/connections">연결 설정</a><a href="/app/account">계정</a>${
    role === 'admin' ? '<a href="/admin">운영자</a>' : ''
  }</nav>`;

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
