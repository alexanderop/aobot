import type { Person, SessionState } from "@aobot/domain";
import { Match } from "effect";
import "./session.css";

/** The person's initial in a round avatar, and their name and address. */
function SignedInAs(props: { readonly person: Person }) {
  const { person } = props;

  return (
    <div className="person-bar">
      <span className="person-bar__avatar" aria-hidden="true">
        {person.name.slice(0, 1).toUpperCase()}
      </span>
      <span className="person-bar__who">
        <span className="person-bar__name">{person.name}</span>
        <span className="person-bar__email">{person.email}</span>
      </span>
      <form method="post" action="/auth/sign-out">
        <button className="person-bar__sign-out" type="submit">
          Sign out
        </button>
      </form>
    </div>
  );
}

/** A session the page is open in: a signed-in person's, or the one person's in single-user mode. */
export type OpenSession = Exclude<SessionState, { readonly _tag: "SignedOut" }>;

/** The bottom of the sidebar: who the page is open for, and signing out. */
export function PersonBar(props: { readonly session: OpenSession }) {
  return Match.valueTags(props.session, {
    SignedIn: ({ person }) => <SignedInAs person={person} />,
    SingleUser: () => (
      <div className="person-bar">
        <span className="person-bar__email">Single-user mode</span>
      </div>
    ),
  });
}
