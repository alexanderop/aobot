import { fileName } from "@aobot/domain";

/**
A file a Bot or a person names, as the rules see it: `file.path` as it was asked for, `file.name` and
`file.extension`, lower-cased and without its dot. The audit row and the span carry the same three, never
what the file holds.
*/
export interface FileTarget {
  readonly path: string;
  readonly name: string;
  readonly extension: string;
}

/**
The {@link FileTarget} of `path`, a path inside the workspace. The extension is what follows the name's
last dot, for a name that starts with one too, so a rule on `file.extension == "env"` stops `.env` as
well as `prod.env`.
*/
export function fileTarget(path: string): FileTarget {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");

  return { path, name, extension: dot === -1 ? "" : name.slice(dot + 1).toLowerCase() };
}
