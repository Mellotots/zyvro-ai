const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { pipeline } = require("stream/promises");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();
const PORT = process.env.PORT || 3000;
const LTX_API_KEY = process.env.LTX_API_KEY;
const jobs = new Map();
const sessions = new Map();
const dataDir = path.join(__dirname, "data");
const usersFile = path.join(dataDir, "users.json");
const historyFile = path.join(dataDir, "history.json");
const usageFile = path.join(dataDir, "usage.json");
const FREE_FIRST_LOGIN_LIMIT = 10;
const FREE_DAILY_LIMIT = 6;
const PRO_DAILY_LIMIT = 30;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const PRO_PRICE_INR = Number(process.env.PRO_PRICE_INR || 299);
fs.mkdirSync(dataDir, { recursive: true });
function readJson(file, fallback){try{return JSON.parse(fs.readFileSync(file,"utf8"));}catch{return fallback;}}
function writeJson(file,value){fs.writeFileSync(file,JSON.stringify(value,null,2));}
const users = new Map(Object.entries(readJson(usersFile, {})));
const history = readJson(historyFile, {});
const usage = readJson(usageFile, {});
function saveUsers(){writeJson(usersFile,Object.fromEntries(users));}
function saveHistory(){writeJson(historyFile,history);}
function saveUsage(){writeJson(usageFile,usage);}
function todayKey(){return new Date().toISOString().slice(0,10);}
function getUsage(email){const today=todayKey(); if(!usage[email] || usage[email].date!==today) usage[email]={date:today,count:0}; return usage[email];}
function firstLoginDateFor(user){ return user.firstLoginDate || new Date(user.createdAt || Date.now()).toISOString().slice(0,10); }
function dailyLimitFor(user){ const plan=user.plan||"free"; if(plan==="pro") return PRO_DAILY_LIMIT; return firstLoginDateFor(user)===todayKey() ? FREE_FIRST_LOGIN_LIMIT : FREE_DAILY_LIMIT; }
function getHistory(email){if(!history[email])history[email]=[];return history[email];}
function requireUser(req,res){const u=sessionUser(req);if(!u){res.status(401).json({error:"Please log in first."});return null;}return u;}
const crypto = require("crypto");
function hashPassword(password, salt=crypto.randomBytes(16).toString("hex")){return salt+":"+crypto.scryptSync(password,salt,64).toString("hex");}
function verifyPassword(password, stored){const [salt,hash]=String(stored).split(":");if(!salt||!hash)return false;const test=crypto.scryptSync(password,salt,64).toString("hex");return crypto.timingSafeEqual(Buffer.from(test,"hex"),Buffer.from(hash,"hex"));}
function sessionUser(req){const t=req.headers.cookie?.match(/(?:^|;\s*)zyvro_session=([^;]+)/)?.[1];const e=t?sessions.get(t):null;return e?users.get(e):null;}
function setSession(res,email){const t=crypto.randomBytes(32).toString("hex");sessions.set(t,email);res.setHeader("Set-Cookie",`zyvro_session=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);}

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

function ltxHeaders() {
  return {
    "Authorization": `Bearer ${LTX_API_KEY}`,
    "Content-Type": "application/json"
  };
}

function requireKey(res) {
  if (!LTX_API_KEY) {
    res.status(503).json({
      error: "LTX API key is not configured.",
      hint: "Create a .env file from .env.example and add LTX_API_KEY."
    });
    return false;
  }
  return true;
}


async function trimTo15Seconds(videoUrl) {
  const input = path.join(os.tmpdir(), `zyvro-${Date.now()}-input.mp4`);
  const output = path.join(os.tmpdir(), `zyvro-${Date.now()}-15s.mp4`);
  try {
    const response = await fetch(videoUrl);
    if (!response.ok || !response.body) throw new Error("Could not download the generated video for trimming.");
    await pipeline(response.body, fs.createWriteStream(input));

    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, [
        "-y", "-i", input, "-t", "15",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-movflags", "+faststart", output
      ]);
      let err = "";
      ff.stderr.on("data", d => { err += d.toString(); });
      ff.on("error", reject);
      ff.on("close", code => code === 0 ? resolve() : reject(new Error(`FFmpeg failed (${code}): ${err.slice(-800)}`)));
    });

    return output;
  } catch (e) {
    try { fs.unlinkSync(input); } catch {}
    try { fs.unlinkSync(output); } catch {}
    throw e;
  }
}

app.get("/api/trimmed/:name", (req, res) => {
  const safe = path.basename(req.params.name);
  const file = path.join(os.tmpdir(), safe);
  if (!fs.existsSync(file)) return res.status(404).send("Video expired. Generate it again.");
  res.sendFile(file, () => {
    setTimeout(() => { try { fs.unlinkSync(file); } catch {} }, 60_000);
  });
});

app.post("/api/generate", async (req, res) => {
  const user = requireUser(req,res); if (!user || !requireKey(res)) return;

  try {
    const {
      mode = "text",
      prompt = "",
      model = "ltx-2-3-fast",
      duration = 8,
      resolution = "1280x720",
      fps = 24,
      imageDataUri = ""
    } = req.body || {};

    if (!prompt.trim()) {
      return res.status(400).json({ error: "Please enter a prompt." });
    }

    if (!["text", "image"].includes(mode)) {
      return res.status(400).json({ error: "Invalid generation mode." });
    }

    if (mode === "image" && !imageDataUri) {
      return res.status(400).json({ error: "Please select an image for Image → Video." });
    }

    if (imageDataUri && imageDataUri.length > 7 * 1024 * 1024) {
      return res.status(413).json({ error: "Image is too large. Please use an image under about 5 MB." });
    }

    const requestedDuration = Number(duration);
    const exact15 = requestedDuration === 15;
    const plan = user.plan || "free";
    const u = getUsage(user.email);
    const dailyLimit = dailyLimitFor(user);
    if (u.count >= dailyLimit) {
      const label = plan === "pro" ? "Pro" : "Free";
      return res.status(429).json({ error: `${label} plan limit reached (${dailyLimit} videos/day). ${plan === "pro" ? "Your limit resets tomorrow." : "Your first-login bonus is 10 videos; after that the Free limit is 6/day."}` });
    }
    if (![6, 8, 10, 12, 14, 15].includes(requestedDuration)) {
      return res.status(400).json({ error: "Choose a supported duration." });
    }
    if (exact15 && !String(model).includes("fast")) {
      return res.status(400).json({ error: "Exact 15-second output currently uses an LTX Fast model." });
    }

    const body = {
      prompt: prompt.trim(),
      model,
      duration: exact15 ? 16 : requestedDuration,
      resolution,
      fps: Number(fps)
    };

    if (mode === "image") {
      body.image_uri = imageDataUri;
    }

    const endpoint = mode === "image"
      ? "https://api.ltx.io/v2/image-to-video"
      : "https://api.ltx.io/v2/text-to-video";

    const response = await fetch(endpoint, {
      method: "POST",
      headers: ltxHeaders(),
      body: JSON.stringify(body)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || data?.message || "LTX rejected the request.",
        details: data
      });
    }

    u.count += 1; saveUsage();
    jobs.set(`${mode}:${data.id}`, { requestedDuration, email:user.email, prompt:prompt.trim(), resolution, model, plan });
    res.json({
      id: data.id,
      mode,
      created_at: data.created_at,
      requested_duration: requestedDuration,
      trim_to_15: exact15
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error while starting the generation." });
  }
});

app.get("/api/status/:mode/:id", async (req, res) => {
  if (!requireKey(res)) return;

  try {
    const mode = req.params.mode;
    const id = req.params.id;

    if (!["text", "image"].includes(mode)) {
      return res.status(400).json({ error: "Invalid mode." });
    }

    const endpoint = mode === "image"
      ? `https://api.ltx.io/v2/image-to-video/${encodeURIComponent(id)}`
      : `https://api.ltx.io/v2/text-to-video/${encodeURIComponent(id)}`;

    const response = await fetch(endpoint, {
      headers: { "Authorization": `Bearer ${LTX_API_KEY}` }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || data?.message || "Could not check LTX job."
      });
    }

    const job = jobs.get(`${mode}:${id}`);
    const user = requireUser(req,res); if (!user) return;
    if (!job || job.email !== user.email) return res.status(404).json({error:"Generation not found for this account."});
    if (data?.status === "completed" && data?.result?.video_url && job?.requestedDuration === 15) {
      try {
        const trimmed = await trimTo15Seconds(data.result.video_url);
        data.result.video_url = `/api/trimmed/${encodeURIComponent(path.basename(trimmed))}`;
        data.result.duration = 15;
        jobs.delete(`${mode}:${id}`);
      } catch (trimErr) {
        console.error(trimErr);
        return res.status(500).json({ error: "Video was generated, but the 15-second finalization failed. Please try again." });
      }
    }

    if (data?.status === "completed" && data?.result?.video_url) {
      getHistory(user.email).unshift({ id, prompt:job.prompt, mode, model:job.model, resolution:job.resolution, duration:job.requestedDuration, status:"Completed", videoUrl:data.result.video_url, time:Date.now() });
      history[user.email] = getHistory(user.email).slice(0,30);
      saveHistory();
      jobs.delete(`${mode}:${id}`);
    }

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error while checking the generation." });
  }
});

app.get("/api/history",(req,res)=>{const u=requireUser(req,res);if(!u)return;res.json({history:getHistory(u.email)});});
app.delete("/api/history",(req,res)=>{const u=requireUser(req,res);if(!u)return;history[u.email]=[];saveHistory();res.json({ok:true});});

app.post("/api/auth/signup",(req,res)=>{const email=String(req.body?.email||"").trim().toLowerCase(),password=String(req.body?.password||""),name=String(req.body?.name||"").trim().slice(0,60);if(!/^\S+@\S+\.\S+$/.test(email))return res.status(400).json({error:"Enter a valid email."});if(password.length<6)return res.status(400).json({error:"Password must be at least 6 characters."});if(users.has(email))return res.status(409).json({error:"An account with this email already exists."});const now=Date.now(); const u={email,name:name||email.split("@")[0],passwordHash:hashPassword(password),plan:"free",createdAt:now,firstLoginDate:new Date(now).toISOString().slice(0,10)};users.set(email,u); history[email]=[]; saveUsers(); saveHistory(); setSession(res,email); res.json({user:{email:u.email,name:u.name,plan:u.plan||"free"}});});
app.post("/api/auth/login",(req,res)=>{const email=String(req.body?.email||"").trim().toLowerCase(),password=String(req.body?.password||""),u=users.get(email);if(!u||!verifyPassword(password,u.passwordHash))return res.status(401).json({error:"Incorrect email or password."});if(!u.firstLoginDate){u.firstLoginDate=new Date(u.createdAt||Date.now()).toISOString().slice(0,10);saveUsers();}setSession(res,email);res.json({user:{email:u.email,name:u.name,plan:u.plan||"free"}});});
app.post("/api/auth/logout",(req,res)=>{const t=req.headers.cookie?.match(/(?:^|;\s*)zyvro_session=([^;]+)/)?.[1];if(t)sessions.delete(t);res.setHeader("Set-Cookie","zyvro_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");res.json({ok:true});});
app.get("/api/auth/me",(req,res)=>{const u=sessionUser(req);if(!u)return res.json({user:null}); if(u.plan==="pro" && u.proUntil && u.proUntil<=Date.now()){u.plan="free";delete u.proUntil;saveUsers();} const q=getUsage(u.email);const limit=dailyLimitFor(u);res.json({user:{email:u.email,name:u.name,plan:u.plan||"free",dailyUsed:q.count,dailyLimit:limit,firstLoginDay:firstLoginDateFor(u)===todayKey(),proUntil:u.proUntil||null,proPriceInr:PRO_PRICE_INR}});});
app.get("/api/account",(req,res)=>{const u=requireUser(req,res);if(!u)return;const q=getUsage(u.email);res.json({plan:u.plan||"free",dailyUsed:q.count,dailyLimit:dailyLimitFor(u),ads:(u.plan||"free")!=="pro",firstLoginDay:firstLoginDateFor(u)===todayKey()});});

function razorpayConfigured(){ return Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET); }
function razorpayAuth(){ return "Basic " + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64"); }
function activatePro(user, paymentId, orderId){
  const now=Date.now();
  const current=(user.proUntil && user.proUntil>now) ? user.proUntil : now;
  user.plan="pro"; user.proUntil=current + 30*24*60*60*1000;
  user.lastPaymentId=paymentId; user.lastOrderId=orderId; saveUsers();
}
app.post("/api/pro/create-order", async (req,res)=>{
  const user=requireUser(req,res); if(!user)return;
  if(!razorpayConfigured()) return res.status(503).json({error:"Pro payments are not configured yet. Add Razorpay keys to the server environment."});
  try{
    const response=await fetch("https://api.razorpay.com/v1/orders",{method:"POST",headers:{"Authorization":razorpayAuth(),"Content-Type":"application/json"},body:JSON.stringify({amount:Math.round(PRO_PRICE_INR*100),currency:"INR",receipt:`zyvro_${Date.now()}`,notes:{email:user.email,product:"Zyvro Pro 30-day"}})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)return res.status(response.status).json({error:data?.error?.description||"Could not create payment order."});
    res.json({keyId:RAZORPAY_KEY_ID,orderId:data.id,amount:data.amount,currency:data.currency,priceInr:PRO_PRICE_INR});
  }catch(e){console.error(e);res.status(500).json({error:"Payment server error."});}
});
app.post("/api/pro/verify", async (req,res)=>{
  const user=requireUser(req,res); if(!user)return;
  if(!razorpayConfigured())return res.status(503).json({error:"Pro payments are not configured."});
  const {razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body||{};
  if(!razorpay_order_id||!razorpay_payment_id||!razorpay_signature)return res.status(400).json({error:"Incomplete payment response."});
  const expected=crypto.createHmac("sha256",RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest("hex");
  const a=Buffer.from(expected), b=Buffer.from(String(razorpay_signature));
  if(a.length!==b.length || !crypto.timingSafeEqual(a,b))return res.status(400).json({error:"Payment signature verification failed."});
  activatePro(user,razorpay_payment_id,razorpay_order_id);
  res.json({ok:true,plan:"pro",proUntil:user.proUntil,dailyLimit:PRO_DAILY_LIMIT});
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    ltxConfigured: Boolean(LTX_API_KEY)
  });
});

app.get("*splat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Zyvro AI running at http://localhost:${PORT}`);
});
