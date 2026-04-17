const fs = require('fs');
let code = fs.readFileSync('admin/src/api.js', 'utf8');

// Replace single-line throws
code = code.replace(/if \(!res\.ok\) throw new Error\([^;]+\);/g, 'if (!res.ok) { await handleApiError(res); }');

fs.writeFileSync('admin/src/api.js', code);
console.log('Done');
