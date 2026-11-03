import { SqliteMigrator } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

const createBotSnapshots = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE bot_snapshots (
      bot_id text PRIMARY KEY,
      snapshot text NOT NULL,
      updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `;
});

const createBotControl = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A row means a person holds the Bot's computer; handing it back deletes the row.
  yield* sql`
    CREATE TABLE bot_control (
      bot_id text PRIMARY KEY,
      since text NOT NULL
    )
  `;
});

const shareComputerControl = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Every Bot shares the one computer, so a person holds it for all of them: one row at most.
  yield* sql`
    CREATE TABLE computer_control (
      id integer PRIMARY KEY CHECK (id = 1),
      since text NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO computer_control (id, since)
    SELECT 1, since FROM bot_control ORDER BY since LIMIT 1
  `;

  yield* sql`DROP TABLE bot_control`;
});

const shareComputerSnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Every Bot drives the one browser, so there is one latest page; read_by is the Bot whose refs name it.
  yield* sql`
    CREATE TABLE computer_snapshot (
      id integer PRIMARY KEY CHECK (id = 1),
      snapshot text NOT NULL,
      read_by text NOT NULL,
      updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `;

  yield* sql`
    INSERT INTO computer_snapshot (id, snapshot, read_by, updated_at)
    SELECT 1, snapshot, bot_id, updated_at FROM bot_snapshots ORDER BY updated_at DESC LIMIT 1
  `;

  yield* sql`DROP TABLE bot_snapshots`;
});

const keepSnapshotUrl = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The rules judge a browser action by the host of the page its ref came from. A snapshot stored
  // before this has no address, and a rule must never judge a ref on the host "", so it is forgotten:
  // no ref resolves until a Bot reads the page again.
  yield* sql`DELETE FROM computer_snapshot`;
  yield* sql`ALTER TABLE computer_snapshot ADD COLUMN url text NOT NULL DEFAULT ''`;
});

// The ledger of every question a rule put to a person. A row only moves forward, one compare-and-set
// UPDATE at a time, so an approved action is spent once and a restart can tell it was started:
// asked -> yes | no | lapsed, yes -> spent | lapsed, spent -> finished | told. No action, digest or
// typed text is kept: only the Bot, the tool and the ask rule, so a question a stopped server left open
// can be closed in the audit trail at the next start-up.
const createApprovals = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE approvals (
      id text PRIMARY KEY,
      conversation_id text NOT NULL,
      run_id text NOT NULL,
      bot_id text NOT NULL,
      tool text NOT NULL,
      rule text NOT NULL,
      state text NOT NULL
        CHECK (state IN ('asked', 'yes', 'no', 'spent', 'lapsed', 'finished', 'told')),
      updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `;

  yield* sql`CREATE INDEX approvals_by_rule ON approvals (conversation_id, rule, state)`;

  yield* sql`
    CREATE TRIGGER approvals_only_forward BEFORE UPDATE ON approvals
    WHEN NEW.id IS NOT OLD.id
      OR NEW.conversation_id IS NOT OLD.conversation_id
      OR NEW.run_id IS NOT OLD.run_id
      OR NEW.bot_id IS NOT OLD.bot_id
      OR NEW.tool IS NOT OLD.tool
      OR NEW.rule IS NOT OLD.rule
      OR NOT (
        (OLD.state = 'asked' AND NEW.state IN ('yes', 'no', 'lapsed'))
        OR (OLD.state = 'yes' AND NEW.state IN ('spent', 'lapsed'))
        OR (OLD.state = 'spent' AND NEW.state IN ('finished', 'told'))
      )
    BEGIN SELECT RAISE(ABORT, 'an approval only moves forward'); END
  `;

  yield* sql`
    CREATE TRIGGER approvals_refuse_delete BEFORE DELETE ON approvals
    BEGIN SELECT RAISE(ABORT, 'approvals cannot be deleted'); END
  `;
});

const keepSnapshotPath = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The safety list judges an element by the path of the page it is on too. A snapshot stored before
  // this has none, so it is forgotten, as in 0005: no ref resolves until a Bot reads the page again.
  yield* sql`DELETE FROM computer_snapshot`;
  yield* sql`ALTER TABLE computer_snapshot ADD COLUMN path text NOT NULL DEFAULT ''`;
});

const nameTheAsker = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Whose authority each question was asked on, so the rows that close one a stopped server left open
  // name that person. A question asked before this names no one, so it is the deployment's.
  yield* sql`ALTER TABLE approvals ADD COLUMN actor_id text NOT NULL DEFAULT 'deployment'`;
  yield* sql`DROP TRIGGER approvals_only_forward`;

  yield* sql`
    CREATE TRIGGER approvals_only_forward BEFORE UPDATE ON approvals
    WHEN NEW.id IS NOT OLD.id
      OR NEW.conversation_id IS NOT OLD.conversation_id
      OR NEW.run_id IS NOT OLD.run_id
      OR NEW.bot_id IS NOT OLD.bot_id
      OR NEW.tool IS NOT OLD.tool
      OR NEW.rule IS NOT OLD.rule
      OR NEW.actor_id IS NOT OLD.actor_id
      OR NOT (
        (OLD.state = 'asked' AND NEW.state IN ('yes', 'no', 'lapsed'))
        OR (OLD.state = 'yes' AND NEW.state IN ('spent', 'lapsed'))
        OR (OLD.state = 'spent' AND NEW.state IN ('finished', 'told'))
      )
    BEGIN SELECT RAISE(ABORT, 'an approval only moves forward'); END
  `;
});

/** Brings the gateway's tables up to date. Safe to run at every boot. */
export const migrateGateway = SqliteMigrator.run({
  table: "gateway_migrations",
  loader: SqliteMigrator.fromRecord({
    "0001_create_bot_snapshots": createBotSnapshots,
    "0002_create_bot_control": createBotControl,
    "0003_share_computer_control": shareComputerControl,
    "0004_share_computer_snapshot": shareComputerSnapshot,
    "0005_keep_snapshot_url": keepSnapshotUrl,
    "0006_create_approvals": createApprovals,
    "0007_keep_snapshot_path": keepSnapshotPath,
    "0008_name_the_asker": nameTheAsker,
  }),
});
