import * as fs from 'fs';

import * as baseDb from '../../db';
import {root} from '../../static/util';

import * as counters from './ladder-counters';
import * as localAgents from './local-agents';
import * as localMatches from './local-matches';
import * as outbox from './outbox';

function defaultDbPath(): string {
  return process.env.ARENA_STATE_DB_PATH ?? (
    process.env.NODE_ENV === 'production' || fs.existsSync('/var/lib/arena')
      ? '/var/lib/arena/state.sqlite'
      : root('db', 'data', 'arena-state.sqlite')
  );
}

export const DB_PATH = defaultDbPath();
export const SCHEMA_DIR = root('arena', 'db', 'schema');
export const MIGRATION_DIR = root('arena', 'db', 'migration');
export const SCHEMA_FILES = baseDb.listSqlFiles(SCHEMA_DIR);

export class Database extends baseDb.SqliteDatabase {
  constructor(dbPath = defaultDbPath(), options: baseDb.Options = {}) {
    super(dbPath, SCHEMA_DIR, MIGRATION_DIR, options);
  }

  upsertLocalAgent(input: localAgents.UpsertLocalAgentInput) {
    localAgents.upsertLocalAgent(this.db, input);
  }

  getLocalAgent(versionId: number): localAgents.LocalAgentRow | undefined {
    return localAgents.getLocalAgent(this.db, versionId);
  }

  listLocalAgents(residency?: localAgents.ResidencyState): localAgents.LocalAgentRow[] {
    return localAgents.listLocalAgents(this.db, residency);
  }

  setAgentResidency(versionId: number, residency: localAgents.ResidencyState, now?: number) {
    localAgents.setAgentResidency(this.db, versionId, residency, now);
  }

  recordAgentGameResult(
    versionId: number,
    faulted: boolean,
    now?: number
  ): localAgents.LocalAgentRow | undefined {
    return localAgents.recordAgentGameResult(this.db, versionId, faulted, now);
  }

  totalHotUnpackedBytes(mode?: localAgents.ExecutionMode): number {
    return localAgents.totalHotUnpackedBytes(this.db, mode);
  }

  listColdEvictionCandidates(mode?: localAgents.ExecutionMode): localAgents.LocalAgentRow[] {
    return localAgents.listColdEvictionCandidates(this.db, mode);
  }

  createMatchCheckpoint(input: localMatches.CreateMatchCheckpointInput) {
    localMatches.createMatchCheckpoint(this.db, input);
  }

  checkpointGame1Complete(input: localMatches.CompleteGame1Input) {
    localMatches.checkpointGame1Complete(this.db, input);
  }

  markMatchCheckpointStatus(id: string, status: localMatches.CheckpointStatus, now?: number) {
    localMatches.markMatchCheckpointStatus(this.db, id, status, now);
  }

  getMatchCheckpoint(id: string): localMatches.LocalMatchCheckpoint | undefined {
    return localMatches.getMatchCheckpoint(this.db, id);
  }

  listIncompleteMatchCheckpoints(): localMatches.LocalMatchCheckpoint[] {
    return localMatches.listIncompleteMatchCheckpoints(this.db);
  }

  enqueueOutbox(
    endpoint: outbox.OutboxEndpoint,
    payload: outbox.OutboxPayload,
    now?: number
  ): number {
    return outbox.enqueueOutbox(this.db, endpoint, payload, now);
  }

  listOutbox(limit?: number): outbox.OutboxRow[] {
    return outbox.listOutbox(this.db, limit);
  }

  deleteOutbox(id: number) {
    outbox.deleteOutbox(this.db, id);
  }

  recordOutboxFailure(id: number, errorMessage: string, now?: number) {
    outbox.recordOutboxFailure(this.db, id, errorMessage, now);
  }

  nextMatchSequence(format: string): number {
    return counters.nextMatchSequence(this.db, this.txRunner, format);
  }

  getMatchSequence(format: string): number {
    return counters.getMatchSequence(this.db, format);
  }

  getLastGlobalMatchSequence(format: string): number {
    return counters.getLastGlobalMatchSequence(this.db, format);
  }

  getGlobalMatchCount(): number {
    return counters.getGlobalMatchCount(this.db);
  }
}

export type {AppliedMigration, Options, TransactionRunner} from '../../db';
export * from './ladder-counters';
export * from './local-agents';
export * from './local-matches';
export * from './outbox';
