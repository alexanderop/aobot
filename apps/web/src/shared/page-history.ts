/** What a page's state needs of the browser's address bar: its URL and its history. */
export interface History {
  readonly url: () => URL;
  readonly push: (url: URL) => void;
  /** Calls `f` each time the person goes back or forward. Answers how to stop. */
  readonly onPop: (f: () => void) => () => void;
}

/** The page's own history. */
export const pageHistory: History = {
  url: () => new URL(window.location.href),
  push: (url) => window.history.pushState(null, "", url),
  onPop: (f) => {
    window.addEventListener("popstate", f);

    return () => window.removeEventListener("popstate", f);
  },
};
