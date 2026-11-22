-- Mark historical passed versions as notified so enabling pass DMs does not retroactively alert owners.
UPDATE agent_versions SET notified = 1 WHERE smoke_status = 'passed' AND notified = 0;
