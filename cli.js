#!/usr/bin/env node
/**
 * Salvium Guardian CLI
 *
 * Manual intervention tool using WASM wallet.
 *
 * Usage:
 *   node cli.js status                    - Show guardian status
 *   node cli.js bounties                  - List all bounties
 *   node cli.js bounty <id>               - Show bounty details
 *   node cli.js sign-refund <id>          - Manually sign refund (ignores deadline)
 *   node cli.js export-seed               - Export guardian master seed
 *   node cli.js export-bounty-seed <id>   - Export bounty wallet seed
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';

async function loadWasm() {
  const SalviumWallet = require('./wasm/SalviumWallet.js');
  return await SalviumWallet();
}

function loadGuardianState() {
  const file = path.join(DATA_DIR, 'guardian-state.json');
  if (!fs.existsSync(file)) {
    console.error('Guardian not initialized. Run the server first.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadBounties() {
  const file = path.join(DATA_DIR, 'bounties.json');
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveBounties(bounties) {
  const file = path.join(DATA_DIR, 'bounties.json');
  fs.writeFileSync(file, JSON.stringify(bounties, null, 2));
}

async function cmdStatus() {
  const state = loadGuardianState();
  const bounties = loadBounties();

  console.log('=== Guardian Status ===');
  console.log('Created:', state.createdAt);
  console.log('Public Info:', state.publicInfo.substring(0, 50) + '...');
  console.log('Bounties:', Object.keys(bounties).length);
}

async function cmdBounties() {
  const bounties = loadBounties();

  if (Object.keys(bounties).length === 0) {
    console.log('No bounties registered.');
    return;
  }

  console.log('=== Bounties ===\n');
  for (const [id, info] of Object.entries(bounties)) {
    console.log(`ID: ${id}`);
    console.log(`  Deadline Block: ${info.deadline_block}`);
    console.log(`  Address: ${info.multisig_address || 'pending'}`);
    console.log(`  Ready: ${info.is_ready || false}`);
    console.log(`  Created: ${info.created_at}`);
    console.log('');
  }
}

async function cmdBounty(id) {
  const bounties = loadBounties();
  const info = bounties[id];

  if (!info) {
    console.error(`Bounty ${id} not found.`);
    process.exit(1);
  }

  console.log('=== Bounty Details ===\n');
  console.log(JSON.stringify(info, null, 2));
}

async function cmdSignRefund(id) {
  const bounties = loadBounties();
  const info = bounties[id];

  if (!info) {
    console.error(`Bounty ${id} not found.`);
    process.exit(1);
  }

  if (!info.is_ready) {
    console.error('Bounty multisig not fully set up.');
    process.exit(1);
  }

  console.log('Loading WASM...');
  const wasm = await loadWasm();

  console.log('Restoring bounty wallet...');
  const wallet = new wasm.WasmWallet();
  wallet.restore_from_seed(info.wallet_mnemonic, 'English', 0);
  wallet.enable_multisig_experimental();

  console.log('Wallet restored.');
  console.log('Address:', info.multisig_address);
  console.log('');
  console.log('To complete manual signing:');
  console.log('1. Get the unsigned transaction from the bounty server');
  console.log('2. Use the sign_multisig method with the tx data');
  console.log('');
  console.log('Bounty wallet seed (for CLI wallet if needed):');
  console.log(info.wallet_mnemonic);

  wallet.delete();
}

async function cmdExportSeed() {
  const state = loadGuardianState();

  console.log('=== Guardian Master Seed ===');
  console.log('');
  console.log('WARNING: Keep this secret! Anyone with this seed');
  console.log('can restore your guardian wallet.');
  console.log('');
  console.log(state.mnemonic);
}

async function cmdExportBountySeed(id) {
  const bounties = loadBounties();
  const info = bounties[id];

  if (!info) {
    console.error(`Bounty ${id} not found.`);
    process.exit(1);
  }

  console.log(`=== Bounty ${id} Seed ===`);
  console.log('');
  console.log('WARNING: Keep this secret!');
  console.log('');
  console.log(info.wallet_mnemonic);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case 'status':
      await cmdStatus();
      break;
    case 'bounties':
      await cmdBounties();
      break;
    case 'bounty':
      if (!args[1]) {
        console.error('Usage: node cli.js bounty <id>');
        process.exit(1);
      }
      await cmdBounty(args[1]);
      break;
    case 'sign-refund':
      if (!args[1]) {
        console.error('Usage: node cli.js sign-refund <id>');
        process.exit(1);
      }
      await cmdSignRefund(args[1]);
      break;
    case 'export-seed':
      await cmdExportSeed();
      break;
    case 'export-bounty-seed':
      if (!args[1]) {
        console.error('Usage: node cli.js export-bounty-seed <id>');
        process.exit(1);
      }
      await cmdExportBountySeed(args[1]);
      break;
    default:
      console.log('Salvium Guardian CLI');
      console.log('');
      console.log('Commands:');
      console.log('  status                    - Show guardian status');
      console.log('  bounties                  - List all bounties');
      console.log('  bounty <id>               - Show bounty details');
      console.log('  sign-refund <id>          - Manual refund signing');
      console.log('  export-seed               - Export guardian master seed');
      console.log('  export-bounty-seed <id>   - Export bounty wallet seed');
      break;
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
