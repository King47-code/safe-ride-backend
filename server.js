// server.js — Safe Ride Backend

require('dotenv').config();
const express    = require('express');
const bodyParser = require('body-parser');
const cors       = require('cors');
const axios      = require('axios');
const { Pool }   = require('pg');
const jwt        = require('jsonwebtoken');
const http       = require('http');

const app    = express();
const server = http.createServer(app);
const io     = require('socket.io')(server, { cors: { origin: '*' } });

app.use(cors());
app.use(bodyParser.json());

const pool         = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const JWT_SECRET   = process.env.JWT_SECRET;

// Haversine distance (km)
function haversineDistance([lon1, lat1], [lon2, lat2]) {
  const toRad = deg => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Auth middleware
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error:'No token provided' });
  const token = header.split(' ')[1];
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error:'Invalid token' }); }
}

// Health check
app.get('/health', (req, res) => res.json({ status:'OK' }));

// Register
app.post('/api/register', async (req, res) => {
  const { name, phone, password, role } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (name, phone, password, role, is_available)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id,name,role`,
      [name, phone, password, role, role==='driver']
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('Registration error:', err.message);
    res.status(500).json({ error:'Registration failed' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { phone, password } = req.body;
  try {
    const { rows } = await pool.query(
      `SELECT id,name,role FROM users WHERE phone=$1 AND password=$2`,
      [phone, password]
    );
    if (!rows.length) return res.status(401).json({ error:'Invalid credentials' });
    const user = rows[0];
    const token = jwt.sign({ id:user.id, role:user.role }, JWT_SECRET);
    res.json({ ...user, token });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error:'Login failed' });
  }
});

// Fare calculation
app.post('/api/rides/fare', auth, async (req, res) => {
  const { pickup, dropoff } = req.body;
  try {
    const geo = await axios.get(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(dropoff)}.json?access_token=${MAPBOX_TOKEN}`
    );
    const dc = geo.data.features[0].center; // [lng,lat]
    const dist = haversineDistance(pickup, dc);
    const fare = parseFloat((5 + 2*dist).toFixed(2));
    res.json({ distance_km:dist.toFixed(2), estimated_fare:fare, dropoff_coords:dc });
  } catch (err) {
    console.error('Fare calc error:', err.message);
    res.status(500).json({ error:'Fare calculation failed' });
  }
});

// Request ride
app.post('/api/rides/request', auth, async (req, res) => {
  const { pickup, dropoff } = req.body;
  try {
    console.log('Ride request from user:', req.user.id, pickup, dropoff);

    // 1. Geocode dropoff
    const geo = await axios.get(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(dropoff)}.json?access_token=${MAPBOX_TOKEN}`
    );
    const dc = geo.data.features[0].center; // [lng,lat]

    // 2. Calculate fare in GHS
    const dist = haversineDistance(pickup, dc);
    const fare = parseFloat(((5 + 2*dist)*12).toFixed(2));

    // 3. JSONB coords
    const pickupJson  = JSON.stringify({ lat:pickup[1], lng:pickup[0] });
    const dropoffJson = JSON.stringify({ lat:dc[1],       lng:dc[0]       });

    // 4. Insert only 5 columns
    const { rows } = await pool.query(
      `INSERT INTO rides
         (rider_id, pickup_coords, dropoff_coords, fare, status)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [req.user.id, pickupJson, dropoffJson, fare, 'requested']
    );

    const ride = rows[0];
    io.emit('ride_requested', ride);
    res.json(ride);

  } catch (err) {
    console.error('Ride request failed:', err.message);
    res.status(500).json({ error:'Ride request failed', details:err.message });
  }
});

// Accept ride
app.post('/api/rides/accept', auth, async (req, res) => {
  const { rideId } = req.body;
  try {
    await pool.query(
      `UPDATE rides SET driver_id=$1, status=$2, updated_at=NOW() WHERE id=$3`,
      [req.user.id, 'accepted', rideId]
    );
    io.emit('ride_accepted',{rideId,driverId:req.user.id});
    res.json({ success:true });
  } catch (err) {
    console.error('Accept ride error:', err.message);
    res.status(500).json({ error:'Could not accept ride' });
  }
});

// Ride history
app.get('/api/rides/history', auth, async (req, res) => {
  const col = req.user.role==='driver'?'driver_id':'rider_id';
  try {
    const { rows } = await pool.query(`SELECT * FROM rides WHERE ${col}=$1 ORDER BY requested_at DESC`,[req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error('History fetch error:', err.message);
    res.status(500).json({ error:'History fetch failed' });
  }
});

// Other routes unchanged...
// (nearby drivers, location update, payments, earnings, chat)

const PORT = process.env.PORT||5000;
server.listen(PORT,()=>console.log(`🚗 Safe Ride on port ${PORT}`));
