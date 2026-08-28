import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import { ArtifactStoreError } from '@waker/artifacts';
import type { AppContext } from '../context.js';

const id = Type.String({ minLength: 1, maxLength: 200 });

export function handleArtifactError(reply: FastifyReply, error: unknown): void {
  if (!(error instanceof ArtifactStoreError)) throw error;
  const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'FILE_TOO_LARGE' ? 413 : 400;
  reply.code(status).send({ error: error.message, code: error.code });
}

async function owns(ctx: AppContext, agentId: string, sessionId: string, reply: FastifyReply) {
  try {
    await ctx.sessions.getSession(sessionId, agentId);
    return true;
  } catch {
    reply.code(404).send({ error: '会话不存在或不属于该 Waker' });
    return false;
  }
}

function attachmentDto(value: ReturnType<AppContext['artifacts']['importBuffer']>) {
  const { storedPath: _storedPath, ...safe } = value;
  return safe;
}

export function decodeBase64(value: string): Buffer {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new ArtifactStoreError('INVALID_INPUT', 'dataBase64 不是合法 Base64');
  return Buffer.from(value, 'base64');
}

export function registerSessionOutputRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    '/sessions/:sessionId/outputs',
    {
      schema: { params: Type.Object({ sessionId: id }), querystring: Type.Object({ agentId: id }) },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const { agentId } = request.query as { agentId: string };
      if (!(await owns(ctx, agentId, sessionId, reply))) return;
      return {
        attachments: ctx.artifacts.listAttachments(sessionId).map(attachmentDto),
        artifacts: ctx.artifacts.listArtifacts(sessionId),
        fileChanges: ctx.artifacts.listFileChanges(sessionId),
      };
    },
  );

  app.post(
    '/sessions/:sessionId/attachments',
    {
      bodyLimit: 36 * 1024 * 1024,
      schema: {
        params: Type.Object({ sessionId: id }),
        body: Type.Object({
          agentId: id,
          originalName: Type.String({ minLength: 1, maxLength: 255 }),
          mimeType: Type.String({ minLength: 1, maxLength: 160 }),
          dataBase64: Type.String({ minLength: 1, maxLength: 35 * 1024 * 1024 }),
        }),
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const body = request.body as {
        agentId: string;
        originalName: string;
        mimeType: string;
        dataBase64: string;
      };
      if (!(await owns(ctx, body.agentId, sessionId, reply))) return;
      try {
        return reply.code(201).send(
          attachmentDto(
            ctx.artifacts.importBuffer({
              sessionId,
              originalName: body.originalName,
              mimeType: body.mimeType,
              data: decodeBase64(body.dataBase64),
            }),
          ),
        );
      } catch (error) {
        return handleArtifactError(reply, error);
      }
    },
  );

  app.get(
    '/sessions/:sessionId/attachments/:attachmentId',
    {
      schema: {
        params: Type.Object({ sessionId: id, attachmentId: id }),
        querystring: Type.Object({ agentId: id }),
      },
    },
    async (request, reply) => {
      const { sessionId, attachmentId } = request.params as {
        sessionId: string;
        attachmentId: string;
      };
      const { agentId } = request.query as { agentId: string };
      if (!(await owns(ctx, agentId, sessionId, reply))) return;
      try {
        const metadata = ctx.artifacts.downloadMetadata(sessionId, attachmentId);
        reply.type(metadata.mimeType);
        reply.header(
          'content-disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(metadata.originalName)}`,
        );
        return reply.send(ctx.artifacts.readAttachment(sessionId, attachmentId));
      } catch (error) {
        return handleArtifactError(reply, error);
      }
    },
  );

  app.delete(
    '/sessions/:sessionId/attachments/:attachmentId',
    {
      schema: {
        params: Type.Object({ sessionId: id, attachmentId: id }),
        querystring: Type.Object({ agentId: id }),
      },
    },
    async (request, reply) => {
      const { sessionId, attachmentId } = request.params as {
        sessionId: string;
        attachmentId: string;
      };
      const { agentId } = request.query as { agentId: string };
      if (!(await owns(ctx, agentId, sessionId, reply))) return;
      return ctx.artifacts.deleteAttachment(sessionId, attachmentId)
        ? reply.code(204).send()
        : reply.code(404).send({ error: '附件不存在' });
    },
  );

  app.post(
    '/sessions/:sessionId/artifacts',
    {
      schema: {
        params: Type.Object({ sessionId: id }),
        body: Type.Object({
          agentId: id,
          attachmentId: id,
          title: Type.String({ minLength: 1, maxLength: 240 }),
          kind: Type.String({ minLength: 1, maxLength: 120 }),
          contentPreview: Type.Optional(Type.String({ maxLength: 4096 })),
        }),
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const body = request.body as {
        agentId: string;
        attachmentId: string;
        title: string;
        kind: string;
        contentPreview?: string;
      };
      if (!(await owns(ctx, body.agentId, sessionId, reply))) return;
      const attachment = ctx.artifacts.getAttachment(sessionId, body.attachmentId);
      if (!attachment) return reply.code(404).send({ error: '附件不存在' });
      try {
        return reply.code(201).send(
          ctx.artifacts.recordArtifact({
            sessionId,
            title: body.title,
            kind: body.kind,
            path: attachment.storedPath,
            contentPreview: body.contentPreview,
          }),
        );
      } catch (error) {
        return handleArtifactError(reply, error);
      }
    },
  );

  app.post(
    '/sessions/:sessionId/file-changes',
    {
      schema: {
        params: Type.Object({ sessionId: id }),
        body: Type.Object({
          agentId: id,
          path: Type.String({ minLength: 1, maxLength: 4000 }),
          kind: Type.Union([Type.Literal('add'), Type.Literal('update'), Type.Literal('delete')]),
          summary: Type.Optional(Type.String({ maxLength: 4096 })),
        }),
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const body = request.body as {
        agentId: string;
        path: string;
        kind: 'add' | 'update' | 'delete';
        summary?: string;
      };
      if (!(await owns(ctx, body.agentId, sessionId, reply))) return;
      try {
        return reply.code(201).send(ctx.artifacts.recordFileChange({ sessionId, ...body }));
      } catch (error) {
        return handleArtifactError(reply, error);
      }
    },
  );
}
