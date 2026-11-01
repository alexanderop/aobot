import { fileName } from "@aobot/domain";
import { fileHref } from "./files.ts";

/** A file in the Bot's workspace the person can download: its name, linking to its exact bytes. */
export function FileChip(props: { readonly path: string }) {
  return (
    // The server names the saved file, so `download` asks only that it be saved, not shown.
    <a className="file-chip" href={fileHref(props.path)} download>
      <span className="file-chip__icon" aria-hidden="true" />
      <span className="file-chip__name">{fileName(props.path)}</span>
    </a>
  );
}
