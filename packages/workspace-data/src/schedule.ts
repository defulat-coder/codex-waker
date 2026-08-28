export type MisfirePolicy = 'run_once' | 'skip';

export interface ScheduleBounds {
  timeZone?: string;
  startAt?: number | null;
  endAt?: number | null;
}

type CronField = { values: Set<number>; unrestricted: boolean };
type Cron = {
  minute: CronField;
  hour: CronField;
  day: CronField;
  month: CronField;
  weekday: CronField;
};

const minuteMs = 60_000;
const maximumSearchMinutes = 5 * 366 * 24 * 60;
const formatters = new Map<string, Intl.DateTimeFormat>();

export function validateTimeZone(value: string): string {
  const timeZone = value.trim();
  if (!timeZone) throw new Error('timezone is required');
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(0);
  } catch {
    throw new Error(`Invalid timezone: ${timeZone}`);
  }
  return timeZone;
}

function parseCronField(text: string, min: number, max: number, weekday = false): CronField {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const pieces = part.split('/');
    if (pieces.length > 2 || !pieces[0]) throw new Error('Invalid cron schedule');
    const base = pieces[0];
    const step = pieces[1] === undefined ? 1 : Number(pieces[1]);
    if (!Number.isInteger(step) || step <= 0 || step > max - min + 1)
      throw new Error('Invalid cron schedule');

    let first: number;
    let last: number;
    if (base === '*') {
      first = min;
      last = max;
    } else {
      const bounds = base.split('-').map(Number);
      if (
        bounds.length > 2 ||
        bounds.some((value) => !Number.isInteger(value) || value < min || value > max) ||
        (bounds.length === 2 && bounds[0]! > bounds[1]!)
      ) {
        throw new Error('Invalid cron schedule');
      }
      first = bounds[0]!;
      last = bounds.length === 2 ? bounds[1]! : pieces[1] === undefined ? first : max;
    }
    for (let value = first; value <= last; value += step)
      values.add(weekday && value === 7 ? 0 : value);
  }
  if (values.size === 0) throw new Error('Invalid cron schedule');
  return {
    values,
    unrestricted: text.split(',').some((part) => part.split('/', 1)[0] === '*'),
  };
}

function parseCron(schedule: string): Cron {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Invalid cron schedule');
  return {
    minute: parseCronField(fields[0]!, 0, 59),
    hour: parseCronField(fields[1]!, 0, 23),
    day: parseCronField(fields[2]!, 1, 31),
    month: parseCronField(fields[3]!, 1, 12),
    weekday: parseCronField(fields[4]!, 0, 7, true),
  };
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(timeZone, value);
  }
  return value;
}

function zonedParts(timestamp: number, timeZone: string): Record<string, number> {
  return Object.fromEntries(
    formatter(timeZone)
      .formatToParts(timestamp)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
}

function cronMatches(cron: Cron, parts: Record<string, number>): boolean {
  const weekday = new Date(Date.UTC(parts.year!, parts.month! - 1, parts.day!)).getUTCDay();
  const dayMatches = cron.day.values.has(parts.day!);
  const weekdayMatches = cron.weekday.values.has(weekday);
  const calendarDayMatches =
    cron.day.unrestricted && cron.weekday.unrestricted
      ? true
      : cron.day.unrestricted
        ? weekdayMatches
        : cron.weekday.unrestricted
          ? dayMatches
          : dayMatches || weekdayMatches;
  return (
    cron.minute.values.has(parts.minute!) &&
    cron.hour.values.has(parts.hour!) &&
    cron.month.values.has(parts.month!) &&
    calendarDayMatches
  );
}

function nextMinuteDelta(values: Set<number>, minute: number): number {
  let delta = 60;
  for (const value of values) {
    const candidate = (value - minute + 60) % 60;
    if (candidate > 0 && candidate < delta) delta = candidate;
  }
  return delta;
}

function previousMinuteDelta(values: Set<number>, minute: number): number {
  let delta = 60;
  for (const value of values) {
    const candidate = (minute - value + 60) % 60;
    if (candidate > 0 && candidate < delta) delta = candidate;
  }
  return delta;
}

function requireTimestamp(value: number | null | undefined, field: string): void {
  if (value !== null && value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Invalid ${field}`);
  }
}

function normalizedBounds(bounds: ScheduleBounds): Required<ScheduleBounds> {
  const timeZone = validateTimeZone(bounds.timeZone ?? 'UTC');
  requireTimestamp(bounds.startAt, 'startAt');
  requireTimestamp(bounds.endAt, 'endAt');
  const startAt = bounds.startAt ?? null;
  const endAt = bounds.endAt ?? null;
  if (startAt !== null && endAt !== null && endAt < startAt)
    throw new Error('endAt must not be before startAt');
  return { timeZone, startAt, endAt };
}

function withinBounds(value: number, startAt: number | null, endAt: number | null): boolean {
  return (startAt === null || value >= startAt) && (endAt === null || value <= endAt);
}

export function calculateNextRun(
  schedule: string | null,
  from: number,
  bounds: ScheduleBounds = {},
): number | null {
  if (!schedule) return null;
  if (!Number.isSafeInteger(from) || from < 0) throw new Error('Invalid schedule cursor');
  const { timeZone, startAt, endAt } = normalizedBounds(bounds);
  if (schedule.startsWith('interval:')) {
    const interval = Number(schedule.slice('interval:'.length));
    if (!Number.isSafeInteger(interval) || interval <= 0)
      throw new Error('Invalid interval schedule');
    const anchor = startAt ?? from;
    const multiplier = from < anchor ? 0 : Math.floor((from - anchor) / interval) + 1;
    const value = anchor + multiplier * interval;
    if (!Number.isSafeInteger(value)) throw new Error('Interval schedule exceeds timestamp range');
    return withinBounds(value, startAt, endAt) ? value : null;
  }
  if (schedule.startsWith('once:')) {
    const timestamp = Number(schedule.slice('once:'.length));
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0)
      throw new Error('Invalid once schedule');
    return timestamp > from && withinBounds(timestamp, startAt, endAt) ? timestamp : null;
  }

  const cron = parseCron(schedule);
  let candidate = Math.floor(from / minuteMs) * minuteMs + minuteMs;
  if (startAt !== null && candidate < startAt) candidate = Math.ceil(startAt / minuteMs) * minuteMs;
  let searchedMinutes = 0;
  while (searchedMinutes < maximumSearchMinutes) {
    if (endAt !== null && candidate > endAt) return null;
    const parts = zonedParts(candidate, timeZone);
    if (cronMatches(cron, parts)) return candidate;
    const delta = nextMinuteDelta(cron.minute.values, parts.minute!);
    candidate += delta * minuteMs;
    searchedMinutes += delta;
  }
  throw new Error('Cron schedule has no occurrence within five years');
}

export function calculatePreviousRun(
  schedule: string,
  at: number,
  bounds: ScheduleBounds = {},
): number | null {
  const { timeZone, startAt, endAt } = normalizedBounds(bounds);
  const ceiling = endAt === null ? at : Math.min(at, endAt);
  if (schedule.startsWith('interval:')) {
    const interval = Number(schedule.slice('interval:'.length));
    if (!Number.isSafeInteger(interval) || interval <= 0)
      throw new Error('Invalid interval schedule');
    const anchor = startAt ?? 0;
    if (ceiling < anchor) return null;
    return anchor + Math.floor((ceiling - anchor) / interval) * interval;
  }
  if (schedule.startsWith('once:')) {
    const timestamp = Number(schedule.slice('once:'.length));
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0)
      throw new Error('Invalid once schedule');
    return timestamp <= ceiling && withinBounds(timestamp, startAt, endAt) ? timestamp : null;
  }

  const cron = parseCron(schedule);
  let candidate = Math.floor(ceiling / minuteMs) * minuteMs;
  let searchedMinutes = 0;
  while (searchedMinutes < maximumSearchMinutes) {
    if (startAt !== null && candidate < startAt) return null;
    const parts = zonedParts(candidate, timeZone);
    if (cronMatches(cron, parts)) return candidate;
    const delta = previousMinuteDelta(cron.minute.values, parts.minute!);
    candidate -= delta * minuteMs;
    searchedMinutes += delta;
  }
  throw new Error('Cron schedule has no occurrence within five years');
}
