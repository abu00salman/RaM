# ram-store-api — بوابة Tap لمتجر RaM

## النشر (مرة واحدة)
```bash
npm i -g wrangler && wrangler login
wrangler secret put TAP_SECRET_KEY      # الصق sk_test_... من لوحة Tap → Merchant → API keys
wrangler deploy                          # يعطيك رابطًا مثل https://ram-store-api.xxx.workers.dev
```
ثم ضع الرابط في `ram-store.html` داخل `STORE.api`.

## حفظ الطلبات في D1 (اختياري)
```bash
wrangler d1 create ram-store             # انسخ database_id إلى wrangler.toml وفعّل القسم
wrangler d1 execute ram-store --file=schema.sql --remote
```

## الانتقال للإنتاج
1. `wrangler secret put TAP_SECRET_KEY` بالمفتاح `sk_live_...`
2. في لوحة Tap فعّل مدى / Apple Pay على نطاق متجرك (Apple Pay يتطلب تحقق النطاق من Tap).
3. تأكد أن `ALLOWED_ORIGIN` يطابق نطاق المتجر النهائي.

## بطاقات الاختبار
تجدها في developers.tap.company → Testing. الحالة الناجحة تعود `CAPTURED`.
