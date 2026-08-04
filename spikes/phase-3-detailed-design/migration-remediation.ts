import { Database } from "bun:sqlite";

const db = new Database(":memory:", { strict: true });
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE revision (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('file','entity','composite'))
  );
  CREATE TABLE job (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    result TEXT
  );
  INSERT INTO revision(project_id, kind) VALUES ('p1', 'file');
  INSERT INTO job(id, project_id, type, status, result)
    VALUES ('j1', 'p1', 'snapshot', 'running', NULL);
`);

db.exec(`
  ALTER TABLE revision ADD COLUMN advances_source INTEGER NOT NULL DEFAULT 1
    CHECK (advances_source IN (0, 1));
  CREATE INDEX idx_revision_source ON revision(project_id, advances_source, id DESC);
`);

db.transaction(() => {
  db.exec(`
    CREATE TABLE __new_job (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','running','succeeded','partial','failed','cancelled')),
      result TEXT,
      cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_pending IN (0, 1)),
      warnings_json TEXT CHECK (warnings_json IS NULL OR json_valid(warnings_json))
    );
    INSERT INTO __new_job(id, project_id, type, status, result)
      SELECT id, project_id, type, status, result FROM job;
    DROP TABLE job;
    ALTER TABLE __new_job RENAME TO job;
    CREATE INDEX idx_job_cleanup ON job(cleanup_pending) WHERE cleanup_pending = 1;
  `);
})();

db.exec(`UPDATE job
  SET status = 'partial', result = '{"missingSceneIds":["scene-3"]}', warnings_json = '[]'
  WHERE id = 'j1'`);

const rejected = (statement: string) => {
  try { db.exec(statement); return false; }
  catch { return true; }
};

console.log(JSON.stringify({
  question: "Does the corrected migration preserve old rows while enforcing partial/boolean/JSON contracts?",
  oldRevision: db.query("SELECT advances_source FROM revision WHERE id=1").get(),
  migratedJob: db.query("SELECT status, cleanup_pending, warnings_json FROM job WHERE id='j1'").get(),
  rejectsInvalidRevisionImpact: rejected("INSERT INTO revision(project_id,kind,advances_source) VALUES ('p1','file',7)"),
  rejectsInvalidCleanupFlag: rejected("UPDATE job SET cleanup_pending=7 WHERE id='j1'"),
  rejectsInvalidWarningsJson: rejected("UPDATE job SET warnings_json='{bad' WHERE id='j1'"),
}, null, 2));

