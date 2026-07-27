/** Propagates canonical calendar blocks and releases to connected channels. */

import { createHash } from 'node:crypto';

import { resolveAdapter, type AdapterMap } from '../channels/registry.ts';
import { MissingCredentialError, redact } from '../channels/credentials.ts';
import type { AvailabilityOutcome } from '../channels/contract.ts';
import { channelConfig, resolveMaxAttempts } from '../config/channels.ts';
import * as calendarRepo from '../db/calendar-repo.ts';
import type { Db } from '../db/index.ts';
import * as repo from '../db/repo.ts';
import { aggregateStatus } from '../domain/propagation.ts';
import type {
  AggregateStatus,
  AvailabilityOperation,
  AvailabilityRecord,
  AvailabilitySyncAttempt,
  CalendarDate,
  ChannelConnection,
  ChannelKey,
} from '../domain/types.ts';

export interface CalendarSyncOptions {
  adapters?: AdapterMap;
  env?: NodeJS.ProcessEnv;
  retryDelayMs?: number;
}

export interface CalendarSyncResult {
  syncId: string | null;
  aggregateStatus: AggregateStatus;
  attempts: AvailabilitySyncAttempt[];
  convergedChannels: ChannelKey[];
}

function keyFor(
  record: AvailabilityRecord,
  operation: AvailabilityOperation,
  nights: readonly CalendarDate[],
): string {
  return createHash('sha256')
    .update(
      [
        record.tenantId,
        record.propertyId,
        record.source,
        record.externalRecordId,
        operation,
        [...nights].sort().join(','),
      ].join('\0'),
    )
    .digest('hex')
    .slice(0, 40);
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

async function submit(
  connection: ChannelConnection,
  input: {
    record: AvailabilityRecord;
    operation: AvailabilityOperation;
    nights: CalendarDate[];
    idempotencyKey: string;
    adapters: AdapterMap;
    env: NodeJS.ProcessEnv;
    retryDelayMs: number;
  },
): Promise<{ outcome: AvailabilityOutcome; attemptsMade: number }> {
  const config = channelConfig(connection.channel);
  if (!config.supportsAvailabilityWrite) {
    return {
      attemptsMade: 0,
      outcome: {
        status: 'rejected',
        reason: `${config.label} does not support this calendar write.`,
        reasonCode: 'unsupported_operation',
        mappedBookingType: null,
        confirmedNights: [],
        latencyMs: 0,
        retryable: false,
      },
    };
  }

  const adapter = resolveAdapter(connection.channel, input.adapters);
  const maxAttempts = resolveMaxAttempts(config, input.env);
  let outcome: AvailabilityOutcome | null = null;
  let attemptsMade = 0;
  while (attemptsMade < maxAttempts) {
    attemptsMade += 1;
    try {
      outcome = await adapter.submitUnavailability({
        tenantId: input.record.tenantId,
        propertyId: input.record.propertyId,
        channel: connection.channel,
        externalListingId: connection.externalListingId,
        nights: input.nights,
        bookingType:
          input.operation === 'release'
            ? config.availableBookingType
            : config.confirmedBookingType,
        sourceBookingRef: `${input.record.source}:${input.record.externalRecordId}`,
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
      });
    } catch (error) {
      if (error instanceof MissingCredentialError) {
        outcome = {
          status: 'failed',
          reason: `${config.label} is connected but ${error.envVar} is not configured.`,
          reasonCode: 'missing_credential',
          mappedBookingType: null,
          confirmedNights: [],
          latencyMs: 0,
          retryable: false,
        };
      } else {
        outcome = {
          status: 'failed',
          reason: redact(error instanceof Error ? error.message : String(error), input.env),
          reasonCode: 'adapter_error',
          mappedBookingType: null,
          confirmedNights: [],
          latencyMs: 0,
          retryable: true,
        };
      }
    }
    if (outcome.status === 'succeeded' || !outcome.retryable) break;
    if (attemptsMade < maxAttempts) await sleep(input.retryDelayMs);
  }
  return {
    attemptsMade,
    outcome:
      outcome ?? {
        status: 'failed',
        reason: `${config.label} produced no outcome.`,
        reasonCode: 'no_outcome',
        mappedBookingType: null,
        confirmedNights: [],
        latencyMs: 0,
        retryable: true,
      },
  };
}

export async function syncAvailabilityChange(
  db: Db,
  record: AvailabilityRecord,
  operation: AvailabilityOperation,
  nights: CalendarDate[],
  options: CalendarSyncOptions = {},
): Promise<CalendarSyncResult> {
  repo.requireProperty(db, record.tenantId, record.propertyId);
  const idempotencyKey = keyFor(record, operation, nights);
  const { sync } = calendarRepo.upsertAvailabilitySync(db, {
    tenantId: record.tenantId,
    propertyId: record.propertyId,
    availabilityRecordId: record.id,
    operation,
    idempotencyKey,
    nights,
  });
  const connections = repo.listConnections(db, record.tenantId, record.propertyId, {
    enabledOnly: true,
  });
  if (connections.length === 0) {
    calendarRepo.updateSyncAggregate(db, record.tenantId, sync.id, 'no_targets');
    return {
      syncId: sync.id,
      aggregateStatus: 'no_targets',
      attempts: [],
      convergedChannels: [],
    };
  }

  const existing = new Map(
    calendarRepo
      .listSyncAttempts(db, record.tenantId, sync.id)
      .map((attempt) => [attempt.channel, attempt]),
  );
  const convergedChannels: ChannelKey[] = [];
  for (const connection of connections) {
    const prior = existing.get(connection.channel);
    if (prior?.status === 'succeeded') {
      convergedChannels.push(connection.channel);
      continue;
    }
    calendarRepo.upsertSyncAttempt(db, {
      syncId: sync.id,
      tenantId: record.tenantId,
      propertyId: record.propertyId,
      channel: connection.channel,
      status: 'pending',
    });
  }

  for (const connection of connections) {
    if (convergedChannels.includes(connection.channel)) continue;
    const { outcome, attemptsMade } = await submit(connection, {
      record,
      operation,
      nights,
      idempotencyKey,
      adapters: options.adapters ?? {},
      env: options.env ?? process.env,
      retryDelayMs: options.retryDelayMs ?? 250,
    });
    calendarRepo.upsertSyncAttempt(db, {
      syncId: sync.id,
      tenantId: record.tenantId,
      propertyId: record.propertyId,
      channel: connection.channel,
      status: outcome.status,
      reason: outcome.reason,
      reasonCode: outcome.reasonCode,
      incrementAttemptsBy: attemptsMade,
    });
    calendarRepo.updateConnectionSyncState(db, {
      tenantId: record.tenantId,
      propertyId: record.propertyId,
      channel: connection.channel,
      status: outcome.status,
      error: outcome.reason,
    });
  }

  const attempts = calendarRepo.listSyncAttempts(db, record.tenantId, sync.id);
  const status = aggregateStatus(
    attempts.map((attempt) => ({
      ...attempt,
      propagationId: sync.id,
      submittedNights: nights,
      mappedBookingType: null,
      firstAttemptedAt: attempt.lastAttemptAt,
      lastAttemptedAt: attempt.lastAttemptAt,
      acceptedAt: attempt.succeededAt,
      latencyMs: null,
    })),
  );
  calendarRepo.updateSyncAggregate(db, record.tenantId, sync.id, status);
  return { syncId: sync.id, aggregateStatus: status, attempts, convergedChannels };
}
