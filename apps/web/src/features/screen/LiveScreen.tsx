import { Option } from "effect";
import "./screen.css";
import { useLiveScreen } from "./use-live-screen.ts";

/** The Bot's screen as a side panel, folded unless `open`. It watches only while open. */
export function LiveScreen(props: { readonly open: boolean }) {
  return (
    <aside
      className="live-screen"
      data-state={props.open ? "open" : "folded"}
      aria-label="The Bot's screen"
      aria-hidden={!props.open}
    >
      {props.open ? <ScreenImage /> : null}
    </aside>
  );
}

function ScreenImage() {
  const { frame } = useLiveScreen();

  return Option.match(frame, {
    onNone: () => <p className="live-screen__waiting">Waiting for the screen…</p>,
    onSome: (src) => <img className="live-screen__frame" src={src} alt="The Bot's browser, live" />,
  });
}
