const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const {
  submitPayment,
  submitPathPayment,
  getPathPaymentQuote,
  getSupportedAssetCodes,
} = require('../services/stellarService');

const SLIPPAGE_BPS = 500; // 5.00%
const SUPPORTED_ASSETS = getSupportedAssetCodes();

// Get contributions for a campaign
router.get('/campaign/:campaignId', async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, sender_public_key, amount, asset, payment_type, source_amount,
            source_asset, conversion_rate, path, tx_hash, created_at
     FROM contributions WHERE campaign_id = $1 ORDER BY created_at DESC`,
    [req.params.campaignId]
  );
  res.json(rows);
});

// Quote conversion before a path payment contribution
router.get('/quote', requireAuth, async (req, res) => {
  const { send_asset, dest_asset, dest_amount } = req.query;
  if (!send_asset || !dest_asset || !dest_amount) {
    return res.status(400).json({
      error: 'send_asset, dest_asset and dest_amount are required query params',
    });
  }
  if (!SUPPORTED_ASSETS.includes(send_asset) || !SUPPORTED_ASSETS.includes(dest_asset)) {
    return res.status(400).json({ error: `Supported assets: ${SUPPORTED_ASSETS.join(', ')}` });
  }

  const paths = await getPathPaymentQuote({
    sendAsset: send_asset,
    destAsset: dest_asset,
    destAmount: dest_amount,
  });

  if (!paths.length) {
    return res.status(404).json({ error: 'No conversion path found for requested assets' });
  }

  const bestPath = paths[0];
  const maxSendWithSlippage = (
    parseFloat(bestPath.source_amount) *
    (1 + SLIPPAGE_BPS / 10000)
  ).toFixed(7);

  res.json({
    send_asset,
    dest_asset,
    dest_amount: String(dest_amount),
    quoted_source_amount: bestPath.source_amount,
    max_send_amount: maxSendWithSlippage,
    estimated_rate: (
      parseFloat(dest_amount) / parseFloat(bestPath.source_amount)
    ).toFixed(15),
    path: bestPath.path,
    path_count: paths.length,
  });
});

// Contribute to a campaign (authenticated, custodial)
router.post('/', requireAuth, async (req, res) => {
  const { campaign_id, amount, send_asset } = req.body;
  if (!campaign_id || !amount || !send_asset) {
    return res.status(400).json({ error: 'campaign_id, amount and send_asset are required' });
  }
  if (!SUPPORTED_ASSETS.includes(send_asset)) {
    return res.status(400).json({ error: `Supported assets: ${SUPPORTED_ASSETS.join(', ')}` });
  }

  // Load campaign
  const { rows: campaigns } = await db.query(
    'SELECT * FROM campaigns WHERE id = $1 AND status = $2',
    [campaign_id, 'active']
  );
  if (!campaigns.length) return res.status(404).json({ error: 'Campaign not found' });

  const campaign = campaigns[0];

  // Load contributor's custodial secret
  const { rows: users } = await db.query(
    'SELECT wallet_secret_encrypted FROM users WHERE id = $1',
    [req.user.userId]
  );
  const senderSecret = users[0].wallet_secret_encrypted; // decrypt in production

  let txHash;
  let conversionQuote = null;

  if (send_asset === campaign.asset_type) {
    // Direct payment — same asset, no conversion needed
    txHash = await submitPayment({
      senderSecret,
      destinationPublicKey: campaign.wallet_public_key,
      asset: send_asset,
      amount,
      memo: `cp-${campaign_id}`,
    });
  } else {
    // Path payment — contributor sends one supported asset, campaign receives its default asset
    const paths = await getPathPaymentQuote({
      sendAsset: send_asset,
      destAsset: campaign.asset_type,
      destAmount: amount,
    });
    if (!paths.length) {
      return res.status(422).json({
        error: `No conversion path found for ${send_asset} -> ${campaign.asset_type}`,
      });
    }

    const bestPath = paths[0];
    const sendMax = (
      parseFloat(bestPath.source_amount) *
      (1 + SLIPPAGE_BPS / 10000)
    ).toFixed(7);

    txHash = await submitPathPayment({
      senderSecret,
      destinationPublicKey: campaign.wallet_public_key,
      sendAsset: send_asset,
      sendMax,
      destAmount: amount,
      memo: `cp-${campaign_id}`,
    });

    conversionQuote = {
      send_asset,
      campaign_asset: campaign.asset_type,
      campaign_amount: String(amount),
      quoted_source_amount: bestPath.source_amount,
      max_send_amount: sendMax,
      path: bestPath.path,
    };
  }

  // The ledger monitor will index this automatically, but return tx hash immediately
  res.status(202).json({
    tx_hash: txHash,
    message: 'Transaction submitted',
    conversion_quote: conversionQuote,
  });
});

module.exports = router;
