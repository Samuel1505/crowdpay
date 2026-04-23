const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ queryImpl, stellarImpl }) {
  const stellarStub = {
    submitPayment: async () => 'unused',
    submitPathPayment: async () => 'unused',
    getPathPaymentQuote: async () => [],
    getSupportedAssetCodes: () => ['XLM', 'USDC'],
    ...stellarImpl,
  };

  const router = proxyquire('./contributions', {
    '../config/database': { query: queryImpl },
    '../services/stellarService': stellarStub,
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-1' };
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/contributions', router);
  return app;
}

test('GET /api/contributions/quote returns best path quote', async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
    stellarImpl: {
      submitPayment: async () => 'unused',
      submitPathPayment: async () => 'unused',
      getPathPaymentQuote: async () => [
        {
          source_asset: 'XLM',
          destination_asset: 'USDC',
          source_amount: '10.0000000',
          destination_amount: '9.0000000',
          path: ['AQUA'],
        },
      ],
    },
  });

  const response = await request(app)
    .get('/api/contributions/quote?send_asset=XLM&dest_asset=USDC&dest_amount=9')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.quoted_source_amount, '10.0000000');
  assert.equal(response.body.max_send_amount, '10.5000000');
  assert.equal(response.body.estimated_rate, '0.900000000000000');
});

test('GET /api/contributions/quote returns 404 when no path exists', async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
    stellarImpl: {
      submitPayment: async () => 'unused',
      submitPathPayment: async () => 'unused',
      getPathPaymentQuote: async () => [],
    },
  });

  const response = await request(app)
    .get('/api/contributions/quote?send_asset=XLM&dest_asset=USDC&dest_amount=9')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 404);
});

test('POST /api/contributions uses direct payment for same asset', async () => {
  const submitted = [];
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: 'c-1', status: 'active', asset_type: 'XLM', wallet_public_key: 'GDEST' }],
        };
      }
      if (text.includes('FROM users')) {
        return { rows: [{ wallet_secret_encrypted: 'SSECRET' }] };
      }
      return { rows: [] };
    },
    stellarImpl: {
      submitPayment: async (payload) => {
        submitted.push(payload);
        return 'tx-direct';
      },
      submitPathPayment: async () => {
        throw new Error('should not be called');
      },
      getPathPaymentQuote: async () => [],
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: 'c-1', amount: '5.0000000', send_asset: 'XLM' });

  assert.equal(response.status, 202);
  assert.equal(response.body.tx_hash, 'tx-direct');
  assert.equal(submitted.length, 1);
});

test('POST /api/contributions uses direct payment for same USDC asset', async () => {
  const submitted = [];
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: 'c-2', status: 'active', asset_type: 'USDC', wallet_public_key: 'GDEST2' }],
        };
      }
      if (text.includes('FROM users')) {
        return { rows: [{ wallet_secret_encrypted: 'SSECRET' }] };
      }
      return { rows: [] };
    },
    stellarImpl: {
      submitPayment: async (payload) => {
        submitted.push(payload);
        return 'tx-direct-usdc';
      },
      submitPathPayment: async () => {
        throw new Error('should not be called');
      },
      getPathPaymentQuote: async () => [],
      getSupportedAssetCodes: () => ['XLM', 'USDC'],
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: 'c-2', amount: '7.0000000', send_asset: 'USDC' });

  assert.equal(response.status, 202);
  assert.equal(response.body.tx_hash, 'tx-direct-usdc');
  assert.equal(submitted.length, 1);
});

test('POST /api/contributions uses path payment for conversion', async () => {
  let pathPayload = null;
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: 'c-1', status: 'active', asset_type: 'USDC', wallet_public_key: 'GDEST' }],
        };
      }
      if (text.includes('FROM users')) {
        return { rows: [{ wallet_secret_encrypted: 'SSECRET' }] };
      }
      return { rows: [] };
    },
    stellarImpl: {
      submitPayment: async () => {
        throw new Error('should not be called');
      },
      submitPathPayment: async (payload) => {
        pathPayload = payload;
        return 'tx-path';
      },
      getPathPaymentQuote: async () => [
        {
          source_asset: 'XLM',
          destination_asset: 'USDC',
          source_amount: '5.0000000',
          destination_amount: '4.5000000',
          path: [],
        },
      ],
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: 'c-1', amount: '4.5000000', send_asset: 'XLM' });

  assert.equal(response.status, 202);
  assert.equal(response.body.tx_hash, 'tx-path');
  assert.equal(response.body.conversion_quote.max_send_amount, '5.2500000');
  assert.equal(pathPayload.sendMax, '5.2500000');
  assert.equal(pathPayload.destAmount, '4.5000000');
});

test('POST /api/contributions supports reverse conversion USDC -> XLM', async () => {
  let pathPayload = null;
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: 'c-3', status: 'active', asset_type: 'XLM', wallet_public_key: 'GDEST3' }],
        };
      }
      if (text.includes('FROM users')) {
        return { rows: [{ wallet_secret_encrypted: 'SSECRET' }] };
      }
      return { rows: [] };
    },
    stellarImpl: {
      submitPayment: async () => {
        throw new Error('should not be called');
      },
      submitPathPayment: async (payload) => {
        pathPayload = payload;
        return 'tx-path-reverse';
      },
      getPathPaymentQuote: async () => [
        {
          source_asset: 'USDC',
          destination_asset: 'XLM',
          source_amount: '12.0000000',
          destination_amount: '10.0000000',
          path: ['AQUA'],
        },
      ],
      getSupportedAssetCodes: () => ['XLM', 'USDC'],
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: 'c-3', amount: '10.0000000', send_asset: 'USDC' });

  assert.equal(response.status, 202);
  assert.equal(response.body.tx_hash, 'tx-path-reverse');
  assert.equal(response.body.conversion_quote.max_send_amount, '12.6000000');
  assert.equal(pathPayload.sendAsset, 'USDC');
  assert.equal(pathPayload.destAmount, '10.0000000');
});
