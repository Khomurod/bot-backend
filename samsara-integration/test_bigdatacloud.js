
async function testBigDataCloud(lat, lon) {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
    console.log(`Testing BigDataCloud for: ${lat}, ${lon}`);
    try {
        const res = await fetch(url);
        if (!res.ok) {
            console.error(`Error ${res.status}`);
            return;
        }
        const data = await res.json();
        console.log(`Response:`, JSON.stringify(data, null, 2));
        const city = data.city || data.locality || data.principalSubdivision || '';
        const state = data.principalSubdivision || '';
        console.log(`Parsed: ${city}, ${state}`);
    } catch (e) {
        console.error(`Fetch error: ${e.message}`);
    }
}

testBigDataCloud(34.794201, -82.392033);
