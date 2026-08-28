import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export type ProjectSource = 'filesystem' | 'git';

export interface ResolvedProjectDirectory {
  absolutePath: string;
  storedPath: string;
}

/** Resolve browser-supplied paths inside the host-owned workspace root. */
export function resolveProjectDirectory(
  workspaceRoot: string,
  inputPath: string | null | undefined,
  source?: ProjectSource,
): ResolvedProjectDirectory {
  if (!inputPath?.trim()) throw new Error('项目路径必填');

  const root = realpathSync(workspaceRoot);
  let directory: string;
  try {
    directory = realpathSync(resolve(root, inputPath.trim()));
    if (!statSync(directory).isDirectory()) throw new Error('项目路径不是目录');
    accessSync(directory, constants.R_OK | constants.X_OK);
  } catch (error) {
    if (error instanceof Error && error.message === '项目路径不是目录') throw error;
    throw new Error('项目路径不存在或不可读取', { cause: error });
  }

  const fromRoot = relative(root, directory);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('项目路径必须位于当前工作区内');
  }

  if (source === 'git') {
    try {
      statSync(join(directory, '.git'));
    } catch (error) {
      throw new Error('Git 项目路径必须是本地检出目录', { cause: error });
    }
  }

  return { absolutePath: directory, storedPath: fromRoot || '.' };
}
