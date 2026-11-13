/**
 * scratch/test_date_parser.js
 */

function detectDateFormat(separatorStrings) {
  let hasMonthSecond = false; // e.g. 12/14/25 -> part2 > 12 -> MDY
  let hasDayFirst = false;    // e.g. 14/12/25 -> part1 > 12 -> DMY

  for (const s of separatorStrings) {
    const m = s.match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
    if (m) {
      const p1 = parseInt(m[1], 10);
      const p2 = parseInt(m[2], 10);
      if (p1 > 12 && p2 <= 12) hasDayFirst = true;
      if (p2 > 12 && p1 <= 12) hasMonthSecond = true;
    }
  }

  if (hasMonthSecond && !hasDayFirst) return 'MDY';
  if (hasDayFirst && !hasMonthSecond) return 'DMY';

  // Fallback to browser locale
  try {
    const sample = new Intl.DateTimeFormat().format(new Date(2025, 11, 25)); // Dec 25
    if (sample.startsWith('12')) return 'MDY';
    if (sample.startsWith('25')) return 'DMY';
  } catch (_) {}

  return 'MDY'; // Default US / Messenger
}

function parseSeparator(str, format = 'MDY', lastDate = null, baseDate = new Date()) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');

  function parseTimeParts(hStr, mStr, meridiem) {
    let hours = parseInt(hStr, 10);
    const minutes = parseInt(mStr, 10);
    const m = (meridiem || '').toLowerCase();
    if (m === 'pm' && hours < 12) hours += 12;
    if (m === 'am' && hours === 12) hours = 0;
    return { hours, minutes };
  }

  // 1. Full Numeric Date + Optional Time: e.g. "12/10/25, 2:19 PM" or "14/12/2025, 9:36 PM"
  const fullNumMatch = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})(?:[,\s]+at)?[,\s]*(?:(\d{1,2}):(\d{2})\s*([ap]m)?)?$/i);
  if (fullNumMatch) {
    let p1 = parseInt(fullNumMatch[1], 10);
    let p2 = parseInt(fullNumMatch[2], 10);
    let year = parseInt(fullNumMatch[3], 10);
    if (year < 100) year += (year < 50 ? 2000 : 1900);

    let month = 0;
    let day = 1;

    if (p1 > 12) {
      // Day first
      day = p1;
      month = p2 - 1;
    } else if (p2 > 12) {
      // Month first
      month = p1 - 1;
      day = p2;
    } else if (format === 'DMY') {
      day = p1;
      month = p2 - 1;
    } else {
      month = p1 - 1;
      day = p2;
    }

    let hours = 12;
    let minutes = 0;
    if (fullNumMatch[4] && fullNumMatch[5]) {
      const tp = parseTimeParts(fullNumMatch[4], fullNumMatch[5], fullNumMatch[6]);
      hours = tp.hours;
      minutes = tp.minutes;
    }

    return new Date(year, month, day, hours, minutes);
  }

  // 2. Relative Today / Yesterday
  if (/^today/i.test(s)) {
    const timeM = s.match(/(\d{1,2}):(\d{2})\s*([ap]m)?/i);
    const ref = baseDate ? new Date(baseDate) : new Date();
    if (timeM) {
      const tp = parseTimeParts(timeM[1], timeM[2], timeM[3]);
      return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), tp.hours, tp.minutes);
    }
    return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), 12, 0);
  }

  if (/^yesterday/i.test(s)) {
    const timeM = s.match(/(\d{1,2}):(\d{2})\s*([ap]m)?/i);
    const ref = baseDate ? new Date(baseDate) : new Date();
    const y = new Date(ref.getTime() - 24 * 60 * 60 * 1000);
    if (timeM) {
      const tp = parseTimeParts(timeM[1], timeM[2], timeM[3]);
      return new Date(y.getFullYear(), y.getMonth(), y.getDate(), tp.hours, tp.minutes);
    }
    return new Date(y.getFullYear(), y.getMonth(), y.getDate(), 12, 0);
  }

  // 3. Weekday + Time: e.g. "Mon 10:32 AM", "Tuesday 4:15 PM"
  const weekdayMatch = s.match(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*(?:[,\s]+at)?[,\s]+(\d{1,2}):(\d{2})\s*([ap]m)?$/i);
  if (weekdayMatch) {
    const weekdayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const targetDay = weekdayMap[weekdayMatch[1].slice(0, 3).toLowerCase()];
    const tp = parseTimeParts(weekdayMatch[2], weekdayMatch[3], weekdayMatch[4]);
    const ref = lastDate ? new Date(lastDate) : (baseDate ? new Date(baseDate) : new Date());

    // Find most recent day matching targetDay
    let diff = (ref.getDay() - targetDay + 7) % 7;
    if (diff === 0 && !lastDate) diff = 7; // if same day and looking back
    const targetDate = new Date(ref.getTime() - diff * 24 * 60 * 60 * 1000);
    return new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), tp.hours, tp.minutes);
  }

  // 4. Time-Only Separator: e.g. "12:45 AM", "2:19 PM"
  const timeOnlyMatch = s.match(/^(\d{1,2}):(\d{2})\s*([ap]m)?$/i);
  if (timeOnlyMatch) {
    const tp = parseTimeParts(timeOnlyMatch[1], timeOnlyMatch[2], timeOnlyMatch[3]);
    if (lastDate) {
      return new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate(), tp.hours, tp.minutes);
    }
    const ref = baseDate ? new Date(baseDate) : new Date();
    return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), tp.hours, tp.minutes);
  }

  // 5. Month Name Format: e.g. "May 11, 2026, 9:14 PM" or "11 May 2026, 9:14 PM"
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return parsed;

  return null;
}

// Tests
console.log('Format detection:', detectDateFormat(['12/10/25, 2:19 PM', '12/14/25, 9:36 PM'])); // Expect MDY because 14 > 12

const d1 = parseSeparator('12/10/25, 2:19 PM', 'MDY');
console.log('12/10/25, 2:19 PM ->', d1.toISOString(), d1.toLocaleDateString(), d1.toLocaleTimeString());

const d2 = parseSeparator('12/14/25, 9:36 PM', 'MDY');
console.log('12/14/25, 9:36 PM ->', d2.toISOString(), d2.toLocaleDateString(), d2.toLocaleTimeString());

const d3 = parseSeparator('12:45 AM', 'MDY', d2);
console.log('12:45 AM with lastDate ->', d3.toISOString(), d3.toLocaleDateString(), d3.toLocaleTimeString());

const d4 = parseSeparator('Mon 10:32 AM', 'MDY', d2);
console.log('Mon 10:32 AM ->', d4.toISOString(), d4.toLocaleDateString(), d4.toLocaleTimeString());

const d5 = parseSeparator('Yesterday at 8:15 PM', 'MDY', null, new Date(2026, 4, 11, 10, 0));
console.log('Yesterday at 8:15 PM ->', d5.toISOString(), d5.toLocaleDateString(), d5.toLocaleTimeString());
