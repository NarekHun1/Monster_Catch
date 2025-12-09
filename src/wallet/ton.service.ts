// src/wallet/ton.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TonClient, WalletContractV5R1, internal } from '@ton/ton';
import { Address, toNano, SendMode, fromNano } from '@ton/core';
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
   * Возвращаем строку-идентификатор операции (можно использовать как txId).
   */
  async sendTon(toAddress: string, amountTon: string): Promise<string> {
    // 1) Получаем ключи из сид-фразы
    const keyPair = await mnemonicToPrivateKey(this.mnemonicWords);

    // 2) Создаём контракт кошелька v5r1 по публичному ключу
    const wallet = WalletContractV5R1.create({
      workchain: 0,
      publicKey: keyPair.publicKey,
    });

    const fromAddress = wallet.address;
    console.log('[TON] Project wallet address:', fromAddress.toString());

    const contract = this.client.open(wallet);

    // 3) Проверяем, задеплоен ли кошелёк и какой баланс
    const isDeployed = await this.client.isContractDeployed(fromAddress);
    console.log('[TON] isDeployed =', isDeployed);

    if (!isDeployed) {
      throw new Error('PROJECT_WALLET_NOT_DEPLOYED');
    }

    const balanceBefore = await this.client.getBalance(fromAddress);
    console.log('[TON] balance before =', fromNano(balanceBefore), 'TON');

    // 4) Логируем, куда и сколько отправляем
    console.log('[TON] send to   =', toAddress);
    console.log('[TON] amountTon =', amountTon);

    // 5) Берём текущий seqno
    const seqnoBefore = await contract.getSeqno();
    console.log('[TON] seqno before =', seqnoBefore);

    // 6) Отправляем транзакцию
    await contract.sendTransfer({
      seqno: seqnoBefore,
      secretKey: keyPair.secretKey,
      // Рекомендуемый режим: платим комиссию отдельно + игнорируем ошибки в обработке сообщения
      sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
      messages: [
        internal({
          to: Address.parse(toAddress),
          value: toNano(amountTon), // amountTon в TON, конвертируем в nanoTON
        }),
      ],
    });

    console.log('[TON] transfer broadcasted, waiting for seqno change...');

    // 7) Ждём, пока seqno увеличится (значит, кошелёк подписал и отправил tx)
    let newSeqno = seqnoBefore;
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      newSeqno = await contract.getSeqno();
      console.log(`[TON] seqno check #${i} =`, newSeqno);
      if (newSeqno > seqnoBefore) {
        break;
      }
    }

    if (newSeqno === seqnoBefore) {
      // seqno не изменился — очень похоже, что транзакция не прошла
      throw new Error('TON_TRANSFER_SEQNO_NOT_CHANGED');
    }

    const balanceAfter = await this.client.getBalance(fromAddress);
    console.log('[TON] balance after =', fromNano(balanceAfter), 'TON');

    // Можно вернуть "псевдо-hash": адрес + старый seqno
    const pseudoTxId = `${fromAddress.toString()}:${seqnoBefore}`;
    console.log('[TON] pseudoTxId =', pseudoTxId);

    return pseudoTxId;
  }
}
