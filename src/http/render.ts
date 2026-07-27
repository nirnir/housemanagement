/**
 * HTML rendering for the propagation status surface.
 *
 * Uses the workspace design-system vocabulary only: `layout`, `side`, `brand`,
 * `cwrap`, `wrap`, `block`, `bar`, `eyebrow`, `title`, `h`, `hh`, `lede`,
 * `note`, `mono`, `cardgrid`, `spec`, `two`, `stack`, `legend`, `toneset`,
 * `tone`, `swset`, `sw`, `heights`, `sub`.
 *
 * The presentation rule that matters: a channel's tile shows that channel's own
 * outcome, and the aggregate badge is rendered from `aggregateStatus` — so a
 * page can never show "all channels updated" while a tile below it reads failed.
 */

import { CHANNEL_CONFIG } from '../config/channels.ts';
import type { CalendarViewModel } from '../worker/calendar-view.ts';
import type { PropagationViewModel } from '../worker/view.ts';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/assets/design-system.css">
</head>
<body>
<div class="layout">
  <nav class="side">
    <div class="brand">Unified calendar</div>
    <div class="stack">
      <a href="/">Calendar</a>
      <a href="/propagations">Propagations</a>
      <a href="/channels">Channels</a>
      <form method="post" action="/signout"><button type="submit">Sign out</button></form>
    </div>
  </nav>
  <div class="cwrap">
    <main class="wrap">
${body}
    </main>
  </div>
</div>
</body>
</html>`;
}

function calendarSyncBadge(record: CalendarViewModel['records'][number]): string {
  if (record.record.lifecycleState === 'conflict') {
    return '<span class="tone" data-status="rejected">Conflict — not propagated</span>';
  }
  if (!record.latestSync) return '<span class="tone" data-status="pending">No sync operation</span>';
  return `<span class="tone" data-aggregate="${record.latestSync.aggregateStatus}">${escapeHtml(
    record.latestSync.aggregateStatus.replace('_', ' '),
  )}</span>`;
}

export function renderCalendar(view: CalendarViewModel): string {
  const channelCards =
    view.connections.length === 0
      ? '<div class="note" data-tone="warn">No channels are connected for this property.</div>'
      : view.connections
          .map(({ connection, channelLabel, colorToken, freshness }) => {
            const tone = freshness === 'fresh' ? 'good' : freshness === 'stale' ? 'bad' : 'warn';
            const lastSuccess = connection.lastSuccessfulSyncAt
              ? escapeHtml(connection.lastSuccessfulSyncAt)
              : 'Never';
            return `<article class="spec" style="--channel-color: var(${colorToken})">
  <p class="hh"><span class="sw" style="--channel-color: var(${colorToken})">${escapeHtml(channelLabel)}</span></p>
  <div class="toneset"><span class="tone" data-status="${escapeHtml(connection.syncStatus ?? 'pending')}">${escapeHtml(freshness)}</span></div>
  <dl>
    <dt>Last successful sync</dt><dd class="mono">${lastSuccess}</dd>
    <dt>Last attempt</dt><dd class="mono">${escapeHtml(connection.lastAttemptAt ?? 'Never')}</dd>
  </dl>
  ${
    connection.lastSyncError
      ? `<div class="note" data-tone="${tone}">${escapeHtml(connection.lastSyncError)}</div>`
      : ''
  }
</article>`;
          })
          .join('\n');

  const recordCards =
    view.records.length === 0
      ? `<div class="note">No calendar records yet. Connected channels remain shown above; an empty calendar does not mean no channels are connected.</div>`
      : view.records
          .map(({ record, sourceLabel, attempts, ...sync }) => {
            const attemptChips = attempts
              .map(
                (attempt) =>
                  `<span class="tone" data-status="${attempt.status}">${escapeHtml(
                    CHANNEL_CONFIG[attempt.channel].label,
                  )}: ${escapeHtml(attempt.status)}</span>`,
              )
              .join('');
            const retry =
              sync.latestSync && attempts.some((attempt) => attempt.status !== 'succeeded')
                ? `<form method="post" action="/calendar/${encodeURIComponent(
                    record.propertyId,
                  )}/records/${encodeURIComponent(record.id)}/retry">
  <button type="submit">Retry failed channels</button>
</form>`
                : '';
            const stateTone =
              record.lifecycleState === 'conflict'
                ? 'bad'
                : record.lifecycleState === 'cancelled'
                  ? 'warn'
                  : 'good';
            return `<article class="spec" data-record-id="${escapeHtml(record.id)}">
  <div class="bar">
    <div>
      <p class="eyebrow">${escapeHtml(sourceLabel)} · ${escapeHtml(record.recordKind.replace('_', ' '))}</p>
      <p class="hh">${escapeHtml(record.checkIn)} → ${escapeHtml(record.checkOut)}</p>
    </div>
    <span class="tone" data-status="${escapeHtml(record.lifecycleState)}">${escapeHtml(record.lifecycleState)}</span>
  </div>
  <dl>
    <dt>Provider reference</dt><dd class="mono">${escapeHtml(record.externalRecordId)}</dd>
    <dt>Provider event</dt><dd class="mono">${escapeHtml(record.providerEventId)}</dd>
    <dt>Propagation</dt><dd>${calendarSyncBadge({ record, sourceLabel, attempts, ...sync })}</dd>
  </dl>
  ${
    record.lifecycleState === 'conflict'
      ? `<div class="note" data-tone="${stateTone}">Overlaps record <span class="mono">${escapeHtml(
          record.conflictWithId ?? 'unknown',
        )}</span>. The incoming occupancy was retained for review and was not propagated.</div>`
      : ''
  }
  ${attemptChips ? `<div class="toneset">${attemptChips}</div>` : ''}
  ${retry}
</article>`;
          })
          .join('\n');

  return page(
    `${view.property.name} · Unified calendar`,
    `      <div class="bar">
        <div>
          <p class="eyebrow">Property availability</p>
          <h1 class="title">${escapeHtml(view.property.name)}</h1>
          <p class="lede">One chronological view across short-term rentals, home exchange, holds and owner blocks.</p>
        </div>
        <div class="toneset">
          <span class="tone" data-status="succeeded">${view.activeCount} active</span>
          ${
            view.conflictCount > 0
              ? `<span class="tone" data-status="rejected">${view.conflictCount} conflict${view.conflictCount === 1 ? '' : 's'}</span>`
              : ''
          }
        </div>
      </div>

      <div class="block">
        <h2 class="h">Channel synchronization</h2>
        <div class="cardgrid">${channelCards}</div>
      </div>

      <div class="block">
        <h2 class="h">Calendar</h2>
        <p class="sub">Checkout and next check-in may share a date; occupied intervals use check-in inclusive and checkout exclusive semantics.</p>
        <div class="cardgrid">${recordCards}</div>
      </div>

      <div class="block">
        <div class="legend">
          <span>Property <span class="mono">${escapeHtml(view.property.id)}</span></span>
          <span>Timezone <span class="mono">${escapeHtml(view.property.timezone)}</span></span>
          <span>Last canonical change <span class="mono">${escapeHtml(view.lastUpdatedAt ?? 'None')}</span></span>
        </div>
      </div>`,
  );
}

export function renderSignIn(error?: string): string {
  return page(
    'Sign in · Availability',
    `      <div class="block">
        <p class="eyebrow">Availability propagation</p>
        <h1 class="title">Sign in</h1>
        <p class="lede">Propagation status is scoped to a tenant. Present your API key to establish that scope.</p>
        ${error ? `<div class="note" data-tone="bad">${escapeHtml(error)}</div>` : ''}
        <form class="stack" method="post" action="/signin">
          <div>
            <label for="apiKey">API key</label>
            <input id="apiKey" name="apiKey" type="password" autocomplete="off" required>
          </div>
          <div><button type="submit">Continue</button></div>
        </form>
      </div>`,
  );
}

function toneBadge(view: PropagationViewModel): string {
  return `<span class="tone" data-aggregate="${view.aggregateStatus}">${escapeHtml(view.aggregateLabel)}</span>`;
}

function nightsHtml(nights: readonly string[]): string {
  if (nights.length === 0) return '<p class="sub">No nights derived.</p>';
  return `<div class="heights">${nights
    .map((n) => `<span class="mono">${escapeHtml(n)}</span>`)
    .join('')}</div>`;
}

/** The banner that keeps a partial or stale result from reading as a success. */
function aggregateNote(view: PropagationViewModel): string {
  if (view.aggregateStatus === 'complete') {
    return `<div class="note" data-tone="good">Every connected channel accepted the mapped unavailable dates.</div>`;
  }
  if (view.aggregateStatus === 'no_targets') {
    return `<div class="note" data-tone="warn">No enabled channel connections exist for this property, so nothing was propagated. This is not a cross-channel success.</div>`;
  }
  const failing = view.attempts.filter((a) => a.status !== 'succeeded');
  const names = failing.map((a) => a.channelLabel).join(', ');
  const tone = view.aggregateStatus === 'failed' ? 'bad' : 'warn';
  const lead =
    view.aggregateStatus === 'failed'
      ? 'No channel has accepted this update.'
      : `Partially updated — ${escapeHtml(names)} ${failing.length === 1 ? 'has' : 'have'} not accepted the update.`;
  return `<div class="note" data-tone="${tone}">${lead} Availability on ${
    failing.length === 1 ? 'that channel' : 'those channels'
  } is stale and the double-booking risk remains.</div>`;
}

function attemptCard(attempt: PropagationViewModel['attempts'][number]): string {
  const rows: string[] = [
    `<dt>Status</dt><dd><span class="tone" data-status="${attempt.status}">${escapeHtml(attempt.statusLabel)}</span></dd>`,
    `<dt>Nights</dt><dd>${attempt.submittedNights.length}</dd>`,
    `<dt>Required</dt><dd>${attempt.required ? 'Yes' : 'No'}</dd>`,
    `<dt>Attempts</dt><dd>${attempt.attemptCount}</dd>`,
  ];
  if (attempt.mappedBookingType) {
    rows.push(`<dt>Mapped as</dt><dd><span class="mono">${escapeHtml(attempt.mappedBookingType)}</span></dd>`);
  }
  if (attempt.latencyMs !== null) {
    rows.push(`<dt>Latency</dt><dd>${attempt.latencyMs}ms</dd>`);
  }
  if (attempt.reasonCode) {
    rows.push(`<dt>Reason code</dt><dd><span class="mono">${escapeHtml(attempt.reasonCode)}</span></dd>`);
  }

  const reason = attempt.reason
    ? `<div class="note" data-tone="${attempt.status === 'delayed' ? 'warn' : 'bad'}">${escapeHtml(attempt.reason)}</div>`
    : '';

  const sync = `<p class="sub">${escapeHtml(attempt.sync.description)}</p>`;

  return `<article class="spec" style="--channel-color: var(${attempt.colorToken})">
  <p class="hh"><span class="sw" style="--channel-color: var(${attempt.colorToken})">${escapeHtml(attempt.channelLabel)}</span></p>
  <dl>${rows.join('')}</dl>
  ${reason}
  ${sync}
  ${nightsHtml(attempt.submittedNights)}
</article>`;
}

function unattemptedCard(entry: PropagationViewModel['unattemptedChannels'][number]): string {
  return `<article class="spec">
  <p class="hh">${escapeHtml(entry.channelLabel)}</p>
  <dl><dt>Status</dt><dd><span class="tone" data-status="not_connected">Not attempted</span></dd></dl>
  <p class="sub">${escapeHtml(entry.reason)}</p>
</article>`;
}

export function renderDetail(view: PropagationViewModel): string {
  const { booking, property, propagation } = view;

  const body = `      <div class="bar">
        <div>
          <p class="eyebrow">Propagation</p>
          <h1 class="title">${escapeHtml(property.name)}</h1>
          <p class="sub">${escapeHtml(booking.checkIn)} → ${escapeHtml(booking.checkOut)} · from ${escapeHtml(
            CHANNEL_CONFIG[booking.sourceChannel].label,
          )} · booking <span class="mono">${escapeHtml(booking.externalBookingId)}</span></p>
        </div>
        <div class="toneset">${toneBadge(view)}</div>
      </div>

      <div class="block">
        ${aggregateNote(view)}
      </div>

      <div class="block">
        <h2 class="h">Derived unavailable nights</h2>
        <p class="sub">Check-in through the night before checkout. ${escapeHtml(
          booking.checkOut,
        )} stays bookable for a same-day arrival.</p>
        ${nightsHtml(propagation.derivedNights)}
      </div>

      <div class="block">
        <h2 class="h">Per-channel result</h2>
        <div class="cardgrid">
          ${view.attempts.map(attemptCard).join('\n')}
          ${view.unattemptedChannels.map(unattemptedCard).join('\n')}
        </div>
      </div>

      <div class="block">
        <div class="legend">
          <span>Idempotency key <span class="mono">${escapeHtml(propagation.idempotencyKey)}</span></span>
          <span>Timezone <span class="mono">${escapeHtml(property.timezone)}</span></span>
          <span>Received <span class="mono">${escapeHtml(booking.receivedAt)}</span></span>
        </div>
      </div>`;

  return page(`${property.name} · Propagation`, body);
}

export function renderList(views: PropagationViewModel[]): string {
  if (views.length === 0) {
    return page(
      'Propagations · Availability',
      `      <div class="block">
        <p class="eyebrow">Availability propagation</p>
        <h1 class="title">Propagations</h1>
        <div class="note">No confirmed bookings have been propagated yet.</div>
      </div>`,
    );
  }

  const rows = views
    .map((view) => {
      const counts = view.attempts.reduce<Record<string, number>>((acc, attempt) => {
        acc[attempt.status] = (acc[attempt.status] ?? 0) + 1;
        return acc;
      }, {});
      const chips = Object.entries(counts)
        .map(([status, count]) => `<span class="tone" data-status="${status}">${count} ${escapeHtml(status)}</span>`)
        .join('');

      return `<article class="spec">
  <p class="hh"><a href="/propagations/${encodeURIComponent(view.propagation.id)}">${escapeHtml(
    view.property.name,
  )}</a></p>
  <dl>
    <dt>Stay</dt><dd>${escapeHtml(view.booking.checkIn)} → ${escapeHtml(view.booking.checkOut)}</dd>
    <dt>Source</dt><dd>${escapeHtml(CHANNEL_CONFIG[view.booking.sourceChannel].label)}</dd>
    <dt>Result</dt><dd>${toneBadge(view)}</dd>
  </dl>
  <div class="toneset" style="margin-top:12px">${chips}</div>
  ${view.anyStale ? '<p class="sub">At least one channel is stale.</p>' : ''}
</article>`;
    })
    .join('\n');

  return page(
    'Propagations · Availability',
    `      <div class="bar">
        <div>
          <p class="eyebrow">Availability propagation</p>
          <h1 class="title">Propagations</h1>
        </div>
      </div>
      <div class="block"><div class="cardgrid">${rows}</div></div>`,
  );
}

export function renderChannels(): string {
  const cards = Object.values(CHANNEL_CONFIG)
    .map(
      (config) => `<article class="spec" style="--channel-color: var(${config.colorToken})">
  <p class="hh"><span class="sw" style="--channel-color: var(${config.colorToken})">${escapeHtml(config.label)}</span></p>
  <dl>
    <dt>Checkout night</dt><dd>${config.checkoutNightPolicy === 'checkout_available' ? 'Bookable' : 'Blocked'}</dd>
    <dt>Mapped type</dt><dd><span class="mono">${escapeHtml(config.confirmedBookingType)}</span></dd>
    <dt>Timeout</dt><dd>${config.timeoutMs}ms</dd>
    <dt>Max attempts</dt><dd>${config.maxAttempts}</dd>
    <dt>Credential</dt><dd><span class="mono">${escapeHtml(config.credentialEnv)}</span></dd>
  </dl>
</article>`,
    )
    .join('\n');

  return page(
    'Channels · Availability',
    `      <div class="bar">
        <div>
          <p class="eyebrow">Configuration</p>
          <h1 class="title">Channels</h1>
          <p class="sub">Date semantics and booking-type mapping per platform.</p>
        </div>
      </div>
      <div class="block">
        <div class="note" data-tone="warn">Checkout-night policy and booking-type mapping are operator-approved assumptions pending validation against each platform's published API contract.</div>
        <div class="cardgrid">${cards}</div>
      </div>`,
  );
}

export function renderError(status: number, message: string): string {
  return page(
    `${status} · Availability`,
    `      <div class="block">
        <h1 class="title">${status}</h1>
        <div class="note" data-tone="bad">${escapeHtml(message)}</div>
        <p><a href="/">Back to propagations</a></p>
      </div>`,
  );
}
