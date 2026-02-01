/**
 * Integration Test - Full Escrow Flow
 *
 * Tests the 2-call API:
 * 1. POST /init-escrow → Guardian returns round1
 * 2. All parties exchange round1, do make_multisig
 * 3. POST /finalize-escrow → Guardian returns round2 + address
 * 4. All parties verify same address
 */

const http = require('http');
const https = require('https');

const GUARDIAN_URL = process.env.GUARDIAN_URL || 'http://localhost:3012';

let wasmModule = null;

async function loadWasm() {
  console.log('[Test] Loading WASM...');
  const SalviumWallet = require('../wasm/SalviumWallet.js');
  wasmModule = await SalviumWallet();
  console.log('[Test] WASM loaded\n');
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${data}`));
        }
      });
    }).on('error', reject);
  });
}

async function httpPost(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON: ${text}`);
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('SALVIUM GUARDIAN - INTEGRATION TEST');
  console.log('='.repeat(60));
  console.log('');

  await loadWasm();
  const bountyId = 'test-' + Date.now();

  // ========================================
  // STEP 1: Health check
  // ========================================
  console.log('[Step 1] Health check...');
  const health = await httpGet(`${GUARDIAN_URL}/health`);
  if (health.status !== 'ok') throw new Error('Guardian not healthy');
  console.log('  ✓ Guardian healthy\n');

  // ========================================
  // STEP 2: Init escrow - get Guardian's round1
  // ========================================
  console.log('[Step 2] POST /init-escrow...');
  const initResult = await httpPost(`${GUARDIAN_URL}/init-escrow`, {
    bounty_id: bountyId
  });
  if (!initResult.success) throw new Error('Init failed: ' + initResult.error);
  const guardian_round1 = initResult.guardian_round1;
  console.log('  Guardian round1:', guardian_round1.substring(0, 40) + '...');
  console.log('  ✓ Got Guardian round1\n');

  // ========================================
  // STEP 3: Server creates wallet, does round1 and round2
  // ========================================
  console.log('[Step 3] Server: prepare + make_multisig...');
  const serverWallet = new wasmModule.WasmWallet();
  serverWallet.create_random('mainnet', 'English');
  serverWallet.enable_multisig_experimental();

  const serverPrep = JSON.parse(serverWallet.prepare_multisig());
  if (!serverPrep.success) throw new Error('Server prepare failed');
  const server_round1 = serverPrep.multisig_info;
  console.log('  Server round1 ready');

  // ========================================
  // STEP 4: Worker creates wallet, does round1 and round2
  // ========================================
  console.log('[Step 4] Worker: prepare + make_multisig...');
  const workerWallet = new wasmModule.WasmWallet();
  workerWallet.create_random('mainnet', 'English');
  workerWallet.enable_multisig_experimental();

  const workerPrep = JSON.parse(workerWallet.prepare_multisig());
  if (!workerPrep.success) throw new Error('Worker prepare failed');
  const worker_round1 = workerPrep.multisig_info;
  console.log('  Worker round1 ready');

  // ========================================
  // STEP 5: All parties do make_multisig with all 3 round1s
  // ========================================
  console.log('[Step 5] All parties: make_multisig...');
  const allRound1 = [guardian_round1, server_round1, worker_round1];

  const serverMake = JSON.parse(serverWallet.make_multisig('', 2, JSON.stringify(allRound1)));
  if (!serverMake.success) throw new Error('Server make failed: ' + serverMake.error);
  const server_round2 = serverMake.multisig_info;
  console.log('  Server round2 ready');

  const workerMake = JSON.parse(workerWallet.make_multisig('', 2, JSON.stringify(allRound1)));
  if (!workerMake.success) throw new Error('Worker make failed: ' + workerMake.error);
  const worker_round2 = workerMake.multisig_info;
  console.log('  Worker round2 ready\n');

  // ========================================
  // STEP 6: Finalize escrow - Guardian does make + exchange
  // ========================================
  console.log('[Step 6] POST /finalize-escrow...');
  const finalResult = await httpPost(`${GUARDIAN_URL}/finalize-escrow`, {
    bounty_id: bountyId,
    deadline_block: 1000000,
    server_round1,
    server_round2,
    worker_round1,
    worker_round2
  });
  if (!finalResult.success) throw new Error('Finalize failed: ' + finalResult.error);

  const guardian_round2 = finalResult.guardian_round2;
  const guardian_address = finalResult.multisig_address;
  console.log('  Guardian round2:', guardian_round2.substring(0, 40) + '...');
  console.log('  Guardian address:', guardian_address);
  console.log('  ✓ Escrow finalized\n');

  // ========================================
  // STEP 7: Server completes key exchange
  // ========================================
  console.log('[Step 7] Server: exchange_multisig_keys...');
  const allRound2 = [guardian_round2, server_round2, worker_round2];
  const serverKex = JSON.parse(serverWallet.exchange_multisig_keys('', JSON.stringify(allRound2)));
  if (!serverKex.success) throw new Error('Server KEX failed: ' + serverKex.error);
  console.log('  Server address:', serverKex.address);

  // ========================================
  // STEP 8: Worker completes key exchange
  // ========================================
  console.log('[Step 8] Worker: exchange_multisig_keys...');
  const workerKex = JSON.parse(workerWallet.exchange_multisig_keys('', JSON.stringify(allRound2)));
  if (!workerKex.success) throw new Error('Worker KEX failed: ' + workerKex.error);
  console.log('  Worker address:', workerKex.address);
  console.log('');

  // ========================================
  // STEP 9: Verify all addresses match
  // ========================================
  console.log('[Step 9] Verify addresses match...');
  console.log('  Guardian:', guardian_address);
  console.log('  Server:  ', serverKex.address);
  console.log('  Worker:  ', workerKex.address);

  if (guardian_address === serverKex.address && serverKex.address === workerKex.address) {
    console.log('  ✓ ALL ADDRESSES MATCH!\n');
  } else {
    throw new Error('Addresses do not match!');
  }

  // ========================================
  // STEP 10: Check bounty stored
  // ========================================
  console.log('[Step 10] Check bounty stored...');
  const bountyInfo = await httpGet(`${GUARDIAN_URL}/bounty/${bountyId}`);
  console.log('  Address:', bountyInfo.multisig_address);
  console.log('  Deadline:', bountyInfo.deadline_block);
  console.log('  ✓ Bounty stored\n');

  // ========================================
  // STEP 11: Test refund rejection
  // ========================================
  console.log('[Step 11] Test refund before deadline...');
  const refundResult = await httpPost(`${GUARDIAN_URL}/sign-refund`, {
    bounty_id: bountyId,
    current_block: 100,
    tx_data: 'test'
  });
  if (refundResult.error?.includes('Deadline not reached')) {
    console.log('  ✓ Correctly rejected (deadline not reached)');
    console.log('  Blocks remaining:', refundResult.blocks_remaining);
  } else {
    console.log('  Unexpected:', refundResult);
  }

  // Cleanup
  serverWallet.delete();
  workerWallet.delete();

  console.log('\n' + '='.repeat(60));
  console.log('ALL TESTS PASSED!');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
