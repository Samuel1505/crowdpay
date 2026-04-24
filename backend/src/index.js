require('dotenv').config();
require('./config/env').validateEnv();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const logger = require('./config/logger');
const { requestIdMiddleware } = require('./middleware/requestId');
const { startLedgerMonitor } = require('./services/ledgerMonitor');
const { sendAlert } = require('./services/alerting');

const app = express();

app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : '*'
}));
app.use(express.json({ limit: '50kb' }));

app.use('/api/users', require('./routes/users'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/contributions', require('./routes/contributions'));
app.use('/api/withdrawals', require('./routes/withdrawals'));
app.use('/api/stellar/transactions', require('./routes/stellarTransactions'));
app.use('/api/admin', require('./routes/admin'));

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info('CrowdPay backend started', {
    port: PORT,
    stellar_network: process.env.STELLAR_NETWORK,
  });
  startLedgerMonitor().catch((err) => {
    logger.error('Ledger monitor failed to start', { error: err.message });
    sendAlert('Startup failure: ledger monitor could not start', { error: err.message });
  });
});
