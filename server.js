require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const http = require('http');

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server, { cors: { origin: '*' } });

app.use(cors());
app.use(bodyParser.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const JWT_SECRET   = process.env.JWT_SECRET;

// Haversine distance (km)
function haversineDistance([lon1, lat1], [lon2, lat2]) {
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1),
        dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Auth middleware
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token provided' });
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Health
app.get('/health', (req, res) => res.json({ status: 'OK' }));

// Register
app.post('/api/register', async (req, res) => {
  const { name, phone, password, role } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (name, phone, password, role, is_available)
       VALUES ($1,$2,$3,$4,$5) RETURNING id,name,role`,
      [name, phone, password, role, role === 'driver']
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('Registration error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
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
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET);
    res.json({ ...user, token });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Calculate fare
app.post('/api/rides/fare', auth, async (req, res) => {
  const { pickup, dropoff } = req.body;
  try {
    const geo = await axios.get(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(dropoff)}.json`,
      { params: { access_token: MAPBOX_TOKEN, limit: 1 } }
    );
    if (!geo.data.features.length) {
      return res.status(422).json({ error: 'Dropoff not found' });
    }
    const [lng, lat] = geo.data.features[0].center;
    const dist = haversineDistance(pickup, [lng, lat]);
    const fare = parseFloat((5 + 2 * dist).toFixed(2));
    res.json({ distance_km: dist.toFixed(2), estimated_fare: fare, dropoff_coords: { lng, lat } });
  } catch (err) {
    console.error('Fare calc error:', err.message);
    res.status(500).json({ error: 'Fare calculation failed' });
  }
});

// Riders request ride
app.post('/api/rides/request', auth, async (req, res) => {
  const { pickup, dropoff } = req.body;
  try {
    const geo = await axios.get(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(dropoff)}.json`,
      { params: { access_token: MAPBOX_TOKEN, limit: 1 } }
    );
    if (!geo.data.features.length) {
      return res.status(422).json({ error: 'Dropoff not found' });
    }
    const [lng, lat] = geo.data.features[0].center;
    const dist = haversineDistance(pickup, [lng, lat]);
    const fare = parseFloat(((5 + 2 * dist) * 12).toFixed(2)); // GHS

    const pJson = JSON.stringify({ lng: pickup[0], lat: pickup[1] });
    const dJson = JSON.stringify({ lng, lat });

    const { rows } = await pool.query(
      `INSERT INTO rides
         (rider_id,pickup_coords,dropoff_coords,dropoff_location,fare,status)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [req.user.id, pJson, dJson, dropoff, fare, 'requested']
    );

    const ride = rows[0];
    io.emit('ride_requested', { ...ride, pickup_coords: JSON.parse(pJson), dropoff_coords: { lng, lat } });
    res.json({ ...ride, pickup_coords: JSON.parse(pJson), dropoff_coords: { lng, lat } });
  } catch (err) {
    console.error('Ride request failed:', err.message);
    res.status(500).json({ error: 'Ride request failed' });
  }
});

// Driver accepts
app.post('/api/rides/accept', auth, async (req, res) => {
  const { rideId } = req.body;
  try {
    await pool.query(
      `UPDATE rides
         SET driver_id=$1, status='accepted', updated_at=NOW()
       WHERE id=$2`,
      [req.user.id, rideId]
    );
    io.emit('ride_accepted', { rideId, driverId: req.user.id });
    res.json({ success: true });
  } catch (err) {
    console.error('Accept error:', err.message);
    res.status(500).json({ error: 'Could not accept ride' });
  }
});

// Ride history
app.get('/api/rides/history', auth, async (req, res) => {
  const col = req.user.role === 'driver' ? 'driver_id' : 'rider_id';
  try {
    const { rows } = await pool.query(
      `SELECT * FROM rides WHERE ${col}=$1 ORDER BY requested_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('History error:', err.message);
    res.status(500).json({ error: 'History fetch failed' });
  }
});

// Driver nearby
app.get('/api/drivers/nearby', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id,name,location
         FROM users
        WHERE role='driver' AND is_available=true`
    );
    res.json(rows);
  } catch (err) {
    console.error('Nearby error:', err.message);
    res.status(500).json({ error: 'Fetch drivers failed' });
  }
});

// Update driver location
app.post('/api/drivers/location', auth, async (req, res) => {
  const { lng, lat } = req.body;
  try {
    const loc = JSON.stringify({ lng, lat });
    await pool.query(
      `UPDATE users SET location=$1, updated_at=NOW() WHERE id=$2`,
      [loc, req.user.id]
    );
    io.emit('driver_location', { userId: req.user.id, lng, lat });
    res.json({ success: true });
  } catch (err) {
    console.error('Location error:', err.message);
    res.status(500).json({ error: 'Location update failed' });
  }
});

// Payments
app.get('/api/payments', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM payments WHERE user_id=$1 ORDER BY paid_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Payments error:', err.message);
    res.status(500).json({ error: 'Payments fetch failed' });
  }
});

// Earnings
app.get('/api/driver/earnings', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT SUM(amount)::NUMERIC(10,2) AS total
         FROM payments WHERE driver_id=$1`,
      [req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('Earnings error:', err.message);
    res.status(500).json({ error: 'Earnings fetch failed' });
  }
});

// Chat
io.on('connection', socket => {
  socket.on('join_ride', rideId => socket.join(`ride_${rideId}`));
  socket.on('chat_message', ({ rideId, message }) => {
    io.to(`ride_${rideId}`).emit('chat_message', { message });
    // persisted to DB:
    pool.query(
      `INSERT INTO messages (ride_id,sender_id,message) VALUES($1,$2,$3)`,
      [rideId, socket.handshake.query.userId, message]
    ).catch(console.error);
  });
});

server.listen(process.env.PORT, () =>
  console.log(`🚗 Safe Ride server listening on port ${process.env.PORT}`)
);
