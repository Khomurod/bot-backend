const fs = require('fs');
let code = fs.readFileSync('admin/src/api.js', 'utf8');

const helper = `async function handleApiError(res) {
  let errorMessage = \`HTTP Error: \${res.status}\`;
  try {
    const contentType = res.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const errData = await res.json();
      errorMessage = errData.error || errorMessage;
    } else {
      const textData = await res.text();
      errorMessage = textData.length < 200 ? textData : errorMessage;
    }
  } catch (e) {
    // Fallback if parsing fails entirely
  }
  throw new Error(errorMessage);
}\n`;

code = code.replace(/function getHeaders\(\) \{[\s\S]*?return headers;\n\}/, match => match + '\n\n' + helper);

const pattern = /if \(!res\.ok\) \{\s*const [a-zA-Z_]+ = await res\.json\(\);\s*throw new Error\([^;]+\);\s*\}/g;
code = code.replace(pattern, 'if (!res.ok) { await handleApiError(res); }');

fs.writeFileSync('admin/src/api.js', code);
console.log('Done');
