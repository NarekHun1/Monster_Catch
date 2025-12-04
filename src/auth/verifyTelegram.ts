import * as crypto from 'crypto';

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
): boolean {
  if (!initData || !botToken) {
    console.warn('verifyTelegramInitData: no initData or botToken');
    return false;
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');

  if (!hash) {
    console.warn('verifyTelegramInitData: no hash in initData');
    return false;
  }

  // ❗ УБИРАЕМ ТОЛЬКО hash, signature не трогаем
  params.delete('hash');

  const dataCheckArr: string[] = [];

  Array.from(params.keys())
    .sort()
    .forEach((key) => {
      const value = params.get(key);
      if (value !== null) {
        dataCheckArr.push(`${key}=${value}`);
      }
    });

  const dataCheckString = dataCheckArr.join('\n');

  // HMAC-SHA256(botToken, key = "WebAppData")
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const hmac = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  console.log('--- TELEGRAM VERIFY DEBUG ---');
  console.log('data_check_string:\n' + dataCheckString);
  console.log('our hmac:      ', hmac);
  console.log('telegram hash: ', hash);

  const ok = hmac === hash;
  console.log('signature OK?', ok);

  return ok;
}
