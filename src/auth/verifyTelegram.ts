import * as crypto from 'crypto';

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
): boolean {
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');

  if (!hash) return false;

  // Сортируем параметры
  const dataCheckArr: string[] = [];
  urlParams.forEach((value, key) => {
    if (key !== 'hash') dataCheckArr.push(`${key}=${value}`);
  });

  dataCheckArr.sort();

  const dataCheckString = dataCheckArr.join('\n');

  // Ключ = SHA256(token)
  const secretKey = crypto.createHash('sha256').update(botToken).digest();

  // Вычисляем HMAC SHA-256
  const hmac = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  return hmac === hash;
}
