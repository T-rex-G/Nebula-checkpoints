-- File reads and completed analysis are different evidence. Existing audits
-- did not retain this proof, so their analysis completeness remains unknown.
ALTER TABLE nv_code_audits ADD COLUMN analysis_complete boolean NULL;
