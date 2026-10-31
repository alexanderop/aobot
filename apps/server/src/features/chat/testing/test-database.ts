import { PgliteClient } from "@effect/sql-pglite";
import { Layer } from "effect";
import { migrateChat } from "../migrations.ts";

/** A fresh in-process Postgres (PGlite) with the chat tables, one per test. */
export const testDatabase = Layer.effectDiscard(migrateChat).pipe(
  Layer.provideMerge(PgliteClient.layer({})),
  Layer.fresh,
);
