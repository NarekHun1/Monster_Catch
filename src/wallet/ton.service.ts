// src/wallet/ton.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TonClient, WalletContractV4, internal } from '@ton/ton';
import { Address, toNano } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';

@Injectable()
export class TonService {
  private readonly client: TonClient;
  private readonly mnemonicWords: string[];

  constructor(private readonly config: ConfigService) {
    const endpoint = this.config.get<string>('TON_ENDPOINT');
    const apiKey = this.config.get<string>('TONCENTER_API_KEY');
    const mnemonic = this.config.get<string>('TON_WALLET_MNEMONIC');

    if (!endpoint) {
      throw new Error('TON_ENDPOINT is not set');
    }
    if (!apiKey) {
      throw new Error('TONCENTER_API_KEY is not set');
    }
    if (!mnemonic) {
      throw new Error('TON_WALLET_MNEMONIC is not set');
    }

    this.client = new TonClient({
      endpoint,
      apiKey,
    });

    this.mnemonicWords = mnemonic.trim().split(/\s+/);
  }

  /**
   * Отправка TON с проектного кошелька на адрес пользователя.
   * amountTon — строка, например "0.5"
   * Возвращаем строку (txHash или пока просто id операции).
   */
  async sendTon(toAddress: string, amountTon: string): Promise<string> {
    // получаем приватный ключ из мнемоники
    const keyPair = await mnemonicToPrivateKey(this.mnemonicWords);

    const wallet = WalletContractV4.create({
      workchain: 0,
      publicKey: keyPair.publicKey,
    });

    const contract = this.client.open(wallet);

    const seqno = await contract.getSeqno();

    await contract.sendTransfer({
      seqno,
      // ВАЖНО: делаем Buffer из secretKey, иначе будет ошибка типов
      secretKey: Buffer.from(keyPair.secretKey),
      messages: [
        internal({
          to: Address.parse(toAddress),
          value: toNano(amountTon),
        }),
      ],
    });

    // Тут можно потом доработать получение реального txHash.
    return `ton-transfer-${Date.now()}`;
  }
}
