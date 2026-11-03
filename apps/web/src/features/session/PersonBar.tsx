import { type Person, SessionState } from "@aobot/domain";
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

/** The bottom of the sidebar: who the page is open for, and signing out. */
export function PersonBar(props: { readonly session: SessionState }) {
  return SessionState.match(props.session, {
    SignedIn: ({ person }) => <SignedInAs person={person} />,
    SingleUser: () => (
      <div className="person-bar">
        <span className="person-bar__email">Single-user mode</span>
      </div>
    ),
    SignedOut: () => null,
  });
}
