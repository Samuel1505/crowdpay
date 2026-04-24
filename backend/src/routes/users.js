const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { Keypair } = require('@stellar/stellar-sdk');
const db = require('../config/database');
const logger = require('../config/logger');
const { ensureCustodialAccountFundedAndTrusted } = require('../services/stellarService');
const { sendEmail } = require('../services/emailService');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Register — creates user + custodial Stellar keypair
router.post('/register', authLimiter, async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'email, password and name are required' });
  }

  const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const keypair = Keypair.random();

  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, wallet_public_key`,
    [email, passwordHash, name, keypair.publicKey(), keypair.secret()]
    // TODO: encrypt secret with KMS before storing in production
  );

  const token = jwt.sign({ userId: rows[0].id, is_admin: false }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });

  const publicKey = keypair.publicKey();
  const secret = keypair.secret();
  const requestId = req.id;
  setImmediate(() => {
    ensureCustodialAccountFundedAndTrusted({ publicKey, secret }).catch((err) => {
      logger.error('Background Stellar funding/trustlines failed', {
        request_id: requestId,
        error: err.message,
      });
    });

    sendEmail({
      to: email,
      subject: 'Welcome to CrowdPay!',
      text: `Welcome ${name}! Your custodial wallet public key is ${publicKey}.`
    });
  });

  res.status(201).json({ token, user: rows[0] });
});

// Login
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);

  if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ userId: rows[0].id, is_admin: rows[0].is_admin }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });

  res.json({
    token,
    user: {
      id: rows[0].id,
      email: rows[0].email,
      name: rows[0].name,
      wallet_public_key: rows[0].wallet_public_key,
      is_admin: rows[0].is_admin,
    },
  });
});

// Forgot password
router.post('/forgot-password', authLimiter, async (req, res) => {
  // Real implementation would send a reset link
  res.json({ message: 'If that email exists, a password reset link has been sent.' });
});

module.exports = router;
