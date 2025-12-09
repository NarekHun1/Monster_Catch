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

    const oldSeqno = await contract.getSeqno();
    this.logger.log(`SEQNO before: ${oldSeqno}`);

    // отправляем транзакцию
    await contract.sendTransfer({
      seqno: oldSeqno,
      secretKey: keyPair.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
      messages: [
        internal({
          to: Address.parse(toAddress),
          value: toNano(amountTon),
        }),
      ],
    });

    // ждём подтверждение сети: seqno должен увеличиться
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));

      const newSeqno = await contract.getSeqno();

      if (newSeqno > oldSeqno) {
        this.logger.log(`TON sent! New seqno = ${newSeqno}`);
        return `tx-${Date.now()}`;
      }
    }

    throw new Error('TON NOT SENT — seqno did NOT increase!');
  }
}
