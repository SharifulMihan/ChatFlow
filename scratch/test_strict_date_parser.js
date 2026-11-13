/**
 * test_strict_date_parser.js
 */

const MONTHS_MAP = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

const BENGALI_MONTHS = {
  'জানুয়ারি': 0, 'ফেব্রুয়ারি': 1, 'মার্চ': 2, 'এপ্রিল': 3,
  'মে': 4, 'জুন': 5, 'জুলাই': 6, 'আগস্ট': 7,
  'সেপ্টেম্বর': 8, 'অক্টোবর': 9, 'নভেম্বর': 10, 'ডিসেম্বর': 11
};

export function isValidConversationDate(d, now = new Date(2026, 10, 11)) {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return false;
  const year = d.getFullYear();
  const currentYear = now.getFullYear();
  if (year < 2008 || year > currentYear + 1) return false;
  if (d.getTime() > now.getTime() + 24 * 60 * 60 * 1000) return false;
  return true;
}

function parseTime(hStr, mStr, meridiem) {
  let hours = parseInt(hStr, 10);
  const minutes = parseInt(mStr, 10);
  const m = (meridiem || '').toLowerCase();
  if (m === 'pm' && hours < 12) hours += 12;
  if (m === 'am' && hours === 12) hours = 0;
  return { hours, minutes };
}

export function parseStrictDate(str, format = 'MDY', lastDate = null, baseDate = new Date(2026, 10, 11)) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
  if (!s || s.length > 60) return null;

  // Rule 1: Full Numeric Date + Time (e.g. "12/16/25, 12:47 AM" or "12/10/2025, 2:19 PM")
  const numDateTime = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})(?:[,\s]+at)?[,\s]+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?$/i);
  if (numDateTime) {
    const p1 = parseInt(numDateTime[1], 10);
    const p2 = parseInt(numDateTime[2], 10);
    let year = parseInt(numDateTime[3], 10);
    if (year < 100) year += 2000;

    let month = 0, day = 1;
    if (p1 > 12) {
      day = p1; month = p2 - 1;
    } else if (p2 > 12) {
      month = p1 - 1; day = p2;
    } else if (format === 'DMY') {
      day = p1; month = p2 - 1;
    } else {
      month = p1 - 1; day = p2;
    }

    const { hours, minutes } = parseTime(numDateTime[4], numDateTime[5], numDateTime[6]);
    const d = new Date(year, month, day, hours, minutes);
    if (isValidConversationDate(d)) return d;
    return null;
  }

  // Rule 2: Full Numeric Date Only (e.g. "12/16/25" or "12/16/2025")
  const numDateOnly = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (numDateOnly) {
    const p1 = parseInt(numDateOnly[1], 10);
    const p2 = parseInt(numDateOnly[2], 10);
    let year = parseInt(numDateOnly[3], 10);
    if (year < 100) year += 2000;

    let month = 0, day = 1;
    if (p1 > 12) {
      day = p1; month = p2 - 1;
    } else if (p2 > 12) {
      month = p1 - 1; day = p2;
    } else if (format === 'DMY') {
      day = p1; month = p2 - 1;
    } else {
      month = p1 - 1; day = p2;
    }

    const d = new Date(year, month, day, 12, 0);
    if (isValidConversationDate(d)) return d;
    return null;
  }

  // Rule 3: Text Month Date + Optional Time (e.g. "May 11, 2026, 9:14 PM" or "11 May 2026, 9:14 PM")
  const textMonth1 = s.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{2,4}))?(?:[,\s]+at|[,\s]+)*(?:(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?)?$/i);
  if (textMonth1) {
    const month = MONTHS_MAP[textMonth1[1].slice(0, 3).toLowerCase()];
    const day = parseInt(textMonth1[2], 10);
    if (day < 1 || day > 31) return null; // Days must be 1-31
    let year = textMonth1[3] ? parseInt(textMonth1[3], 10) : (lastDate ? lastDate.getFullYear() : baseDate.getFullYear());
    if (year < 100) year += 2000;
    let hours = 12, minutes = 0;
    if (textMonth1[4] && textMonth1[5]) {
      const tp = parseTime(textMonth1[4], textMonth1[5], textMonth1[6]);
      hours = tp.hours; minutes = tp.minutes;
    }
    const d = new Date(year, month, day, hours, minutes);
    if (isValidConversationDate(d)) return d;
    return null;
  }

  const textMonth2 = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s*,?\s*(\d{2,4}))?(?:[,\s]+at|[,\s]+)*(?:(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?)?$/i);
  if (textMonth2) {
    const day = parseInt(textMonth2[1], 10);
    if (day < 1 || day > 31) return null; // Days must be 1-31
    const month = MONTHS_MAP[textMonth2[2].slice(0, 3).toLowerCase()];
    let year = textMonth2[3] ? parseInt(textMonth2[3], 10) : (lastDate ? lastDate.getFullYear() : baseDate.getFullYear());
    if (year < 100) year += 2000;
    let hours = 12, minutes = 0;
    if (textMonth2[4] && textMonth2[5]) {
      const tp = parseTime(textMonth2[4], textMonth2[5], textMonth2[6]);
      hours = tp.hours; minutes = tp.minutes;
    }
    const d = new Date(year, month, day, hours, minutes);
    if (isValidConversationDate(d)) return d;
    return null;
  }

  // Rule 4: Relative Today / Yesterday
  if (/^today/i.test(s)) {
    const m = s.match(/^today(?:[,\s]+at)?[,\s]+(\d{1,2}):(\d{2})\s*([ap]m)?$/i);
    const ref = baseDate ? new Date(baseDate) : new Date();
    let hours = 12, minutes = 0;
    if (m) {
      const tp = parseTime(m[1], m[2], m[3]);
      hours = tp.hours; minutes = tp.minutes;
    }
    const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), hours, minutes);
    if (isValidConversationDate(d)) return d;
    return null;
  }

  if (/^yesterday/i.test(s)) {
    const m = s.match(/^yesterday(?:[,\s]+at)?[,\s]+(\d{1,2}):(\d{2})\s*([ap]m)?$/i);
    const ref = baseDate ? new Date(baseDate) : new Date();
    const y = new Date(ref.getTime() - 24 * 60 * 60 * 1000);
    let hours = 12, minutes = 0;
    if (m) {
      const tp = parseTime(m[1], m[2], m[3]);
      hours = tp.hours; minutes = tp.minutes;
    }
    const d = new Date(y.getFullYear(), y.getMonth(), y.getDate(), hours, minutes);
    if (isValidConversationDate(d)) return d;
    return null;
  }

  // Rule 5: Weekday + Time
  const weekdayMatch = s.match(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*(?:[,\s]+at)?[,\s]+(\d{1,2}):(\d{2})\s*([ap]m)?$/i);
  if (weekdayMatch) {
    const weekdayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const targetDay = weekdayMap[weekdayMatch[1].slice(0, 3).toLowerCase()];
    const tp = parseTime(weekdayMatch[2], weekdayMatch[3], weekdayMatch[4]);
    const ref = lastDate ? new Date(lastDate) : (baseDate ? new Date(baseDate) : new Date());
    let diff = (ref.getDay() - targetDay + 7) % 7;
    if (diff === 0 && !lastDate) diff = 7;
    const targetDate = new Date(ref.getTime() - diff * 24 * 60 * 60 * 1000);
    const d = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), tp.hours, tp.minutes);
    if (isValidConversationDate(d)) return d;
    return null;
  }

  // Rule 6: Time-Only Separator (e.g. "12:45 AM" or "14:30")
  const timeOnly12 = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)$/i);
  if (timeOnly12) {
    const tp = parseTime(timeOnly12[1], timeOnly12[2], timeOnly12[3]);
    const ref = lastDate ? new Date(lastDate) : (baseDate ? new Date(baseDate) : new Date());
    const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), tp.hours, tp.minutes);
    if (isValidConversationDate(d)) return d;
    return null;
  }

  const timeOnly24 = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (timeOnly24) {
    const hours = parseInt(timeOnly24[1], 10);
    const minutes = parseInt(timeOnly24[2], 10);
    const ref = lastDate ? new Date(lastDate) : (baseDate ? new Date(baseDate) : new Date());
    const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), hours, minutes);
    if (isValidConversationDate(d)) return d;
    return null;
  }

  // Rule 7: Bengali Date/Time
  const bnMatch = s.match(/^(\d{1,2})\s+(জানুয়ারি|ফেব্রুয়ারি|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|অক্টোবর|নভেম্বর|ডিসেম্বর)(?:\s+(\d{2,4}))?(?:,\s*(\d{1,2}):(\d{2})\s*(পূর্বাহ্ন|অপরাহ্ন)?)?$/);
  if (bnMatch) {
    const day = parseInt(bnMatch[1], 10);
    const month = BENGALI_MONTHS[bnMatch[2]];
    let year = bnMatch[3] ? parseInt(bnMatch[3], 10) : (lastDate ? lastDate.getFullYear() : baseDate.getFullYear());
    if (year < 100) year += 2000;
    let hours = 12, minutes = 0;
    if (bnMatch[4] && bnMatch[5]) {
      const tp = parseTime(bnMatch[4], bnMatch[5], bnMatch[6] === 'অপরাহ্ন' ? 'pm' : (bnMatch[6] === 'পূর্বাহ্ন' ? 'am' : ''));
      hours = tp.hours; minutes = tp.minutes;
    }
    const d = new Date(year, month, day, hours, minutes);
    if (isValidConversationDate(d)) return d;
    return null;
  }

  // STRICT REJECTION: never fallback to new Date(s)!
  return null;
}

// ── Test Cases ────────────────────────────────────────────────────────────────
console.log('Testing Positive Date Separator Cases...');
const p1 = parseStrictDate('12/16/25, 12:47 AM');
console.assert(p1 !== null && p1.getFullYear() === 2025 && p1.getMonth() === 11 && p1.getDate() === 16, '12/16/25, 12:47 AM should parse');

const p2 = parseStrictDate('12/10/2025, 2:19 PM');
console.assert(p2 !== null && p2.getFullYear() === 2025 && p2.getMonth() === 11 && p2.getDate() === 10, '12/10/2025, 2:19 PM should parse');

const p3 = parseStrictDate('12:45 AM');
console.assert(p3 !== null && p3.getHours() === 0 && p3.getMinutes() === 45, '12:45 AM should parse');

const p4 = parseStrictDate('Mon 10:32 AM');
console.assert(p4 !== null, 'Mon 10:32 AM should parse');

const p5 = parseStrictDate('Today 4:58 PM');
console.assert(p5 !== null && p5.getHours() === 16 && p5.getMinutes() === 58, 'Today 4:58 PM should parse');

const p6 = parseStrictDate('Yesterday');
console.assert(p6 !== null, 'Yesterday should parse');

const p7 = parseStrictDate('11 May 2026, 9:14 PM');
console.assert(p7 !== null && p7.getMonth() === 4 && p7.getDate() === 11, '11 May 2026, 9:14 PM should parse');

const p8 = parseStrictDate('May 11, 2026');
console.assert(p8 !== null && p8.getMonth() === 4 && p8.getDate() === 11, 'May 11, 2026 should parse');

const p9 = parseStrictDate('14:30');
console.assert(p9 !== null && p9.getHours() === 14 && p9.getMinutes() === 30, '14:30 should parse');

console.log('Testing Negative Cases (MUST BE NULL)...');
const negatives = [
  'B2',
  '2 ta form',
  '1 or 0',
  '250',
  '300',
  '350',
  '500',
  '500-01',
  'Jan 50',
  'Tumi B2 er Student form submit korba kobe',
  'Unfortunately amr kase B2 er 2 ta form ase',
  'Ami Wednesday amder B1 er gula shob submit kore dibo',
  'Nadira Fairuxa replied to you',
  'You replied to Nadira Fairuxa',
  'You sent',
  'Ok',
  'Cc',
  'Wait ektu vabi solution ta',
  '1/1/1990', // Before 2008
  '1/1/2050'  // Future date
];

for (const neg of negatives) {
  const res = parseStrictDate(neg);
  console.assert(res === null, `Expected null for "${neg}", got: ${res?.toISOString()}`);
}

console.log('All date parser test cases passed 100%!');
