function safeFieldValue(field) {
  try {
    const values = field?.values;
    if (Array.isArray(values) && values.length > 0) {
      return values.map((value) => String(value)).join(', ');
    }
    if (typeof values === 'string') return values;
    return '';
  } catch {
    return '';
  }
}

function buildLeadFieldMap(leadData) {
  const fieldMap = {};
  for (const field of leadData?.field_data || []) {
    const name = field?.name;
    const value = safeFieldValue(field);
    if (name && value) fieldMap[name] = value;
  }
  return fieldMap;
}

function formatLeadMessage(leadData) {
  try {
    const fieldMap = buildLeadFieldMap(leadData);
    const lines = ['New Facebook Lead!', ''];
    const prettyKeys = {
      full_name: 'Name',
      first_name: 'First Name',
      last_name: 'Last Name',
      email: 'Email',
      phone_number: 'Phone',
      phone: 'Phone',
      city: 'City',
      state: 'State',
      zip_code: 'ZIP',
      country: 'Country',
      company_name: 'Company',
      job_title: 'Job Title',
      message: 'Message',
      comments: 'Comments',
      inbox_url: 'Inbox URL',
    };

    const shown = new Set();
    for (const [key, label] of Object.entries(prettyKeys)) {
      if (fieldMap[key]) {
        lines.push(`${label}: ${fieldMap[key]}`);
        shown.add(key);
      }
    }

    for (const [key, value] of Object.entries(fieldMap)) {
      if (!shown.has(key)) {
        lines.push(`${key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}: ${value}`);
      }
    }

    if (leadData?.created_time) {
      lines.push('', `Submitted: ${leadData.created_time}`);
    }
    lines.push(`Lead ID: ${leadData?.id || 'unknown'}`);
    return lines.join('\n');
  } catch (err) {
    const leadId = leadData?.id || 'unknown';
    return [
      'New Facebook Lead!',
      '',
      `Lead ID: ${leadId}`,
      `Formatting warning: ${err?.message || 'Unknown error'}`,
    ].join('\n');
  }
}

function formatMessengerMessage(senderProfile, messageText, senderId) {
  const first = senderProfile?.first_name || '';
  const last = senderProfile?.last_name || '';
  const fallbackName = senderProfile?.name || 'Unknown';
  const name = `${first} ${last}`.trim() || fallbackName;

  return [
    'New Messenger Lead!',
    '',
    `Name: ${name}`,
    `Sender ID: ${senderId}`,
    '',
    'Message:',
    messageText || '(no text)',
    '',
    `Inbox: https://business.facebook.com/latest/${senderId}?navref=threadviewbypsid`,
  ].join('\n');
}

module.exports = {
  safeFieldValue,
  buildLeadFieldMap,
  formatLeadMessage,
  formatMessengerMessage,
};
