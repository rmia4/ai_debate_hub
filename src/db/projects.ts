import { randomBytes } from 'node:crypto';
import type { Db, Queryable } from './db.js';
import { CREATE_LIMITS, DiscussionError, usageOf, type Status } from './discussions.js';
import { hitRateLimit } from './rate-limit.js';

export type BackgroundKind = 'text' | 'link' | 'file';
export const BACKGROUND_KINDS: readonly BackgroundKind[] = ['text', 'link', 'file'];

export const PROJECT_LIMITS = { projects: 10, backgrounds: 30, writesPerDay: 100 };
export const PROJECT_INPUT_LIMITS = { name: 100, description: 2000, title: 100, summary: 300, body: 50_000, location: 2000 };

export interface Project {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  created_at: Date;
  updated_at: Date;
}

// 항목 메타데이터. 본문은 getBackground로만 꺼낸다
export interface Background {
  id: string;
  project_id: string;
  kind: BackgroundKind;
  title: string;
  summary: string;
  location: string | null;
  body_length: number;
  revision: number;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface BackgroundInput {
  kind: BackgroundKind;
  title: string;
  summary?: string;
  body?: string;
  location?: string;
}

// kind는 바꿀 수 없다. 넣으면 현재 종류와 같아야 한다
export interface BackgroundPatch {
  kind?: BackgroundKind;
  title?: string;
  summary?: string;
  body?: string;
  location?: string;
}

const writeKey = (userId: string) => `background-write:${userId}`;
const DAY_SECONDS = 24 * 60 * 60;

const PROJECT_COLS = `p.id, p.owner_id, p.name, p.description, p.created_at, p.updated_at`;
const BACKGROUND_COLS = `b.id, b.project_id, b.kind, b.title, b.summary, b.location, length(b.body) AS body_length, b.revision,
  b.updated_by, b.created_at, b.updated_at`;

const invalid = (message: string) => new DiscussionError('invalid_settings', message);
const notFound = () => new DiscussionError('not_found', '존재하지 않는 배경 항목입니다');
const bytesOf = (b: { title: string; summary: string; body: string; location: string | null }) =>
  Buffer.byteLength(b.title) + Buffer.byteLength(b.summary) + Buffer.byteLength(b.body) + Buffer.byteLength(b.location ?? '');

function checkText(value: string, max: number, label: string, required = false) {
  if (required && !value.trim()) throw invalid(`${label}을(를) 입력하세요`);
  if (value.length > max) throw invalid(`${label}은(는) ${max}자까지입니다`);
}

function checkProject(input: { name: string; description?: string }) {
  checkText(input.name, PROJECT_INPUT_LIMITS.name, '프로젝트 이름', true);
  checkText(input.description ?? '', PROJECT_INPUT_LIMITS.description, '프로젝트 설명');
}

// link는 http·https만, file은 절대경로 형식만(Windows C:\…, C:/…, \\server\…, POSIX /…). 파일이 실제로 있는지는 확인할 수 없다
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/]|\/)/;
function checkLocation(kind: BackgroundKind, location: string) {
  checkText(location, PROJECT_INPUT_LIMITS.location, kind === 'link' ? 'URL' : '파일 경로', true);
  if (kind === 'link') {
    let url: URL | null = null;
    try {
      url = new URL(location);
    } catch {
      // 아래에서 거부한다
    }
    if (!url || !['http:', 'https:'].includes(url.protocol)) throw invalid('link는 http 또는 https 주소만 받습니다');
  } else if (!ABSOLUTE_PATH.test(location)) {
    throw invalid('file은 절대경로만 받습니다(예: C:\\proj\\README.md, /home/u/a.md). 상대경로와 ~는 쓸 수 없습니다');
  }
}

// 저장할 모양. text는 location이 NULL, link·file은 body가 ''(schema.sql의 CHECK와 같은 규칙)
function backgroundValues(kind: BackgroundKind, v: { title: string; summary: string; body: string; location: string | null }) {
  checkText(v.title, PROJECT_INPUT_LIMITS.title, '제목', true);
  checkText(v.summary, PROJECT_INPUT_LIMITS.summary, '요약');
  if (kind === 'text') checkText(v.body, PROJECT_INPUT_LIMITS.body, '본문');
  else checkLocation(kind, v.location ?? '');
  return v;
}

function rejectWrongFields(kind: BackgroundKind, input: { body?: string; location?: string }) {
  if (kind === 'text' && input.location !== undefined) throw invalid('text 항목은 location을 받지 않습니다');
  if (kind !== 'text' && input.body !== undefined) throw invalid('link·file 항목은 body를 받지 않습니다');
}

// 프로젝트·배경 데이터 접근은 이 함수가 돌려주는 메서드로만 한다. 모든 쿼리에 owner_id 조건이 붙고,
// 남의 프로젝트·항목은 없는 것과 똑같이 not_found다. 쓰기는 모두 사용자 행을 먼저 잠근다(discussions.create와 같은 잠금).
export function projectsFor(db: Db, userId: string) {
  const lockUser = async (q: Queryable) => {
    const user = await q.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    if (!user.rows[0]) throw new DiscussionError('not_found', '사용자가 없습니다');
  };
  const ownedProject = async (q: Queryable, id: string) => {
    const { rows } = await q.query<Project>(`SELECT ${PROJECT_COLS} FROM projects p WHERE p.id = $1 AND p.owner_id = $2`, [id, userId]);
    if (!rows[0]) throw new DiscussionError('not_found', '존재하지 않는 프로젝트입니다');
    return rows[0];
  };
  // 삭제되지 않은 항목만. lock이면 행을 잠근다
  const ownedBackground = async (q: Queryable, id: string, lock = false) => {
    const { rows } = await q.query<Background & { body: string }>(
      `SELECT ${BACKGROUND_COLS}, b.body FROM project_backgrounds b JOIN projects p ON p.id = b.project_id
       WHERE b.id = $1 AND p.owner_id = $2 AND b.deleted_at IS NULL${lock ? ' FOR UPDATE OF b' : ''}`,
      [id, userId],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  };
  const checkBytes = async (q: Queryable, added: number) => {
    if (added <= 0) return;
    const usage = await usageOf(q, userId);
    if (usage.bytes + added > CREATE_LIMITS.bytes) {
      throw new DiscussionError('limit_exceeded', '텍스트 용량 한도(5MB)를 넘습니다. 토론이나 배경 항목을 삭제하세요');
    }
  };
  const countWrite = async (q: Queryable) => {
    if (!(await hitRateLimit(q, writeKey(userId), DAY_SECONDS, PROJECT_LIMITS.writesPerDay))) {
      throw new DiscussionError('limit_exceeded', `배경 항목 추가·수정은 하루 ${PROJECT_LIMITS.writesPerDay}회까지입니다`);
    }
  };

  return {
    // 이름 순. backgrounds는 삭제되지 않은 항목 수
    async list(): Promise<(Project & { backgrounds: number })[]> {
      const { rows } = await db.query<Project & { backgrounds: number }>(
        `SELECT ${PROJECT_COLS},
           (SELECT count(*) FROM project_backgrounds b WHERE b.project_id = p.id AND b.deleted_at IS NULL)::int AS backgrounds
         FROM projects p WHERE p.owner_id = $1 ORDER BY p.name, p.id`,
        [userId],
      );
      return rows;
    },

    // 프로젝트, 항목 메타데이터(삭제된 항목 제외), 프로젝트 안 토론
    async get(id: string) {
      const project = await ownedProject(db, id);
      const backgrounds = (
        await db.query<Background>(
          `SELECT ${BACKGROUND_COLS} FROM project_backgrounds b WHERE b.project_id = $1 AND b.deleted_at IS NULL ORDER BY b.created_at, b.id`,
          [id],
        )
      ).rows;
      const discussions = (
        await db.query<{ id: string; topic: string; status: Status; updated_at: Date }>(
          `SELECT id, topic, status, updated_at FROM discussions WHERE project_id = $1 AND owner_id = $2 ORDER BY updated_at DESC, id`,
          [id, userId],
        )
      ).rows;
      return { project, backgrounds, discussions };
    },

    // 계정 내보내기용: 모든 프로젝트와 삭제되지 않은 항목의 본문·위치
    async all() {
      const projects = await this.list();
      return Promise.all(
        projects.map(async (project) => ({
          project,
          backgrounds: (
            await db.query<Background & { body: string }>(
              `SELECT ${BACKGROUND_COLS}, b.body FROM project_backgrounds b WHERE b.project_id = $1 AND b.deleted_at IS NULL
               ORDER BY b.created_at, b.id`,
              [project.id],
            )
          ).rows,
        })),
      );
    },

    async create(input: { name: string; description?: string }): Promise<Project> {
      checkProject(input);
      return db.tx(async (q) => {
        await lockUser(q);
        const { rows: n } = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM projects WHERE owner_id = $1`, [userId]);
        if (n[0].n >= PROJECT_LIMITS.projects) throw new DiscussionError('limit_exceeded', `프로젝트는 ${PROJECT_LIMITS.projects}개까지입니다`);
        const { rows } = await q.query<Project>(
          `INSERT INTO projects (id, owner_id, name, description) VALUES ($1, $2, $3, $4)
           RETURNING id, owner_id, name, description, created_at, updated_at`,
          [randomBytes(12).toString('base64url'), userId, input.name, input.description ?? ''],
        );
        return rows[0];
      });
    },

    async update(id: string, input: { name: string; description?: string }): Promise<void> {
      checkProject(input);
      await db.tx(async (q) => {
        await lockUser(q);
        await ownedProject(q, id);
        await q.query(`UPDATE projects SET name = $3, description = $4, updated_at = now() WHERE id = $1 AND owner_id = $2`, [
          id,
          userId,
          input.name,
          input.description ?? '',
        ]);
      });
    },

    // 진행 중인 토론이 있으면 거부한다. 종료된 토론과 배경 항목은 ON DELETE CASCADE로 함께 지워진다
    async remove(id: string): Promise<void> {
      await db.tx(async (q) => {
        await lockUser(q);
        await ownedProject(q, id);
        const { rows } = await q.query(`SELECT 1 FROM discussions WHERE project_id = $1 AND status = 'active' LIMIT 1`, [id]);
        if (rows[0]) throw new DiscussionError('in_use', '진행 중인 토론이 있는 프로젝트는 삭제할 수 없습니다. 먼저 토론을 종료하세요');
        await q.query(`DELETE FROM projects WHERE id = $1 AND owner_id = $2`, [id, userId]);
      });
    },

    // 본문까지 포함한 항목. 삭제된 항목은 not_found
    getBackground: (id: string) => ownedBackground(db, id),

    async addBackground(projectId: string, input: BackgroundInput, updatedBy: string): Promise<Background> {
      if (!BACKGROUND_KINDS.includes(input.kind)) throw invalid('kind는 text·link·file 중 하나입니다');
      rejectWrongFields(input.kind, input);
      const v = backgroundValues(input.kind, {
        title: input.title,
        summary: input.summary ?? '',
        body: input.kind === 'text' ? (input.body ?? '') : '',
        location: input.kind === 'text' ? null : (input.location ?? '').trim(),
      });
      return db.tx(async (q) => {
        await lockUser(q);
        await ownedProject(q, projectId);
        const { rows: n } = await q.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM project_backgrounds WHERE project_id = $1 AND deleted_at IS NULL`,
          [projectId],
        );
        if (n[0].n >= PROJECT_LIMITS.backgrounds) {
          throw new DiscussionError('limit_exceeded', `배경 항목은 프로젝트당 ${PROJECT_LIMITS.backgrounds}개까지입니다`);
        }
        await checkBytes(q, bytesOf(v));
        await countWrite(q);
        const { rows } = await q.query<Background>(
          `INSERT INTO project_backgrounds AS b (id, project_id, kind, title, summary, body, location, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${BACKGROUND_COLS}`,
          [randomBytes(12).toString('base64url'), projectId, input.kind, v.title, v.summary, v.body, v.location, updatedBy],
        );
        return rows[0];
      });
    },

    // 낙관적 수정: expected_revision이 현재 revision과 같을 때만 고치고 revision을 1 올린다
    async updateBackground(id: string, expectedRevision: number, patch: BackgroundPatch, updatedBy: string): Promise<Background> {
      return db.tx(async (q) => {
        await lockUser(q);
        const cur = await ownedBackground(q, id, true);
        if (patch.kind !== undefined && patch.kind !== cur.kind) throw invalid('항목의 종류(kind)는 바꿀 수 없습니다');
        rejectWrongFields(cur.kind, patch);
        if (cur.revision !== expectedRevision) {
          throw new DiscussionError('revision_mismatch', `현재 revision은 ${cur.revision}입니다. get_background로 다시 읽은 뒤 고치세요`);
        }
        const v = backgroundValues(cur.kind, {
          title: patch.title ?? cur.title,
          summary: patch.summary ?? cur.summary,
          body: patch.body ?? cur.body,
          location: patch.location === undefined ? cur.location : patch.location.trim(),
        });
        await checkBytes(q, bytesOf(v) - bytesOf(cur));
        await countWrite(q);
        const { rows } = await q.query<Background>(
          `UPDATE project_backgrounds b SET title = $2, summary = $3, body = $4, location = $5, updated_by = $6,
             revision = revision + 1, updated_at = now()
           WHERE id = $1 RETURNING ${BACKGROUND_COLS}`,
          [id, v.title, v.summary, v.body, v.location, updatedBy],
        );
        return rows[0];
      });
    },

    // 진행 중인 토론이 참조하면 거부, 참조가 없으면 실제 삭제, 종료된 토론만 참조하면 소프트 삭제(기록에 남긴다)
    async removeBackground(id: string): Promise<'deleted' | 'soft_deleted'> {
      return db.tx(async (q) => {
        await lockUser(q);
        await ownedBackground(q, id, true);
        const { rows } = await q.query<{ active: boolean }>(
          `SELECT d.status = 'active' AS active FROM discussion_backgrounds r JOIN discussions d ON d.id = r.discussion_id
           WHERE r.background_id = $1`,
          [id],
        );
        if (rows.some((r) => r.active)) throw new DiscussionError('in_use', '진행 중인 토론이 참조하는 항목은 삭제할 수 없습니다');
        if (rows.length) {
          await q.query(`UPDATE project_backgrounds SET deleted_at = now() WHERE id = $1`, [id]);
          return 'soft_deleted';
        }
        await q.query(`DELETE FROM project_backgrounds WHERE id = $1`, [id]);
        return 'deleted';
      });
    },
  };
}
