export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const page = (title: string, body: string) => `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · AI Debate Hub</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.6}
label{display:block;margin:.75rem 0}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.4rem;text-align:left}
.warn{background:#fff4e5;border:1px solid #f0b000;padding:.75rem}button,.btn{padding:.5rem 1rem;display:inline-block}
code,pre{background:#f4f4f4;padding:.1rem .3rem}pre{padding:.75rem;overflow-x:auto}footer{margin-top:3rem;font-size:.9em;color:#666}</style>
</head><body><h1>${esc(title)}</h1>${body}
<footer><a href="/">처음</a> · <a href="/terms">이용약관</a> · <a href="/privacy">개인정보 처리방침</a></footer></body></html>`;

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
