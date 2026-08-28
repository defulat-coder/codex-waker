import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import { KnowledgeError, type BindingContext, type SearchMode } from '@waker/knowledge';
import type {
  KnowledgeDocument,
  KnowledgeNotebook,
  KnowledgeSearchResponse,
} from '@waker/contracts';
import type { AppContext } from '../context.js';

const id = Type.String({ minLength: 1, maxLength: 160, pattern: '^[a-zA-Z0-9._:-]+$' });
const scope = Type.Object({
  kind: Type.Union([Type.Literal('waker'), Type.Literal('project')]),
  id,
});

function binding(value?: { kind: 'waker' | 'project'; id: string }): BindingContext | undefined {
  return value ? { scopeType: value.kind, scopeId: value.id } : undefined;
}

function handleKnowledgeError(reply: FastifyReply, error: unknown): never | void {
  if (!(error instanceof KnowledgeError)) throw error;
  const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'VERSION_CONFLICT' ? 409 : 403;
  reply.code(status).send({ error: error.message });
}

function notebookDto(
  notebook: { id: string; name: string; description: string; createdAt: string; updatedAt: string },
  documentCount: number,
): KnowledgeNotebook {
  return {
    id: notebook.id,
    title: notebook.name,
    ...(notebook.description ? { description: notebook.description } : {}),
    createdAt: notebook.createdAt,
    updatedAt: notebook.updatedAt,
    documentCount,
  };
}

function documentDto(document: {
  id: string;
  notebookId: string;
  title: string;
  sourceUri?: string;
  currentVersion: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  content?: string;
}): KnowledgeDocument {
  return {
    id: document.id,
    notebookId: document.notebookId,
    title: document.title,
    ...(document.sourceUri ? { uri: document.sourceUri } : {}),
    mimeType:
      typeof document.metadata.mimeType === 'string' ? document.metadata.mimeType : 'text/markdown',
    sourceType:
      document.metadata.sourceType === 'file' ||
      document.metadata.sourceType === 'web' ||
      document.metadata.sourceType === 'text'
        ? document.metadata.sourceType
        : 'markdown',
    content: document.content ?? '',
    version: document.currentVersion,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

export function registerKnowledgeRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/knowledge/notebooks', async (request) => {
    const query = request.query as { scopeKind?: 'waker' | 'project'; scopeId?: string };
    const context =
      query.scopeKind && query.scopeId
        ? binding({ kind: query.scopeKind, id: query.scopeId })
        : undefined;
    const items = ctx.knowledge
      .listNotebooks(context)
      .map((entry) => notebookDto(entry, ctx.knowledge.listDocuments(entry.id, context).length));
    return { items, total: items.length };
  });

  app.post(
    '/knowledge/notebooks',
    {
      schema: {
        body: Type.Object({
          title: Type.String({ minLength: 1, maxLength: 160 }),
          description: Type.Optional(Type.String({ maxLength: 2000 })),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as { title: string; description?: string };
      const created = ctx.knowledge.createNotebook({
        name: body.title,
        description: body.description,
      });
      return reply.code(201).send(notebookDto(created, 0));
    },
  );

  app.delete(
    '/knowledge/notebooks/:notebookId',
    { schema: { params: Type.Object({ notebookId: id }) } },
    async (request, reply) => {
      const { notebookId } = request.params as { notebookId: string };
      const query = request.query as { scopeKind?: 'waker' | 'project'; scopeId?: string };
      try {
        if (
          !ctx.knowledge.deleteNotebook(
            notebookId,
            query.scopeKind && query.scopeId
              ? binding({ kind: query.scopeKind, id: query.scopeId })
              : undefined,
          )
        )
          return reply.code(404).send({ error: '知识库不存在' });
        return reply.code(204).send();
      } catch (error) {
        return handleKnowledgeError(reply, error);
      }
    },
  );

  app.get('/knowledge/documents', async (request, reply) => {
    const query = request.query as {
      notebookId?: string;
      scopeKind?: 'waker' | 'project';
      scopeId?: string;
    };
    if (!query.notebookId) return reply.code(400).send({ error: 'notebookId 必填' });
    try {
      const context =
        query.scopeKind && query.scopeId
          ? binding({ kind: query.scopeKind, id: query.scopeId })
          : undefined;
      const items = ctx.knowledge.listDocuments(query.notebookId, context).map(documentDto);
      return { items, total: items.length };
    } catch (error) {
      return handleKnowledgeError(reply, error);
    }
  });

  app.post(
    '/knowledge/documents',
    {
      schema: {
        body: Type.Object({
          notebookId: id,
          title: Type.String({ minLength: 1, maxLength: 240 }),
          content: Type.String({ minLength: 1, maxLength: 2_000_000 }),
          uri: Type.Optional(Type.String({ maxLength: 2000 })),
          mimeType: Type.Optional(Type.String({ maxLength: 120 })),
          sourceType: Type.Optional(
            Type.Union([
              Type.Literal('text'),
              Type.Literal('markdown'),
              Type.Literal('file'),
              Type.Literal('web'),
            ]),
          ),
          scope: Type.Optional(scope),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as {
        notebookId: string;
        title: string;
        content: string;
        uri?: string;
        mimeType?: string;
        sourceType?: KnowledgeDocument['sourceType'];
        scope?: { kind: 'waker' | 'project'; id: string };
      };
      try {
        const created = await ctx.knowledge.createDocument({
          notebookId: body.notebookId,
          title: body.title,
          content: body.content,
          sourceUri: body.uri,
          metadata: {
            mimeType: body.mimeType ?? 'text/markdown',
            sourceType: body.sourceType ?? 'markdown',
          },
          binding: binding(body.scope),
        });
        return reply.code(201).send(documentDto(created));
      } catch (error) {
        return handleKnowledgeError(reply, error);
      }
    },
  );

  app.patch(
    '/knowledge/documents/:documentId',
    {
      schema: {
        params: Type.Object({ documentId: id }),
        body: Type.Object({
          expectedVersion: Type.Integer({ minimum: 1 }),
          content: Type.String({ minLength: 1, maxLength: 2_000_000 }),
          title: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
          scope: Type.Optional(scope),
        }),
      },
    },
    async (request, reply) => {
      const { documentId } = request.params as { documentId: string };
      const body = request.body as {
        expectedVersion: number;
        content: string;
        title?: string;
        scope?: { kind: 'waker' | 'project'; id: string };
      };
      try {
        return documentDto(
          await ctx.knowledge.updateDocument(documentId, { ...body, binding: binding(body.scope) }),
        );
      } catch (error) {
        return handleKnowledgeError(reply, error);
      }
    },
  );

  app.delete(
    '/knowledge/documents/:documentId',
    {
      schema: {
        params: Type.Object({ documentId: id }),
        querystring: Type.Object({
          scopeKind: Type.Optional(Type.Union([Type.Literal('waker'), Type.Literal('project')])),
          scopeId: Type.Optional(id),
        }),
      },
    },
    async (request, reply) => {
      const { documentId } = request.params as { documentId: string };
      const query = request.query as { scopeKind?: 'waker' | 'project'; scopeId?: string };
      try {
        const context =
          query.scopeKind && query.scopeId
            ? { scopeType: query.scopeKind, scopeId: query.scopeId }
            : undefined;
        if (!ctx.knowledge.deleteDocument(documentId, context))
          return reply.code(404).send({ error: '知识文档不存在' });
        return reply.code(204).send();
      } catch (error) {
        return handleKnowledgeError(reply, error);
      }
    },
  );

  app.post(
    '/knowledge/rebuild',
    {
      schema: {
        body: Type.Object({
          notebookId: Type.Optional(id),
          documentId: Type.Optional(id),
          force: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (request) => ({
      indexedChunks: await ctx.knowledge.rebuild(
        request.body as { notebookId?: string; documentId?: string; force?: boolean },
      ),
    }),
  );

  app.get('/knowledge/bindings', async (request) => {
    const { notebookId } = request.query as { notebookId?: string };
    const items = ctx.knowledge.listBindings(notebookId).map((item) => ({
      notebookId: item.notebookId,
      scope: { kind: item.scopeType, id: item.scopeId },
      access: item.canWrite ? 'read_write' : 'read_only',
      createdAt: item.createdAt,
    }));
    return { items, total: items.length };
  });

  app.get('/knowledge/audits', async (request) => {
    const { notebookId } = request.query as { notebookId?: string };
    const items = ctx.knowledge.listAudits(notebookId);
    return { items, total: items.length };
  });

  app.post(
    '/knowledge/bindings',
    {
      schema: {
        body: Type.Object({
          notebookId: id,
          scope,
          access: Type.Union([Type.Literal('read_only'), Type.Literal('read_write')]),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as {
        notebookId: string;
        scope: { kind: 'waker' | 'project'; id: string };
        access: 'read_only' | 'read_write';
      };
      try {
        ctx.knowledge.bindNotebook(
          body.notebookId,
          binding(body.scope)!,
          body.access === 'read_write',
        );
        return reply
          .code(201)
          .send({ notebookId: body.notebookId, scope: body.scope, access: body.access });
      } catch (error) {
        return handleKnowledgeError(reply, error);
      }
    },
  );

  app.delete(
    '/knowledge/bindings/:notebookId',
    {
      schema: {
        params: Type.Object({ notebookId: id }),
        querystring: Type.Object({
          scopeKind: Type.Union([Type.Literal('waker'), Type.Literal('project')]),
          scopeId: id,
        }),
      },
    },
    async (request, reply) => {
      const { notebookId } = request.params as { notebookId: string };
      const query = request.query as { scopeKind: 'waker' | 'project'; scopeId: string };
      if (
        !ctx.knowledge.unbindNotebook(notebookId, {
          scopeType: query.scopeKind,
          scopeId: query.scopeId,
        })
      )
        return reply.code(404).send({ error: '知识库绑定不存在' });
      return reply.code(204).send();
    },
  );

  app.post(
    '/knowledge/search',
    {
      schema: {
        body: Type.Object({
          scope,
          query: Type.String({ minLength: 1, maxLength: 4000 }),
          mode: Type.Union([
            Type.Literal('keyword'),
            Type.Literal('vector'),
            Type.Literal('hybrid'),
          ]),
          notebookId: Type.Optional(id),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as {
        scope: { kind: 'waker' | 'project'; id: string };
        query: string;
        mode: SearchMode;
        notebookId?: string;
        limit?: number;
      };
      try {
        const results = await ctx.knowledge.search(body.query, {
          mode: body.mode,
          notebookId: body.notebookId,
          limit: body.limit,
          binding: binding(body.scope),
        });
        const fellBack =
          body.mode !== 'keyword' &&
          results.length > 0 &&
          results.every((result) => result.vectorScore === undefined);
        const response: KnowledgeSearchResponse = {
          results: results.map((result) => ({
            notebookId: result.notebookId,
            documentId: result.documentId,
            documentVersion: result.version,
            chunkId: result.chunkId,
            title: result.title,
            ...(result.citation.sourceUri ? { uri: result.citation.sourceUri } : {}),
            startLine: result.citation.startLine,
            endLine: result.citation.endLine,
            content: result.content,
            snippet:
              result.content.length > 240 ? `${result.content.slice(0, 237)}…` : result.content,
            ...(result.keywordScore === undefined ? {} : { keywordScore: result.keywordScore }),
            ...(result.vectorScore === undefined ? {} : { vectorScore: result.vectorScore }),
            score: result.score,
            citation: `${result.citation.sourceUri ?? result.title}#L${result.citation.startLine}-L${result.citation.endLine}`,
          })),
          modeUsed: fellBack ? 'keyword_fallback' : body.mode,
          degraded: fellBack,
          ...(fellBack ? { reason: '本地向量不可用，已自动回退关键词检索' } : {}),
          total: results.length,
          truncated: results.length === (body.limit ?? 8),
        };
        return response;
      } catch (error) {
        return handleKnowledgeError(reply, error);
      }
    },
  );
}
