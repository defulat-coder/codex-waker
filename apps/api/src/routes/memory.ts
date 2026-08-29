import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  MemoryError,
  runMemoryMaintenance,
  type MemoryFilter,
  type MemoryScope,
} from '@waker/memory';
import type { AppContext } from '../context.js';

const id = Type.String({ minLength: 1, maxLength: 200 });
const scopeSchema = Type.Object({
  type: Type.Union([Type.Literal('waker'), Type.Literal('project'), Type.Literal('group')]),
  id,
});

function scopeFrom(value?: { type?: MemoryScope['type']; id?: string }): MemoryScope | undefined {
  return value?.type && value.id ? { type: value.type, id: value.id } : undefined;
}

function filterFrom(query: {
  scopeType?: MemoryScope['type'];
  scopeId?: string;
  source?: string;
  from?: string;
  to?: string;
}): MemoryFilter {
  return {
    ...(query.scopeType && query.scopeId
      ? { scope: { type: query.scopeType, id: query.scopeId } }
      : {}),
    ...(query.source ? { source: query.source } : {}),
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
  };
}

function handleMemoryError(reply: FastifyReply, error: unknown): void {
  if (!(error instanceof MemoryError)) throw error;
  const status =
    error.code === 'NOT_FOUND'
      ? 404
      : error.code === 'VERSION_CONFLICT' || error.code === 'IMPORT_CONFLICT'
        ? 409
        : error.code === 'SCOPE_MISMATCH'
          ? 403
          : 400;
  reply.code(status).send({ error: error.message, code: error.code });
}

export function registerMemoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/memories', async (request) => {
    const items = ctx.memory.list(
      filterFrom(
        request.query as {
          scopeType?: MemoryScope['type'];
          scopeId?: string;
          source?: string;
          from?: string;
          to?: string;
        },
      ),
    );
    return { items, total: items.length };
  });

  app.post(
    '/memories',
    {
      schema: {
        body: Type.Object({
          scope: scopeSchema,
          source: Type.String({ minLength: 1, maxLength: 160 }),
          title: Type.String({ minLength: 1, maxLength: 240 }),
          content: Type.String({ minLength: 1, maxLength: 2_000_000 }),
        }),
      },
    },
    async (request, reply) => {
      try {
        return reply.code(201).send(ctx.memory.create(request.body as never));
      } catch (error) {
        return handleMemoryError(reply, error);
      }
    },
  );

  app.get(
    '/memories/:memoryId',
    { schema: { params: Type.Object({ memoryId: id }) } },
    async (request, reply) => {
      const { memoryId } = request.params as { memoryId: string };
      const query = request.query as { scopeType?: MemoryScope['type']; scopeId?: string };
      try {
        return ctx.memory.get(memoryId, scopeFrom({ type: query.scopeType, id: query.scopeId }));
      } catch (error) {
        return handleMemoryError(reply, error);
      }
    },
  );

  app.patch(
    '/memories/:memoryId',
    {
      schema: {
        params: Type.Object({ memoryId: id }),
        body: Type.Object({
          expectedVersion: Type.Integer({ minimum: 1 }),
          scope: Type.Optional(scopeSchema),
          source: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
          title: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
          content: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000_000 })),
        }),
      },
    },
    async (request, reply) => {
      const { memoryId } = request.params as { memoryId: string };
      try {
        return ctx.memory.update(memoryId, request.body as never);
      } catch (error) {
        return handleMemoryError(reply, error);
      }
    },
  );

  app.delete(
    '/memories/:memoryId',
    {
      schema: {
        params: Type.Object({ memoryId: id }),
        body: Type.Object({
          expectedVersion: Type.Integer({ minimum: 1 }),
          scope: Type.Optional(scopeSchema),
        }),
      },
    },
    async (request, reply) => {
      const { memoryId } = request.params as { memoryId: string };
      try {
        ctx.memory.delete(memoryId, request.body as never);
        return reply.code(204).send();
      } catch (error) {
        return handleMemoryError(reply, error);
      }
    },
  );

  app.get(
    '/memories/:memoryId/versions',
    { schema: { params: Type.Object({ memoryId: id }) } },
    async (request) => {
      const { memoryId } = request.params as { memoryId: string };
      const items = ctx.memory.listVersions(memoryId);
      return { items, total: items.length };
    },
  );

  app.get(
    '/memories/:memoryId/snapshots',
    { schema: { params: Type.Object({ memoryId: id }) } },
    async (request) => {
      const { memoryId } = request.params as { memoryId: string };
      const items = ctx.memory.listSnapshots(memoryId);
      return { items, total: items.length };
    },
  );

  app.post(
    '/memories/:memoryId/snapshots',
    {
      schema: {
        params: Type.Object({ memoryId: id }),
        body: Type.Optional(
          Type.Object({ operation: Type.Optional(Type.String({ maxLength: 120 })) }),
        ),
      },
    },
    async (request, reply) => {
      const { memoryId } = request.params as { memoryId: string };
      try {
        const body = (request.body ?? {}) as { operation?: string };
        return reply.code(201).send(ctx.memory.snapshot(memoryId, body.operation));
      } catch (error) {
        return handleMemoryError(reply, error);
      }
    },
  );

  app.get('/memory/timeline', async (request) => {
    const query = request.query as {
      scopeType?: MemoryScope['type'];
      scopeId?: string;
      source?: string;
      from?: string;
      to?: string;
      documentId?: string;
      action?: string;
    };
    const items = ctx.memory.listTimeline({
      ...filterFrom(query),
      ...(query.documentId ? { documentId: query.documentId } : {}),
      ...(query.action ? { action: query.action } : {}),
    });
    return { items, total: items.length };
  });

  app.get('/memory/diff', async (request, reply) => {
    const query = request.query as { from?: string; to?: string };
    if (!query.from || !query.to) return reply.code(400).send({ error: 'from 与 to 必填' });
    try {
      return { diff: ctx.memory.diff(query.from, query.to) };
    } catch (error) {
      return handleMemoryError(reply, error);
    }
  });

  app.post(
    '/memory/rollback',
    {
      schema: {
        body: Type.Object({
          snapshotId: id,
          expectedVersion: Type.Integer({ minimum: 1 }),
          scope: Type.Optional(scopeSchema),
          apply: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as {
        snapshotId: string;
        expectedVersion: number;
        scope?: MemoryScope;
        apply?: boolean;
      };
      try {
        return ctx.memory.rollback(body.snapshotId, body);
      } catch (error) {
        return handleMemoryError(reply, error);
      }
    },
  );

  app.post(
    '/memory/maintenance/run',
    {
      schema: {
        body: Type.Object({
          scope: scopeSchema,
          staleAfterDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as { scope: MemoryScope; staleAfterDays?: number };
      try {
        return runMemoryMaintenance(ctx.memory, {
          scope: body.scope,
          trigger: 'manual',
          ...(body.staleAfterDays ? { staleAfterDays: body.staleAfterDays } : {}),
        });
      } catch (error) {
        return handleMemoryError(reply, error);
      }
    },
  );

  app.get('/memory/export', async (request, reply) => {
    const query = request.query as {
      format?: 'json' | 'markdown';
      documentId?: string;
      scopeType?: MemoryScope['type'];
      scopeId?: string;
      source?: string;
    };
    try {
      if (query.format === 'markdown') {
        if (!query.documentId)
          return reply.code(400).send({ error: 'Markdown 导出需要 documentId' });
        return {
          format: 'markdown',
          content: ctx.memory.exportMarkdown(
            query.documentId,
            scopeFrom({ type: query.scopeType, id: query.scopeId }),
          ),
        };
      }
      return { format: 'json', content: ctx.memory.exportJson(filterFrom(query)) };
    } catch (error) {
      return handleMemoryError(reply, error);
    }
  });

  app.post(
    '/memory/import',
    {
      schema: {
        body: Type.Union([
          Type.Object({
            format: Type.Literal('json'),
            content: Type.String({ minLength: 1, maxLength: 5_000_000 }),
          }),
          Type.Object({
            format: Type.Literal('markdown'),
            scope: scopeSchema,
            source: Type.String({ minLength: 1, maxLength: 160 }),
            title: Type.String({ minLength: 1, maxLength: 240 }),
            content: Type.String({ minLength: 1, maxLength: 2_000_000 }),
          }),
        ]),
      },
    },
    async (request, reply) => {
      const body = request.body as {
        format: 'json' | 'markdown';
        content: string;
        scope?: MemoryScope;
        source?: string;
        title?: string;
      };
      try {
        const result =
          body.format === 'json'
            ? ctx.memory.importJson(body.content)
            : [
                ctx.memory.importMarkdown({
                  scope: body.scope!,
                  source: body.source!,
                  title: body.title!,
                  markdown: body.content,
                }),
              ];
        return reply.code(201).send({ items: result, total: result.length });
      } catch (error) {
        return handleMemoryError(reply, error);
      }
    },
  );
}
