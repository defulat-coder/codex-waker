import type { SidebarSection, SidebarSectionsState } from '@waker/contracts';

/** 结构校验失败；路由层映射为 400（对齐旧版 SidebarSectionsValidationError）。 */
export class SidebarSectionsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SidebarSectionsValidationError';
  }
}

export function emptySidebarSections(): SidebarSectionsState {
  return {
    sections: [],
    assignments: {},
    entryOrder: [],
    collapsed: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 结构校验（移植旧版 SidebarSectionsStore.validate 的规则与错误语义）：
 * 分组 id 必填且唯一、name 1-32 字符、parentId 必须存在且最多两级嵌套、不允许自父级；
 * assignments 里指向不存在分组的条目、collapsed 里不存在的 id 直接丢弃；
 * entryOrder 去空白去重。sessionId 的 Agent 归属校验不在此处，由 AgentSessionStore 复核。
 */
export function validateSidebarSections(value: unknown): SidebarSectionsState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SidebarSectionsValidationError('sidebar sections payload must be an object');
  }
  const record = value as Record<string, unknown>;
  const sectionsRaw = Array.isArray(record.sections) ? record.sections : [];
  const sections: SidebarSection[] = [];
  const byId = new Map<string, SidebarSection>();
  for (const raw of sectionsRaw) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!id) throw new SidebarSectionsValidationError('section id is required');
    if (byId.has(id)) throw new SidebarSectionsValidationError(`duplicate section id: ${id}`);
    if (!name || name.length > 32) {
      throw new SidebarSectionsValidationError('section name must be 1-32 characters');
    }
    const parentId =
      typeof item.parentId === 'string' && item.parentId.trim() ? item.parentId.trim() : null;
    const order = typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : 0;
    const section: SidebarSection = { id, name, parentId, order };
    sections.push(section);
    byId.set(id, section);
  }
  for (const section of sections) {
    if (!section.parentId) continue;
    const parent = byId.get(section.parentId);
    if (!parent)
      throw new SidebarSectionsValidationError(`section parent not found: ${section.parentId}`);
    if (parent.parentId)
      throw new SidebarSectionsValidationError('sections may nest at most two levels');
    if (section.parentId === section.id)
      throw new SidebarSectionsValidationError('section cannot be its own parent');
  }
  const assignments: Record<string, string> = {};
  const assignmentsRaw = record.assignments;
  if (assignmentsRaw && typeof assignmentsRaw === 'object' && !Array.isArray(assignmentsRaw)) {
    for (const [key, sectionId] of Object.entries(assignmentsRaw)) {
      if (!key || typeof sectionId !== 'string') continue;
      if (!byId.has(sectionId)) continue;
      assignments[key] = sectionId;
    }
  }
  const collapsed = Array.isArray(record.collapsed)
    ? record.collapsed.filter((id): id is string => typeof id === 'string' && byId.has(id))
    : [];
  const entryOrder = Array.isArray(record.entryOrder)
    ? Array.from(
        new Set(
          record.entryOrder
            .filter((key): key is string => typeof key === 'string')
            .map((key) => key.trim())
            .filter(Boolean),
        ),
      )
    : [];
  const updatedAt =
    typeof record.updatedAt === 'string' && record.updatedAt.trim()
      ? record.updatedAt
      : new Date().toISOString();
  return { sections, assignments, entryOrder, collapsed, updatedAt };
}
