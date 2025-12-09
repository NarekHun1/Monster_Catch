// src/wallet/ton.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TonClient, WalletContractV5R1, internal, SendMode } from '@ton/ton';
import { Address, toNano } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';

@Injectable()
export class TonService {
  private readonly logger = new Logger(TonService.name);
  private readonly client: TonClient;
  private readonly mnemonicWords: string[];

  constructor(private readonly config: ConfigService) {
    const endpoint = this.config.get<string>('TON_ENDPOINT');
    const apiKey = this.config.get<string>('TONCENTER_API_KEY');
    const mnemonic = this.config.get<string>('TON_WALLET_MNEMONIC');

    if (!endpoint) throw new Error('TON_ENDPOINT is not set');
    if (!apiKey) throw new Error('TONCENTER_API_KEY is not set');
    if (!mnemonic) throw new Error('TON_WALLET_MNEMONIC is not set');

    this.client = new TonClient({
      endpoint,
      apiKey,
    });

    this.mnemonicWords = mnemonic.trim().split(/\s+/);
  }

  async sendTon(toAddress: string, amountTon: string): Promise<string> {
    const keyPair = await mnemonicToPrivateKey(this.mnemonicWords);

    const wallet = WalletContractV5R1.create({
      workchain: 0,
      publicKey: keyPair.publicKey,
    });

    const contract = this.client.open(wallet);

    const seqno = await contract.getSeqno();
    this.logger.log(`SEQNO = ${seqno}`);

    await contract.sendTransfer({
      seqno,
      secretKey: keyPair.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      messages: [
        internal({
          to: Address.parse(toAddress),
          value: toNano(amountTon),
        }),
      ],
    });

    return `tx-${Date.now()}`;
  }
}
