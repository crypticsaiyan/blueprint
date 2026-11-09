import { GROUP_MODULES, MAX_GROUPS } from "@shared/map-layout";

// Large repos have hundreds of modules; the map draws them as folder groups
// instead, picking the deepest folder level that still fits on screen.

export interface ModuleGroup {
  /** Folder path shared by the group's modules, e.g. "apps/web/src/trpc". */
  key: string;
  modules: string[];
}

const dirOf = (path: string) => path.split("/").slice(0, -1);

/** Null when the repo is small enough to draw every module. */
export function groupModules(paths: string[]): ModuleGroup[] | null {
  if (paths.length <= GROUP_MODULES) return null;
  const dirs = paths.map(dirOf);
  // Skip the folders every module shares: they tell the groups nothing.
  let common = dirs[0] ?? [];
  for (const dir of dirs) {
    let i = 0;
    while (i < common.length && dir[i] === common[i]) i++;
    common = common.slice(0, i);
  }
  const keyAt = (dir: string[], depth: number) => dir.slice(0, common.length + depth).join("/") || ".";
  let depth = 1;
  for (let d = 1; d <= 8; d++) {
    const count = new Set(dirs.map((dir) => keyAt(dir, d))).size;
    if (count > MAX_GROUPS) break;
    depth = d;
    if (dirs.every((dir) => dir.length <= common.length + d)) break;
  }
  const groups = new Map<string, string[]>();
  paths.forEach((path, i) => {
    const key = keyAt(dirs[i]!, depth);
    groups.set(key, [...(groups.get(key) ?? []), path]);
  });
  return [...groups].map(([key, modules]) => ({ key, modules })).sort((a, b) => a.key.localeCompare(b.key));
}
