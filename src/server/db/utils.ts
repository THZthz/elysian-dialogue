/**
 * Chorus — cinematic dialogue engine
 * Copyright (C) 2026 Amias
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */


// ── Time helpers ──

export function formatHour(hour: number): string {
  const h = Math.floor(hour);
  const m = hour % 1 === 0.5 ? 30 : 0;
  const period = h < 12 ? "AM" : "PM";
  const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const mm = m === 0 ? "00" : "30";
  return `${displayH}:${mm} ${period}`;
}

export function formatTime(t: number): string {
  const day = Math.floor(t / 48);
  const halfHours = t % 48;
  const hour = halfHours / 2;
  return `Day ${day}, ${formatHour(hour)}`;
}

export function describeTime(time: { day: number; hour: number }): string {
  return `Day ${time.day}, ${formatHour(time.hour)}`;
}

export function describeInternalTime(time: number): string {
  const day = Math.floor(time / 48);
  const halfHours = time % 48;
  const hour = Math.floor(halfHours / 2);
  return describeTime({day, hour});
}
