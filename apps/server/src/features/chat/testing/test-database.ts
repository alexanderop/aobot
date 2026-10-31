import { SqliteClient } from "@effect/sql-sqlite-node";
import { Layer } from "effect";
import { migrateChat } from "../migrations.ts";

/** A fresh in-memory SQLite database with the chat tables, one per test. */
export const testDatabase = Layer.effectDiscard(migrateChat).pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  Layer.fresh,
);
