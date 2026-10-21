import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import type { Discussion, Turn } from '../db/discussions.js';
import { PARTICIPANT_NAME } from '../instructions.js';

// AI 본문은 외부 입력이다. marked로 변환한 뒤 sanitize-html로 허용 태그·링크 프로토콜(http·https·mailto)만 남긴다.
export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false, gfm: true });
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.filter((t) => t !== 'img'),
    allowedAttributes: { a: ['href', 'title'], code: ['class'], th: ['align'], td: ['align'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow' }) },
  });
}

export const STATUS_LABEL = {
  active: '진행 중',
  agreed: '합의 완료',
  max_reached: '최대 도달·합의 미확정',
  closed: '수동 종료',
} as const;

export const MODE_LABEL = { parallel: '동시', sequential: '순차' } as const;

// 마크다운 내보내기. 웹은 진행 중 라운드의 제출까지 모두 담는다.
export function discussionMarkdown(d: Discussion, turns: Turn[]): string {
  const unit = d.mode === 'parallel' ? '라운드' : '턴';
  const lines = [
    `# ${d.topic}`,
    '',
    `- 토론 ID: ${d.id}`,
    `- 진행 방식: ${MODE_LABEL[d.mode]}`,
    `- 상태: ${STATUS_LABEL[d.status]}`,
    `- 현재/최대 ${unit}: ${d.current_round}/${d.max_rounds}`,
    `- 생성: ${new Date(d.created_at).toISOString()}`,
    '',
  ];
  if (d.context) lines.push('## 배경', '', d.context, '');
  lines.push('## 기록', '');
  for (const t of turns) {
    lines.push(`### ${unit} ${t.round} · ${PARTICIPANT_NAME[t.participant]}${t.client_name ? ` (${t.client_name})` : ''} · 답변 ID ${t.id}`, '', t.content, '');
    if (t.proposal) lines.push('**제안**', '', t.proposal, '');
    if (t.agreement) lines.push(`- 동의 상태: ${t.agreement}${t.accepted_proposal_id ? ` (합의안 ${t.accepted_proposal_id})` : ''}`);
    if (t.sign) lines.push('- 사인함');
    if (t.open_issues.length) lines.push(`- 남은 이견: ${t.open_issues.join(' / ')}`);
    lines.push('');
  }
  const agreed = turns.find((t) => t.id === d.agreed_proposal_id);
  lines.push('## 결론', '', STATUS_LABEL[d.status], '');
  if (agreed?.proposal) lines.push(agreed.proposal, '');
  return lines.join('\n');
}
