
const { reverseGeocode } = require('./src/geocoder');

async function main() {
    const lat = 34.794201;
    const lon = -82.392033;
    console.log(`Testing reverse geocode for: ${lat}, ${lon}`);
    
    const result = await reverseGeocode(lat, lon);
    console.log(`Result: "${result}"`);
}

main();
