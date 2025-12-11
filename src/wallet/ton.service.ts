// src/wallet/ton.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TonClient, WalletContractV5R1, internal } from '@ton/ton';
import { Address, toNano, SendMode, fromNano } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';

@Injectable()
export class TonService {
  public walletAddress: string;

  private readonly client: TonClient;
  private readonly mnemonicWords: string[];

  constructor(private readonly config: ConfigService) {
    const endpoint = this.config.get<string>('TON_ENDPOINT');
    const apiKey = this.config.get<string>('TONCENTER_API_KEY');
    const mnemonic = this.config.get<string>('TON_WALLET_MNEMONIC');

    if (!endpoint) throw new Error('TON_ENDPOINT is not set');
    if (!apiKey) throw new Error('TONCENTER_API_KEY is not set');
    if (!mnemonic) throw new Error('TON_WALLET_MNEMONIC is not set');

    this.client = new TonClient({ endpoint, apiKey });
    this.mnemonicWords = mnemonic.trim().split(/\s+/);
    this.walletAddress = `UQBMUf6rkqfF_kxnhtdhB855Uah1Bl6fe0MWAZdU9Lnk7nHX`;
  }

  async isWalletDeployed(addr: string): Promise<boolean> {
    try {
      const address = Address.parse(addr);
      return await this.client.isContractDeployed(address);
    } catch {
      return false;
    }
  }

  /**
   * Отправка TON пользователю
   */
  async sendTon(toAddress: string, amountTon: string): Promise<string> {
    // --------------------------------------------
    // 1️⃣ НОРМАЛИЗАЦИЯ АДРЕСА
    // --------------------------------------------
    let normalized: string;
    try {
      const parsed = Address.parse(toAddress);
      normalized = parsed.toString({ bounceable: true });
    } catch {
      throw new BadRequestException('INVALID_TON_ADDRESS');
    }

    console.log('[TON] normalized user address =', normalized);

    // --------------------------------------------
    // 2️⃣ Получаем проектный кошелёк
    // --------------------------------------------
    const keyPair = await mnemonicToPrivateKey(this.mnemonicWords);

    const projectWallet = WalletContractV5R1.create({
      workchain: 0,
      publicKey: keyPair.publicKey,
    });

    const projectFriendly = projectWallet.address.toString();
    console.log('[TON] Project wallet =', projectFriendly);

    // --------------------------------------------
    // 3️⃣ Запрет на отправку самому себе
    // --------------------------------------------
    if (normalized === projectFriendly) {
      throw new BadRequestException('CANNOT_WITHDRAW_TO_PROJECT_WALLET');
    }

    const contract = this.client.open(projectWallet);

    // --------------------------------------------
    // 4️⃣ Проверяем деплой и баланс
    // --------------------------------------------
    const isDeployed = await this.client.isContractDeployed(projectWallet.address);
    console.log('[TON] isDeployed =', isDeployed);

    if (!isDeployed) throw new Error('PROJECT_WALLET_NOT_DEPLOYED');

    const balanceBefore = await this.client.getBalance(projectWallet.address);
    console.log('[TON] balance before =', fromNano(balanceBefore), 'TON');

    console.log('[TON] Send to =', normalized);
    console.log('[TON] amount =', amountTon);

    // --------------------------------------------
    // 5️⃣ seqno
    // --------------------------------------------
    const seqnoBefore = await contract.getSeqno();
    console.log('[TON] seqno before =', seqnoBefore);

    // --------------------------------------------
    // 6️⃣ отправка транзакции
    // --------------------------------------------
    await contract.sendTransfer({
      seqno: seqnoBefore,
      secretKey: keyPair.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
      messages: [
        internal({
          to: Address.parse(normalized),
          value: toNano(amountTon),
        }),
      ],
    });

    console.log('[TON] transfer broadcasted, waiting for seqno…');

    // --------------------------------------------
    // 7️⃣ ждем подтверждения
    // --------------------------------------------
    let newSeqno = seqnoBefore;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      newSeqno = await contract.getSeqno();
      console.log(`[TON] seqno #${i} =`, newSeqno);
      if (newSeqno > seqnoBefore) break;
    }

    if (newSeqno === seqnoBefore) {
      throw new Error('TON_TRANSFER_SEQNO_NOT_CHANGED');
    }

    // --------------------------------------------
    // 8️⃣ баланс после
    // --------------------------------------------
    const balanceAfter = await this.client.getBalance(projectWallet.address);
    console.log('[TON] balance after =', fromNano(balanceAfter), 'TON');

    // --------------------------------------------
    // 9️⃣ возвращаем псевдо hash
    // --------------------------------------------
    const pseudoTxId = `${projectFriendly}:${seqnoBefore}`;
    console.log('[TON] TX =', pseudoTxId);

    return pseudoTxId;
  }
}
