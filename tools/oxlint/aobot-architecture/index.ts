import { defineRule, eslintCompatPlugin } from "vite-plus/lint/plugins";
import type { Context, ESTree } from "vite-plus/lint/plugins";
import { builtinModules } from "node:module";
import { ownerOf, resolveLocal, workspaceImport } from "./paths.ts";
import type { Owner } from "./paths.ts";
import { featureDependencies, workspaceDependencies } from "./policy.ts";

type Check = (from: Owner, to: Owner | null, source: string) => string | null;

const nodeModules = new Set(builtinModules);

function visits(context: Context, check: Check) {
  const from = ownerOf(context.cwd, context.filename);

  function inspect(node: ESTree.Node, source: string): void {
    const target = resolveLocal(context.cwd, context.filename, source);
    const problem = check(from, target === null ? null : ownerOf(context.cwd, target), source);
    if (problem) context.report({ node, messageId: "violation", data: { problem } });
  }

  return {
    ImportDeclaration(node: ESTree.ImportDeclaration) {
      inspect(node.source, node.source.value);
    },
    ExportNamedDeclaration(node: ESTree.ExportNamedDeclaration) {
      if (node.source) inspect(node.source, node.source.value);
    },
    ExportAllDeclaration(node: ESTree.ExportAllDeclaration) {
      inspect(node.source, node.source.value);
    },
    TSImportType(node: ESTree.TSImportType) {
      inspect(node.source, node.source.value);
    },
    TSExternalModuleReference(node: ESTree.TSExternalModuleReference) {
      inspect(node.expression, node.expression.value);
    },
    ImportExpression(node: ESTree.ImportExpression) {
      if (node.source.type === "Literal" && typeof node.source.value === "string") {
        inspect(node.source, node.source.value);
      } else if (check === boundaryProblem && from.layer !== "outside") {
        context.report({
          node,
          messageId: "violation",
          data: {
            problem: "Use a literal dynamic import so architecture boundaries can be checked.",
          },
        });
      }
    },
    CallExpression(node: ESTree.CallExpression) {
      if (node.callee.type !== "Identifier" || node.callee.name !== "require") return;
      const argument = node.arguments[0];
      if (argument?.type === "Literal" && typeof argument.value === "string") {
        inspect(argument, argument.value);
      } else if (check === boundaryProblem && from.layer !== "outside") {
        context.report({
          node,
          messageId: "violation",
          data: { problem: "Use a literal require so architecture boundaries can be checked." },
        });
      }
    },
  };
}

function workspaceProblem(from: Owner, source: string): string | null {
  const imported = workspaceImport(source);
  if (imported === null || from.workspace === null) return null;
  if (!workspaceDependencies.has(imported.workspace))
    return `Register workspace ${imported.workspace} in the architecture policy.`;
  if (
    imported.workspace !== from.workspace &&
    !workspaceDependencies.get(from.workspace)?.includes(imported.workspace)
  ) {
    return `${from.workspace} has no declared dependency on workspace ${imported.workspace}.`;
  }

  return null;
}

function boundaryProblem(from: Owner, to: Owner | null, source: string): string | null {
  if (from.layer === "outside") return null;
  const crossWorkspace = workspaceProblem(from, source);
  if (crossWorkspace) return crossWorkspace;
  if (to === null) {
    if (source.startsWith("#") && !source.startsWith("#/"))
      return `Unrecognized local alias ${source}; use #/.`;
    return null;
  }

  if (to.workspace !== from.workspace) {
    return to.workspace === null
      ? `${from.path} cannot import ${to.path}, which is outside every workspace.`
      : `Import workspace ${to.workspace} as @aobot/${to.workspace}, not through a relative path.`;
  }

  const features = featureDependencies.get(from.workspace ?? "");
  if (to.feature && !features?.has(to.feature))
    return `Register feature ${to.feature} of ${to.workspace} in the architecture policy.`;
  if (to.layer === "unknown" || to.layer === "outside")
    return `${from.path} cannot depend on ${to.path}, which is outside the architecture layers.`;
  if (from.layer === "shared" && to.layer !== "shared")
    return "Shared code cannot depend on features or app composition.";
  if (from.layer === "feature") {
    if (
      to.feature &&
      to.feature !== from.feature &&
      !features?.get(from.feature ?? "")?.includes(to.feature)
    ) {
      return `${from.feature} has no declared dependency on ${to.feature}.`;
    }

    if (to.layer === "app") return "Features cannot depend on app composition.";
  }

  return null;
}

function publicApiProblem(from: Owner, to: Owner | null, source: string): string | null {
  if (from.layer === "outside") return null;
  const imported = workspaceImport(source);
  if (imported && imported.subpath !== "")
    return `Import @aobot/${imported.workspace}, not its internal path ${imported.subpath}.`;
  if (to?.entry === "testing" && !from.test && from.entry !== "testing")
    return `Only tests may import ${to.path}: a testing module is no part of the running app.`;
  if (!to?.feature || from.feature === to.feature || to.workspace !== from.workspace) return null;
  if (to.entry !== null) return null;
  return `Import ${to.feature}/public instead of internal module ${to.path}.`;
}

function domainPurityProblem(from: Owner, _to: Owner | null, source: string): string | null {
  if (from.workspace !== "domain" || from.layer !== "package" || from.test) return null;
  if (source.startsWith("node:") || nodeModules.has(source)) {
    return "packages/domain runs in the server, the web page and the desktop app: no Node built-ins.";
  }

  if (/^(?:react(?:\/|$)|react-dom(?:\/|$)|electron(?:\/|$))/u.test(source)) {
    return "packages/domain holds schemas only: no React or Electron imports.";
  }

  return null;
}

function rule(description: string, check: Check) {
  return defineRule({
    meta: { type: "problem", docs: { description }, messages: { violation: "{{problem}}" } },
    create(context) {
      return visits(context, check);
    },
  });
}

const boundaries = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Enforce layer direction and declared workspace and feature dependencies.",
    },
    messages: { violation: "{{problem}}" },
  },
  create(context) {
    const from = ownerOf(context.cwd, context.filename);
    return {
      ...visits(context, boundaryProblem),
      Program(node) {
        if (
          from.workspace !== null &&
          from.layer !== "outside" &&
          !workspaceDependencies.has(from.workspace)
        ) {
          context.report({
            node,
            messageId: "violation",
            data: { problem: `Register workspace ${from.workspace} in the architecture policy.` },
          });
        }

        if (from.layer === "unknown") {
          context.report({
            node,
            messageId: "violation",
            data: {
              problem: `${from.path} is not in a known layer: use src/app, src/features/<name> or src/shared.`,
            },
          });
        }

        if (from.feature && !featureDependencies.get(from.workspace ?? "")?.has(from.feature)) {
          context.report({
            node,
            messageId: "violation",
            data: {
              problem: `Register feature ${from.feature} of ${from.workspace} in the architecture policy.`,
            },
          });
        }
      },
    };
  },
});

/** True for `import type { A }` and `import { type A, type B }`: erased at build time, so it never pulls a module into a hot update. */
function typeOnly(node: ESTree.ImportDeclaration): boolean {
  if (node.importKind === "type") return true;
  return (
    node.specifiers.length > 0 &&
    node.specifiers.every((s) => s.type === "ImportSpecifier" && s.importKind === "type")
  );
}

const contextLeaf = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "A module that creates a React context imports only react at runtime, so a hot update never re-creates the context.",
    },
    messages: { violation: "{{problem}}" },
  },
  create(context) {
    const runtimeImports: { node: ESTree.Node; source: string }[] = [];
    let createsContext = false;
    return {
      ImportDeclaration(node: ESTree.ImportDeclaration) {
        if (node.source.value === "react") {
          createsContext ||= node.specifiers.some(
            (s) =>
              s.type === "ImportSpecifier" &&
              s.imported.type === "Identifier" &&
              s.imported.name === "createContext",
          );
          return;
        }

        if (!typeOnly(node)) runtimeImports.push({ node: node.source, source: node.source.value });
      },
      ExportNamedDeclaration(node: ESTree.ExportNamedDeclaration) {
        if (node.source && node.exportKind !== "type")
          runtimeImports.push({ node: node.source, source: node.source.value });
      },
      ExportAllDeclaration(node: ESTree.ExportAllDeclaration) {
        if (node.exportKind !== "type")
          runtimeImports.push({ node: node.source, source: node.source.value });
      },
      "Program:exit"() {
        if (!createsContext) return;
        for (const { node, source } of runtimeImports) {
          context.report({
            node,
            messageId: "violation",
            data: {
              problem: `This module creates a React context, so its only runtime import is react: a hot update that reaches ${source} would re-run it, create a new context and split providers from consumers. Use import type, or move the code that needs ${source} into another module.`,
            },
          });
        }
      },
    };
  },
});

/** aobot's architecture: workspace and feature boundaries, public entry points, a pure domain package. */
export default eslintCompatPlugin({
  meta: { name: "aobot-architecture" },
  rules: {
    boundaries,
    "context-leaf": contextLeaf,
    "public-api": rule(
      "Use public entry points across feature and workspace boundaries.",
      publicApiProblem,
    ),
    "domain-purity": rule("Keep packages/domain free of platform imports.", domainPurityProblem),
  },
});
