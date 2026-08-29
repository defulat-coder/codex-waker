import { Type } from '@sinclair/typebox';
import { AGENT_ID_PATTERN, AGENT_THINKING_LEVELS, type AgentThinkingLevel } from '@waker/contracts';
import { AGENT_BODY_MAX_BYTES } from '@waker/codex-runtime';

export const AgentIdSchema = Type.String({ pattern: AGENT_ID_PATTERN });
// Mirrors the Codex session-id shape (workbench ids, thread UUIDs, slugs); rejects path-ish input up front.
export const SessionIdSchema = Type.String({
  pattern: '^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$',
  maxLength: 120,
});
export const ThinkingLevelSchema = Type.Unsafe<AgentThinkingLevel>({
  enum: [...AGENT_THINKING_LEVELS],
});

const TurnAttachmentMimeTypeSchema = Type.Union([
  Type.String({ pattern: '^text/[^\\s]+$', maxLength: 160 }),
  Type.String({ pattern: '^image/[^\\s]+$', maxLength: 160 }),
  Type.Literal('application/json'),
  Type.Literal('application/xml'),
]);

const ChatInlineAttachmentSchema = Type.Object(
  {
    originalName: Type.String({ minLength: 1, maxLength: 255 }),
    mimeType: TurnAttachmentMimeTypeSchema,
    // 25 MiB binary expands to roughly 33.4 MiB Base64; ArtifactStore enforces the decoded limit.
    dataBase64: Type.String({ minLength: 1, maxLength: 35 * 1024 * 1024 }),
  },
  { additionalProperties: false },
);

export const ChatRequestSchema = Type.Object(
  {
    agentId: AgentIdSchema,
    sessionId: Type.Optional(SessionIdSchema),
    message: Type.String({ minLength: 1, maxLength: 4000 }),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    thinking: Type.Optional(ThinkingLevelSchema),
    attachmentIds: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
        maxItems: 8,
        uniqueItems: true,
      }),
    ),
    attachments: Type.Optional(Type.Array(ChatInlineAttachmentSchema, { maxItems: 8 })),
    projectId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

export const PreferenceKeySchema = Type.String({
  pattern: '^(ui\\.[a-z-]{1,40}|thinking\\.[a-z][a-z0-9-]{1,63}|model\\.[a-z][a-z0-9-]{1,63})$',
});
export const PreferenceUpdateSchema = Type.Object({
  key: PreferenceKeySchema,
  value: Type.Unknown(),
});

// 关于我区块（我最擅长 / 工作风格）：模板可选携带，条目必须是 {title, text}。
const AgentProfileSectionSchema = Type.Array(
  Type.Object({
    title: Type.String({ minLength: 1, maxLength: 80 }),
    text: Type.String({ minLength: 1, maxLength: 400 }),
  }),
  { maxItems: 8 },
);

// maxLength counts UTF-16 code units; createAgent re-checks the 32KB byte cap.
export const CreateAgentSchema = Type.Object({
  id: Type.Optional(AgentIdSchema),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  mark: Type.String({ minLength: 1, maxLength: 8 }),
  tagline: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.String({ minLength: 1, maxLength: 400 }),
  suggestions: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
    minItems: 1,
    maxItems: 8,
  }),
  body: Type.String({ minLength: 1, maxLength: AGENT_BODY_MAX_BYTES }),
  strengths: Type.Optional(AgentProfileSectionSchema),
  workStyles: Type.Optional(AgentProfileSectionSchema),
});

export const UpdateAgentSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  mark: Type.Optional(Type.String({ minLength: 1, maxLength: 8 })),
  tagline: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
  suggestions: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 8 }),
  ),
  body: Type.Optional(Type.String({ minLength: 1, maxLength: AGENT_BODY_MAX_BYTES })),
});

export const ImportAgentSchema = Type.Object({
  id: AgentIdSchema,
  content: Type.String({ minLength: 1, maxLength: 48 * 1024 }),
});

export const AgentParamsSchema = Type.Object({ agentId: AgentIdSchema });
// 头像上传沿用会话附件的 Base64 JSON 模式；magic bytes 与 2MB 上限在路由层复核。
export const UploadAgentAvatarSchema = Type.Object({
  mimeType: Type.Union([Type.Literal('image/png'), Type.Literal('image/jpeg')]),
  // 2MB 二进制展开约 2.8MB Base64。
  dataBase64: Type.String({ minLength: 1, maxLength: 3 * 1024 * 1024 }),
});
export const SessionParamsSchema = Type.Object({
  agentId: AgentIdSchema,
  sessionId: SessionIdSchema,
});
export const RenameSessionSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 80 }),
});

// GET /inbox 的 query：tab 默认 attention，q 对 title/preview 做大小写不敏感包含过滤。
export const InboxQuerySchema = Type.Object({
  tab: Type.Optional(
    Type.Union([Type.Literal('attention'), Type.Literal('completed'), Type.Literal('all')]),
  ),
  q: Type.Optional(Type.String({ maxLength: 200 })),
});
// 至少一个字段（minProperties），否则 400。
export const UpdateInboxStateSchema = Type.Object(
  { read: Type.Optional(Type.Boolean()), completed: Type.Optional(Type.Boolean()) },
  { minProperties: 1 },
);
export const PromptNameSchema = Type.Object({
  name: Type.String({ pattern: '^[a-z0-9-]{1,80}$' }),
});

export const UpdatePromptSchema = Type.Object({
  content: Type.String({ minLength: 1, maxLength: 32000 }),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});

// 空内容（trim 后）表示删除 .codex/APPEND_SYSTEM.md。
export const UpdateAppendSystemSchema = Type.Object({ content: Type.String({ maxLength: 16000 }) });

// 技能库：install/remove 的入参直接拼进 npx 参数数组（execFile，无 shell），pattern 再挡一层。
export const SkillSourceSchema = Type.String({
  pattern: '^[a-z0-9_.-]+/[a-z0-9_.-]+$',
  maxLength: 200,
});
export const SkillNameSchema = Type.String({
  // 禁止纯点号（'.'、'..'）与连续点（'a..b'），挡住目录遍历形态的名字。
  pattern: '^(?!\\.*$)(?!.*\\.\\.)[a-z0-9_.-]+$',
  maxLength: 100,
});
export const RuntimeSkillNameSchema = Type.String({ pattern: '^[a-z0-9-]{1,80}$' });
export const SkillInstallSchema = Type.Object({
  source: SkillSourceSchema,
  skillId: RuntimeSkillNameSchema,
});
export const SkillRemoveSchema = Type.Object({
  name: SkillNameSchema,
  locator: Type.String({
    pattern: '^(agents:\\.agents|codex:\\.codex)/skills/[a-z0-9_.-]+/SKILL\\.md$',
    maxLength: 240,
  }),
  // 'codex' = .codex/skills 直接删目录；'agents' = .agents/skills 走 npx skills remove。
  scope: Type.Optional(Type.Union([Type.Literal('codex'), Type.Literal('agents')])),
});
// query ≥2 字符走 skills.sh 搜索，否则返回首页榜单；limit 封顶 100。
export const SkillLibraryQuerySchema = Type.Object({
  query: Type.Optional(Type.String({ maxLength: 200 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
// 已安装技能内容：scope 限定两个目录，name 与 remove 同一 pattern（挡路径穿越）。
export const SkillContentQuerySchema = Type.Object({
  scope: Type.Union([Type.Literal('codex'), Type.Literal('agents')]),
  name: SkillNameSchema,
  locator: Type.Optional(
    Type.String({
      pattern: '^(agents:\\.agents|codex:\\.codex)/skills/[a-z0-9_.-]+/SKILL\\.md$',
      maxLength: 240,
    }),
  ),
});
// skills.sh 详情：source/skillId 与 install 同一 pattern。
export const SkillDetailQuerySchema = Type.Object({
  source: SkillSourceSchema,
  skillId: SkillNameSchema,
});

// 文件浏览：path 为相对仓库根的路径；逃逸/敏感文件由路由层复核（schema 只挡长度）。
export const FileListQuerySchema = Type.Object({
  path: Type.Optional(Type.String({ maxLength: 1000 })),
});
export const FileContentQuerySchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1000 }),
});

// 手工上传：maxLength 计 UTF-16 code units；staging 再复核 UTF-8 字节和严格 frontmatter。
export const SkillUploadSchema = Type.Object({
  name: Type.String({ pattern: '^[a-z0-9-]{1,80}$' }),
  content: Type.String({ minLength: 1, maxLength: 128 * 1024 }),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
});
