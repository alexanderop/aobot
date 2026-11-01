/** Where the page downloads the file at `path` in the Bot's workspace from, and uploads one to. */
export function fileHref(path: string): string {
  return `/files?path=${encodeURIComponent(path)}`;
}
