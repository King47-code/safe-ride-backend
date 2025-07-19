// Safe Ride Backend - Full Implementation with Real-Time Features

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

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;

// Haversine formula
function haversineDistance([lon1, lat1], [lon2, lat2]) {
  const toRad = deg => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Health check
app.get('/health', (req, res) => res.json({ status: 'OK' }));

// DB test
app.get('/dbtest', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT NOW() AS now');
    res.json({ dbTime: rows[0].now });
  } catch (err) {
    res.status(500).json({ error: 'Database connection failed' });
  }
});

// Register
app.post('/api/register', async (req, res) => {
  const { name, phone, password, role } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO users (name, phone, password, role, is_available) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, role',
      [name, phone, password, role, role === 'driver']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { phone, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT id, name, role FROM users WHERE phone = $1 AND password = $2', [phone, password]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET);
    res.json({ ...user, token });
  } catch {
    res.status(500).json({ error: 'Login error' });
  }
});

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

// Fare calculation
app.post('/api/rides/fare', auth, async (req, res) => {
  const { pickup, dropoff } = req.body;
  try {
    const geo = await axios.get(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(dropoff)}.json?access_token=${MAPBOX_TOKEN}`);
    const dropoffCoords = geo.data.features[0].center;
    const distance = haversineDistance(pickup, dropoffCoords);
    const fare = parseFloat((5 + 2 * distance).toFixed(2));
    res.json({ distance_km: distance.toFixed(2), estimated_fare: fare, dropoff_coords: dropoffCoords });
  } catch (err) {
    res.status(500).json({ error: 'Fare calculation failed' });
  }
});

// Request ride
app.post('/api/rides/request', auth, async (req, res) => {
  const { pickup, dropoff } = req.body;
  try {
    const geo = await axios.get(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(dropoff)}.json?access_token=${MAPBOX_TOKEN}`);
    const dropoffCoords = geo.data.features[0].center;
    const distance = haversineDistance(pickup, dropoffCoords);
    const fare = parseFloat(((5 + 2 * distance) * 12).toFixed(2)); // Fare in GHS

    const result = await pool.query(
      'INSERT INTO rides (rider_id, pickup_coords, dropoff_coords, fare, status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.user.id, pickup, dropoffCoords, fare, 'requested']
    );
    io.emit('ride_requested', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Ride request failed' });
  }
});

// Accept ride
app.post('/api/rides/accept', auth, async (req, res) => {
  const { rideId } = req.body;
  try {
    await pool.query('UPDATE rides SET driver_id = $1, status = $2 WHERE id = $3', [req.user.id, 'accepted', rideId]);
    io.emit('ride_accepted', { rideId, driverId: req.user.id });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Could not accept ride' });
  }
});

// Ride history
app.get('/api/rides/history', auth, async (req, res) => {
  const col = req.user.role === 'driver' ? 'driver_id' : 'rider_id';
  try {
    const { rows } = await pool.query(`SELECT * FROM rides WHERE ${col} = $1`, [req.user.id]);
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'History fetch failed' });
  }
});

// Get nearby drivers
app.get('/api/drivers/nearby', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, location FROM users WHERE role = $1 AND is_available = true', ['driver']);
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Driver fetch error' });
  }
});

// Update driver location
app.post('/api/drivers/location', auth, async (req, res) => {
  const { lat, lng } = req.body;
  try {
    await pool.query('UPDATE users SET location = POINT($1, $2) WHERE id = $3', [lng, lat, req.user.id]);
    io.emit('driver_location', { id: req.user.id, lat, lng });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Location update failed' });
  }
});

// Payments
app.get('/api/payments', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM payments WHERE user_id = $1', [req.user.id]);
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Payments fetch failed' });
  }
});

// Earnings
app.get('/api/driver/earnings', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT SUM(amount) AS total FROM payments WHERE driver_id = $1', [req.user.id]);
    res.json(rows[0]);
  } catch {
    res.status(500).json({ error: 'Earnings fetch failed' });
  }
});

// Chat and Socket.IO
io.on('connection', socket => {
  socket.on('join_ride', rideId => socket.join(`ride_${rideId}`));
  socket.on('chat_message', ({ rideId, message }) => {
    io.to(`ride_${rideId}`).emit('chat_message', { message });
  });
  socket.on('location_update', ({ userId, lat, lng }) => {
    io.emit('driver_location', { userId, lat, lng });
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
