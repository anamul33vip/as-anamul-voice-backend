# AS ANAMUL VOICE Backend — বাংলা সেটআপ

এই ফোল্ডারে Node.js + Express API, Web Admin Panel এবং Gemini TTS endpoint আছে। Android অ্যাপের বর্তমান `Api.kt`-এর route-গুলোর সঙ্গে API path মিলিয়ে রাখা হয়েছে।

## যা আছে
- Access Key তৈরি/মুছা, মেয়াদ, এক ডিভাইসে লক, Ban/Unban, Reset Device
- Redeem Code
- Online ping, দৈনিক পরিসংখ্যান ও activity log
- App config, announcement, minimum version ও maintenance switch
- Gemini TTS থেকে WAV audio
- `/admin` ওয়েব অ্যাডমিন প্যানেল
- `/healthz` health check

## স্থানীয়ভাবে চালানো
Node.js 20 বা তার পরের LTS সংস্করণ ব্যবহার করুন। এই ফোল্ডারে টার্মিনাল খুলে:

```bash
npm install
```

এরপর environment variables সেট করুন:

```bash
ADMIN_PASSWORD='একটি দীর্ঘ ও অনন্য পাসওয়ার্ড'
TOKEN_SECRET='কমপক্ষে ৩২ অক্ষরের একটি র‍্যান্ডম গোপন স্ট্রিং'
GEMINI_API_KEY='আপনার Gemini API key'
DB_FILE='./data.json'
npm start
```

Windows PowerShell-এ environment variable সেট করার ধরন:

```powershell
$env:ADMIN_PASSWORD='একটি দীর্ঘ ও অনন্য পাসওয়ার্ড'
$env:TOKEN_SECRET='কমপক্ষে ৩২ অক্ষরের একটি র‍্যান্ডম গোপন স্ট্রিং'
$env:GEMINI_API_KEY='আপনার Gemini API key'
$env:DB_FILE='./data.json'
npm start
```

তারপর `http://localhost:3000/admin` খুলুন। Production-এ অবশ্যই HTTPS ব্যবহার করবেন।

## Render-এ Deploy
1. এই backend ফোল্ডারটি GitHub repository-তে রাখুন।
2. Render-এ নতুন Web Service তৈরি করে এই ফোল্ডারকে Root Directory দিন।
3. Build command: `npm install`
4. Start command: `npm start`
5. Environment Variables-এ `ADMIN_PASSWORD`, `TOKEN_SECRET`, `GEMINI_API_KEY` যোগ করুন।
6. Persistent Disk যুক্ত করে Mount Path `/var/data` দিন এবং `DB_FILE=/var/data/data.json` সেট করুন।
7. Deploy শেষে `https://আপনার-সার্ভিস.onrender.com/healthz` এবং `/admin` পরীক্ষা করুন।

`TOKEN_SECRET` বদলালে আগের লগইন টোকেন অকার্যকর হবে। `ADMIN_PASSWORD` ও `TOKEN_SECRET` কখনো GitHub-এ লিখবেন না।

## গুরুত্বপূর্ণ সীমাবদ্ধতা
- বর্তমান Android সোর্স `/api/app/tts` দিয়ে text-to-speech audio নেয় এবং ফোনে প্লে করে। Shizuku injection ফোনের স্থানীয় Android অংশ।
- এই backend নিজে microphone recording বা bidirectional real-time audio stream করে না। এগুলো যোগ করতে Android UI/কোড এবং আলাদা streaming integration-ও আপডেট করতে হবে।
- JSON database ছোট/পরীক্ষামূলক ব্যবহারের জন্য। একাধিক server instance বা বড় ব্যবহারকারীর জন্য PostgreSQL/Firestore-এ migration করা উচিত।
- Gemini API key ছাড়া TTS endpoint `TTS_NOT_CONFIGURED` দেখাবে। Gemini API-তে usage charge/quota প্রযোজ্য হতে পারে।
