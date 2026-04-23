const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const {
  createCampaignWallet,
  getCampaignBalance,
  getSupportedAssetCodes,
} = require('../services/stellarService');
const { watchCampaignWallet } = require('../services/ledgerMonitor');
const SUPPORTED_ASSETS = getSupportedAssetCodes();

// List all active campaigns
router.get('/', async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, title, description, target_amount, raised_amount, asset_type,
            wallet_public_key, status, creator_id, created_at
     FROM campaigns WHERE status = 'active' ORDER BY created_at DESC`
  );
  res.json(rows);
});

// Get single campaign
router.get('/:id', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  res.json(rows[0]);
});

// Get live on-chain balance for a campaign
router.get('/:id/balance', async (req, res) => {
  const { rows } = await db.query(
    'SELECT wallet_public_key FROM campaigns WHERE id = $1',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  const balance = await getCampaignBalance(rows[0].wallet_public_key);
  res.json(balance);
});

// Create campaign (authenticated)
router.post('/', requireAuth, async (req, res) => {
  const { title, description, target_amount, asset_type, deadline } = req.body;
  if (!title || !target_amount || !asset_type) {
    return res.status(400).json({ error: 'title, target_amount and asset_type are required' });
  }
  if (!SUPPORTED_ASSETS.includes(asset_type)) {
    return res.status(400).json({
      error: `asset_type must be one of: ${SUPPORTED_ASSETS.join(', ')}`,
    });
  }

  // Get creator's public key to add as campaign wallet signer
  const { rows: userRows } = await db.query(
    'SELECT wallet_public_key FROM users WHERE id = $1',
    [req.user.userId]
  );
  const creatorPublicKey = userRows[0].wallet_public_key;

  // Create the on-chain campaign wallet
  const wallet = await createCampaignWallet(creatorPublicKey);

  const { rows } = await db.query(
    `INSERT INTO campaigns
       (title, description, target_amount, asset_type, wallet_public_key, creator_id, deadline)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [title, description, target_amount, asset_type, wallet.publicKey, req.user.userId, deadline]
  );

  // Start monitoring the new wallet immediately
  watchCampaignWallet(rows[0].id, wallet.publicKey);

  res.status(201).json(rows[0]);
});

module.exports = router;
