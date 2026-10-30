/**
Which workspace may import which. Workspaces import each other only through their package name
(`@aobot/<name>`), never through a relative path. Add a workspace here before creating its directory.
*/
export const workspaceDependencies: ReadonlyMap<string, readonly string[]> = new Map([
  ["domain", []],
  ["computer", ["domain"]],
  ["server", ["domain"]],
  ["web", ["domain"]],
  ["desktop", ["domain"]],
]);

/**
Which feature may import which, per app. A feature imports another only through its `public.ts`.
Add a feature here before creating its directory.

The server graph is where "every action goes through the gateway" lives: only `gateway` depends on
`computers`, so nothing else can reach a computer.
*/
export const featureDependencies: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> = new Map([
  ["server", new Map([
    ["bots", []],
    ["audit", []],
    ["policy", []],
    ["computers", []],
    ["gateway", ["bots", "policy", "audit", "computers"]],
    ["agent", ["bots", "gateway"]],
    ["chat", ["bots", "agent"]],
    ["auth", []],
    ["approvals", ["gateway"]],
  ])],
  ["web", new Map([
    ["chat", []],
    ["bots", []],
    ["screen", []],
    ["audit", []],
    ["approvals", ["chat"]],
  ])],
  ["computer", new Map([
    ["browser", []],
    ["shell", []],
    ["screen", ["browser"]],
    ["control", ["browser"]],
  ])],
  ["desktop", new Map<string, readonly string[]>()],
]);

/** Every dependency must exist and each graph must stay acyclic. */
export function policyProblems(graph: ReadonlyMap<string, readonly string[]>, label: string): string[] {
  const problems: string[] = [];
  const finished = new Set<string>();
  const active = new Set<string>();

  function visit(node: string, path: readonly string[]): void {
    if (active.has(node)) {
      problems.push(`${label}: dependency cycle ${[...path, node].join(" -> ")}`);
      return;
    }

    if (finished.has(node)) return;
    active.add(node);
    for (const dependency of graph.get(node) ?? []) {
      if (!graph.has(dependency)) {
        problems.push(`${label}: ${node} depends on unregistered ${dependency}`);
      } else {
        visit(dependency, [...path, node]);
      }
    }

    active.delete(node);
    finished.add(node);
  }

  for (const node of graph.keys()) visit(node, []);
  return problems;
}
