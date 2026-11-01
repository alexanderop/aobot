import { Control } from "@aobot/domain";
import { Option } from "effect";
import type { MouseEvent, ReactNode } from "react";
import { panelOpen } from "./control-state.ts";
import { pointOnFrame } from "./point-on-frame.ts";
import "./screen.css";
import { type UseControl, useControl } from "./use-control.ts";
import { useLiveScreen } from "./use-live-screen.ts";

/**
The Bot's screen as a side panel, open as {@link panelOpen} decides, and it watches the screen only then.
Folded, it is a rail with one button to take control.
*/
export function LiveScreen(props: { readonly usesComputer: boolean }) {
  const control = useControl();
  const open = panelOpen(props.usesComputer, control.holder, control.problem);

  return (
    <aside
      className="live-screen"
      data-state={open ? "open" : "folded"}
      aria-label="The Bot's screen"
    >
      {open ? (
        <ScreenPanel control={control} />
      ) : (
        <button
          type="button"
          className="live-screen__rail-button"
          aria-label="Take control"
          title="Take control of the Bot's computer"
          disabled={control.sending}
          onClick={control.takeControl}
        >
          <PointerIcon />
        </button>
      )}
    </aside>
  );
}

function ScreenPanel({ control }: { readonly control: UseControl }) {
  const { frame } = useLiveScreen();
  const holding = Control.guards.Person(control.holder);

  const clickFrame = (event: MouseEvent<HTMLImageElement>) => {
    const image = event.currentTarget;

    const point = pointOnFrame(event.clientX, event.clientY, image.getBoundingClientRect(), {
      width: image.naturalWidth,
      height: image.naturalHeight,
    });

    if (Option.isSome(point)) control.click(point.value);
  };

  const handBack = (
    <button
      type="button"
      className="live-screen__button live-screen__button--accent"
      disabled={control.sending}
      onClick={control.handBack}
    >
      Hand back
    </button>
  );

  const bar = Control.match(control.holder, {
    Bot: (): Bar => ({
      status: "The Bot holds its computer.",
      actions: (
        <button
          type="button"
          className="live-screen__button"
          disabled={control.sending}
          onClick={control.takeControl}
        >
          Take control
        </button>
      ),
    }),
    Taking: ({ waitingFor }): Bar => ({
      status:
        waitingFor === 0
          ? "No Bot action left to wait for."
          : `Waiting for the Bot's last ${waitingFor === 1 ? "action" : `${waitingFor} actions`} to finish…`,
      actions: (
        <button type="button" className="live-screen__button" disabled>
          Taking control…
        </button>
      ),
    }),
    Person: (): Bar =>
      Option.isSome(frame)
        ? { status: "You have control. The Bot waits until you hand it back.", actions: handBack }
        : {
            // After a restart no computer runs; taking control again starts one.
            status: "You have control, but the computer is not showing a page.",
            actions: (
              <>
                <button
                  type="button"
                  className="live-screen__button"
                  disabled={control.sending}
                  onClick={control.takeControl}
                >
                  Start the computer
                </button>
                {handBack}
              </>
            ),
          },
  });

  return (
    <>
      <div className="live-screen__bar">
        <p className="live-screen__status">{bar.status}</p>
        {bar.actions}
      </div>
      {Option.match(control.problem, {
        onNone: () => null,
        onSome: (message) => (
          <p className="live-screen__problem" role="alert">
            {message}
          </p>
        ),
      })}
      <div className="live-screen__view">
        {Option.match(frame, {
          onNone: () => <p className="live-screen__waiting">Waiting for the screen…</p>,
          onSome: (src) => (
            <img
              className="live-screen__frame"
              data-control={holding ? "person" : "bot"}
              src={src}
              alt={
                holding
                  ? "The Bot's browser, live. A click here clicks there."
                  : "The Bot's browser, live"
              }
              onClick={holding ? clickFrame : undefined}
            />
          ),
        })}
      </div>
    </>
  );
}

/** What the bar above the screen says about who holds it, and the buttons that go with it. */
interface Bar {
  readonly status: string;
  readonly actions: ReactNode;
}

function PointerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M5 3l14 8-6 1.5L10 19z" fill="currentColor" />
    </svg>
  );
}
