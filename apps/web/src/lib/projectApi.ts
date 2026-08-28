import type { ProjectDeleteImpact, WakerProject } from '@waker/contracts';

export type ProjectInput = Pick<
  WakerProject,
  'name' | 'description' | 'visibility' | 'source' | 'path'
>;

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    let message = fallback;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the local recovery message when the API did not return JSON.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function createProject(wakerId: string, input: ProjectInput): Promise<WakerProject> {
  return readJson(
    await fetch('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wakerId, ...input }),
    }),
    '项目暂时无法创建',
  );
}

export async function updateProject(
  wakerId: string,
  projectId: string,
  input: ProjectInput,
): Promise<WakerProject> {
  return readJson(
    await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wakerId, ...input }),
    }),
    '项目暂时无法保存',
  );
}

export async function fetchProjectDeleteImpact(
  wakerId: string,
  projectId: string,
): Promise<ProjectDeleteImpact> {
  const query = new URLSearchParams({ wakerId });
  return readJson(
    await fetch(
      `/api/v1/projects/${encodeURIComponent(projectId)}/delete-impact?${query.toString()}`,
    ),
    '删除影响暂时无法读取',
  );
}

export async function deleteProject(wakerId: string, projectId: string): Promise<void> {
  const query = new URLSearchParams({ wakerId });
  const response = await fetch(
    `/api/v1/projects/${encodeURIComponent(projectId)}?${query.toString()}`,
    { method: 'DELETE' },
  );
  if (response.ok) return;
  await readJson(response, '项目暂时无法删除');
}
