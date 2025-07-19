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

// PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Secrets
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;

// Distance calculator
function haversineDistance([lon1, lat1], [lon2, lat2]) {
  const toRad = deg => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Health
app.get('/health', (req, res) => res.json({ status: 'OK' }));

// DB connection test
app.get('/dbtest', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT NOW() AS now');
    res.json({ dbTime: rows[0].now });
  } catch (err) {
    console.error('DB test error:', err);
    res.status(500).json({ error: 'Database connection failed' });
  }
});

// Registration
app.post('/api/register', async (req, res) => {
  const { name, phone, password, role } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO users (name, phone, password, role) VALUES ($1, $2, $3, $4) RETURNING id, name, role',
      [name, phone, password, role]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { phone, password } = req.body;
  try {
    const { rows } = await pool.query(
      'SELECT id, name, role FROM users WHERE phone = $1 AND password = $2',
      [phone, password]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET);
    res.json({ ...user, token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login error' });
  }
});

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

// Fare endpoint
app.post('/api/rides/fare', auth, (req, res) => {
  const { pickup, dropoff } = req.body;
  const distance = haversineDistance(pickup, dropoff);
  const fare = parseFloat((5 + 2 * distance).toFixed(2));
  res.json({ distance_km: distance.toFixed(2), estimated_fare: fare });
});

// Request ride (automatically calculate fare inside)
app.post('/api/rides/request', auth, async (req, res) => {
  const { pickup, dropoff_name } = req.body;

  try {
    const geo = await axios.get(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(dropoff_name)}.json?access_token=${MAPBOX_TOKEN}`);
    const dropoff_coords = geo.data.features[0].center;
    const fare = parseFloat((5 + 2 * haversineDistance(pickup, dropoff_coords)).toFixed(2));

    const pickupPoint = `(${pickup[0]},${pickup[1]})`;
    const dropoffPoint = `(${dropoff_coords[0]},${dropoff_coords[1]})`;

    const result = await pool.query(
      'INSERT INTO rides (rider_id, pickup_coords, dropoff_coords, fare, status, dropoff_location) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [req.user.id, pickupPoint, dropoffPoint, fare, 'requested', dropoff_name]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Ride request failed:', err);
    res.status(500).json({ error: 'Ride request failed' });
  }
});

// Ride history
app.get('/api/rides/history', auth, async (req, res) => {
  const col = req.user.role === 'driver' ? 'driver_id' : 'rider_id';
  try {
    const query = `SELECT id, dropoff_location AS dropoff, status FROM rides WHERE ${col} = $1`;
    const { rows } = await pool.query(query, [req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch history' });
  }
});

// Payments
app.get('/api/payments', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, ride_id, amount, status FROM payments WHERE user_id = $1',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Payment fetch error' });
  }
});

// Driver earnings
app.get('/api/driver/earnings', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT SUM(amount) AS total FROM payments WHERE driver_id = $1',
      [req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Earnings fetch failed' });
  }
});

// Chat
io.on('connection', socket => {
  socket.on('join', ({ userId }) => socket.join(userId));
  socket.on('message', msg => io.emit('message', msg));
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
