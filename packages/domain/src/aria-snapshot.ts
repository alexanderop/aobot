import { Option, Schema } from "effect";
import type { RefTarget } from "./computer.ts";

/**
An element line's key, such as `button "Search" [ref=e12]`: a role, its name as a JSON string, then
attributes in brackets.
*/
const keyPattern =
  /^(?<role>[a-z]+)(?: (?<name>"(?:[^"\\]|\\.)*"))?(?<attributes>(?: \[[^\]]*\])*)$/u;

const refPattern = / \[ref=(?<ref>[^\]]+)\]/u;

const decodeName = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));

/**
The key of one `- ` line. Playwright writes it as YAML: in single quotes, with `''` for a quote, when it
would otherwise read as something else, such as a name holding `: `. Unquoted, it ends at the first
`:` before a space or the end of the line, where the element's value or children begin.
*/
function lineKey(line: string): Option.Option<string> {
  const item = /^\s*- (?<item>.*)$/u.exec(line)?.groups?.["item"];

  if (item === undefined) return Option.none();

  if (!item.startsWith("'")) return Option.some(item.split(/:(?:\s|$)/u, 1)[0] ?? "");

  return Option.map(
    Option.fromNullishOr(/^'(?<quoted>(?:[^']|'')*)'/u.exec(item)?.groups?.["quoted"]),
    (quoted) => quoted.replaceAll("''", "'"),
  );
}

function lineTarget(line: string): Option.Option<RefTarget> {
  return Option.flatMap(lineKey(line), (key) => {
    const parts = keyPattern.exec(key)?.groups;
    const role = parts?.["role"];
    const ref = refPattern.exec(parts?.["attributes"] ?? "")?.groups?.["ref"];

    if (role === undefined || ref === undefined) return Option.none();

    const quotedName = parts?.["name"];
    const name = quotedName === undefined ? Option.some("") : decodeName(quotedName);

    return Option.map(name, (decoded) => ({ ref, role, name: decoded }));
  });
}

/**
Every element with a ref in an `ariaSnapshot({ mode: "ai" })` snapshot, by ref. A line the cap cut short,
or one without a ref (text, `/url`, options), names no element.
*/
export function snapshotRefs(snapshot: string): ReadonlyMap<string, RefTarget> {
  return new Map(
    snapshot
      .split("\n")
      .flatMap((line) => Option.toArray(lineTarget(line)))
      .map((target) => [target.ref, target] as const),
  );
}

/** The first element in `snapshot` with this role and name, such as the search box a test means. */
export function findRef(
  snapshot: string,
  element: Omit<RefTarget, "ref">,
): Option.Option<RefTarget> {
  return Option.fromNullishOr(
    [...snapshotRefs(snapshot).values()].find(
      ({ role, name }) => role === element.role && name === element.name,
    ),
  );
}
