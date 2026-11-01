import { posix } from "node:path";
import { fileName } from "@aobot/domain";

/**
A file a Bot or a person names, as the rules E2 brings will see it: `file.path` as it was asked for,
`file.name` and `file.extension`, lower-cased and without its dot. The audit row and the span carry the
same three, never what the file holds.
*/
export interface FileTarget {
  readonly path: string;
  readonly name: string;
  readonly extension: string;
}

/** The {@link FileTarget} of `path`, a path inside the workspace. */
export function fileTarget(path: string): FileTarget {
  const name = fileName(path);

  return { path, name, extension: posix.extname(name).slice(1).toLowerCase() };
}
