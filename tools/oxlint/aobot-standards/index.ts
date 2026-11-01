import { defineRule, eslintCompatPlugin } from "vite-plus/lint/plugins";
import type { Context, ESTree } from "vite-plus/lint/plugins";
import { ownerOf } from "../aobot-architecture/paths.ts";

const safetyPattern = /(?:^|[^\p{L}\p{N}_])SAFETY\s*:\s*\S/u;

/** Statements and members a SAFETY comment may sit above, like the type-assertion rule. */
const commentOwnerKinds = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
  "IfStatement",
  "ForStatement",
  "ForOfStatement",
  "WhileStatement",
]);

function hasSafetyComment(context: Context, node: ESTree.Node): boolean {
  let current: ESTree.Node = node;
  while (current.type !== "Program") {
    const comments = context.sourceCode.getCommentsBefore(current);
    if (comments.some((comment) => comment.end <= node.start && safetyPattern.test(comment.value)))
      return true;
    if (commentOwnerKinds.has(current.type)) {
      const parent = current.parent;
      return (
        parent.type === "ExportNamedDeclaration" &&
        context.sourceCode
          .getCommentsBefore(parent)
          .some((comment) => safetyPattern.test(comment.value))
      );
    }

    current = current.parent;
  }

  return false;
}

const noUnjustifiedNonNullAssertion = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Branch or refine optional values instead of asserting them with `!`." },
    messages: {
      violation:
        "Replace `!` with a branch, `??` fallback or typed lookup. If the invariant is real (e.g. index after a length check), state it in a `// SAFETY:` comment above the statement.",
    },
  },
  create(context) {
    return {
      TSNonNullExpression(node: ESTree.TSNonNullExpression) {
        if (!hasSafetyComment(context, node)) context.report({ node, messageId: "violation" });
      },
    };
  },
});

/**
Where optional values must be `Option`: every workspace's source. Exempt, because `Option` cannot or should not go there:
- React components (`.tsx`) and React ref types (`RefObject<T | null>`): React's own optional conventions;
- tests, test helpers, stories and generated code.
Boundary adapters for external formats (the Agent SDK, Playwright, wire payloads) opt out in `.oxlintrc.json`.
*/
function optionScope(context: Context): boolean {
  const owner = ownerOf(context.cwd, context.filename);
  if (owner.layer === "outside" || owner.layer === "unknown" || owner.test) return false;
  return !/\.tsx$|\.gen\.ts$|\/testing(?:\/|\.ts$)/u.test(owner.path);
}

/** `RefObject<HTMLCanvasElement | null>`: React fills refs with null, so the union is React's type, not ours. */
function isReactRefArgument(node: ESTree.TSUnionType): boolean {
  const reference = node.parent.parent;
  return (
    node.parent.type === "TSTypeParameterInstantiation" &&
    reference?.type === "TSTypeReference" &&
    reference.typeName.type === "Identifier" &&
    /^(?:RefObject|MutableRefObject|Ref)$/u.test(reference.typeName.name)
  );
}

const noOptionalValues = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Model optional fields, parameters and returns as Option.Option<A> outside the plain-TypeScript simulation.",
    },
    messages: {
      union:
        "Use Option.Option<A> instead of `| {{kind}}`. Keep null/undefined only in a boundary adapter (see .oxlintrc.json overrides).",
      optional:
        "Use Option.Option<A> instead of an optional `?` {{kind}}. Keep optional shapes only in a boundary adapter (see .oxlintrc.json overrides).",
    },
  },
  create(context) {
    if (!optionScope(context)) return {};
    return {
      TSUnionType(node: ESTree.TSUnionType) {
        if (isReactRefArgument(node)) return;
        const nullish = node.types.find(
          (type) => type.type === "TSUndefinedKeyword" || type.type === "TSNullKeyword",
        );
        if (nullish)
          context.report({
            node,
            messageId: "union",
            data: { kind: nullish.type === "TSNullKeyword" ? "null" : "undefined" },
          });
      },
      TSPropertySignature(node: ESTree.TSPropertySignature) {
        if (node.optional)
          context.report({ node, messageId: "optional", data: { kind: "property" } });
      },
      PropertyDefinition(node: ESTree.PropertyDefinition) {
        if (node.optional)
          context.report({ node, messageId: "optional", data: { kind: "property" } });
      },
      Identifier(node: ESTree.BindingIdentifier) {
        // SAFETY: Oxlint's types say `optional?: false`, but the parser sets `true` on an optional parameter (`x?: T`).
        const optional = node.optional as boolean | undefined;
        if (optional === true)
          context.report({ node, messageId: "optional", data: { kind: "parameter" } });
      },
    };
  },
});

function isDocumented(context: Context, node: ESTree.Node): boolean {
  return context.sourceCode
    .getCommentsBefore(node)
    .some((comment) => comment.type === "Block" && comment.value.startsWith("*"));
}

function documentationScope(context: Context): boolean {
  const owner = ownerOf(context.cwd, context.filename);
  if (owner.layer === "outside" || owner.layer === "unknown" || owner.test) return false;
  return !/\.(?:stories|gen)\.tsx?$|\/testing(?:\/|\.ts$)/u.test(owner.path);
}

const requireExportJsdoc = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Every exported declaration carries a JSDoc block saying what it is for.",
    },
    messages: { violation: "Add a `/** … */` JSDoc block above exported `{{name}}`." },
  },
  create(context) {
    if (!documentationScope(context)) return {};
    function nameOf(declaration: ESTree.Node): string {
      if ("id" in declaration && declaration.id && "name" in declaration.id)
        return String(declaration.id.name);
      if (declaration.type === "VariableDeclaration") {
        return declaration.declarations
          .map((d) => (d.id.type === "Identifier" ? d.id.name : "…"))
          .join(", ");
      }

      return "default";
    }

    return {
      ExportNamedDeclaration(node: ESTree.ExportNamedDeclaration) {
        if (!node.declaration || node.declaration.type === "TSModuleDeclaration") return;
        if (!isDocumented(context, node))
          context.report({
            node,
            messageId: "violation",
            data: { name: nameOf(node.declaration) },
          });
      },
      ExportDefaultDeclaration(node: ESTree.ExportDefaultDeclaration) {
        if (node.declaration.type === "Identifier") return;
        if (!isDocumented(context, node))
          context.report({
            node,
            messageId: "violation",
            data: { name: nameOf(node.declaration) },
          });
      },
    };
  },
});

function checkEffectSource(context: Context, source: ESTree.StringLiteral): void {
  if (/^effect\/[A-Z]/u.test(source.value)) {
    const name = source.value.slice("effect/".length);
    context.report({ node: source, messageId: "violation", data: { name } });
  }
}

const noEffectLeafImports = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Import stable Effect modules from the `effect` root, not their leaf path.",
    },
    messages: {
      violation:
        'Import `{{name}}` from "effect" (`import { {{name}} } from "effect"`) instead of its leaf module.',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node: ESTree.ImportDeclaration) {
        checkEffectSource(context, node.source);
      },
      ExportNamedDeclaration(node: ESTree.ExportNamedDeclaration) {
        if (node.source) checkEffectSource(context, node.source);
      },
      ExportAllDeclaration(node: ESTree.ExportAllDeclaration) {
        checkEffectSource(context, node.source);
      },
    };
  },
});

/** Global constructors whose names end in Error: `instanceof` is the only way to narrow them. */
const builtinErrors = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "DOMException",
]);

const noTaggedErrorInstanceof = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Narrow tagged errors by tag, not by class identity." },
    messages: {
      violation:
        'Narrow `{{name}}` by its tag (`Effect.catchTags`, `Predicate.isTagged(error, "{{name}}")` or `Match.tag`) instead of `instanceof`.',
    },
  },
  create(context) {
    return {
      BinaryExpression(node: ESTree.BinaryExpression) {
        if (node.operator !== "instanceof" || node.right.type !== "Identifier") return;
        const name = node.right.name;
        if (name.endsWith("Error") && !builtinErrors.has(name))
          context.report({ node, messageId: "violation", data: { name } });
      },
    };
  },
});

/** Test files of every tier: unit and service tests, the contract suites and the nightly smoke test. */
const testFilePattern = /\.(?:test|contract|smoke)\.[cm]?[jt]sx?$/u;

/** Whether `name` at `node` is bound by `import { name } from "effect"`, not a local of the same name. */
function isEffectImport(context: Context, node: ESTree.IdentifierReference, name: string): boolean {
  let scope = context.sourceCode.getScope(node);

  while (true) {
    const variable = scope.set.get(node.name);

    if (variable !== undefined) {
      return variable.defs.some(
        (definition) =>
          definition.type === "ImportBinding" &&
          definition.node.type === "ImportSpecifier" &&
          definition.parent?.type === "ImportDeclaration" &&
          definition.parent.source.value === "effect" &&
          (definition.node.imported.type === "Identifier"
            ? definition.node.imported.name
            : definition.node.imported.value) === name,
      );
    }

    if (scope.upper === null) return false;
    scope = scope.upper;
  }
}

/** `Effect.runPromise` and friends: each builds a runtime of its own instead of the test's. */
const effectRunners = new Set([
  "runCallback",
  "runCallbackWith",
  "runFork",
  "runForkWith",
  "runPromise",
  "runPromiseExit",
  "runPromiseExitWith",
  "runPromiseWith",
  "runSync",
  "runSyncExit",
  "runSyncExitWith",
  "runSyncWith",
]);

/** The member `object.property` read without computed access, as two names. */
function memberNames(
  node: ESTree.Node,
): { object: ESTree.IdentifierReference; property: string } | undefined {
  if (node.type !== "MemberExpression" || node.computed) return undefined;
  if (node.object.type !== "Identifier" || node.property.type !== "Identifier") return undefined;

  return { object: node.object, property: node.property.name };
}

const noManualEffectRuntimeInTests = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Run Effects in tests through @effect/vitest, not a runtime the test builds itself.",
    },
    messages: {
      violation:
        "Do not call `{{name}}` in a test. Write the test as `it.effect` (or `it.live` for real time) from @effect/vitest and yield the Effect.",
    },
  },
  create(context) {
    if (!testFilePattern.test(context.filename)) return {};

    return {
      // A member read, not only a call: `.pipe(Effect.runPromise)` builds a runtime too.
      MemberExpression(node: ESTree.MemberExpression) {
        const member = memberNames(node);
        if (member === undefined) return;

        const runner =
          (member.object.name === "Effect" && effectRunners.has(member.property)) ||
          (member.object.name === "ManagedRuntime" && member.property === "make");

        if (runner && isEffectImport(context, member.object, member.object.name))
          context.report({
            node,
            messageId: "violation",
            data: { name: `${member.object.name}.${member.property}` },
          });
      },
    };
  },
});

const testFunctions = new Set(["describe", "it", "test"]);

/** `it(…)`, `describe(…)`, `it.effect(…)`, `it.live(…)`: calls that declare a test or a group. */
function declaresTest(callee: ESTree.Node): string | undefined {
  if (callee.type === "Identifier") return testFunctions.has(callee.name) ? callee.name : undefined;

  const member = memberNames(callee);
  if (member === undefined || !testFunctions.has(member.object.name)) return undefined;

  return ["effect", "live", "layer"].includes(member.property)
    ? `${member.object.name}.${member.property}`
    : undefined;
}

const loops = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement"]);

const functions = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);

/** Whether `node` runs once per iteration of a loop. Inside a function it runs once per call. */
function isInsideLoop(node: ESTree.Node): boolean {
  let current = node.parent;

  while (current !== null && current.type !== "Program") {
    if (loops.has(current.type)) return true;
    if (functions.has(current.type)) {
      const call = current.parent;
      // `[…].forEach((x) => it(…))` and `.map` are loops too.
      if (call.type !== "CallExpression") return false;
      const callee = call.callee;

      return (
        callee.type === "MemberExpression" &&
        callee.property.type === "Identifier" &&
        ["forEach", "map", "flatMap"].includes(callee.property.name)
      );
    }

    current = current.parent;
  }

  return false;
}

const noTestInLoop = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Declare one test per case with `.each`, not inside a loop." },
    messages: {
      violation:
        "Do not call `{{name}}(…)` inside a loop. Use `{{name}}.each(cases)(name, …)`, so each case is named and reported on its own.",
    },
  },
  create(context) {
    if (!testFilePattern.test(context.filename)) return {};

    return {
      CallExpression(node: ESTree.CallExpression) {
        const name = declaresTest(node.callee);

        if (name !== undefined && isInsideLoop(node))
          context.report({ node: node.callee, messageId: "violation", data: { name } });
      },
    };
  },
});

const preferCatchTags = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Catch known tags with `catchTags`, even for one tag." },
    messages: {
      violation:
        "Use `{{module}}.catchTags({ Tag: handler })` instead of `{{module}}.catchTag`, even for one tag, so adding a second is one more key.",
    },
  },
  create(context) {
    return {
      MemberExpression(node: ESTree.MemberExpression) {
        const member = memberNames(node);
        if (member === undefined || member.property !== "catchTag") return;
        if (!["Effect", "Stream", "Layer"].includes(member.object.name)) return;

        if (isEffectImport(context, member.object, member.object.name))
          context.report({ node, messageId: "violation", data: { module: member.object.name } });
      },
    };
  },
});

/** Project coding standards that the vendored anti-slop rules do not cover. */
export default eslintCompatPlugin({
  meta: { name: "aobot-standards" },
  rules: {
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
    "no-test-in-loop": noTestInLoop,
    "prefer-catch-tags": preferCatchTags,
    "no-effect-leaf-imports": noEffectLeafImports,
    "no-optional-values": noOptionalValues,
    "no-tagged-error-instanceof": noTaggedErrorInstanceof,
    "no-unjustified-non-null-assertion": noUnjustifiedNonNullAssertion,
    "require-export-jsdoc": requireExportJsdoc,
  },
});
