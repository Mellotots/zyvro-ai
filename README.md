# Zyvro AI v9

Polished Zyvro AI frontend on top of the v8 backend.

## Includes
- Text → Video and Image → Video
- 6–15 second duration selector (15s is generated with LTX Fast at 16s then finalized to exactly 15s)
- Portrait 9:16, Landscape 16:9, Square 1:1
- Account login/signup
- Per-account generation history
- Free: 10 videos on first-login day, then 6/day
- Pro: 30 videos/day, no ads, 30 days per successful ₹299 payment
- Razorpay checkout + server-side signature verification
- Polished dashboard, usage meter, responsive mobile UI
- Persistent dark/light theme preference

## Run
1. `npm install`
2. Copy `.env.example` to `.env`
3. Add LTX and Razorpay keys
4. `npm start`
5. Open `http://localhost:3000`

Real LTX generation and Razorpay payments require valid service credentials.
