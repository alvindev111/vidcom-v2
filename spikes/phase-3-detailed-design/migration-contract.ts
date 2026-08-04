import { Database } from "bun:sqlite";

const db = new Database(":memory:", { strict: true });
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
  CREATE TABLE revision (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('file','entity','composite'))
  );
  CREATE TABLE job (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued','running','succeeded','failed','cancelled'))
  );
  INSERT INTO revision(project_id, kind) VALUES ('p1', 'file');
  INSERT INTO job(id, status) VALUES ('j1', 'running');
`);

// DDL exactly matching §6.5 of Design v1.
db.exec("ALTER TABLE revision ADD COLUMN advances_source integer NOT NULL DEFAULT 1");
db.exec("ALTER TABLE job ADD COLUMN cleanup_pending integer NOT NULL DEFAULT 0");
db.exec("ALTER TABLE job ADD COLUMN warnings_json text");

const oldRevisionDefault = db.query("SELECT advances_source FROM revision WHERE id = 1").get() as { advances_source: number };

let partialStatusAccepted = true;
let partialStatusError = "";
try { db.exec("UPDATE job SET status = 'partial' WHERE id = 'j1'"); }
catch (error) { partialStatusAccepted = false; partialStatusError = String(error); }

let invalidRevisionImpactAccepted = true;
try { db.exec("INSERT INTO revision(project_id, kind, advances_source) VALUES ('p1', 'file', 7)"); }
catch { invalidRevisionImpactAccepted = false; }

let invalidWarningsJsonAccepted = true;
try { db.exec("UPDATE job SET warnings_json = '{not-json' WHERE id = 'j1'"); }
catch { invalidWarningsJsonAccepted = false; }

console.log(JSON.stringify({
  question: "Can the expand-only DDL in Design v1 enforce its stated contracts?",
  oldRevisionDefault: oldRevisionDefault.advances_source,
  partialStatusAccepted,
  partialStatusError,
  invalidRevisionImpactAccepted,
  invalidWarningsJsonAccepted,
  conclusion: "R7 partial needs a job-table rebuild (or an explicitly different public model); the ADD COLUMN statements also omit promised CHECK constraints.",
}, null, 2));

