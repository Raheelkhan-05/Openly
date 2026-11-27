// Habits worth knowing: when people open, and how quickly. tzOffsetMin is JavaScript's getTimezoneOffset().
function computeInsights(summaries, tzOffsetMin = 0) {
  const hours = Array(24).fill(0);
  const weekdays = Array(7).fill(0);
  const minutes = [];
  let opened = 0;
  let clicked = 0;
  for (const s of summaries) {
    if (s.click_count > 0) clicked += 1;
    if (s.status !== 'opened' || !s.first_open_at) continue;
    opened += 1;
    const first = Date.parse(s.first_open_at);
    const local = new Date(first - tzOffsetMin * 60000);
    hours[local.getUTCHours()] += 1;
    weekdays[local.getUTCDay()] += 1;
    minutes.push(Math.max(0, (first - Date.parse(s.sent_at)) / 60000));
  }
  minutes.sort((a, b) => a - b);
  const mid = Math.floor(minutes.length / 2);
  const median = !minutes.length ? null : minutes.length % 2 ? minutes[mid] : (minutes[mid - 1] + minutes[mid]) / 2;
  return {
    total: summaries.length,
    opened,
    clicked,
    open_rate: summaries.length ? opened / summaries.length : null,
    median_minutes_to_first_open: median,
    hours,
    weekdays,
  };
}
module.exports = { computeInsights };
