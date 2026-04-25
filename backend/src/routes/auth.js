const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
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
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const { rows } = await db.query('SELECT id, name FROM users WHERE email = $1', [email]);
    const user = rows[0];

    // Always return success to prevent enumeration
    const successMsg = { message: 'If that email exists, a password reset link has been sent.' };

    if (!user) {
      return res.json(successMsg);
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    await db.query(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiresAt]
    );

    const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${token}`;

    setImmediate(() => {
      sendEmail({
        to: email,
        subject: 'Password Reset Request',
        text: `Hi ${user.name},\n\nYou requested a password reset. Please use the link below to reset your password. It expires in 15 minutes.\n\n${resetLink}\n\nIf you didn't request this, you can safely ignore this email.`,
        html: `<p>Hi ${user.name},</p><p>You requested a password reset. Please click the link below to reset your password. It expires in 15 minutes.</p><p><a href="${resetLink}">${resetLink}</a></p><p>If you didn't request this, you can safely ignore this email.</p>`
      });
    });

    res.json(successMsg);
  } catch (err) {
    logger.error('Forgot password failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reset password
router.post('/reset-password', authLimiter, async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: 'Token and new password are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const { rows } = await db.query(
      `SELECT prt.id, prt.user_id 
       FROM password_reset_tokens prt
       WHERE prt.token_hash = $1 AND prt.used_at IS NULL AND prt.expires_at > NOW()`,
      [tokenHash]
    );

    const resetToken = rows[0];
    if (!resetToken) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Update password and invalidate token in one transaction
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, resetToken.user_id]);
      await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $3', [resetToken.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ message: 'Password has been reset successfully. You can now log in with your new password.' });
  } catch (err) {
    logger.error('Reset password failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
