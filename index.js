/**

╔══════════════════════════════════════════╗

║       WhatsApp Bot - index.js            ║

║     Developed by Anoop Dubey 🚀          ║

╚══════════════════════════════════════════╝
*/

'use strict';

// ─── Crypto global polyfill (MUST be before all other requires) ───────────
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
  // flexible match
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
  try {
    const m = msg.message;
    if (!m) return '';

    // unwrap ephemeral / view-once wrappers
    const inner =
      m.ephemeralMessage?.message ||
      m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message ||
      m.documentWithCaptionMessage?.message ||
      m;

    const type = getContentType(inner);
    if (!type) return '';

    if (type === 'conversation') return inner.conversation || '';
    if (type === 'extendedTextMessage') return inner.extendedTextMessage?.text || '';
    if (type === 'imageMessage') return inner.imageMessage?.caption || '';
    if (type === 'videoMessage') return inner.videoMessage?.caption || '';
    if (type === 'documentMessage') return inner.documentMessage?.caption || '';
    if (type === 'buttonsResponseMessage') return inner.buttonsResponseMessage?.selectedDisplayText || '';
    if (type === 'listResponseMessage') return inner.listResponseMessage?.singleSelectReply?.selectedRowId || '';
    if (type === 'templateButtonReplyMessage') return inner.templateButtonReplyMessage?.selectedId || '';

    return '';
  } catch {
    return '';
  }
}

// ─── Groq AI ─────────────────────────────────────────────────────────────────
async function askGroq(prompt, systemPrompt = 'You are a helpful WhatsApp assistant. Keep answers concise.') {
  try {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: config.groqModel || 'llama3-8b-8192',
        messages: [
          { role: 'system', content: systemPrompt },
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
    if (!res.data?.choices?.[0]?.message?.content) throw new Error('Empty response from Groq');
    return res.data.choices[0].message.content.trim();
  } catch (err) {
    log('ERROR', `askGroq failed: ${err.message}`);
    throw err;
  }
}

// ─── Auto-Reply Store ────────────────────────────────────────────────────────
const autoReplyUsers = new Set();
const autoReplyCooldowns = new Map();
const AUTO_REPLY_COOLDOWN = 8000;

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
  await reply(sock, msg, `⚡ Latency: ${latency}ms\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('help', async (sock, msg) => {
  const list = Object.keys(commands)
    .sort()
    .map((c) => `• .${c}`)
    .join('\n');
  await reply(
    sock,
    msg,
    `╔══════════════════════╗\n║   📋 COMMAND LIST     ║\n╚══════════════════════╝\n\n${list}\n\nDeveloped by Anoop Dubey 🚀`
  );
});

addCmd('menu', async (sock, msg) => {
  await reply(
    sock,
    msg,
    `╔══════════════════════════╗\n║  🤖 WHATSAPP BOT MENU  ║\n╚══════════════════════════╝\n\n🔧 UTILITY\n.ping .uptime .serverinfo\n.myinfo .time .date .calc\n.encode .decode .shorten\n\n🤖 AI\n.ai <prompt>\n\n🌐 INFO & API\n.weather <city>\n.crypto <coin>\n.news .joke .quote\n.fact .wiki <topic>\n.dictionary <word>\n.translate <lang> <text>\n.covid <country>\n.currency <from> <to> <amt>\n.ip <address>\n.whois <domain>\n\n🎲 FUN\n.flipcoin .dice .rps <choice>\n.8ball <question>\n.roast .compliment\n.would .truth .dare\n.meme .riddle\n\n⚙️ SYSTEM\n.owner .botinfo\n.rr <msg> <count>\n.broadcast <msg>\n.kick <@user> (group)\n.add <number> (group)\n.promote <@user>\n.demote <@user>\n.mute .unmute\n.delete .sticker\n.tagall\n\nDeveloped by Anoop Dubey 🚀`
  );
});

addCmd('owner', async (sock, msg) => {
  await reply(
    sock,
    msg,
    `👑 Bot Owner\n\nName: ${config.ownerName || 'Anoop Dubey'}\nNumber: wa.me/${config.ownerNumber}\n\n_Developed by Anoop Dubey 🚀_`
  );
});

addCmd('botinfo', async (sock, msg) => {
  await reply(
    sock,
    msg,
    `🤖 Bot Information\n\n• Name: ${config.botName || 'AnoopBot'}\n• Version: ${config.version || '1.0.0'}\n• Platform: ${os.platform()} ${os.arch()}\n• Node.js: ${process.version}\n• Uptime: ${formatUptime(process.uptime())}\n• Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB used\n\nDeveloped by Anoop Dubey 🚀`
  );
});

addCmd('uptime', async (sock, msg) => {
  await reply(sock, msg, `⏱️ Uptime: ${formatUptime(process.uptime())}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('serverinfo', async (sock, msg) => {
  const cpus = os.cpus();
  await reply(
    sock,
    msg,
    `🖥️ Server Info\n\n• OS: ${os.type()} ${os.release()}\n• CPU: ${cpus[0]?.model || 'Unknown'} (${cpus.length} cores)\n• RAM: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB total\n• Free RAM: ${(os.freemem() / 1024 / 1024 / 1024).toFixed(2)} GB\n• Hostname: ${os.hostname()}\n\nDeveloped by Anoop Dubey 🚀`
  );
});

addCmd('myinfo', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;
  await reply(
    sock,
    msg,
    `👤 Your Info\n\n• JID: ${sender}\n• Number: ${sender.split('@')[0]}\n• Chat: ${jid.endsWith('@g.us') ? 'Group' : 'Private'}\n\nDeveloped by Anoop Dubey 🚀`
  );
});

addCmd('time', async (sock, msg) => {
  const now = new Date();
  await reply(sock, msg, `🕐 Current Time (UTC):\n${now.toUTCString()}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('date', async (sock, msg) => {
  const now = new Date();
  await reply(
    sock,
    msg,
    `📅 Today's Date:\n${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n\n_Developed by Anoop Dubey 🚀_`
  );
});

addCmd('calc', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .calc <expression>\nExample: .calc 2+2*5');
  const expr = args.join(' ');
  try {
    const safeExpr = expr.replace(/[^0-9+\-*/.() ]/g, '');
    const result = Function('"use strict"; return (' + safeExpr + ')')();
    await reply(sock, msg, `🧮 Calculator\n\n📥 Input: ${expr}\n📤 Result: ${result}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Invalid expression.');
  }
});

addCmd('encode', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .encode <text>');
  const encoded = Buffer.from(args.join(' ')).toString('base64');
  await reply(sock, msg, `🔐 Base64 Encoded:\n${encoded}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('decode', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .decode <base64>');
  try {
    const decoded = Buffer.from(args[0], 'base64').toString('utf-8');
    await reply(sock, msg, `🔓 Base64 Decoded:\n${decoded}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Invalid Base64 string.');
  }
});

addCmd('shorten', async (sock, msg, args) => {
  if (!args[0]) return reply(sock, msg, '❌ Usage: .shorten <url>');
  try {
    const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(args[0])}`, { timeout: 8000 });
    await reply(sock, msg, `🔗 Shortened URL:\n${res.data}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Failed to shorten URL.');
  }
});

// ────────────────────────────────────────────────────────────────────────────
//  AI COMMAND
// ────────────────────────────────────────────────────────────────────────────

addCmd('ai', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .ai <your question>');
  if (!config.groqApiKey || config.groqApiKey === 'your_groq_api_key') {
    return reply(sock, msg, '❌ Groq API key not set in config.json');
  }
  const prompt = args.join(' ');
  await typingDelay(sock, msg.key.remoteJid, 2000);
  try {
    const answer = await askGroq(prompt);
    await reply(sock, msg, `🤖 *AI Response*\n\n${answer}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch (e) {
    log('ERROR', `Groq API: ${e.message}`);
    await reply(sock, msg, '❌ AI unavailable right now. Try again later.\n\n_Developed by Anoop Dubey 🚀_');
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
      `🌤️ Weather in ${d.name}, ${d.sys.country}\n\n🌡️ Temp: ${d.main.temp}°C (feels ${d.main.feels_like}°C)\n💧 Humidity: ${d.main.humidity}%\n🌬️ Wind: ${d.wind.speed} m/s\n☁️ Condition: ${d.weather[0].description}\n\nDeveloped by Anoop Dubey 🚀`
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
      `💰 ${coin.toUpperCase()} Price\n\n💵 USD: $${data.usd?.toLocaleString()}\n₹ INR: ₹${data.inr?.toLocaleString()}\n📈 24h Change: ${data.usd_24h_change?.toFixed(2)}%\n\nDeveloped by Anoop Dubey 🚀`
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
    const text = articles.map((a, i) => `${i + 1}. ${a.title}\n   🔗 ${a.url}`).join('\n\n');
    await reply(sock, msg, `📰 Top 5 News Headlines\n\n${text}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Failed to fetch news.');
  }
});

addCmd('joke', async (sock, msg) => {
  try {
    const res = await axios.get('https://official-joke-api.appspot.com/random_joke', { timeout: 8000 });
    await reply(sock, msg, `😂 Random Joke\n\n${res.data.setup}\n\n${res.data.punchline}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Could not fetch a joke.');
  }
});

addCmd('quote', async (sock, msg) => {
  try {
    const res = await axios.get('https://zenquotes.io/api/random', { timeout: 8000 });
    const q = res.data[0];
    await reply(sock, msg, `💬 Quote of the Day\n\n"${q.q}"\n— ${q.a}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Could not fetch quote.');
  }
});

addCmd('fact', async (sock, msg) => {
  try {
    const res = await axios.get('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en', { timeout: 8000 });
    await reply(sock, msg, `💡 Random Fact\n\n${res.data.text}\n\n_Developed by Anoop Dubey 🚀_`);
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
      `📖 Wikipedia: ${res.data.title}\n\n${res.data.extract || 'No summary available.'}\n\n🔗 ${res.data.content_urls?.desktop?.page || ''}\n\n_Developed by Anoop Dubey 🚀_`
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
      `📚 ${entry.word}\n\n🗣️ Part of Speech: ${meaning.partOfSpeech}\n📝 Definition: ${def.definition}\n📖 Example: ${def.example || 'N/A'}\n🔄 Synonyms: ${def.synonyms?.slice(0, 3).join(', ') || 'N/A'}\n\nDeveloped by Anoop Dubey 🚀`
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
      `🌐 Translation (→ ${lang})\n\n📥 Original: ${text}\n📤 Translated: ${res.data.responseData.translatedText}\n\n_Developed by Anoop Dubey 🚀_`
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
    await reply(sock, msg, `💱 Currency Converter\n\n${amount} ${from.toUpperCase()} = ${result} ${to.toUpperCase()}\n📊 Rate: 1 ${from.toUpperCase()} = ${rate} ${to.toUpperCase()}\n\n_Developed by Anoop Dubey 🚀_`);
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
      `🌍 IP Information\n\n🔹 IP: ${d.ip}\n🏳️ Country: ${d.country_name}\n🏙️ City: ${d.city}\n📍 Region: ${d.region}\n📮 Postal: ${d.postal}\n🌐 ISP: ${d.org}\n🕐 Timezone: ${d.timezone}\n\nDeveloped by Anoop Dubey 🚀`
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
      `🔍 WHOIS: ${args[0]}\n\n📛 Domain: ${d.domain}\n📅 Created: ${d.create_date || 'N/A'}\n🔄 Updated: ${d.update_date || 'N/A'}\n🌐 Country: ${d.country || 'N/A'}\n\nDeveloped by Anoop Dubey 🚀`
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
      `🦠 COVID-19 Stats: ${d.country || 'World'}\n\n✅ Cases: ${d.cases?.toLocaleString()}\n💀 Deaths: ${d.deaths?.toLocaleString()}\n💚 Recovered: ${d.recovered?.toLocaleString()}\n🏥 Active: ${d.active?.toLocaleString()}\n📅 Updated: ${new Date(d.updated).toLocaleString()}\n\nDeveloped by Anoop Dubey 🚀`
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
      `🐙 GitHub: ${d.login}\n\n👤 Name: ${d.name || 'N/A'}\n📝 Bio: ${d.bio || 'N/A'}\n📦 Repos: ${d.public_repos}\n👥 Followers: ${d.followers}\n🔗 ${d.html_url}\n\nDeveloped by Anoop Dubey 🚀`
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
  await reply(sock, msg, `Coin Flip Result: ${result}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('dice', async (sock, msg, args) => {
  const sides = parseInt(args[0]) || 6;
  const result = Math.floor(Math.random() * sides) + 1;
  await reply(sock, msg, `🎲 Dice Roll (d${sides}): ${result}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('rps', async (sock, msg, args) => {
  const choices = ['rock', 'paper', 'scissors'];
  const emojis = { rock: '🪨', paper: '📄', scissors: '✂️' };
  const userChoice = (args[0] || '').toLowerCase();
  if (!choices.includes(userChoice)) return reply(sock, msg, '❌ Usage: .rps <rock|paper|scissors>');
  const botChoice = choices[Math.floor(Math.random() * 3)];
  let result;
  if (userChoice === botChoice) result = "It's a tie! 🤝";
  else if (
    (userChoice === 'rock' && botChoice === 'scissors') ||
    (userChoice === 'paper' && botChoice === 'rock') ||
    (userChoice === 'scissors' && botChoice === 'paper')
  )
    result = 'You win! 🎉';
  else result = 'You lose! 😢';

  await reply(sock, msg, `✊ Rock Paper Scissors\n\nYou: ${emojis[userChoice]} ${userChoice}\nBot: ${emojis[botChoice]} ${botChoice}\n\n${result}\n\n_Developed by Anoop Dubey 🚀_`);
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
  await reply(sock, msg, `🎱 Magic 8-Ball\n\n❓ ${args.join(' ')}\n\n💬 ${answer}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('roast', async (sock, msg) => {
  const roasts = [
    "You're the reason they put instructions on shampoo bottles.",
    "I'd agree with you but then we'd both be wrong.",
    "You're not stupid; you just have bad luck thinking.",
    'Some cause happiness wherever they go. You cause it whenever you go.',
    "I'd call you a tool, but that would mean you're actually useful.",
  ];
  await reply(sock, msg, `🔥 Roast:\n\n${roasts[Math.floor(Math.random() * roasts.length)]}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('compliment', async (sock, msg) => {
  const compliments = [
    'You light up every room you walk into! ✨',
    'Your kindness is a strength, not a weakness. 💪',
    'You have an incredible mind! 🧠',
    'You make the world a better place just by being in it. 🌍',
    'You are more than enough. 💫',
  ];
  await reply(sock, msg, `💖 Compliment:\n\n${compliments[Math.floor(Math.random() * compliments.length)]}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('would', async (sock, msg) => {
  const questions = [
    'Would you rather have super speed or super strength?',
    'Would you rather be invisible or be able to fly?',
    'Would you rather eat only pizza or only sushi for life?',
    "Would you rather know when you'll die or how you'll die?",
    'Would you rather be a famous actor or a famous musician?',
  ];
  await reply(sock, msg, `🤔 Would You Rather?\n\n${questions[Math.floor(Math.random() * questions.length)]}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('truth', async (sock, msg) => {
  const truths = [
    "What's the most embarrassing thing you've ever done?",
    "What's your biggest secret?",
    'Have you ever lied to your best friend?',
    "What's the worst thing you've ever said about someone behind their back?",
    'Have you ever cheated on a test?',
  ];
  await reply(sock, msg, `💬 Truth:\n\n${truths[Math.floor(Math.random() * truths.length)]}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('dare', async (sock, msg) => {
  const dares = [
    'Send a voice message singing your favourite song.',
    'Change your display name to something funny for 1 hour.',
    'Post the last photo in your gallery as your status.',
    'Text your crush right now!',
    'Do 20 push-ups and send proof.',
  ];
  await reply(sock, msg, `😈 Dare:\n\n${dares[Math.floor(Math.random() * dares.length)]}\n\n_Developed by Anoop Dubey 🚀_`);
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
  await reply(sock, msg, `🧩 Riddle\n\n❓ ${r.q}\n\n||💡 Answer: ${r.a}||\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('meme', async (sock, msg) => {
  try {
    const res = await axios.get('https://meme-api.com/gimme', { timeout: 8000 });
    const meme = res.data;
    await sock.sendMessage(msg.key.remoteJid, {
      image: { url: meme.url },
      caption: `😂 ${meme.title}\n\n_Developed by Anoop Dubey 🚀_`,
    }, { quoted: msg });
  } catch {
    await reply(sock, msg, '❌ Failed to fetch meme.');
  }
});

addCmd('number', async (sock, msg, args) => {
  const num = args[0] || Math.floor(Math.random() * 1000);
  try {
    const res = await axios.get(`http://numbersapi.com/${num}`, { timeout: 8000 });
    await reply(sock, msg, `🔢 Number Fact: ${num}\n\n${res.data}\n\n_Developed by Anoop Dubey 🚀_`);
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

// ────────────────────────────────────────────────────────────────────────────
//  GROUP COMMANDS
// ────────────────────────────────────────────────────────────────────────────

addCmd('kick', async (sock, msg, args) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return reply(sock, msg, '❌ This command only works in groups.');
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (!mentioned.length) return reply(sock, msg, '❌ Tag the user to kick: .kick @user');
  for (const user of mentioned) {
    try {
      await sock.groupParticipantsUpdate(jid, [user], 'remove');
    } catch {}
  }
  await reply(sock, msg, `✅ Kicked ${mentioned.length} user(s).\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('add', async (sock, msg, args) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return reply(sock, msg, '❌ This command only works in groups.');
  if (!args[0]) return reply(sock, msg, '❌ Usage: .add <number> (with country code, no +)');
  const user = `${args[0].replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  try {
    await sock.groupParticipantsUpdate(jid, [user], 'add');
    await reply(sock, msg, `✅ Added ${args[0]}.\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Failed to add user.');
  }
});

addCmd('promote', async (sock, msg, args) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return reply(sock, msg, '❌ This command only works in groups.');
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (!mentioned.length) return reply(sock, msg, '❌ Tag the user to promote.');
  for (const user of mentioned) {
    try { await sock.groupParticipantsUpdate(jid, [user], 'promote'); } catch {}
  }
  await reply(sock, msg, `✅ Promoted ${mentioned.length} user(s).\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('demote', async (sock, msg, args) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return reply(sock, msg, '❌ This command only works in groups.');
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (!mentioned.length) return reply(sock, msg, '❌ Tag the user to demote.');
  for (const user of mentioned) {
    try { await sock.groupParticipantsUpdate(jid, [user], 'demote'); } catch {}
  }
  await reply(sock, msg, `✅ Demoted ${mentioned.length} user(s).\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('mute', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return reply(sock, msg, '❌ Groups only.');
  try {
    await sock.groupSettingUpdate(jid, 'announcement');
    await reply(sock, msg, '🔇 Group muted (only admins can send).\n\n_Developed by Anoop Dubey 🚀_');
  } catch {
    await reply(sock, msg, '❌ Failed. Make sure bot is admin.');
  }
});

addCmd('unmute', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return reply(sock, msg, '❌ Groups only.');
  try {
    await sock.groupSettingUpdate(jid, 'not_announcement');
    await reply(sock, msg, '🔊 Group unmuted.\n\n_Developed by Anoop Dubey 🚀_');
  } catch {
    await reply(sock, msg, '❌ Failed. Make sure bot is admin.');
  }
});

addCmd('tagall', async (sock, msg) => {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return reply(sock, msg, '❌ Groups only.');
  try {
    const meta = await sock.groupMetadata(jid);
    const members = meta.participants.map((p) => p.id);
    const text = members.map((m) => `@${m.split('@')[0]}`).join(' ');
    await sock.sendMessage(jid, { text: `📢 Tagging all members:\n\n${text}`, mentions: members }, { quoted: msg });
  } catch {
    await reply(sock, msg, '❌ Failed to tag all.');
  }
});

addCmd('delete', async (sock, msg) => {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
  const participant = msg.message?.extendedTextMessage?.contextInfo?.participant;
  const jid = msg.key.remoteJid;
  if (!quoted) return reply(sock, msg, '❌ Reply to a message to delete it.');
  try {
    await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: quoted, participant } });
  } catch {
    await reply(sock, msg, '❌ Could not delete message.');
  }
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
      await sock.sendMessage(jid, { text: `📢 Broadcast\n\n${text}\n\n_Developed by Anoop Dubey 🚀_` });
      sent++;
      await sleep(1000);
    } catch {}
  }
  await reply(sock, msg, `✅ Broadcast complete. Sent to ${sent} chats.\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('sticker', async (sock, msg) => {
  try {
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted) return reply(sock, msg, '❌ Reply to an image or short video to make a sticker.\n\n_Developed by Anoop Dubey 🚀_');
    const type = getContentType(quoted);
    if (!['imageMessage', 'videoMessage'].includes(type)) {
      return reply(sock, msg, '❌ Reply to an *image* or *video* only.\n\n_Developed by Anoop Dubey 🚀_');
    }
    await reply(sock, msg, '⏳ Creating sticker...');
    const msgType = type === 'imageMessage' ? 'image' : 'video';
    const stream = await sock.downloadContentFromMessage(quoted[type], msgType);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    if (!buffer.length) throw new Error('Empty buffer downloaded');
    await sock.sendMessage(
      msg.key.remoteJid,
      {
        sticker: buffer,
        ...(type === 'videoMessage' ? { gifPlayback: false } : {}),
      },
      { quoted: msg }
    );
  } catch (err) {
    log('ERROR', `sticker: ${err.message}`);
    await reply(sock, msg, '❌ Failed to create sticker. Make sure image/video is not too large.\n\n_Developed by Anoop Dubey 🚀_');
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
    const lyricsText = d.lyrics?.slice(0, 1500) || 'Lyrics not found.';
    await reply(sock, msg, `🎵 ${d.title} by ${d.author}\n\n${lyricsText}\n\n_Developed by Anoop Dubey 🚀_`);
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
      caption: `🎨 Avatar generated!\n\n_Developed by Anoop Dubey 🚀_`,
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
      caption: `📱 QR Code Generated!\n\n_Developed by Anoop Dubey 🚀_`,
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
      caption: `📸 Screenshot of: ${args[0]}\n\n_Developed by Anoop Dubey 🚀_`,
    }, { quoted: msg });
  } catch {
    await reply(sock, msg, '❌ Failed to take screenshot.');
  }
});

addCmd('password', async (sock, msg, args) => {
  const len = parseInt(args[0]) || 16;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()+-=';
  let pwd = '';
  for (let i = 0; i < Math.min(len, 64); i++) pwd += chars[Math.floor(Math.random() * chars.length)];
  await reply(sock, msg, `🔑 Generated Password (${len} chars):\n${pwd}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('uuid', async (sock, msg) => {
  const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
  await reply(sock, msg, `🆔 Generated UUID:\n${uuid}\n\n_Developed by Anoop Dubey 🚀_`);
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
  await reply(sock, msg, `📝 Lorem Ipsum:\n\n${text}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('ascii', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .ascii <text>');
  const text = args.join(' ').toUpperCase().slice(0, 10);
  const art = text.split('').join('  ');
  await reply(sock, msg, `🔤 ASCII Art:\n\n${art}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('reverse', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .reverse <text>');
  const reversed = args.join(' ').split('').reverse().join('');
  await reply(sock, msg, `🔄 Reversed:\n${reversed}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('charcount', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .charcount <text>');
  const text = args.join(' ');
  await reply(sock, msg, `📊 Character Count\n\nText: "${text}"\nCharacters: ${text.length}\nWords: ${text.split(/\s+/).length}\nLetters: ${(text.match(/[a-zA-Z]/g) || []).length}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('mock', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .mock <text>');
  const mocked = args.join(' ').split('').map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('');
  await reply(sock, msg, `🤪 MoCkEd:\n${mocked}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('binary', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .binary <text>');
  const bin = args.join(' ').split('').map((c) => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' ');
  await reply(sock, msg, `💻 Binary:\n${bin}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('hex', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .hex <text>');
  const hex = Buffer.from(args.join(' ')).toString('hex');
  await reply(sock, msg, `🔢 Hex:\n${hex}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('age', async (sock, msg, args) => {
  if (!args[0]) return reply(sock, msg, '❌ Usage: .age <YYYY-MM-DD>');
  const birth = new Date(args[0]);
  if (isNaN(birth)) return reply(sock, msg, '❌ Invalid date format. Use YYYY-MM-DD');
  const now = new Date();
  const age = now.getFullYear() - birth.getFullYear() - (now < new Date(now.getFullYear(), birth.getMonth(), birth.getDate()) ? 1 : 0);
  await reply(sock, msg, `🎂 Age Calculator\n\nBirthdate: ${args[0]}\nAge: ${age} years old\n\n_Developed by Anoop Dubey 🚀_`);
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
  await reply(sock, msg, `⏳ Countdown to ${name}\n\n📅 Date: ${args[0]}\n⏰ Time left: ${days}d ${hrs}h\n\n_Developed by Anoop Dubey 🚀_`);
});

// ────────────────────────────────────────────────────────────────────────────
//  FIXED .rr COMMAND
// ────────────────────────────────────────────────────────────────────────────

addCmd('rr', async (sock, msg, args) => {
  if (args.length < 2) return reply(sock, msg, '❌ Usage: .rr <message> <count>\nMax count: 20\n\n_Developed by Anoop Dubey 🚀_');
  const count = Math.min(parseInt(args[args.length - 1]) || 1, 20);
  if (isNaN(count) || count < 1) return reply(sock, msg, '❌ Count must be a number between 1-20.');
  const text = args.slice(0, -1).join(' ');
  if (!text) return reply(sock, msg, '❌ Please provide a message to repeat.');
  await reply(sock, msg, `📤 Sending *${count}* messages...\n\n_Developed by Anoop Dubey 🚀_`);
  const jid = msg.key.remoteJid;
  for (let i = 1; i <= count; i++) {
    try {
      await sock.sendMessage(jid, { text: `[${i}/${count}] ${text}\n\n_Developed by Anoop Dubey 🚀_` });
      await sleep(1500);
    } catch (e) {
      log('ERROR', `rr send ${i}: ${e.message}`);
    }
  }
});

// ────────────────────────────────────────────────────────────────────────────
//  AUTO-REPLY COMMANDS
// ────────────────────────────────────────────────────────────────────────────

addCmd('autoreply', async (sock, msg, args) => {
  const jid = msg.key.remoteJid;
  const sub = (args[0] || '').toLowerCase();
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

  if (sub === 'list') {
    if (!autoReplyUsers.size) return reply(sock, msg, '📋 No users in auto-reply list.\n\n_Developed by Anoop Dubey 🚀_');
    const list = [...autoReplyUsers].map(u => `• @${u.split('@')[0]}`).join('\n');
    return reply(sock, msg, `🤖 *Auto-Reply List*\n\n${list}\n\n_Developed by Anoop Dubey 🚀_`);
  }

  if (!['on', 'off'].includes(sub)) {
    return reply(sock, msg, '❌ Usage:\n.autoreply on @user\n.autoreply off @user\n.autoreply list\n\n_Developed by Anoop Dubey 🚀_');
  }
  if (!mentioned.length) return reply(sock, msg, '❌ Tag a user: .autoreply on @user\n\n_Developed by Anoop Dubey 🚀_');

  for (const user of mentioned) {
    if (sub === 'on') {
      autoReplyUsers.add(user);
    } else {
      autoReplyUsers.delete(user);
    }
  }
  const names = mentioned.map(u => `@${u.split('@')[0]}`).join(', ');
  await reply(sock, msg, `✅ Auto-reply *${sub.toUpperCase()}* for ${names}\n\n_Developed by Anoop Dubey 🚀_`);
});

// ────────────────────────────────────────────────────────────────────────────
//  POWER AI COMMANDS
// ────────────────────────────────────────────────────────────────────────────

addCmd('gpt', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .gpt <prompt>\n\n_Developed by Anoop Dubey 🚀_');
  const prompt = args.join(' ');
  await typingDelay(sock, msg.key.remoteJid, 1500);
  try {
    const ans = await askGroq(prompt, 'You are a smart AI assistant. Reply in 1-3 short lines. Be direct and helpful.');
    await reply(sock, msg, `🧠 *GPT Response*\n\n${ans}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ AI unavailable. Try again.\n\n_Developed by Anoop Dubey 🚀_');
  }
});

addCmd('debug', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .debug <your code>\n\n_Developed by Anoop Dubey 🚀_');
  const code = args.join(' ');
  await typingDelay(sock, msg.key.remoteJid, 2000);
  try {
    const ans = await askGroq(`Debug this code and explain the bug clearly:\n\`\`\`\n${code}\n\`\`\``, 'You are a senior developer. Find bugs, explain them simply, and suggest the fix. Be concise.');
    await reply(sock, msg, `🐛 *Debug Analysis*\n\n${ans}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ AI unavailable.\n\n_Developed by Anoop Dubey 🚀_');
  }
});

addCmd('gen', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .gen <idea topic>\n\n_Developed by Anoop Dubey 🚀_');
  const idea = args.join(' ');
  await typingDelay(sock, msg.key.remoteJid, 2000);
  try {
    const ans = await askGroq(`Generate a unique startup/business idea about: ${idea}`, 'You generate creative startup ideas. Format: Name, Problem, Solution, Revenue Model. Keep it short.');
    await reply(sock, msg, `💡 *Startup Idea*\n\n${ans}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ AI unavailable.\n\n_Developed by Anoop Dubey 🚀_');
  }
});

addCmd('prompt', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .prompt <topic>\n\n_Developed by Anoop Dubey 🚀_');
  const topic = args.join(' ');
  await typingDelay(sock, msg.key.remoteJid, 1500);
  try {
    const ans = await askGroq(`Create a powerful AI prompt for the topic: ${topic}`, 'You are a prompt engineer. Generate creative, detailed AI prompts. Keep it under 5 lines.');
    await reply(sock, msg, `✍️ *AI Prompt*\n\n${ans}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ AI unavailable.\n\n_Developed by Anoop Dubey 🚀_');
  }
});

// ────────────────────────────────────────────────────────────────────────────
//  VIRAL / FLEX COMMANDS
// ────────────────────────────────────────────────────────────────────────────

addCmd('hack', async (sock, msg, args) => {
  const target = args.join(' ') || 'Target System';
  const jid = msg.key.remoteJid;
  const steps = [
    `💀 *HACK INITIATED* 💀\n\n🎯 Target: ${target}\n🔍 Scanning open ports...`,
    `⚡ Port scan complete!\n🔓 Vulnerabilities found: 3\n📡 Attempting SSH brute force...`,
    `🔐 SSH cracked!\n👤 User: admin | Pass: ****\n📂 Accessing root directory...`,
    `💾 Dumping database...\n📊 Rows extracted: 48,291\n🔑 Decrypting password hashes...`,
    `✅ *HACK COMPLETE!*\n\n🏆 Target: ${target}\n📁 Files stolen: 12,482\n🔓 Accounts cracked: 7\n\n⚠️ _This is just for fun. Hacking is illegal! 😈_\n\n_Developed by Anoop Dubey 🚀_`,
  ];
  for (const step of steps) {
    await sock.sendMessage(jid, { text: step }, { quoted: msg });
    await sleep(2000);
  }
});

addCmd('iptrack', async (sock, msg, args) => {
  if (!args[0]) return reply(sock, msg, '❌ Usage: .iptrack <ip>\n\n_Developed by Anoop Dubey 🚀_');
  const ip = args[0];
  try {
    const res = await axios.get(`https://ipapi.co/${ip}/json/`, { timeout: 8000 });
    const d = res.data;
    if (d.error) return reply(sock, msg, `❌ Invalid IP: ${d.reason || 'Unknown error'}`);
    await reply(sock, msg, `🌍 *IP TRACKER* 🌍\n\n╔══════════════════╗\n║  TARGET LOCATED  ║\n╚══════════════════╝\n\n🔹 IP: ${d.ip}\n🏳️ Country: ${d.country_name} ${d.country_code}\n🏙️ City: ${d.city}\n📍 Region: ${d.region}\n🌐 ISP: ${d.org}\n📡 Network: ${d.network || 'N/A'}\n🕐 Timezone: ${d.timezone}\n📮 Postal: ${d.postal || 'N/A'}\n📌 Coords: ${d.latitude}, ${d.longitude}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ Failed to track IP.\n\n_Developed by Anoop Dubey 🚀_');
  }
});

addCmd('darkweb', async (sock, msg) => {
  const sites = ['xmh57jrzrnw6insl.onion', 'silkroad7rn2puhj.onion', 'hss3uro2hsxfogfq.onion', 'zqktlwiuavvvqqt4.onion'];
  const data = ['BTC Wallet: 1A2B3...8Z', 'Stolen DB: 2.1M records', 'Credit Cards: $5 each', 'Premium VPN: Free tier'];
  const rdSite = sites[Math.floor(Math.random() * sites.length)];
  const rdData = data[Math.floor(Math.random() * data.length)];
  await reply(sock, msg, `🕸️ *DARK WEB SCANNER* 🕸️\n\n⚠️ Connecting to Tor network...\n🔒 Anonymizing IP...\n✅ Connected!\n\n📡 Random .onion: ${rdSite}\n💀 Found: ${rdData}\n\n⚠️ _This is fictional/for fun. Do NOT access dark web!_\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('identity', async (sock, msg) => {
  const firstNames = ['Alex', 'Jordan', 'Morgan', 'Taylor', 'Casey', 'Riley', 'Avery', 'Quinn'];
  const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis'];
  const cities = ['New York', 'London', 'Toronto', 'Sydney', 'Berlin', 'Mumbai', 'Tokyo', 'Paris'];
  const domains = ['gmail.com', 'yahoo.com', 'outlook.com', 'proton.me'];
  const fn = firstNames[Math.floor(Math.random() * firstNames.length)];
  const ln = lastNames[Math.floor(Math.random() * lastNames.length)];
  const city = cities[Math.floor(Math.random() * cities.length)];
  const dom = domains[Math.floor(Math.random() * domains.length)];
  const year = 1980 + Math.floor(Math.random() * 25);
  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
  const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
  const phone = `+1${Math.floor(Math.random() * 9000000000) + 1000000000}`;
  await reply(sock, msg, `🎭 *FAKE IDENTITY GENERATOR*\n\n👤 Name: ${fn} ${ln}\n📧 Email: ${fn.toLowerCase()}.${ln.toLowerCase()}@${dom}\n📱 Phone: ${phone}\n🎂 DOB: ${year}-${month}-${day}\n🏙️ City: ${city}\n🔑 Password: ${fn}@${year}!\n\n⚠️ _For fun only. Do not misuse!_\n\n_Developed by Anoop Dubey 🚀_`);
});

// ────────────────────────────────────────────────────────────────────────────
//  SOCIAL COMMANDS
// ────────────────────────────────────────────────────────────────────────────

addCmd('githubstalk', async (sock, msg, args) => {
  if (!args[0]) return reply(sock, msg, '❌ Usage: .githubstalk <username>\n\n_Developed by Anoop Dubey 🚀_');
  try {
    const [userRes, repoRes] = await Promise.all([
      axios.get(`https://api.github.com/users/${args[0]}`, { timeout: 8000 }),
      axios.get(`https://api.github.com/users/${args[0]}/repos?sort=updated&per_page=3`, { timeout: 8000 }),
    ]);
    const d = userRes.data;
    const repos = repoRes.data.map(r => `• ${r.name} ⭐${r.stargazers_count}`).join('\n');
    await reply(sock, msg, `🕵️ *GitHub Stalk: ${d.login}*\n\n👤 Name: ${d.name || 'N/A'}\n📝 Bio: ${d.bio || 'N/A'}\n📦 Repos: ${d.public_repos}\n👥 Followers: ${d.followers}\n➕ Following: ${d.following}\n🏢 Company: ${d.company || 'N/A'}\n📍 Location: ${d.location || 'N/A'}\n🔗 ${d.html_url}\n\n📂 *Top Repos:*\n${repos || 'None'}\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    await reply(sock, msg, '❌ GitHub user not found.\n\n_Developed by Anoop Dubey 🚀_');
  }
});

addCmd('instauser', async (sock, msg, args) => {
  if (!args[0]) return reply(sock, msg, '❌ Usage: .instauser <username>\n\n_Developed by Anoop Dubey 🚀_');
  await reply(sock, msg, `📸 *Instagram: @${args[0]}*\n\n🔗 Profile: instagram.com/${args[0]}\n\n⚠️ Instagram blocks API access. Open the link to view profile.\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('website', async (sock, msg, args) => {
  if (!args[0]) return reply(sock, msg, '❌ Usage: .website <url>\n\n_Developed by Anoop Dubey 🚀_');
  let url = args[0];
  if (!url.startsWith('http')) url = 'https://' + url;
  try {
    const res = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = res.data.toString();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    const title = titleMatch?.[1]?.trim() || 'N/A';
    const desc = descMatch?.[1]?.trim() || 'N/A';
    await reply(sock, msg, `🌐 *Website Info*\n\n🔗 URL: ${url}\n📌 Title: ${title}\n📝 Description: ${desc.slice(0, 200)}\n✅ Status: Online\n\n_Developed by Anoop Dubey 🚀_`);
  } catch (e) {
    await reply(sock, msg, `❌ Could not fetch website. It may be offline or blocking bots.\n\n_Developed by Anoop Dubey 🚀_`);
  }
});

// ────────────────────────────────────────────────────────────────────────────
//  USEFUL COMMANDS
// ────────────────────────────────────────────────────────────────────────────

addCmd('passgen', async (sock, msg, args) => {
  const len = Math.min(parseInt(args[0]) || 16, 64);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=';
  let pwd = '';
  for (let i = 0; i < len; i++) pwd += chars[Math.floor(Math.random() * chars.length)];
  await reply(sock, msg, `🔑 *Strong Password*\n\n\`${pwd}\`\n\nLength: ${len} chars\n💪 Strength: Very Strong\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('username', async (sock, msg, args) => {
  if (!args.length) return reply(sock, msg, '❌ Usage: .username <name>\n\n_Developed by Anoop Dubey 🚀_');
  const base = args.join('').toLowerCase().replace(/[^a-z0-9]/g, '');
  const styles = [
    `_${base}_`,
    `${base}.official`,
    `x_${base}_x`,
    `${base}__`,
    `${base}.real`,
    `im.${base}`,
    `${base}.yt`,
    `${base}.ig`,
    `the.${base}`,
    `${base}.pro`,
  ];
  await reply(sock, msg, `✨ *Username Ideas for "${args.join(' ')}"*\n\n${styles.map(s => `• ${s}`).join('\n')}\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('tempemail', async (sock, msg) => {
  try {
    const res = await axios.get('https://api.guerrillamail.com/ajax.php?f=get_email_address', { timeout: 8000 });
    const email = res.data?.email_addr;
    if (!email) throw new Error('No email');
    await reply(sock, msg, `📧 *Temp Email Generated!*\n\n📬 Email: ${email}\n⏳ Expires in ~1 hour\n\n🔗 Check inbox: guerrillamail.com\n\n_Developed by Anoop Dubey 🚀_`);
  } catch {
    const rand = Math.random().toString(36).slice(2, 10);
    await reply(sock, msg, `📧 *Temp Email*\n\n📬 Email: ${rand}@guerrillamailblock.com\n\n🔗 Check at: guerrillamail.com\n\n_Developed by Anoop Dubey 🚀_`);
  }
});

// ────────────────────────────────────────────────────────────────────────────
//  GAME COMMANDS
// ────────────────────────────────────────────────────────────────────────────

const quizData = [
  { q: 'What is the capital of Japan?', options: ['A) Beijing', 'B) Seoul', 'C) Tokyo', 'D) Bangkok'], ans: 'C' },
  { q: 'What does HTML stand for?', options: ['A) Hyper Text Markup Language', 'B) High Tech Machine Language', 'C) Home Tool Markup Language', 'D) None'], ans: 'A' },
  { q: 'How many bits in a byte?', options: ['A) 4', 'B) 8', 'C) 16', 'D) 32'], ans: 'B' },
  { q: 'Who created Linux?', options: ['A) Bill Gates', 'B) Steve Jobs', 'C) Linus Torvalds', 'D) Mark Zuckerberg'], ans: 'C' },
  { q: 'What is 2^10?', options: ['A) 512', 'B) 1024', 'C) 2048', 'D) 256'], ans: 'B' },
];

addCmd('quiz', async (sock, msg) => {
  const q = quizData[Math.floor(Math.random() * quizData.length)];
  await reply(sock, msg, `🎯 *QUIZ TIME!*\n\n❓ ${q.q}\n\n${q.options.join('\n')}\n\n||✅ Answer: ${q.ans}||\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('mathbattle', async (sock, msg) => {
  const ops = ['+', '-', '*'];
  const op = ops[Math.floor(Math.random() * ops.length)];
  const a = Math.floor(Math.random() * 50) + 1;
  const b = Math.floor(Math.random() * 20) + 1;
  let ans;
  if (op === '+') ans = a + b;
  else if (op === '-') ans = a - b;
  else ans = a * b;
  await reply(sock, msg, `⚡ *MATH BATTLE!*\n\n🧮 Solve: ${a} ${op} ${b} = ?\n\n⏱️ 10 seconds!\n\n||✅ Answer: ${ans}||\n\n_Developed by Anoop Dubey 🚀_`);
});

addCmd('rank', async (sock, msg) => {
  const ranks = [
    '😂 Rank: *NOOB* (Bottom 0.1%)',
    '🟤 Rank: *BRONZE* (Bottom 30%)',
    '⚪ Rank: *SILVER* (Average)',
    '🟡 Rank: *GOLD* (Top 40%)',
    '💎 Rank: *DIAMOND* (Top 15%)',
    '👑 Rank: *LEGEND* (Top 5%)',
    '🔱 Rank: *GOD TIER* (Top 0.1%)',
  ];
  const rank = ranks[Math.floor(Math.random() * ranks.length)];
  await reply(sock, msg, `🏆 *RANK SYSTEM*\n\n${rank}\n\n_Developed by Anoop Dubey 🚀_`);
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
    if (msg.key.fromMe) return; // ignore bot's own messages

    const jid = msg.key.remoteJid;
    if (!jid) return;

    // ── Proper sender for both DM and Group ─────────────────────────────────
    // In groups: key.participant holds the sender's JID
    // In DMs: key.remoteJid is the sender
    const isGroup = jid.endsWith('@g.us');
    const sender = (isGroup ? msg.key.participant : msg.key.remoteJid) || msg.key.remoteJid;

    const text = getMsgText(msg).trim();
    if (!text) return;

    const prefix = config.prefix || '.';

    // ── AUTO-REPLY AI LOGIC ──────────────────────────────────────────────────
    if (!text.startsWith(prefix) && autoReplyUsers.has(sender)) {
      const now = Date.now();
      const lastReply = autoReplyCooldowns.get(sender) || 0;
      if (now - lastReply > AUTO_REPLY_COOLDOWN) {
        autoReplyCooldowns.set(sender, now);
        try {
          await typingDelay(sock, jid, 1000);
          const aiReply = await askGroq(text, 'You are a friendly WhatsApp chat companion. Reply naturally in 1-3 short lines. Be casual and fun. Match the language of the user.');
          await sock.sendMessage(jid, { text: aiReply }, { quoted: msg });
        } catch (e) {
          log('ERROR', `auto-reply AI: ${e.message}`);
        }
      }
      return;
    }

    if (!text.startsWith(prefix)) return;

    const body = text.slice(prefix.length).trim();
    if (!body) return;
    const [cmd, ...args] = body.split(' ');
    const command = cmd.toLowerCase();

    log('INFO', `[${isGroup ? 'GROUP' : 'DM'}] ${sender} → .${command}`);

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
//  CONNECTION — Railway-safe, pairing code from config
// ────────────────────────────────────────────────────────────────────────────

let isReconnecting = false;

async function startBot() {
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

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(qr);
      log('INFO', '╔══════════════════════════════════════╗');
      log('INFO', '║  📱 SCAN QR CODE TO LOGIN           ║');
      log('INFO', '║  Open this URL in your browser:     ║');
      log('INFO', '╚══════════════════════════════════════╝');
      log('INFO', 'QR IMAGE URL: ' + qrUrl);
    }

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
