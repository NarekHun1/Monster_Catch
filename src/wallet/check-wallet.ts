// src/wallet/check-wallet.ts
import 'dotenv/config';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { fromNano } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';

async function main() {
  const endpoint = process.env.TON_ENDPOINT!;
  const apiKey = process.env.TONCENTER_API_KEY!;
  const mnemonic = process.env.TON_WALLET_MNEMONIC!;
  console.log('TON_ENDPOINT:', endpoint);
  console.log('TONCENTER_API_KEY set:', !!apiKey);
  console.log('TON_WALLET_MNEMONIC set:', !!mnemonic);

  const client = new TonClient({ endpoint, apiKey });

  const mnemonics = mnemonic.trim().split(/\s+/);
  const keyPair = await mnemonicToPrivateKey(mnemonics);

  const wallet = WalletContractV5R1.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });

  console.log('Project wallet (user-friendly):', wallet.address.toString());
  console.log('Project wallet (raw):', wallet.address.toRawString());

  const isDeployed = await client.isContractDeployed(wallet.address);
  console.log('Deployed:', isDeployed);

  const balance = await client.getBalance(wallet.address);
  console.log('Balance TON:', fromNano(balance));
}

main().catch(console.error);
