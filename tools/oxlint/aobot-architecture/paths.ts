import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

type Layer = "package" | "app" | "feature" | "shared" | "unknown" | "outside";

export interface Owner {
  readonly path: string;
  /** `apps/<name>` or `packages/<name>`, or null outside both. */
  readonly workspace: string | null;
  /** The workspace's directory relative to the root, e.g. `apps/server`. */
  readonly workspaceDir: string | null;
  readonly layer: Layer;
  readonly feature: string | null;
  readonly entry: "public" | null;
  readonly test: boolean;
}

function canonical(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

/** `@aobot/server/x` → { workspace: "server", subpath: "x" }. */
export function workspaceImport(source: string): { workspace: string; subpath: string } | null {
  const match = /^@aobot\/([^/]+)(?:\/(.*))?$/u.exec(source);
  if (!match?.[1]) return null;
  return { workspace: match[1], subpath: match[2] ?? "" };
}

/** Resolve `#/` (the importer's own `src`), relative paths, extensionless modules, index files and symlinks. */
export function resolveLocal(root: string, importer: string, source: string): string | null {
  let target: string;
  if (source.startsWith("#/")) {
    const owner = ownerOf(root, importer);
    if (owner.workspaceDir === null) return null;
    target = resolve(root, owner.workspaceDir, "src", source.slice(2));
  } else if (source.startsWith(".") || isAbsolute(source)) {
    target = resolve(dirname(importer), source);
  } else {
    return null;
  }

  const candidates = [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`];
  for (const candidate of candidates) {
    if (/\.[cm]?[jt]sx?$/u.test(candidate) && existsSync(candidate)) return canonical(candidate);
  }

  if (target.endsWith(".js") && existsSync(`${target.slice(0, -3)}.ts`)) return canonical(`${target.slice(0, -3)}.ts`);
  return target;
}

/**
Where a file sits. Apps use `src/app` (composition), `src/features/<name>` and `src/shared`;
packages are one layer. Anything else under an app's `src` is `unknown`, which the boundaries rule reports.
*/
export function ownerOf(root: string, filename: string): Owner {
  const path = relative(canonical(root), canonical(filename)).replaceAll("\\", "/").replace(/\?.*$/u, "");
  const parts = path.split("/");
  const test = /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path);
  const base = { path, test, feature: null, entry: null } as const;

  if ((parts[0] === "apps" || parts[0] === "packages") && parts[1] && parts.length > 2) {
    const workspace = parts[1];
    const workspaceDir = `${parts[0]}/${workspace}`;
    if (parts[2] !== "src") return { ...base, workspace, workspaceDir, layer: "outside" };
    if (parts[0] === "packages") return { ...base, workspace, workspaceDir, layer: "package" };

    const area = parts[3] ?? "";
    if (area === "features" && parts[4] && parts.length > 5) {
      const module = parts[5]?.replace(/\.[cm]?[jt]sx?$/u, "") ?? "";
      return {
        ...base, workspace, workspaceDir, layer: "feature", feature: parts[4],
        entry: parts.length === 6 && module === "public" ? "public" : null,
      };
    }

    if (area === "shared") return { ...base, workspace, workspaceDir, layer: "shared" };
    if (area === "app" || parts.length === 4) return { ...base, workspace, workspaceDir, layer: "app" };
    return { ...base, workspace, workspaceDir, layer: "unknown" };
  }

  return { ...base, workspace: null, workspaceDir: null, layer: "outside" };
}
