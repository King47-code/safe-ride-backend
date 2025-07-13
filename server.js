// File: server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server, { cors: { origin: '*' } });

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Database pool
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Constants
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;

// Utility: Haversine distance
function haversineDistance([lon1, lat1], [lon2, lat2]) {
  const toRad = val => (val * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Health endpoint
app.get('/health', (req, res) => res.send({ status: 'OK' }));

// Registration
app.post('/api/register', async (req, res) => {
  const { name, email, password, role } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO users (name, email, password, role) VALUES ($1,$2,$3,$4) RETURNING id,name,role',
      [name,email,password,role]
    );
    res.json(result.rows[0]);
  } catch(err) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT id,name,role FROM users WHERE email=$1 AND password=$2', [email,password]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET);
    res.json({ ...user, token });
  } catch {
    res.status(500).json({ error: 'Login error' });
  }
});

// Auth middleware
function auth(req,res,next){
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({error:'No token'});
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({error:'Invalid token'});
  }
}

// Calculate fare
app.post('/api/rides/fare', auth, async (req, res) => {
  const { pickup, dropoff } = req.body; // pickup coords, dropoff coords
  const distance = haversineDistance(pickup, dropoff);
  const fare = parseFloat((5 + 2*distance).toFixed(2));
  res.json({ distance_km:distance.toFixed(2), estimated_fare:fare });
});

// Request ride
app.post('/api/rides/request', auth, async (req,res) => {
  const { pickup, dropoff, fare } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO rides (rider_id, pickup_coords, dropoff_coords, fare,status) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [req.user.id, pickup, dropoff, fare,'requested']
    );
    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error:'Request failed' });
  }
});

// Ride history
app.get('/api/rides/history', auth, async (req,res) => {
  const { id, role } = req.user;
  const col = role==='driver'?'driver_id':'rider_id';
  const { rows } = await pool.query(`SELECT id,dropoff_location AS dropoff,status FROM rides WHERE ${col}=$1`, [id]);
  res.json(rows);
});

// Payments
app.get('/api/payments', auth, async (req,res) => {
  const { rows } = await pool.query('SELECT id,ride_id,amount,status FROM payments WHERE user_id=$1', [req.user.id]);
  res.json(rows);
});

// Earnings
app.get('/api/driver/earnings', auth, async (req,res) => {
  const { rows } = await pool.query('SELECT SUM(amount) AS total FROM payments WHERE driver_id=$1', [req.user.id]);
  res.json(rows[0]);
});

// Socket.IO chat
io.on('connection', socket => {
  socket.on('join', ({userId}) => socket.join(userId));
  socket.on('message', msg => io.emit('message', msg));
});

// Start server
const PORT = process.env.PORT||5000;
server.listen(PORT, ()=> console.log(`Server running on ${PORT}`));