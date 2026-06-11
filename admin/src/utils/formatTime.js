/**
 * Converts ISO timestamps to human-friendly relative times.
 * "2026-06-11T15:58:32Z" → "10 mins ago"
 * "2026-06-10T08:00:00Z" → "Yesterday at 8:00 AM"
 * "2026-06-01T12:00:00Z" → "Jun 1 at 12:00 PM"
 */
export function timeAgo(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return '—';
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 0) return formatDate(date);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min${diffMins === 1 ? '' : 's'} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  if (diffDays === 1) return `Yesterday at ${formatTime(date)}`;
  if (diffDays < 7) return `${diffDays} days ago`;

  return formatDate(date);
}

function formatTime(date) {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ` at ${formatTime(date)}`;
}

/**
 * Friendly timezone name.
 * "America/Chicago" → "Central Time"
 */
export function friendlyTimezone(iana) {
  const map = {
    'America/Chicago': 'Central Time',
    'America/New_York': 'Eastern Time',
    'America/Denver': 'Mountain Time',
    'America/Los_Angeles': 'Pacific Time',
    'Asia/Tashkent': 'Tashkent Time',
    'Europe/London': 'London Time',
    'UTC': 'UTC',
  };
  return map[iana] || iana;
}

/**
 * Humanize database column names for display.
 * "driver_name" → "Driver Name"
 * "created_at" → "Created"
 * "group_id" → "Group"
 */
export function humanizeColumn(col) {
  const overrides = {
    'driver_name': 'Driver',
    'first_name': 'First Name',
    'last_name': 'Last Name',
    'group_name': 'Group',
    'group_id': 'Group',
    'created_at': 'Date',
    'updated_at': 'Updated',
    'sent_at': 'Sent',
    'message_text': 'Message',
    'message_text_en': 'Message',
    'response_text': 'Response',
    'telegram_group_id': 'Telegram Group',
    'telegram_user_id': 'Telegram ID',
    'telegram_username': 'Username',
    'telegram_first_name': 'Name',
    'unit_number': 'Unit #',
    'driver_type': 'Type',
    'date_of_birth': 'Birthday',
    'date_of_start': 'Start Date',
    'status_source': 'Source',
    'phone_number': 'Phone',
    'email': 'Email',
    'full_name': 'Full Name',
    'event_type': 'Event',
    'page_id': 'Page',
    'needs_review': 'Review',
    'sentiment_label': 'Sentiment',
    'annotation_tags': 'Tags',
    'category': 'Category',
    'count': 'Count',
    'total': 'Total',
    'avg': 'Average',
    'id': 'ID',
  };
  if (overrides[col]) return overrides[col];
  return col
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bId\b/, 'ID')
    .replace(/\bAt\b/, '')
    .trim();
}
