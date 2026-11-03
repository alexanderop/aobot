import { Email } from "@aobot/domain";
import { Actor } from "../actor.ts";

/** A person signed in at the company. */
export const alice = Actor.cases.Person.make({
  email: Email.make("alice@example.com"),
  name: "Alice",
});

/** Another person signed in at the company. */
export const bob = Actor.cases.Person.make({ email: Email.make("bob@example.com"), name: "Bob" });
