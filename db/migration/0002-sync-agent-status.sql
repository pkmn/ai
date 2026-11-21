-- Reconcile agents.status with per-ladder grants in agent_ladders for non-disabled agents.
UPDATE agents
SET status = CASE
  WHEN EXISTS (SELECT 1 FROM agent_ladders WHERE agent_id = agents.id) THEN 'qualified'
  ELSE 'pending'
END
WHERE status != 'disabled';
