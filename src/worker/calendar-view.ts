/** Tenant/property-scoped read model for the unified calendar. */

import { CHANNEL_CONFIG } from '../config/channels.ts';
import * as calendarRepo from '../db/calendar-repo.ts';
import type { Db } from '../db/index.ts';
import * as repo from '../db/repo.ts';
import type {
  AvailabilityRecord,
  AvailabilitySync,
  AvailabilitySyncAttempt,
  ChannelConnection,
  Property,
} from '../domain/types.ts';

const FRESHNESS_TARGET_MS = 5 * 60_000;

export interface CalendarRecordView {
  record: AvailabilityRecord;
  sourceLabel: string;
  latestSync: AvailabilitySync | null;
  attempts: AvailabilitySyncAttempt[];
}

export interface CalendarConnectionView {
  connection: ChannelConnection;
  channelLabel: string;
  colorToken: string;
  freshness: 'fresh' | 'stale' | 'pending';
}

export interface CalendarViewModel {
  property: Property;
  records: CalendarRecordView[];
  connections: CalendarConnectionView[];
  activeCount: number;
  conflictCount: number;
  lastUpdatedAt: string | null;
}

function connectionFreshness(
  connection: ChannelConnection,
  now: Date,
): CalendarConnectionView['freshness'] {
  if (!connection.lastAttemptAt) return 'pending';
  if (connection.syncStatus !== 'succeeded' || !connection.lastSuccessfulSyncAt) return 'stale';
  return now.getTime() - new Date(connection.lastSuccessfulSyncAt).getTime() > FRESHNESS_TARGET_MS
    ? 'stale'
    : 'fresh';
}

export function buildCalendarView(
  db: Db,
  tenantId: string,
  propertyId: string,
  now = new Date(),
): CalendarViewModel {
  const property = repo.requireProperty(db, tenantId, propertyId);
  const records = calendarRepo.listAvailabilityRecords(db, tenantId, propertyId);
  const connections = repo.listConnections(db, tenantId, propertyId);
  return {
    property,
    records: records.map((record) => {
      const latest = calendarRepo.latestSyncForRecord(db, tenantId, propertyId, record.id);
      return {
        record,
        sourceLabel:
          record.source === 'owner' ? 'Owner' : CHANNEL_CONFIG[record.source].label,
        latestSync: latest?.sync ?? null,
        attempts: latest?.attempts ?? [],
      };
    }),
    connections: connections.map((connection) => ({
      connection,
      channelLabel: CHANNEL_CONFIG[connection.channel].label,
      colorToken: CHANNEL_CONFIG[connection.channel].colorToken,
      freshness: connectionFreshness(connection, now),
    })),
    activeCount: records.filter((record) => record.lifecycleState === 'active').length,
    conflictCount: records.filter((record) => record.lifecycleState === 'conflict').length,
    lastUpdatedAt:
      records.length === 0
        ? null
        : records.reduce((latest, record) =>
            record.updatedAt > latest ? record.updatedAt : latest,
          records[0]!.updatedAt),
  };
}
