/**
 * ledgerMonitor.js
 *
 * Opens Horizon streaming connections for all active campaign wallets.
 * When a payment is detected, it indexes the contribution in PostgreSQL
 * and updates the campaign's raised amount.
 */

const { server } = require('../config/stellar');
const db = require('../config/database');

// Map of publicKey -> EventSource (so we can close them if needed)
const activeStreams = new Map();

async function watchCampaignWallet(campaignId, walletPublicKey) {
  if (activeStreams.has(walletPublicKey)) return;

  console.log(`[monitor] Watching campaign ${campaignId} wallet ${walletPublicKey}`);

  const closeStream = server
    .payments()
    .forAccount(walletPublicKey)
    .cursor('now')
    .stream({
      onmessage: (payment) => handlePayment(campaignId, walletPublicKey, payment),
      onerror: (err) => {
        console.error(`[monitor] Stream error for ${walletPublicKey}:`, err.message);
      },
    });

  activeStreams.set(walletPublicKey, closeStream);
}

async function handlePayment(campaignId, walletPublicKey, payment) {
  // Only process incoming payments
  if (payment.to !== walletPublicKey) return;
  if (payment.type !== 'payment' && payment.type !== 'path_payment_strict_receive') return;

  const destinationAsset = payment.asset_type === 'native' ? 'XLM' : payment.asset_code;
  const destinationAmount = parseFloat(payment.amount);
  const sourceAsset = payment.source_asset_type
    ? (payment.source_asset_type === 'native' ? 'XLM' : payment.source_asset_code)
    : null;
  const sourceAmount = payment.source_amount ? parseFloat(payment.source_amount) : null;
  const path = Array.isArray(payment.path)
    ? payment.path.map((asset) => (asset.asset_type === 'native' ? 'XLM' : asset.asset_code))
    : null;
  const paymentType = payment.type;
  const conversionRate =
    sourceAmount && destinationAmount ? destinationAmount / sourceAmount : null;
  const txHash = payment.transaction_hash;

  try {
    // Deduplicate by tx hash
    const existing = await db.query(
      'SELECT id FROM contributions WHERE tx_hash = $1',
      [txHash]
    );
    if (existing.rows.length > 0) return;

    await db.query('BEGIN');

    await db.query(
      `INSERT INTO contributions
         (campaign_id, sender_public_key, amount, asset, payment_type, source_amount,
          source_asset, conversion_rate, path, tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      [
        campaignId,
        payment.from,
        destinationAmount,
        destinationAsset,
        paymentType,
        sourceAmount,
        sourceAsset,
        conversionRate,
        path ? JSON.stringify(path) : null,
        txHash,
      ]
    );

    // Update campaign raised amount (normalise to campaign asset later for multi-asset)
    await db.query(
      `UPDATE campaigns SET raised_amount = raised_amount + $1 WHERE id = $2`,
      [destinationAmount, campaignId]
    );

    await db.query('COMMIT');
    console.log(
      `[monitor] Contribution indexed: ${destinationAmount} ${destinationAsset} -> campaign ${campaignId}`
    );
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('[monitor] Failed to index contribution:', err.message);
  }
}

async function startLedgerMonitor() {
  const { rows } = await db.query(
    `SELECT id, wallet_public_key FROM campaigns WHERE status = 'active'`
  );

  for (const campaign of rows) {
    watchCampaignWallet(campaign.id, campaign.wallet_public_key);
  }

  console.log(`[monitor] Watching ${rows.length} active campaign(s)`);
}

module.exports = { startLedgerMonitor, watchCampaignWallet };
