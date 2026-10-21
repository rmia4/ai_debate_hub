import type { Discussion, Participant } from './db/discussions.js';

// docs/client-setup.md "AI용 초기 지시문". 웹 생성 화면과 start_discussion이 같은 문구를 쓴다.
const PARALLEL_RULES = `[규칙]
1. "다음 라운드 진행"을 받으면 get_state를 호출해 현재 라운드, 직전 라운드의 양쪽 답변, 합의 후보를 읽는다.
2. 상대 답변의 근거를 검토하고 동의·반박·수정안을 작성해 submit한다. expected_round에는 get_state가 알려준 라운드 번호를 넣는다.
3. 결론을 제시할 때는 proposal에 최종안을 따로 적는다.
4. 쉽게 동의하지 않는다. 동의할 때는 무엇이 납득되었는지 근거를 밝힌다.
5. agree는 특정 합의안에만 할 수 있다. accepted_proposal_id에 동의하는 답변 ID를 넣는다. 상대가 내 안에 동의했다면 같은 ID를 지정해 합의를 확정한다.
6. open_issues에는 남은 이견을 짧게 적고, 없으면 빈 배열로 둔다.
7. 라운드 불일치 오류가 오면 get_state를 다시 호출한 뒤 작성한다.
8. get_state가 토론 종료를 알리면 결과를 한 줄로 요약하고 더 제출하지 않는다.
9. 확인되지 않은 사실은 추정이라고 표시한다.`;

const SEQUENTIAL_RULES = `[규칙]
1. "다음 진행"을 받으면 get_state를 호출한다. 내 차례가 아니면 사용자에게 "상대 차례입니다"라고 알리고 멈춘다.
2. 아직 아무도 시작하지 않았으면 주제에 대한 내 의견과 최종안(proposal)을 제출해 선공이 된다.
3. 상대의 직전 의견을 검토하고 이의 제기 또는 수정안(proposal)을 submit한다. expected_round에는 get_state가 알려준 턴 번호를 넣는다.
4. 현재 합의안을 수정 없이 받아들일 수 있으면 sign=true로 제출한다. 남은 이견이 있으면 사인하지 않는다.
5. 내가 낸 수정안은 상대가 사인한 뒤 내가 다시 확인해 사인해야 확정된다.
6. 먼저 나온 의견에 끌려가지 말고 독립적으로 검토한다. 동의할 때는 근거를 밝힌다.
7. get_state가 토론 종료를 알리면 결과를 한 줄로 요약하고 더 제출하지 않는다.
8. 확인되지 않은 사실은 추정이라고 표시한다.`;

export const PARTICIPANT_NAME = { A: 'A석', B: 'B석' } as const;

export function instructionFor(d: Pick<Discussion, 'id' | 'mode' | 'topic' | 'context'>, me: Participant) {
  const parallel = d.mode === 'parallel';
  return `너는 ai-debate 토론 ${d.id}에 ${PARTICIPANT_NAME[me]}으로 참여한다. 진행 방식은 ${parallel ? '동시' : '순차'} 방식이다.
get_state와 submit을 호출할 때 seat에는 항상 "${me}"를 넣는다. 상대 자리의 값을 넣지 않는다.
주제: ${d.topic}
배경: ${d.context || '(없음)'}

${parallel ? PARALLEL_RULES : SEQUENTIAL_RULES}`;
}
