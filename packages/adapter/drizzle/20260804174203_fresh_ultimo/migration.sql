ALTER TABLE `job` ADD `termination_proof_json` text
  CONSTRAINT `ck_job_termination_proof_json`
  CHECK (`termination_proof_json` IS NULL OR json_valid(`termination_proof_json`));
