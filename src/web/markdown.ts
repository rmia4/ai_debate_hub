import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { finalCrossing, type Discussion, type Reference, type Turn } from '../db/discussions.js';
import type { Background, Project } from '../db/projects.js';
import { crossingText, PARTICIPANT_NAME } from '../instructions.js';

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

export const KIND_LABEL = { text: '메모', link: '링크', file: '파일' } as const;

// 참조 배경 한 줄. 삭제된 text 항목은 본문을 이어 붙여 기록에 남긴다
function referenceMarkdown(r: Reference): string[] {
  const flags = [r.deleted ? '삭제됨' : '', r.revision !== r.revision_at_start ? `토론 중 수정됨(r${r.revision_at_start}→r${r.revision})` : '']
    .filter(Boolean)
    .join(', ');
  const head = `- ${r.title} (${KIND_LABEL[r.kind]}, ${r.id}, r${r.revision})${r.location ? `: ${r.location}` : ''}${flags ? ` [${flags}]` : ''}`;
  return r.body ? [head, '', r.body, ''] : [head];
}

// 계정 내보내기용: 프로젝트와 배경 항목(본문·위치)
export function projectMarkdown(p: Project, backgrounds: (Background & { body: string })[]): string {
  const lines = [`# 프로젝트: ${p.name}`, '', `- 프로젝트 ID: ${p.id}`, `- 생성: ${new Date(p.created_at).toISOString()}`, ''];
  if (p.description) lines.push(p.description, '');
  for (const b of backgrounds) {
    lines.push(`## ${b.title} (${KIND_LABEL[b.kind]}, ${b.id}, r${b.revision})`, '');
    if (b.summary) lines.push(`- 요약: ${b.summary}`);
    if (b.location) lines.push(`- 위치: ${b.location}`);
    lines.push(`- 최근 수정: ${new Date(b.updated_at).toISOString()} (${b.updated_by})`, '');
    if (b.kind === 'text') lines.push(b.body, '');
  }
  return lines.join('\n');
}

// 마크다운 내보내기. 웹은 진행 중 라운드의 제출까지 모두 담는다.
export function discussionMarkdown(d: Discussion, turns: Turn[], refs: Reference[] = []): string {
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
  if (d.project_id) lines.splice(2, 0, `- 프로젝트 ID: ${d.project_id}`);
  if (d.context) lines.push('## 배경', '', d.context, '');
  if (refs.length) lines.push('## 참조 배경', '', ...refs.flatMap(referenceMarkdown), '');
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
  const crossing = finalCrossing(d, turns);
  if (crossing) lines.push(crossingText(crossing), '');
  return lines.join('\n');
}
