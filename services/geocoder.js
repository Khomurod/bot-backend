/**
 * geocoder.js
 * Performs reverse geocoding to convert GPS coordinates to "City, State".
 * Uses the free BigDataCloud Reverse Geocode API.
 *
 * NOTE: This is the main app's own copy. It used to be imported from
 * ../samsara-integration/src/geocoder, but the Samsara poller now lives in a
 * separate repository/service, so the main app keeps a local copy to avoid a
 * cross-repo dependency. Live-location features (dispatch ETA, fuel stop
 * alerts, driver location monitor, EVO/TT ELD) rely on this.
 */

async function reverseGeocode(lat, lon) {
    if (lat == null || lon == null) return null;

    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;

    try {
        const res = await fetch(url);

        if (!res.ok) {
            console.error(`[Geocoder] API error ${res.status}`);
            return null;
        }

        const data = await res.json();

        // Extract city/locality and state
        const city = data.city || data.locality || null;
        const state = data.principalSubdivision || null;

        if (city && state) {
            return `${city}, ${state}`;
        }
        if (state) return state;
        if (city) return city;

        return null;
    } catch (err) {
        console.error('[Geocoder] Error:', err.message);
        return null;
    }
}

module.exports = { reverseGeocode };
