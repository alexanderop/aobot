import { Option, Schema } from "effect";
import type { SnapshotElement } from "./computer.ts";

/**
An element line's key, such as `button "Search" [ref=e12]`: a role, its name as a JSON string, then
attributes in brackets.
*/
const keyPattern =
  /^(?<role>[a-z]+)(?: (?<name>"(?:[^"\\]|\\.)*"))?(?<attributes>(?: \[[^\]]*\])*)$/u;

const refPattern = / \[ref=(?<ref>[^\]]+)\]/u;

const decodeName = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));

/**
One `- ` line, split where its key ends: the indent and dash before it, the key as written and as read,
and what follows it, such as `: Ada` for a field's value or `:` before its children.
*/
interface ItemLine {
  readonly head: string;
  readonly written: string;
  readonly key: string;
  readonly rest: string;
}

/**
One `- ` line, split at its key. Playwright writes the key as YAML: in single quotes, with `''` for a quote,
when it would otherwise read as something else, such as a name holding `: `. Unquoted, it ends at the
first `:` before a space or the end of the line, where the element's value or children begin.
*/
function itemLine(line: string): Option.Option<ItemLine> {
  const parts = /^(?<head>\s*- )(?<item>.*)$/u.exec(line)?.groups;
  const head = parts?.["head"];
  const item = parts?.["item"];

  if (head === undefined || item === undefined) return Option.none();

  if (!item.startsWith("'")) {
    const written = item.split(/:(?:\s|$)/u, 1)[0] ?? "";

    return Option.some({ head, written, key: written, rest: item.slice(written.length) });
  }

  return Option.map(Option.fromNullishOr(/^'(?<quoted>(?:[^']|'')*)'/u.exec(item)), (quoted) => ({
    head,
    written: quoted[0],
    key: (quoted.groups?.["quoted"] ?? "").replaceAll("''", "'"),
    rest: item.slice(quoted[0].length),
  }));
}

function itemTarget({ key }: ItemLine): Option.Option<SnapshotElement> {
  const parts = keyPattern.exec(key)?.groups;
  const role = parts?.["role"];
  const ref = refPattern.exec(parts?.["attributes"] ?? "")?.groups?.["ref"];

  if (role === undefined || ref === undefined) return Option.none();

  const quotedName = parts?.["name"];
  const name = quotedName === undefined ? Option.some("") : decodeName(quotedName);

  return Option.map(name, (decoded) => ({ ref, role, name: decoded }));
}

/**
Every element with a ref in an `ariaSnapshot({ mode: "ai" })` snapshot, by ref. A line the cap cut short,
or one without a ref (text, `/url`, options), names no element.
*/
export function snapshotRefs(snapshot: string): ReadonlyMap<string, SnapshotElement> {
  return new Map(
    snapshot
      .split("\n")
      .flatMap((line) => Option.toArray(Option.flatMap(itemLine(line), itemTarget)))
      .map((target) => [target.ref, target] as const),
  );
}

/** What a field shows in place of a value it must not show: that it holds one, never what. */
export const hiddenValue = "[hidden]";

/** The roles whose value in a snapshot is what somebody typed, not text of the page. */
const typedRoles: ReadonlySet<string> = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

/** A field someone types into, and the line that shows its value. */
interface FilledField {
  readonly element: SnapshotElement;
  readonly item: ItemLine;
}

/** The field a line names, when it is one someone types into and the line shows its value. */
function filledField(line: string): Option.Option<FilledField> {
  return Option.flatMap(
    Option.filter(itemLine(line), ({ rest }) => rest.startsWith(": ") && rest.length > 2),
    (item) =>
      Option.filter(
        Option.map(itemTarget(item), (element) => ({ element, item })),
        ({ element }) => typedRoles.has(element.role),
      ),
  );
}

/** Every field in `snapshot` that shows what was typed into it, such as `textbox "Name" [ref=e5]: Ada`. */
export function filledFields(snapshot: string): ReadonlyArray<SnapshotElement> {
  return snapshot
    .split("\n")
    .flatMap((line) => Option.toArray(Option.map(filledField(line), ({ element }) => element)));
}

/** `snapshot` with the value of every filled field whose ref `hidden` names shown as {@link hiddenValue}. */
export function hideValues(snapshot: string, hidden: (ref: string) => boolean): string {
  return snapshot
    .split("\n")
    .map((line) =>
      Option.match(
        Option.filter(filledField(line), ({ element }) => hidden(element.ref)),
        {
          onNone: () => line,
          onSome: ({ item }) => `${item.head}${item.written}: ${JSON.stringify(hiddenValue)}`,
        },
      ),
    )
    .join("\n");
}

/** The first element in `snapshot` with this role and name, such as the search box a test means. */
export function findRef(
  snapshot: string,
  element: Omit<SnapshotElement, "ref">,
): Option.Option<SnapshotElement> {
  return Option.fromNullishOr(
    [...snapshotRefs(snapshot).values()].find(
      ({ role, name }) => role === element.role && name === element.name,
    ),
  );
}
