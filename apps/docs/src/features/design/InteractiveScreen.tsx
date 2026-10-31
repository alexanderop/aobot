import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { ComposerStage } from "./ComposerStage.tsx";
import type { InteractiveName } from "./screens.ts";

function FocusedComposer() {
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    stage.current?.querySelector("textarea")?.focus({ preventScroll: true });
  }, []);

  return (
    <div ref={stage}>
      <ComposerStage disabled={false} isRunning={false} />
    </div>
  );
}

const interactiveScreens: Record<InteractiveName, () => ReactNode> = {
  "composer-idle": () => <ComposerStage disabled={false} isRunning={false} />,
  "composer-focused": () => <FocusedComposer />,
};

/** A screen that hydrates, so the reader can type into it. Only these ship script to the page. */
export function InteractiveScreen(props: { readonly name: InteractiveName }) {
  return interactiveScreens[props.name]();
}
