require('dotenv').config();
const SAMSARA_API_KEY = process.env.SAMSARA_API_KEY || '';

async function findSpecificEvent() {
    if (!SAMSARA_API_KEY) {
        throw new Error('SAMSARA_API_KEY is not set');
    }

    const startTime = new Date('2026-04-15T18:00:00Z').toISOString(); // Earlier than 11:27 PM +5
    const endTime = new Date('2026-04-16T00:00:00Z').toISOString();
    const params = new URLSearchParams({ startTime, endTime, includeDriver: 'true' });
    const url = `https://api.samsara.com/fleet/safety-events?${params}`;
    
    console.log(`Searching events between ${startTime} and ${endTime}...`);
    
    const apiRes = await fetch(url, {
        headers: { 'Authorization': `Bearer ${SAMSARA_API_KEY}`, 'Accept': 'application/json' }
    });
    const json = await apiRes.json();
    const events = json.data || [];
    
    console.log(`Found ${events.length} events in range.`);
    
    const target = events.find(e => {
        const driverName = e.driver?.name || '';
        return driverName.includes('SHERZOD ABDUEV');
    });
    
    if (target) {
        console.log('✅ FOUND TARGET EVENT:');
        console.log(JSON.stringify(target, null, 2));
    } else {
        console.log('❌ Could not find event for SHERZOD ABDUEV in that range.');
        console.log('Sample of events found:');
        events.slice(0, 3).forEach(e => console.log(`- ${e.time} | Driver: ${e.driver?.name}`));
    }
}

findSpecificEvent();
