// routes/flood.js
import express from 'express';
import fetch from 'node-fetch';

const router = express.Router();

router.get('/floodzone', async (req, res) => {
  const { lat, lon } = req.query;

  const FEMA_ENDPOINT = 'https://services.arcgis.com/HZlFg9wR9wxz7FeG/arcgis/rest/services/NFHL/FeatureServer/0/query';
  const params = new URLSearchParams({
    f: 'json',
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'false'
  });

  const url = `${FEMA_ENDPOINT}?${params}`;
  console.log('Fetching FEMA URL:', url); // Add this line


  try {
    const response = await fetch(url);
    const contentType = response.headers.get('content-type');

    if (!response.ok) {
      const text = await response.text();
      console.error('Non-OK response:', response.status, text);
      return res.status(500).json({ error: 'Non-OK response from FEMA' });
    }

    if (!contentType || !contentType.includes('application/json')) {
      const text = await response.text();
      console.error('Unexpected response content-type:', contentType);
      console.error('Response text:', text);
      return res.status(500).json({ error: 'Unexpected response format from FEMA' });
    }

    const data = await response.json();

    if (data.features?.length > 0) {
      const zone = data.features[0].attributes;
      res.json({
        isFloodZone: true,
        floodZone: zone.FLDFLDZON || 'Unknown',
        description: zone.FLDAR || 'No description available'
      });
    } else {
      res.json({ isFloodZone: false, floodZone: null, description: null });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch FEMA data' });
  }
});

export default router;