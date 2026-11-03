import { Option } from "effect";
import "./session.css";
import { refusalOf, signInHref } from "./session.ts";

/** What a signed-out page shows: one way in, and why the last sign-in was refused, if it was. */
export function SignInScreen() {
  const refusal = refusalOf(window.location.search);

  return (
    <main className="sign-in">
      <h1 className="sign-in__name">aobot</h1>
      <p className="sign-in__lead">Your coworkers who happen to be Bots.</p>
      <a className="sign-in__button" href={signInHref(new URL(window.location.href))}>
        Sign in with your company account
      </a>
      {Option.match(refusal, {
        onNone: () => null,
        onSome: (words) => (
          <p className="sign-in__refusal" role="alert">
            {words}
          </p>
        ),
      })}
    </main>
  );
}
