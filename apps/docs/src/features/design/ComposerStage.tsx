import { Composer } from "@aobot/web";
import "./stage.css";

const noop = () => undefined;

/** The app's composer on its own, with the side padding it has inside the conversation. */
export function ComposerStage(props: { readonly disabled: boolean; readonly isRunning: boolean }) {
  return (
    <div className="stage">
      <Composer
        botName="Fitness Coach"
        disabled={props.disabled}
        isRunning={props.isRunning}
        onSend={noop}
        onStop={noop}
      />
    </div>
  );
}
