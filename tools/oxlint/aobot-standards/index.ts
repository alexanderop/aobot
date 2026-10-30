import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";
import type { Context, ESTree } from "@oxlint/plugins";
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
    if (comments.some((comment) => comment.end <= node.start && safetyPattern.test(comment.value))) return true;
    if (commentOwnerKinds.has(current.type)) {
      const parent = current.parent;
      return parent.type === "ExportNamedDeclaration" &&
        context.sourceCode.getCommentsBefore(parent).some((comment) => safetyPattern.test(comment.value));
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
      violation: "Replace `!` with a branch, `??` fallback or typed lookup. If the invariant is real (e.g. index after a length check), state it in a `// SAFETY:` comment above the statement.",
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
  return node.parent.type === "TSTypeParameterInstantiation" && reference?.type === "TSTypeReference" &&
    reference.typeName.type === "Identifier" && /^(?:RefObject|MutableRefObject|Ref)$/u.test(reference.typeName.name);
}

const noOptionalValues = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Model optional fields, parameters and returns as Option.Option<A> outside the plain-TypeScript simulation." },
    messages: {
      union: "Use Option.Option<A> instead of `| {{kind}}`. Keep null/undefined only in a boundary adapter (see .oxlintrc.json overrides).",
      optional: "Use Option.Option<A> instead of an optional `?` {{kind}}. Keep optional shapes only in a boundary adapter (see .oxlintrc.json overrides).",
    },
  },
  create(context) {
    if (!optionScope(context)) return {};
    return {
      TSUnionType(node: ESTree.TSUnionType) {
        if (isReactRefArgument(node)) return;
        const nullish = node.types.find((type) => type.type === "TSUndefinedKeyword" || type.type === "TSNullKeyword");
        if (nullish) context.report({ node, messageId: "union", data: { kind: nullish.type === "TSNullKeyword" ? "null" : "undefined" } });
      },
      TSPropertySignature(node: ESTree.TSPropertySignature) {
        if (node.optional) context.report({ node, messageId: "optional", data: { kind: "property" } });
      },
      PropertyDefinition(node: ESTree.PropertyDefinition) {
        if (node.optional) context.report({ node, messageId: "optional", data: { kind: "property" } });
      },
      Identifier(node: ESTree.BindingIdentifier) {
        // SAFETY: Oxlint's types say `optional?: false`, but the parser sets `true` on an optional parameter (`x?: T`).
        const optional = node.optional as boolean | undefined;
        if (optional === true) context.report({ node, messageId: "optional", data: { kind: "parameter" } });
      },
    };
  },
});

function isDocumented(context: Context, node: ESTree.Node): boolean {
  return context.sourceCode.getCommentsBefore(node).some((comment) => comment.type === "Block" && comment.value.startsWith("*"));
}

function documentationScope(context: Context): boolean {
  const owner = ownerOf(context.cwd, context.filename);
  if (owner.layer === "outside" || owner.layer === "unknown" || owner.test) return false;
  return !/\.(?:stories|gen)\.tsx?$|\/testing(?:\/|\.ts$)/u.test(owner.path);
}

const requireExportJsdoc = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Every exported declaration carries a JSDoc block saying what it is for." },
    messages: { violation: "Add a `/** … */` JSDoc block above exported `{{name}}`." },
  },
  create(context) {
    if (!documentationScope(context)) return {};
    function nameOf(declaration: ESTree.Node): string {
      if ("id" in declaration && declaration.id && "name" in declaration.id) return String(declaration.id.name);
      if (declaration.type === "VariableDeclaration") {
        return declaration.declarations.map((d) => (d.id.type === "Identifier" ? d.id.name : "…")).join(", ");
      }

      return "default";
    }

    return {
      ExportNamedDeclaration(node: ESTree.ExportNamedDeclaration) {
        if (!node.declaration || node.declaration.type === "TSModuleDeclaration") return;
        if (!isDocumented(context, node)) context.report({ node, messageId: "violation", data: { name: nameOf(node.declaration) } });
      },
      ExportDefaultDeclaration(node: ESTree.ExportDefaultDeclaration) {
        if (node.declaration.type === "Identifier") return;
        if (!isDocumented(context, node)) context.report({ node, messageId: "violation", data: { name: nameOf(node.declaration) } });
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
    docs: { description: "Import stable Effect modules from the `effect` root, not their leaf path." },
    messages: { violation: "Import `{{name}}` from \"effect\" (`import { {{name}} } from \"effect\"`) instead of its leaf module." },
  },
  create(context) {
    return {
      ImportDeclaration(node: ESTree.ImportDeclaration) { checkEffectSource(context, node.source); },
      ExportNamedDeclaration(node: ESTree.ExportNamedDeclaration) { if (node.source) checkEffectSource(context, node.source); },
      ExportAllDeclaration(node: ESTree.ExportAllDeclaration) { checkEffectSource(context, node.source); },
    };
  },
});

/** Global constructors whose names end in Error: `instanceof` is the only way to narrow them. */
const builtinErrors = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError", "DOMException",
]);

const noTaggedErrorInstanceof = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Narrow tagged errors by tag, not by class identity." },
    messages: {
      violation: "Narrow `{{name}}` by its tag (`Effect.catchTag`, `Predicate.isTagged(error, \"{{name}}\")` or `Match.tag`) instead of `instanceof`.",
    },
  },
  create(context) {
    return {
      BinaryExpression(node: ESTree.BinaryExpression) {
        if (node.operator !== "instanceof" || node.right.type !== "Identifier") return;
        const name = node.right.name;
        if (name.endsWith("Error") && !builtinErrors.has(name)) context.report({ node, messageId: "violation", data: { name } });
      },
    };
  },
});

/** Project coding standards that the vendored anti-slop rules do not cover. */
export default eslintCompatPlugin({
  meta: { name: "aobot-standards" },
  rules: {
    "no-effect-leaf-imports": noEffectLeafImports,
    "no-optional-values": noOptionalValues,
    "no-tagged-error-instanceof": noTaggedErrorInstanceof,
    "no-unjustified-non-null-assertion": noUnjustifiedNonNullAssertion,
    "require-export-jsdoc": requireExportJsdoc,
  },
});
