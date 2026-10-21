import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { finalCrossing, type Discussion, type Reference, type Turn } from '../db/discussions.js';
import { getIssueLedger, type IssueChange, type IssueEvent, type IssueView } from '../db/issues.js';
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

export const ISSUE_ACTION_LABEL = { open: '개설', revise: '문구 수정', resolve: '해결', withdraw: '철회', reopen: '재개' } as const;
export const ISSUE_STATUS_LABEL = { open: '열림', resolved: '해결', withdrawn: '철회' } as const;

// 쟁점 변경 한 줄(텍스트). 웹은 이스케이프한 뒤 제안 링크·배지를 붙이고, 내보내기는 그대로 쓴다
export function issueChangeText(c: IssueChange): string {
  const ref = c.ref ?? '새 쟁점';
  if (c.action === 'open') return `${ref} ${ISSUE_ACTION_LABEL.open}: ${c.text}`;
  const why = c.note ? ` (근거: ${c.note})` : '';
  if (c.action === 'revise') return `${ref} ${ISSUE_ACTION_LABEL.revise}: ${c.before?.title} → ${c.text}${why}`;
  return `${ref} ${ISSUE_ACTION_LABEL[c.action]}${why}`;
}

// 대기: 동시 방식 진행 중 라운드의 변경. 충돌: 두 자리가 같은 쟁점을 다르게 바꿔 반영되지 않음
export const issueChangeFlags = (c: IssueChange) => [c.pending ? '변경 대기' : '', c.conflict ? '충돌·미반영' : ''].filter(Boolean);

// 종료된 토론에서 열린 채 남은 쟁점의 표시. 합의로 끝났으면 '합의 시 미종결'
export const unresolvedLabel = (d: Discussion) => (d.status === 'agreed' ? '합의 시 미종결' : '종료 시 미종결');

// 쟁점 요약 한 줄(텍스트): 상태와 개설·종결 턴
export function issueLineText(d: Discussion, i: IssueView): string {
  const unit = d.mode === 'parallel' ? '라운드' : '턴';
  const opened = `${unit} ${i.opened.turn} ${PARTICIPANT_NAME[i.opened.by]} 개설`;
  const closed = i.closed
    ? `, ${unit} ${i.closed.turn} ${PARTICIPANT_NAME[i.closed.by]} ${ISSUE_ACTION_LABEL[i.closed.action]}${i.closed.note ? ` (근거: ${i.closed.note})` : ''}`
    : '';
  return `${i.ref} ${i.title} [${ISSUE_STATUS_LABEL[i.status]}${i.unresolved_at_end ? `·${unresolvedLabel(d)}` : ''}] (${opened}${closed})`;
}

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
export function discussionMarkdown(d: Discussion, turns: Turn[], issueEvents: IssueEvent[] = [], refs: Reference[] = []): string {
  const ledger = getIssueLedger({ discussion: d, turns, issueEvents }, 'web');
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
    if (t.open_issues.length) lines.push(`- 구 형식 이견: ${t.open_issues.join(' / ')}`);
    for (const c of ledger.changesByTurn[t.id] ?? []) {
      const extra = [c.proposal_turn_id ? `반영 제안 ${c.proposal_turn_id}` : '', ...issueChangeFlags(c)].filter(Boolean);
      lines.push(`- 쟁점 ${issueChangeText(c)}${extra.length ? ` [${extra.join(', ')}]` : ''}`);
    }
    lines.push('');
  }
  if (ledger.issues.length) lines.push('## 쟁점', '', ...ledger.issues.map((i) => `- ${issueLineText(d, i)}`), '');
  const agreed = turns.find((t) => t.id === d.agreed_proposal_id);
  lines.push('## 결론', '', STATUS_LABEL[d.status], '');
  if (agreed?.proposal) lines.push(agreed.proposal, '');
  const crossing = finalCrossing(d, turns);
  if (crossing) lines.push(crossingText(crossing), '');
  return lines.join('\n');
}
