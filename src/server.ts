import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initDB } from './db/index.ts';
import { bot } from './bot.js';
import { initExpenseTopic } from './bot/topics/expenseTopic.ts';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// API routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

async function startServer() {
  await initDB();

  if (bot) {
    bot.setMyCommands([
      { command: '/menu', description: 'Mở Menu chính' },
      { command: '/cancel', description: 'Hủy thao tác hiện tại' },
      { command: '/set_topic', description: 'Chỉ định Topic nhập liệu (Admin)' }
    ]);

    await initExpenseTopic();
    console.log("🤖 Telegram Bot is running...");
  } else {
    console.warn("⚠️ TELEGRAM_BOT_TOKEN is not set. Bot is disabled.");
  }

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
