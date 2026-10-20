import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Caller } from './caller.js';

// 1단계 시험용: 연결과 역할 판별만 확인하는 더미 get_state
function buildServer(caller: Caller): McpServer {
  const server = new McpServer({ name: 'ai-debate-hub', version: '0.1.0' });
  server.registerTool(
    'get_state',
    {
      description: '토론의 현재 상태를 조회한다. (1단계 시험용 더미: 연결된 사용자와 역할만 반환)',
      inputSchema: { discussion_id: z.string().max(64).describe('토론 ID') },
    },
    async ({ discussion_id }) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            discussion_id,
            status: 'dummy',
            user: caller.userId,
            me: caller.participant,
            message: `연결 확인: ${caller.participant} 역할로 접속했습니다.`,
          }),
        },
      ],
    }),
  );
  return server;
}

// 무상태 Streamable HTTP: 요청마다 서버·전송 객체를 새로 만든다.
export async function handleMcp(req: Request, res: Response, caller: Caller): Promise<void> {
  const server = buildServer(caller);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
