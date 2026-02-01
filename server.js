/**
 * Salvium Guardian Server
 *
 * Automated 3rd party for bounty escrow multisig.
 *
 * API Flow (orchestrated by bounty server):
 * 1. POST /init-escrow    → Guardian returns round1
 * 2. Bounty server coordinates round1 exchange
 * 3. POST /finalize-escrow → Guardian does make+exchange, returns round2+address
 * 4. Bounty server coordinates round2 exchange
 *
 * Wallet is kept in memory between init and finalize (typically <1 second).
 * If server restarts, bounty server retries from step 1.
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Configuration
const PORT = process.env.PORT || 3012;
const DATA_DIR = process.env.DATA_DIR || '/data';
const NETWORK = process.env.NETWORK || 'mainnet';

// State
let wasmModule = null;
let isInitialized = false;

// Pending escrows (wallet in memory, waiting for finalize)
const pendingEscrows = new Map();

// Completed bounties (persisted to disk)
const bountyData = new Map();

// Active wallets for signing (kept after finalize)
const activeWallets = new Map();

// Cleanup pending escrows older than 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, escrow] of pendingEscrows) {
    if (now - escrow.created_at > 5 * 60 * 1000) {
      console.log(`[Guardian] Cleaning up stale pending escrow: ${id}`);
      escrow.wallet.delete();
      pendingEscrows.delete(id);
    }
  }
}, 60 * 1000);

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Load the Salvium WASM module
 */
async function loadWasm() {
  console.log('[Guardian] Loading WASM module...');
  const SalviumWallet = require('./wasm/SalviumWallet.js');
  wasmModule = await SalviumWallet();
  console.log('[Guardian] WASM module loaded');
}

/**
 * Save bounty state to disk
 */
function saveBountyState() {
  const bountyFile = path.join(DATA_DIR, 'bounties.json');
  const data = {};
  for (const [id, info] of bountyData) {
    data[id] = info;
  }
  fs.writeFileSync(bountyFile, JSON.stringify(data, null, 2));
}

/**
 * Load bounty state from disk
 */
function loadBountyState() {
  const bountyFile = path.join(DATA_DIR, 'bounties.json');
  if (fs.existsSync(bountyFile)) {
    const data = JSON.parse(fs.readFileSync(bountyFile, 'utf8'));
    for (const [id, info] of Object.entries(data)) {
      bountyData.set(id, info);
    }
    console.log(`[Guardian] Loaded ${bountyData.size} bounties`);
  }
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

/**
 * Health check
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    initialized: isInitialized,
    pendingEscrows: pendingEscrows.size,
    completedBounties: bountyData.size
  });
});

/**
 * Step 1: Initialize escrow - Guardian generates round1
 *
 * Bounty server calls this, then distributes guardian_round1 to all parties.
 */
app.post('/init-escrow', async (req, res) => {
  if (!isInitialized) {
    return res.status(503).json({ error: 'Guardian not initialized' });
  }

  const { bounty_id } = req.body;

  if (!bounty_id) {
    return res.status(400).json({ error: 'Missing required field: bounty_id' });
  }

  // Check if already exists
  if (bountyData.has(bounty_id)) {
    return res.status(409).json({ error: 'Bounty already finalized' });
  }

  // Clean up any existing pending escrow with same ID
  if (pendingEscrows.has(bounty_id)) {
    pendingEscrows.get(bounty_id).wallet.delete();
    pendingEscrows.delete(bounty_id);
  }

  try {
    console.log(`[Guardian] Init escrow: ${bounty_id}`);

    // Create wallet and do round 1
    const wallet = new wasmModule.WasmWallet();
    wallet.create_random(NETWORK, 'English');
    wallet.enable_multisig_experimental();

    const prepResult = JSON.parse(wallet.prepare_multisig());
    if (!prepResult.success) {
      wallet.delete();
      throw new Error('Failed to prepare multisig: ' + prepResult.error);
    }

    // Store in pending (waiting for finalize)
    pendingEscrows.set(bounty_id, {
      wallet,
      guardian_round1: prepResult.multisig_info,
      created_at: Date.now()
    });

    res.json({
      success: true,
      bounty_id,
      guardian_round1: prepResult.multisig_info
    });

  } catch (err) {
    console.error('[Guardian] Init escrow error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Step 2: Finalize escrow - Guardian does make_multisig + exchange_multisig_keys
 *
 * Bounty server sends all round1 and round2 messages.
 * Guardian completes the key exchange and returns the final address.
 */
app.post('/finalize-escrow', async (req, res) => {
  if (!isInitialized) {
    return res.status(503).json({ error: 'Guardian not initialized' });
  }

  const {
    bounty_id,
    deadline_block,
    server_round1,
    server_round2,
    worker_round1,
    worker_round2
  } = req.body;

  if (!bounty_id || !deadline_block || !server_round1 || !server_round2 || !worker_round1 || !worker_round2) {
    return res.status(400).json({
      error: 'Missing required fields: bounty_id, deadline_block, server_round1, server_round2, worker_round1, worker_round2'
    });
  }

  // Get pending escrow
  const pending = pendingEscrows.get(bounty_id);
  if (!pending) {
    return res.status(404).json({
      error: 'Pending escrow not found. Call /init-escrow first.',
      hint: 'The escrow may have expired (5 min timeout) or server restarted.'
    });
  }

  try {
    console.log(`[Guardian] Finalize escrow: ${bounty_id}`);
    const wallet = pending.wallet;
    const guardian_round1 = pending.guardian_round1;

    // Round 2: make_multisig with all round1 messages
    const allRound1 = [guardian_round1, server_round1, worker_round1];
    const makeResult = JSON.parse(wallet.make_multisig('', 2, JSON.stringify(allRound1)));
    if (!makeResult.success) {
      throw new Error('Failed to make multisig: ' + makeResult.error);
    }
    const guardian_round2 = makeResult.multisig_info;

    // Round 3: exchange_multisig_keys with all round2 messages
    const allRound2 = [guardian_round2, server_round2, worker_round2];
    const kexResult = JSON.parse(wallet.exchange_multisig_keys('', JSON.stringify(allRound2)));
    if (!kexResult.success) {
      throw new Error('Failed to exchange keys: ' + kexResult.error);
    }

    const multisig_address = kexResult.address;
    console.log(`[Guardian] Escrow finalized: ${multisig_address}`);

    // Move from pending to completed
    pendingEscrows.delete(bounty_id);

    // Store bounty data
    const bountyInfo = {
      bounty_id,
      deadline_block,
      multisig_address,
      is_ready: kexResult.is_ready,
      created_at: new Date().toISOString(),
      wallet_mnemonic: wallet.get_seed('')
    };
    bountyData.set(bounty_id, bountyInfo);
    saveBountyState();

    // Keep wallet for signing
    activeWallets.set(bounty_id, wallet);

    res.json({
      success: true,
      bounty_id,
      guardian_round1,
      guardian_round2,
      multisig_address,
      is_ready: kexResult.is_ready
    });

  } catch (err) {
    console.error('[Guardian] Finalize escrow error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Sync multisig outputs before creating transactions
 * Both parties must export and import multisig_info to sync state
 */
app.post('/sync-outputs', async (req, res) => {
  if (!isInitialized) {
    return res.status(503).json({ error: 'Guardian not initialized' });
  }

  const { bounty_id, other_multisig_info } = req.body;

  if (!bounty_id) {
    return res.status(400).json({ error: 'Missing required field: bounty_id' });
  }

  const bountyInfo = bountyData.get(bounty_id);
  if (!bountyInfo) {
    return res.status(404).json({ error: 'Bounty not found' });
  }

  try {
    const wallet = activeWallets.get(bounty_id);
    if (!wallet) {
      return res.status(400).json({
        error: 'Wallet not in memory. Use CLI for manual recovery.',
        hint: 'docker exec salvium-guardian node cli.js export-bounty-seed ' + bounty_id
      });
    }

    // Export our multisig info
    const exportResult = JSON.parse(wallet.export_multisig_info());
    if (!exportResult.success) {
      throw new Error('Failed to export multisig info: ' + exportResult.error);
    }
    const guardian_multisig_info = exportResult.info;

    // If other party's info provided, import it
    if (other_multisig_info && Array.isArray(other_multisig_info)) {
      const importResult = JSON.parse(wallet.import_multisig_info(JSON.stringify(other_multisig_info)));
      if (!importResult.success) {
        console.log('[Guardian] Import multisig info warning:', importResult.error);
      } else {
        console.log(`[Guardian] Imported ${importResult.n_outputs} outputs for bounty ${bounty_id}`);
      }
    }

    res.json({
      success: true,
      bounty_id,
      guardian_multisig_info
    });

  } catch (err) {
    console.error('[Guardian] Sync outputs error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Sign a refund transaction (only after deadline)
 * Uses the new sign_multisig_tx_hex WASM function
 */
app.post('/sign-refund', async (req, res) => {
  if (!isInitialized) {
    return res.status(503).json({ error: 'Guardian not initialized' });
  }

  const { bounty_id, current_block, tx_data_hex } = req.body;

  if (!bounty_id || current_block === undefined || !tx_data_hex) {
    return res.status(400).json({
      error: 'Missing required fields: bounty_id, current_block, tx_data_hex'
    });
  }

  const bountyInfo = bountyData.get(bounty_id);
  if (!bountyInfo) {
    return res.status(404).json({ error: 'Bounty not found' });
  }

  // Check deadline
  if (current_block < bountyInfo.deadline_block) {
    return res.status(403).json({
      error: 'Deadline not reached',
      current_block,
      deadline_block: bountyInfo.deadline_block,
      blocks_remaining: bountyInfo.deadline_block - current_block
    });
  }

  try {
    const wallet = activeWallets.get(bounty_id);
    if (!wallet) {
      return res.status(400).json({
        error: 'Wallet not in memory. Use CLI for manual recovery.',
        hint: 'docker exec salvium-guardian node cli.js export-bounty-seed ' + bounty_id
      });
    }

    // Describe the transaction first to verify it's a valid refund
    if (typeof wallet.describe_multisig_tx_hex === 'function') {
      const descResult = JSON.parse(wallet.describe_multisig_tx_hex(tx_data_hex));
      console.log(`[Guardian] Refund tx for bounty ${bounty_id}:`, descResult);
    }

    // Sign the multisig transaction
    if (typeof wallet.sign_multisig_tx_hex !== 'function') {
      return res.status(501).json({
        error: 'sign_multisig_tx_hex not available in WASM',
        hint: 'Update WASM to version with multisig transaction support'
      });
    }

    const signResult = JSON.parse(wallet.sign_multisig_tx_hex(tx_data_hex));
    if (!signResult.success) {
      throw new Error('Failed to sign refund: ' + signResult.error);
    }

    console.log(`[Guardian] Signed refund for bounty ${bounty_id}, ready: ${signResult.ready}`);

    res.json({
      success: true,
      bounty_id,
      tx_data_hex: signResult.tx_data_hex,
      signers: signResult.signers,
      ready: signResult.ready
    });

  } catch (err) {
    console.error('[Guardian] Sign refund error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Sign a payout transaction (dispute resolution - worker + guardian)
 * This is for when the worker disputes and guardian sides with them
 */
app.post('/sign-payout', async (req, res) => {
  if (!isInitialized) {
    return res.status(503).json({ error: 'Guardian not initialized' });
  }

  const { bounty_id, tx_data_hex, reason } = req.body;

  if (!bounty_id || !tx_data_hex) {
    return res.status(400).json({
      error: 'Missing required fields: bounty_id, tx_data_hex'
    });
  }

  const bountyInfo = bountyData.get(bounty_id);
  if (!bountyInfo) {
    return res.status(404).json({ error: 'Bounty not found' });
  }

  try {
    const wallet = activeWallets.get(bounty_id);
    if (!wallet) {
      return res.status(400).json({
        error: 'Wallet not in memory. Use CLI for manual recovery.',
        hint: 'docker exec salvium-guardian node cli.js export-bounty-seed ' + bounty_id
      });
    }

    // For dispute resolution, guardian should manually verify
    // In production, this would require human review
    console.log(`[Guardian] Payout request for bounty ${bounty_id}, reason: ${reason || 'none provided'}`);

    // Describe the transaction
    if (typeof wallet.describe_multisig_tx_hex === 'function') {
      const descResult = JSON.parse(wallet.describe_multisig_tx_hex(tx_data_hex));
      console.log(`[Guardian] Payout tx details:`, descResult);
    }

    // Sign the multisig transaction
    if (typeof wallet.sign_multisig_tx_hex !== 'function') {
      return res.status(501).json({
        error: 'sign_multisig_tx_hex not available in WASM'
      });
    }

    const signResult = JSON.parse(wallet.sign_multisig_tx_hex(tx_data_hex));
    if (!signResult.success) {
      throw new Error('Failed to sign payout: ' + signResult.error);
    }

    console.log(`[Guardian] Signed payout for bounty ${bounty_id}, ready: ${signResult.ready}`);

    res.json({
      success: true,
      bounty_id,
      tx_data_hex: signResult.tx_data_hex,
      signers: signResult.signers,
      ready: signResult.ready
    });

  } catch (err) {
    console.error('[Guardian] Sign payout error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get bounty info
 */
app.get('/bounty/:id', (req, res) => {
  const bountyInfo = bountyData.get(req.params.id);
  if (!bountyInfo) {
    // Check if pending
    if (pendingEscrows.has(req.params.id)) {
      return res.json({
        bounty_id: req.params.id,
        status: 'pending',
        message: 'Waiting for /finalize-escrow'
      });
    }
    return res.status(404).json({ error: 'Bounty not found' });
  }

  res.json({
    bounty_id: bountyInfo.bounty_id,
    deadline_block: bountyInfo.deadline_block,
    multisig_address: bountyInfo.multisig_address,
    is_ready: bountyInfo.is_ready,
    created_at: bountyInfo.created_at,
    wallet_in_memory: activeWallets.has(req.params.id)
  });
});

/**
 * List all bounties
 */
app.get('/bounties', (req, res) => {
  const bounties = [];
  for (const [id, info] of bountyData) {
    bounties.push({
      bounty_id: id,
      deadline_block: info.deadline_block,
      multisig_address: info.multisig_address,
      is_ready: info.is_ready,
      created_at: info.created_at
    });
  }

  res.json({
    pending: pendingEscrows.size,
    completed: bounties.length,
    bounties
  });
});

// ============================================================================
// STARTUP
// ============================================================================

async function main() {
  try {
    await loadWasm();
    loadBountyState();
    isInitialized = true;

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Guardian] Server running on port ${PORT}`);
      console.log(`[Guardian] API Flow:`);
      console.log(`  1. POST /init-escrow     → Get guardian_round1`);
      console.log(`  2. POST /finalize-escrow → Complete key exchange`);
      console.log(`  3. POST /sign-refund     → Sign refund (after deadline)`);
    });
  } catch (err) {
    console.error('[Guardian] Failed to start:', err);
    process.exit(1);
  }
}

main();
