/**
 * ╔══════════════════════════════════════════╗
 * ║       WhatsApp Bot - index.js            ║
 * ║     Developed by Anoop Dubey 🚀          ║
 * ╚══════════════════════════════════════════╝
 */

'use strict';

// ─── Crypto global polyfill (MUST be before all other requires) ───────────
// Railway Node.js envs don't always expose crypto as a global.
// Baileys internally uses crypto.*, so patch global FIRST.
const crypto = require("crypto");
if (!globalThis.crypto) globalThis.crypto = crypto;
if (!global.crypto) global.crypto = crypto;

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidDecode,
  proto,
  getContentType,
} = require('@whiskeysockets/baileys');

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// ─── Load Config ────────────────────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));

// ─── Sessions folder ─────────────────────────────────────────────────────────
const SESSION_DIR = './sessions';
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

// ─── Logger ──────────────────────────────────────────────────────────────────
const LOG_LEVELS = { INFO: '✅', WARN: '⚠️', ERROR: '❌', DEBUG: '🔍' };
const log = (level, msg) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${LOG_LEVELS[level] || '📌'} [${level}] ${msg}`);
};

// ─── Cooldown Store ──────────────────────────────────────────────────────────
const cooldowns = new Map();
const COOLDOWN_MS = config.cooldownMs || 3000;

function isOnCooldown(jid, cmd) {
  const key = `${jid}:${cmd}`;
  const last = cooldowns.get(key) || 0;
  if (Date.now() - last < COOLDOWN_MS) return true;
  cooldowns.set(key, Date.now());
  return false;
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────
const rateLimiter = new Map();
const RATE_LIMIT = config.rateLimit || 10;
const RATE_WINDOW = config.rateWindowMs || 60000;

function isRateLimited(jid) {
  const now = Date.now();
  const entry = rateLimiter.get(jid) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW) {
    rateLimiter.set(jid, { count: 1, start: now });
    return false;
  }
  if (entry.count >= RATE_LIMIT) return true;
  entry.count++;
  rateLimiter.set(jid, entry);
  return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isOwner(jid) {
  const num = jid.replace(/[^0-9]/g, '');
  return config.ownerNumber === num || config.ownerNumber === jid.split('@')[0];
}

async function typingDelay(sock, jid, ms = 1200) {
  await sock.sendPresenceUpdate('composing', jid);
  await sleep(ms);
  await sock.sendPresenceUpdate('paused', jid);
}

async function reply(sock, msg, text) {
  await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

function getMsgText(msg) {
  const type = getContentType(msg.message);
  if (!type) return '';
  if (type === 'conversation') return msg.message.conversation;
  if (type === 'extendedTextMessage') return msg.message.extendedTextMessage.text;
  if (type === 'imageMessage') return msg.message.imageMessage.caption || '';
  if (type === 'videoMessage') return msg.message.videoMessage.caption || '';
  return '';
}

// ─── Groq AI ─────────────────────────────────────────────────────────────────
async function askGroq(prompt) {
  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: config.groqModel || 'llama3-8b-8192',
      messages: [
        { role: 'system', content: 'You are a helpful WhatsApp assistant. Keep answers concise.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1024,
    },
    {
      headers: {
        Authorization: `Bearer ${config.groqApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    }
  );
  return res.data.choices[0].message.content.trim();
}

// ─── Command Definitions ──────────────────────────────────────────────────────
const commands = {};

function addCmd(name, fn) {
  commands[name] = fn;
}

// ────────────────────────────────────────────────────────────────────────────
//  UTILITY COMMANDS
// ────────────────────────────────────────────────────────────────────────────

addCmd('ping', async (sock, msg) => {
  const start = Date.now();
  await reply(sock, msg, '🏓 Pong!');
  const latency = Date.now() - start;
  await reply(sock, msg, `⚡ Latency: *${latency}ms*\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('help', async (sock, msg) => {
  const list = Object.keys(commands)
    .sort()
    .map((c) => `• .${c}`)
    .join('\n');
  await reply(
    sock,
    msg,
    `╔══════════════════════╗
║   📋 COMMAND LIST     ║
╚══════════════════════╝

${list}

_Developed by Anoop Dubey 🚀_`
  );
});

addCmd('menu', async (sock, msg) => {
  await reply(
    sock,
    msg,
    `╔══════════════════════════╗
║  🤖 WHATSAPP BOT MENU  ║
╚══════════════════════════╝

🔧 *UTILITY*
.ping .uptime .serverinfo
.myinfo .time .date .calc
.encode .decode .shorten

🤖 *AI*
.ai <prompt>

🌐 *INFO & API*
.weather <city>
.crypto <coin>
.news .joke .quote
.fact .wiki <topic>
.dictionary <word>
.translate <lang> <text>
.covid <country>
.currency <from> <to> <amt>
.ip <address>
.whois <domain>

🎲 *FUN*
.flipcoin .dice .rps <choice>
.8ball <question>
.roast .compliment
.would .truth .dare
.meme .riddle

⚙️ *SYSTEM*
.owner .botinfo
.rr <msg> <count>
.broadcast <msg>
.kick <@user> (group)
.add <number> (group)
.promote <@user>
.demote <@user>
.mute .unmute
.delete .sticker
.tagall

_Developed by Anoop Dubey 🚀_`
  );
});

addCmd('owner', async (sock, msg) => {
  await reply(
    sock,
    msg,
    `👑 *Bot Owner*\n\nName: ${config.ownerName || 'Anoop Dubey'}\nNumber: wa.me/${config.ownerNumber}\n\n_Developed by Anoop Dubey 🚀_`
  );
});

addCmd('botinfo', async (sock, msg) => {
  await reply(
    sock,
    msg,
    `🤖 *Bot Information*

• Name: ${config.botName || 'AnoopBot'}
• Version: ${config.version || '1.0.0'}
• Platform: ${os.platform()} ${os.arch()}
• Node.js: ${process.version}
• Uptime: ${formatUptime(process.uptime())}
• Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB used

_Developed by Anoop Dubey 🚀_`
  );
});

addCmd('uptime', async (sock, msg) => {
  await reply(sock, msg, `⏱️ *Uptime:* ${formatUptime(process.uptime())}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('serverinfo', async (sock, msg) => {
  const cpus = os.cpus();
  await reply(
    sock,
    msg,
    `🖥️ *Server Info*

• OS: ${os.type()} ${os.release()}
• CPU: ${cpus[0]?.model || 'Unknown'} (${cpus.length} cores)
• RAM: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB total
• Free RAM: ${(os.freemem() / 1024 / 1024 / 1024).toFixed(2)} GB
• Hostname: ${os.hostname()}

_Developed by Anoop Dubey 🚀_`
  );
});

addCmd('myinfo', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;
  await reply(
    sock,
    msg,
    `👤 *Your Info*

• JID: ${sender}
• Number: ${sender.split('@')[0]}
• Chat: ${jid.endsWith('@g.us') ? 'Group' : 'Private'}

_Developed by Anoop Dubey 🚀_`
  );
});

addCmd('time', async (sock, msg) => {
  const now = new Date();
  await reply(sock, msg, `🕐 *Current Time (UTC):*\n${now.toUTCString()}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('date', async (sock, msg) => {
  const now = new Date();
  await reply(
    sock,
    msg,
    `📅 *Today's Date:*\n${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n\n_Developed by Anoop Dubey 🚀_`
  );
});

addCmd('calc', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .calc <expression>\nExample: .calc 2+2*5');
  const expr = args.join(' ');
  try {
    const safeExpr = expr.replace(/[^0-9+\-*/.() ]/g, '');
    const result = Function('"use strict"; return (' + safeExpr + ')')();
    await reply(sock, msg, `🧮 *Calculator*\n\n📥 Input: \`${expr}\`\n📤 Result: *${result}*\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Invalid expression.');
  }
});

addCmd('encode', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .encode <text>');
  const encoded = Buffer.from(args.join(' ')).toString('base64');
  await reply(sock, msg, `🔐 *Base64 Encoded:*\n\`${encoded}\`\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('decode', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .decode <base64>');
  try {
    const decoded = Buffer.from(args[0], 'base64').toString('utf-8');
    await reply(sock, msg, `🔓 *Base64 Decoded:*\n${decoded}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Invalid Base64 string.');
  }
});

addCmd('shorten', async (sock, msg, args) => {
  if (!args[0]) return reply(sock, msg, '❌ Usage: .shorten <url>');
  try {
    const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(args[0])}`, { timeout: 8000 });
    await reply(sock, msg, `🔗 *Shortened URL:*\n${res.data}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Failed to shorten URL.');
  }
});

// ────────────────────────────────────────────────────────────────────────────
//  AI COMMAND
// ────────────────────────────────────────────────────────────────────────────

addCmd('ai', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .ai <your question>');
  const prompt = args.join(' ');
  await typingDelay(sock, msg.key.remoteJid, 2000);
  try {
    const answer = await askGroq(prompt);
    await reply(sock, msg, `🤖 *AI Response:*\n\n${answer}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch (e) {
    log('ERROR', `Groq API: ${e.message}`);
    await reply(sock, msg, '❌ AI is unavailable right now. Check your Groq API key.');
  }
});

// ────────────────────────────────────────────────────────────────────────────
//  INFO / API COMMANDS
// ────────────────────────────────────────────────────────────────────────────

addCmd('weather', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .weather <city>');
  const city = args.join(' ');
  try {
    const key = config.weatherApiKey || '';
    if (!key || key === 'your_openweathermap_api_key') return reply(sock, msg, '❌ No weather API key set in config.json (weatherApiKey).');
    const res = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${key}&units=metric`,
      { timeout: 8000 }
    );
    const d = res.data;
    await reply(
      sock,
      msg,
      `🌤️ *Weather in ${d.name}, ${d.sys.country}*

🌡️ Temp: ${d.main.temp}°C (feels ${d.main.feels_like}°C)
💧 Humidity: ${d.main.humidity}%
🌬️ Wind: ${d.wind.speed} m/s
☁️ Condition: ${d.weather[0].description}

_Developed by Anoop Dubey 🚀_`
    );
  } catch {
    await reply(sock, msg, '❌ City not found or API error.');
  }
});

addCmd('crypto', async (sock, msg, args) => {
  const coin = (args[0] || 'bitcoin').toLowerCase();
  try {
    const res = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coin}&vs_currencies=usd,inr&include_24hr_change=true`,
      { timeout: 8000 }
    );
    const data = res.data[coin];
    if (!data) return reply(sock, msg, `❌ Coin "${coin}" not found.`);
    await reply(
      sock,
      msg,
      `💰 *${coin.toUpperCase()} Price*

💵 USD: $${data.usd?.toLocaleString()}
₹ INR: ₹${data.inr?.toLocaleString()}
📈 24h Change: ${data.usd_24h_change?.toFixed(2)}%

_Developed by Anoop Dubey 🚀_`
    );
  } catch {
    await reply(sock, msg, '❌ Failed to fetch crypto price.');
  }
});

addCmd('news', async (sock, msg) => {
  try {
    const key = config.newsApiKey || '';
    if (!key || key === 'your_newsapi_key') return reply(sock, msg, '❌ No news API key set in config.json (newsApiKey).');
    const res = await axios.get(
      `https://newsapi.org/v2/top-headlines?country=us&pageSize=5&apiKey=${key}`,
      { timeout: 8000 }
    );
    const articles = res.data.articles.slice(0, 5);
    const text = articles.map((a, i) => `${i + 1}. *${a.title}*\n   🔗 ${a.url}`).join('\n\n');
    await reply(sock, msg, `📰 *Top 5 News Headlines*\n\n${text}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Failed to fetch news.');
  }
});

addCmd('joke', async (sock, msg) => {
  try {
    const res = await axios.get('https://official-joke-api.appspot.com/random_joke', { timeout: 8000 });
    await reply(sock, msg, `😂 *Random Joke*\n\n${res.data.setup}\n\n${res.data.punchline}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Could not fetch a joke.');
  }
});

addCmd('quote', async (sock, msg) => {
  try {
    const res = await axios.get('https://zenquotes.io/api/random', { timeout: 8000 });
    const q = res.data[0];
    await reply(sock, msg, `💬 *Quote of the Day*\n\n"${q.q}"\n— _${q.a}_\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Could not fetch quote.');
  }
});

addCmd('fact', async (sock, msg) => {
  try {
    const res = await axios.get('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en', { timeout: 8000 });
    await reply(sock, msg, `💡 *Random Fact*\n\n${res.data.text}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Could not fetch fact.');
  }
});

addCmd('wiki', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .wiki <topic>');
  const topic = args.join(' ');
  try {
    const res = await axios.get(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`,
      { timeout: 10000 }
    );
    await reply(
      sock,
      msg,
      `📖 *Wikipedia: ${res.data.title}*\n\n${res.data.extract || 'No summary available.'}\n\n🔗 ${res.data.content_urls?.desktop?.page || ''}\n\n_Developed by Anoop Dubey 🚀_`
    );
  } catch {
    await reply(sock, msg, '❌ Topic not found on Wikipedia.');
  }
});

addCmd('dictionary', async (sock, msg, args) => {
  if (!args[0]) return reply(sock, msg, '❌ Usage: .dictionary <word>');
  try {
    const res = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${args[0]}`, { timeout: 8000 });
    const entry = res.data[0];
    const meaning = entry.meanings[0];
    const def = meaning.definitions[0];
    await reply(
      sock,
      msg,
      `📚 *${entry.word}*

🗣️ Part of Speech: ${meaning.partOfSpeech}
📝 Definition: ${def.definition}
📖 Example: ${def.example || 'N/A'}
🔄 Synonyms: ${def.synonyms?.slice(0, 3).join(', ') || 'N/A'}

_Developed by Anoop Dubey 🚀_`
    );
  } catch {
    await reply(sock, msg, '❌ Word not found.');
  }
});

addCmd('translate', async (sock, msg, args) => {
  if (args.length < 2) return reply(sock, msg, '❌ Usage: .translate <lang_code> <text>\nExample: .translate es Hello World');
  const lang = args[0];
  const text = args.slice(1).join(' ');
  try {
    const res = await axios.get(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${lang}`,
      { timeout: 8000 }
    );
    await reply(
      sock,
      msg,
      `🌐 *Translation (→ ${lang})*\n\n📥 Original: ${text}\n📤 Translated: ${res.data.responseData.translatedText}\n\n_Developed by Anoop Dubey 🚀_`
    );
  } catch {
    await reply(sock, msg, '❌ Translation failed.');
  }
});

addCmd('currency', async (sock, msg, args) => {
  if (args.length < 3) return reply(sock, msg, '❌ Usage: .currency <FROM> <TO> <amount>\nExample: .currency USD INR 100');
  const [from, to, amount] = args;
  try {
    const res = await axios.get(`https://open.er-api.com/v6/latest/${from.toUpperCase()}`, { timeout: 8000 });
    const rate = res.data.rates[to.toUpperCase()];
    if (!rate) return reply(sock, msg, '❌ Invalid currency code.');
    const result = (parseFloat(amount) * rate).toFixed(2);
    await reply(sock, msg, `💱 *Currency Converter*\n\n${amount} ${from.toUpperCase()} = *${result} ${to.toUpperCase()}*\n📊 Rate: 1 ${from.toUpperCase()} = ${rate} ${to.toUpperCase()}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Could not fetch exchange rate.');
  }
});

addCmd('ip', async (sock, msg, args) => {
  const ip = args[0] || '';
  try {
    const url = ip ? `https://ipapi.co/${ip}/json/` : 'https://ipapi.co/json/';
    const res = await axios.get(url, { timeout: 8000 });
    const d = res.data;
    await reply(
      sock,
      msg,
      `🌍 *IP Information*

🔹 IP: ${d.ip}
🏳️ Country: ${d.country_name}
🏙️ City: ${d.city}
📍 Region: ${d.region}
📮 Postal: ${d.postal}
🌐 ISP: ${d.org}
🕐 Timezone: ${d.timezone}

_Developed by Anoop Dubey 🚀_`
    );
  } catch {
    await reply(sock, msg, '❌ Failed to fetch IP info.');
  }
});

addCmd('whois', async (sock, msg, args) => {
  if (!args[0]) return reply(sock, msg, '❌ Usage: .whois <domain>');
  try {
    const res = await axios.get(`https://api.domainsdb.info/v1/domains/search?domain=${args[0]}&zone=com`, { timeout: 8000 });
    const d = res.data.domains?.[0];
    if (!d) return reply(sock, msg, '❌ No info found for that domain.');
    await reply(
      sock,
      msg,
      `🔍 *WHOIS: ${args[0]}*

📛 Domain: ${d.domain}
📅 Created: ${d.create_date || 'N/A'}
🔄 Updated: ${d.update_date || 'N/A'}
🌐 Country: ${d.country || 'N/A'}

_Developed by Anoop Dubey 🚀_`
    );
  } catch {
    await reply(sock, msg, '❌ WHOIS lookup failed.');
  }
});

addCmd('covid', async (sock, msg, args) => {
  const country = args.join(' ') || 'world';
  try {
    const url =
      country.toLowerCase() === 'world'
        ? 'https://disease.sh/v3/covid-19/all'
        : `https://disease.sh/v3/covid-19/countries/${encodeURIComponent(country)}`;
    const res = await axios.get(url, { timeout: 8000 });
    const d = res.data;
    await reply(
      sock,
      msg,
      `🦠 *COVID-19 Stats: ${d.country || 'World'}*

✅ Cases: ${d.cases?.toLocaleString()}
💀 Deaths: ${d.deaths?.toLocaleString()}
💚 Recovered: ${d.recovered?.toLocaleString()}
🏥 Active: ${d.active?.toLocaleString()}
📅 Updated: ${new Date(d.updated).toLocaleString()}

_Developed by Anoop Dubey 🚀_`
    );
  } catch {
    await reply(sock, msg, '❌ Could not fetch COVID data for that country.');
  }
});

addCmd('github', async (sock, msg, args) => {
  if (!args[0]) return reply(sock, msg, '❌ Usage: .github <username>');
  try {
    const res = await axios.get(`https://api.github.com/users/${args[0]}`, { timeout: 8000 });
    const d = res.data;
    await reply(
      sock,
      msg,
      `🐙 *GitHub: ${d.login}*

👤 Name: ${d.name || 'N/A'}
📝 Bio: ${d.bio || 'N/A'}
📦 Repos: ${d.public_repos}
👥 Followers: ${d.followers}
🔗 ${d.html_url}

_Developed by Anoop Dubey 🚀_`
    );
  } catch {
    await reply(sock, msg, '❌ GitHub user not found.');
  }
});

// ────────────────────────────────────────────────────────────────────────────
//  FUN COMMANDS
// ────────────────────────────────────────────────────────────────────────────

addCmd('flipcoin', async (sock, msg) => {
  const result = Math.random() < 0.5 ? '🪙 Heads' : '🪙 Tails';
  await reply(sock, msg, `*Coin Flip Result:* ${result}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('dice', async (sock, msg, args) => {
  const sides = parseInt(args[0]) || 6;
  const result = Math.floor(Math.random() * sides) + 1;
  await reply(sock, msg, `🎲 *Dice Roll (d${sides}):* ${result}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('rps', async (sock, msg, args) => {
  const choices = ['rock', 'paper', 'scissors'];
  const emojis = { rock: '🪨', paper: '📄', scissors: '✂️' };
  const userChoice = (args[0] || '').toLowerCase();
  if (!choices.includes(userChoice)) return reply(sock, msg, '❌ Usage: .rps <rock|paper|scissors>');
  const botChoice = choices[Math.floor(Math.random() * 3)];
  let result;
  if (userChoice === botChoice) result = "It's a *tie*! 🤝";
  else if (
    (userChoice === 'rock' && botChoice === 'scissors') ||
    (userChoice === 'paper' && botChoice === 'rock') ||
    (userChoice === 'scissors' && botChoice === 'paper')
  )
    result = 'You *win*! 🎉';
  else result = 'You *lose*! 😢';

  await reply(sock, msg, `✊ *Rock Paper Scissors*\n\nYou: ${emojis[userChoice]} ${userChoice}\nBot: ${emojis[botChoice]} ${botChoice}\n\n${result}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('8ball', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .8ball <question>');
  const answers = [
    'It is certain ✅', 'Without a doubt ✅', 'Yes definitely ✅',
    'You may rely on it ✅', 'As I see it, yes ✅', 'Most likely ✅',
    'Outlook good ✅', 'Yes ✅', 'Signs point to yes ✅',
    'Reply hazy, try again 🤔', 'Ask again later 🤔', 'Better not tell you now 🤔',
    'Cannot predict now 🤔', 'Concentrate and ask again 🤔',
    "Don't count on it ❌", 'My reply is no ❌', 'My sources say no ❌',
    'Outlook not so good ❌', 'Very doubtful ❌',
  ];
  const answer = answers[Math.floor(Math.random() * answers.length)];
  await reply(sock, msg, `🎱 *Magic 8-Ball*\n\n❓ ${args.join(' ')}\n\n💬 ${answer}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('roast', async (sock, msg) => {
  const roasts = [
    "You're the reason they put instructions on shampoo bottles.",
    "I'd agree with you but then we'd both be wrong.",
    "You're not stupid; you just have bad luck thinking.",
    'Some cause happiness wherever they go. You cause it whenever you go.',
    "I'd call you a tool, but that would mean you're actually useful.",
  ];
  await reply(sock, msg, `🔥 *Roast:*\n\n${roasts[Math.floor(Math.random() * roasts.length)]}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('compliment', async (sock, msg) => {
  const compliments = [
    'You light up every room you walk into! ✨',
    'Your kindness is a strength, not a weakness. 💪',
    'You have an incredible mind! 🧠',
    'You make the world a better place just by being in it. 🌍',
    'You are more than enough. 💫',
  ];
  await reply(sock, msg, `💖 *Compliment:*\n\n${compliments[Math.floor(Math.random() * compliments.length)]}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('would', async (sock, msg) => {
  const questions = [
    'Would you rather have super speed or super strength?',
    'Would you rather be invisible or be able to fly?',
    'Would you rather eat only pizza or only sushi for life?',
    "Would you rather know when you'll die or how you'll die?",
    'Would you rather be a famous actor or a famous musician?',
  ];
  await reply(sock, msg, `🤔 *Would You Rather?*\n\n${questions[Math.floor(Math.random() * questions.length)]}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('truth', async (sock, msg) => {
  const truths = [
    "What's the most embarrassing thing you've ever done?",
    "What's your biggest secret?",
    'Have you ever lied to your best friend?',
    "What's the worst thing you've ever said about someone behind their back?",
    'Have you ever cheated on a test?',
  ];
  await reply(sock, msg, `💬 *Truth:*\n\n${truths[Math.floor(Math.random() * truths.length)]}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('dare', async (sock, msg) => {
  const dares = [
    'Send a voice message singing your favourite song.',
    'Change your display name to something funny for 1 hour.',
    'Post the last photo in your gallery as your status.',
    'Text your crush right now!',
    'Do 20 push-ups and send proof.',
  ];
  await reply(sock, msg, `😈 *Dare:*\n\n${dares[Math.floor(Math.random() * dares.length)]}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('riddle', async (sock, msg) => {
  const riddles = [
    { q: "I speak without a mouth and hear without ears. I have no body, but I come alive with the wind. What am I?", a: "An echo" },
    { q: "The more you take, the more you leave behind. What am I?", a: "Footsteps" },
    { q: "What has hands but can't clap?", a: "A clock" },
    { q: "What has keys but no locks, space but no room, and you can enter but can't go in?", a: "A keyboard" },
    { q: "What can travel around the world while staying in a corner?", a: "A stamp" },
  ];
  const r = riddles[Math.floor(Math.random() * riddles.length)];
  await reply(sock, msg, `🧩 *Riddle*\n\n❓ ${r.q}\n\n||💡 Answer: ${r.a}||\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('meme', async (sock, msg) => {
  try {
    const res = await axios.get('https://meme-api.com/gimme', { timeout: 8000 });
    const meme = res.data;
    await sock.sendMessage(msg.key.remoteJid, {
      image: { url: meme.url },
      caption: `😂 *${meme.title}*\n\n_Developed by Anoop Dubey 🚀_`,
    }, { quoted: msg });
  } catch {
    await reply(sock, msg, '❌ Failed to fetch meme.');
  }
});

addCmd('number', async (sock, msg, args) => {
  const num = args[0] || Math.floor(Math.random() * 1000);
  try {
    const res = await axios.get(`http://numbersapi.com/${num}`, { timeout: 8000 });
    await reply(sock, msg, `🔢 *Number Fact: ${num}*\n\n${res.data}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Could not fetch number fact.');
  }
});

addCmd('cat', async (sock, msg) => {
  try {
    const res = await axios.get('https://api.thecatapi.com/v1/images/search', { timeout: 8000 });
    await sock.sendMessage(msg.key.remoteJid, {
      image: { url: res.data[0].url },
      caption: "🐱 Here's a cute cat!\n\n_Developed by Anoop Dubey 🚀_",
    }, { quoted: msg });
  } catch {
    await reply(sock, msg, '❌ Failed to fetch cat image.');
  }
});

addCmd('dog', async (sock, msg) => {
  try {
    const res = await axios.get('https://dog.ceo/api/breeds/image/random', { timeout: 8000 });
    await sock.sendMessage(msg.key.remoteJid, {
      image: { url: res.data.message },
      caption: "🐶 Here's a cute dog!\n\n_Developed by Anoop Dubey 🚀_",
    }, { quoted: msg });
  } catch {
    await reply(sock, msg, '❌ Failed to fetch dog image.');
  }
});

addCmd('fox', async (sock, msg) => {
  try {
    const res = await axios.get('https://randomfox.ca/floof/', { timeout: 8000 });
    await sock.sendMessage(msg.key.remoteJid, {
      image: { url: res.data.image },
      caption: "🦊 Here's a cute fox!\n\n_Developed by Anoop Dubey 🚀_",
    }, { quoted: msg });
  } catch {
    await reply(sock, msg, '❌ Failed to fetch fox image.');
  }
});

addCmd('nasa', async (sock, msg) => {
  try {
    const key = config.nasaApiKey || 'DEMO_KEY';
    const res = await axios.get(`https://api.nasa.gov/planetary/apod?api_key=${key}`, { timeout: 10000 });
    const d = res.data;
    if (d.media_type === 'image') {
      await sock.sendMessage(msg.key.remoteJid, {
        image: { url: d.url },
        caption: `🚀 *NASA APOD: ${d.title}*\n\n${d.explanation?.slice(0, 400)}...\n📅 Date: ${d.date}\n\n_Developed by Anoop Dubey 🚀_`,
      }, { quoted: msg });
    } else {
      await reply(sock, msg, `🚀 *NASA APOD: ${d.title}*\n\n${d.explanation?.slice(0, 400)}...\n🔗 ${d.url}\n\n_Developed by Anoop Dubey 🚀_`);
    }
  } catch {
    await reply(sock, msg, '❌ Failed to fetch NASA image.');
  }
});

// ────────────────────────────────────────────────────────────────────────────
//  GROUP COMMANDS
// ────────────────────────────────────────────────────────────────────────────

addCmd('tagall', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return reply(sock, msg, '❌ This command only works in groups.');
  try {
    const meta = await sock.groupMetadata(jid);
    const members = meta.participants;
    let text = `📢 *Attention Everyone!*\n\n`;
    const mentions = [];
    for (const m of members) {
      text += `@${m.id.split('@')[0]} `;
      mentions.push(m.id);
    }
    await sock.sendMessage(jid, { text, mentions }, { quoted: msg });
  } catch {
    await reply(sock, msg, '❌ Failed to tag all members.');
  }
});

addCmd('kick', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return reply(sock, msg, '❌ Groups only.');
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (!mentioned.length) return reply(sock, msg, '❌ Usage: .kick @user');
  try {
    await sock.groupParticipantsUpdate(jid, mentioned, 'remove');
    await reply(sock, msg, `✅ Kicked ${mentioned.length} member(s).\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Failed to kick. Make sure I am admin.');
  }
});

addCmd('add', async (sock, msg, args) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return reply(sock, msg, '❌ Groups only.');
  if (!args[0]) return reply(sock, msg, '❌ Usage: .add <number> (without +)');
  const num = `${args[0].replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  try {
    await sock.groupParticipantsUpdate(jid, [num], 'add');
    await reply(sock, msg, `✅ Added ${args[0]}.\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Failed to add member.');
  }
});

addCmd('promote', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return reply(sock, msg, '❌ Groups only.');
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (!mentioned.length) return reply(sock, msg, '❌ Usage: .promote @user');
  try {
    await sock.groupParticipantsUpdate(jid, mentioned, 'promote');
    await reply(sock, msg, `✅ Promoted to admin!\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Failed. Need admin rights.');
  }
});

addCmd('demote', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return reply(sock, msg, '❌ Groups only.');
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (!mentioned.length) return reply(sock, msg, '❌ Usage: .demote @user');
  try {
    await sock.groupParticipantsUpdate(jid, mentioned, 'demote');
    await reply(sock, msg, `✅ Demoted from admin.\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Failed. Need admin rights.');
  }
});

addCmd('mute', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return reply(sock, msg, '❌ Groups only.');
  try {
    await sock.groupSettingUpdate(jid, 'announcement');
    await reply(sock, msg, '🔇 Group muted (only admins can send messages).\n\n_Developed by Anoop Dubey 🚀_');
  } catch {
    await reply(sock, msg, '❌ Failed. Need admin rights.');
  }
});

addCmd('unmute', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return reply(sock, msg, '❌ Groups only.');
  try {
    await sock.groupSettingUpdate(jid, 'not_announcement');
    await reply(sock, msg, '🔊 Group unmuted.\n\n_Developed by Anoop Dubey 🚀_');
  } catch {
    await reply(sock, msg, '❌ Failed. Need admin rights.');
  }
});

addCmd('groupinfo', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return reply(sock, msg, '❌ Groups only.');
  try {
    const meta = await sock.groupMetadata(jid);
    await reply(
      sock,
      msg,
      `ℹ️ *Group Info*

📛 Name: ${meta.subject}
👥 Members: ${meta.participants.length}
📝 Description: ${meta.desc || 'No description'}
🕐 Created: ${new Date(meta.creation * 1000).toLocaleDateString()}

_Developed by Anoop Dubey 🚀_`
    );
  } catch {
    await reply(sock, msg, '❌ Failed to fetch group info.');
  }
});

addCmd('delete', async (sock, msg) => {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted) return reply(sock, msg, '❌ Reply to a message to delete it.');
  try {
    const key = msg.message.extendedTextMessage.contextInfo.stanzaId;
    const participant = msg.message.extendedTextMessage.contextInfo.participant;
    await sock.sendMessage(msg.key.remoteJid, {
      delete: { remoteJid: msg.key.remoteJid, fromMe: false, id: key, participant },
    });
  } catch {
    await reply(sock, msg, '❌ Could not delete message.');
  }
});

// ────────────────────────────────────────────────────────────────────────────
//  SPECIAL COMMANDS
// ────────────────────────────────────────────────────────────────────────────

addCmd('rr', async (sock, msg, args) => {
  if (args.length < 2) return reply(sock, msg, '❌ Usage: .rr <message> <count>\nExample: .rr Hello 5');
  const count = Math.min(parseInt(args[args.length - 1]) || 1, config.maxRepeat || 20);
  const message = args.slice(0, -1).join(' ');
  await reply(sock, msg, `🔁 Sending "${message}" × ${count} times...\n\n_Developed by Anoop Dubey 🚀_`);
  for (let i = 1; i <= count; i++) {
    await sock.sendMessage(msg.key.remoteJid, { text: `[${i}/${count}] ${message}` });
    await sleep(config.repeatDelayMs || 1500);
  }
  await reply(sock, msg, `✅ Done! Sent ${count} message(s).\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('broadcast', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .broadcast <message>');
  const text = args.join(' ');
  const chats = Object.keys(sock.chats || {});
  if (!chats.length) return reply(sock, msg, '❌ No chats available in store.');
  await reply(sock, msg, `📢 Broadcasting to ${chats.length} chats...`);
  let sent = 0;
  for (const jid of chats.slice(0, 50)) {
    try {
      await sock.sendMessage(jid, { text: `📢 *Broadcast*\n\n${text}\n\n_Developed by Anoop Dubey 🚀_` });
      sent++;
      await sleep(1000);
    } catch {}
  }
  await reply(sock, msg, `✅ Broadcast complete. Sent to ${sent} chats.\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('sticker', async (sock, msg) => {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted) return reply(sock, msg, '❌ Reply to an image/video to make a sticker.');
  const type = getContentType(quoted);
  if (!['imageMessage', 'videoMessage'].includes(type)) return reply(sock, msg, '❌ Reply to an image or video.');
  try {
    const stream = await sock.downloadContentFromMessage(quoted[type], type === 'imageMessage' ? 'image' : 'video');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    await sock.sendMessage(msg.key.remoteJid, { sticker: buffer }, { quoted: msg });
  } catch {
    await reply(sock, msg, '❌ Failed to create sticker.');
  }
});

addCmd('toimg', async (sock, msg) => {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted?.stickerMessage) return reply(sock, msg, '❌ Reply to a sticker to convert it to image.');
  try {
    const stream = await sock.downloadContentFromMessage(quoted.stickerMessage, 'sticker');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    await sock.sendMessage(msg.key.remoteJid, { image: buffer, caption: '🖼️ Converted!\n\n_Developed by Anoop Dubey 🚀_' }, { quoted: msg });
  } catch {
    await reply(sock, msg, '❌ Failed to convert sticker.');
  }
});

// ────────────────────────────────────────────────────────────────────────────
//  MISC EXTRA COMMANDS
// ────────────────────────────────────────────────────────────────────────────

addCmd('lyrics', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .lyrics <song name>');
  try {
    const res = await axios.get(`https://some-random-api.com/others/lyrics?title=${encodeURIComponent(args.join(' '))}`, { timeout: 10000 });
    const d = res.data;
    const lyrics = d.lyrics?.slice(0, 1500) || 'Lyrics not found.';
    await reply(sock, msg, `🎵 *${d.title}* by *${d.author}*\n\n${lyrics}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Lyrics not found.');
  }
});

addCmd('avatar', async (sock, msg, args) => {
  const text = encodeURIComponent(args.join(' ') || 'A');
  const url = `https://ui-avatars.com/api/?name=${text}&size=512&background=random&bold=true`;
  try {
    await sock.sendMessage(msg.key.remoteJid, {
      image: { url },
      caption: `🎨 *Avatar generated!*\n\n_Developed by Anoop Dubey 🚀_`,
    }, { quoted: msg });
  } catch {
    await reply(sock, msg, '❌ Failed to generate avatar.');
  }
});

addCmd('qr', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .qr <text or url>');
  const data = encodeURIComponent(args.join(' '));
  const url = `https://api.qrserver.com/v1/create-qr-code/?data=${data}&size=512x512`;
  try {
    await sock.sendMessage(msg.key.remoteJid, {
      image: { url },
      caption: `📱 *QR Code Generated!*\n\n_Developed by Anoop Dubey 🚀_`,
    }, { quoted: msg });
  } catch {
    await reply(sock, msg, '❌ Failed to generate QR code.');
  }
});

addCmd('ss', async (sock, msg, args) => {
  if (!args[0]) return reply(sock, msg, '❌ Usage: .ss <url>');
  try {
    const res = await axios.get(`https://image.thum.io/get/width/1280/crop/720/${encodeURIComponent(args[0])}`, {
      responseType: 'arraybuffer', timeout: 15000
    });
    await sock.sendMessage(msg.key.remoteJid, {
      image: Buffer.from(res.data),
      caption: `📸 *Screenshot of:* ${args[0]}\n\n_Developed by Anoop Dubey 🚀_`,
    }, { quoted: msg });
  } catch {
    await reply(sock, msg, '❌ Failed to take screenshot.');
  }
});

addCmd('password', async (sock, msg, args) => {
  const len = parseInt(args[0]) || 16;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=';
  let pwd = '';
  for (let i = 0; i < Math.min(len, 64); i++) pwd += chars[Math.floor(Math.random() * chars.length)];
  await reply(sock, msg, `🔑 *Generated Password (${len} chars):*\n\`${pwd}\`\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('uuid', async (sock, msg) => {
  const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
  await reply(sock, msg, `🆔 *Generated UUID:*\n\`${uuid}\`\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('lorem', async (sock, msg, args) => {
  const count = parseInt(args[0]) || 1;
  const sentences = [
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
    'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
    'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.',
    'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum.',
    'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia.',
  ];
  const text = Array.from({ length: Math.min(count, 10) }, (_, i) => sentences[i % sentences.length]).join(' ');
  await reply(sock, msg, `📝 *Lorem Ipsum:*\n\n${text}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('ascii', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .ascii <text>');
  const text = args.join(' ').toUpperCase().slice(0, 10);
  const art = text.split('').join('  ');
  await reply(sock, msg, `🔤 *ASCII Art:*\n\n\`${art}\`\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('reverse', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .reverse <text>');
  const reversed = args.join(' ').split('').reverse().join('');
  await reply(sock, msg, `🔄 *Reversed:*\n${reversed}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('charcount', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .charcount <text>');
  const text = args.join(' ');
  await reply(sock, msg, `📊 *Character Count*\n\nText: "${text}"\nCharacters: ${text.length}\nWords: ${text.split(/\s+/).length}\nLetters: ${(text.match(/[a-zA-Z]/g) || []).length}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('mock', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .mock <text>');
  const mocked = args.join(' ').split('').map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('');
  await reply(sock, msg, `🤪 *MoCkEd:*\n${mocked}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('binary', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .binary <text>');
  const bin = args.join(' ').split('').map((c) => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' ');
  await reply(sock, msg, `💻 *Binary:*\n\`${bin}\`\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('hex', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .hex <text>');
  const hex = Buffer.from(args.join(' ')).toString('hex');
  await reply(sock, msg, `🔢 *Hex:*\n\`${hex}\`\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('age', async (sock, msg, args) => {
  if (!args[0]) return reply(sock, msg, '❌ Usage: .age <YYYY-MM-DD>');
  const birth = new Date(args[0]);
  if (isNaN(birth)) return reply(sock, msg, '❌ Invalid date format. Use YYYY-MM-DD');
  const now = new Date();
  const age = now.getFullYear() - birth.getFullYear() - (now < new Date(now.getFullYear(), birth.getMonth(), birth.getDate()) ? 1 : 0);
  await reply(sock, msg, `🎂 *Age Calculator*\n\nBirthdate: ${args[0]}\nAge: *${age} years old*\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('countdown', async (sock, msg, args) => {
  if (!args[0]) return reply(sock, msg, '❌ Usage: .countdown <YYYY-MM-DD> [Event Name]');
  const date = new Date(args[0]);
  if (isNaN(date)) return reply(sock, msg, '❌ Invalid date format. Use YYYY-MM-DD');
  const name = args.slice(1).join(' ') || 'Event';
  const diff = date - Date.now();
  if (diff < 0) return reply(sock, msg, '❌ That date has already passed!');
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hrs = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  await reply(sock, msg, `⏳ *Countdown to ${name}*\n\n📅 Date: ${args[0]}\n⏰ Time left: *${days}d ${hrs}h*\n\n_Developed by Anoop Dubey 🚀_`);
});

// ────────────────────────────────────────────────────────────────────────────
//  UTILS
// ────────────────────────────────────────────────────────────────────────────

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
}

// ────────────────────────────────────────────────────────────────────────────
//  MESSAGE HANDLER
// ────────────────────────────────────────────────────────────────────────────

async function handleMessage(sock, msg) {
  try {
    if (!msg.message) return;
    if (msg.key.fromMe) return;

    const text = getMsgText(msg).trim();
    if (!text.startsWith(config.prefix || '.')) return;

    const jid = msg.key.remoteJid;
    const sender = msg.key.participant || jid;
    const body = text.slice((config.prefix || '.').length).trim();
    const [cmd, ...args] = body.split(' ');
    const command = cmd.toLowerCase();

    log('INFO', `[MSG] ${sender} → .${command}`);

    // Owner check
    if (!isOwner(sender)) {
      return sock.sendMessage(jid, {
        text: `🚫 *Access Denied*\n\nThis bot is private.\n_Only the owner can use this bot._\n\n_Developed by Anoop Dubey 🚀_`,
      }, { quoted: msg });
    }

    // Rate limit
    if (isRateLimited(sender)) {
      return reply(sock, msg, `⏱️ You're sending too many commands. Please slow down.\n\n_Developed by Anoop Dubey 🚀_`);
    }

    // Cooldown
    if (isOnCooldown(sender, command)) {
      return reply(sock, msg, `⏳ Please wait before using *.${command}* again.\n\n_Developed by Anoop Dubey 🚀_`);
    }

    const handler = commands[command];
    if (!handler) {
      return reply(sock, msg, `❓ Unknown command: *.${command}*\nType *.help* to see all commands.\n\n_Developed by Anoop Dubey 🚀_`);
    }

    await typingDelay(sock, jid, 600);
    await handler(sock, msg, args);
  } catch (err) {
    log('ERROR', `handleMessage: ${err.message}`);
    try {
      await reply(sock, msg, `⚠️ An error occurred: ${err.message}\n\n_Developed by Anoop Dubey 🚀_`);
    } catch {}
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  CONNECTION — Railway-safe, no stdin, auto pairing code from config
// ────────────────────────────────────────────────────────────────────────────

let isReconnecting = false;

async function startBot() {
  // Use sessions folder for persistent auth
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();
  log('INFO', `Using Baileys v${version.join('.')}`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: [config.botName || 'AnoopBot', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    logger: {
      level: 'silent',
      trace: () => {}, debug: () => {}, info: () => {},
      warn: () => {}, error: () => {}, fatal: () => {},
      child: () => ({
        level: 'silent',
        trace: () => {}, debug: () => {}, info: () => {},
        warn: () => {}, error: () => {}, fatal: () => {},
        child: () => ({})
      })
    },
  });

  // ── Auto pairing code on first run (no stdin, reads from config) ──────────
  if (!sock.authState.creds.registered) {
    const phoneNumber = (config.phoneNumber || config.ownerNumber || '').replace(/[^0-9]/g, '');
    if (!phoneNumber) {
      log('ERROR', 'No phoneNumber found in config.json! Add "phoneNumber": "91XXXXXXXXXX" to config.json');
      process.exit(1);
    }

    // Small delay to let the socket fully init before requesting pairing
    await sleep(3000);

    try {
      const code = await sock.requestPairingCode(phoneNumber);
      console.log(`\n╔══════════════════════════════════════╗`);
      console.log(`║        🔑 PAIRING CODE BELOW         ║`);
      console.log(`╠══════════════════════════════════════╣`);
      console.log(`║           ${code}            ║`);
      console.log(`╚══════════════════════════════════════╝`);
      console.log(`\n➡️  Open WhatsApp → Linked Devices → Link a Device`);
      console.log(`➡️  Enter the code above when prompted\n`);
    } catch (err) {
      log('ERROR', `Failed to get pairing code: ${err.message}`);
    }
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      if (isLoggedOut) {
        log('ERROR', 'Logged out from WhatsApp. Delete the sessions folder and restart to re-link.');
        process.exit(1);
      }

      if (!isReconnecting) {
        isReconnecting = true;
        log('WARN', `Connection closed (code: ${statusCode}). Reconnecting in 5s...`);
        setTimeout(async () => {
          isReconnecting = false;
          await startBot();
        }, 5000);
      }
    } else if (connection === 'open') {
      isReconnecting = false;
      log('INFO', `Bot connected as ${sock.user?.id}`);
      console.log(`\n╔══════════════════════════════════════╗`);
      console.log(`║  🤖 ${(config.botName || 'AnoopBot').padEnd(30)}  ║`);
      console.log(`║  ✅ Bot is ONLINE and ready!         ║`);
      console.log(`║  Developed by Anoop Dubey 🚀         ║`);
      console.log(`╚══════════════════════════════════════╝\n`);
    } else if (connection === 'connecting') {
      log('INFO', 'Connecting to WhatsApp...');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      await handleMessage(sock, msg);
    }
  });

  return sock;
}

// ────────────────────────────────────────────────────────────────────────────
//  GLOBAL ERROR HANDLERS
// ────────────────────────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => log('ERROR', `Uncaught: ${err.message}`));
process.on('unhandledRejection', (err) => log('ERROR', `Unhandled Rejection: ${err}`));

// ────────────────────────────────────────────────────────────────────────────
//  LAUNCH
// ────────────────────────────────────────────────────────────────────────────

console.log(`
╔══════════════════════════════════════╗
║       WhatsApp Bot Starting...       ║
║     Developed by Anoop Dubey 🚀      ║
╚══════════════════════════════════════╝
`);

startBot().catch((err) => {
  log('ERROR', `Fatal: ${err.message}`);
  process.exit(1);
});
