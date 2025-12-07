// src/wallet/ton.service.ts
import { Injectable } from '@nestjs/common';
import { TonClient, WalletContractV4, internal } from '@ton/ton';
import { Address, toNano } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';

@Injectable()
export class TonService {
  private client: TonClient;
  private mnemonicWords: string[];

  constructor() {
    const endpoint = process.env.TON_ENDPOINT;
    const mnemonic = process.env.TON_WALLET_MNEMONIC;

    if (!endpoint) {
      throw new Error('TON_ENDPOINT is not set');
    }
    if (!mnemonic) {
      throw new Error('TON_WALLET_MNEMONIC is not set');
    }

    this.client = new TonClient({ endpoint });
    this.mnemonicWords = mnemonic.trim().split(/\s+/);
  }

  /**
   * Отправка TON с проектного кошелька на адрес пользователя.
   * amountTon — строка, например "0.5"
   * Возвращаем строку (txHash или просто id операции, пока можно заглушку).
   */
  async sendTon(toAddress: string, amountTon: string): Promise<string> {
    const keyPair = await mnemonicToPrivateKey(this.mnemonicWords);

    const wallet = WalletContractV4.create({
      workchain: 0,
      publicKey: keyPair.publicKey,
    });

    const contract = this.client.open(wallet);

    const seqno = await contract.getSeqno();

    await contract.sendTransfer({
      seqno,
      // ❗ ВАЖНО: делаем Buffer из secretKey
      secretKey: Buffer.from(keyPair.secretKey),
      messages: [
        internal({
          to: Address.parse(toAddress),
          value: toNano(amountTon),
        }),
      ],
    });

    // Библиотека не всегда отдаёт прямой txHash.
    // Для простого варианта можешь вернуть, например, `${Date.now()}`
    // или потом доработать получение реального хеша.
    return `ton-transfer-${Date.now()}`;
  }
}
