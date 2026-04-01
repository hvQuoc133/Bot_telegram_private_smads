import TelegramBot from 'node-telegram-bot-api';
import 'dotenv/config';
import { handleMessage } from './core/messageHandler';
import { handleCallbackQuery } from './core/callbackHandler';

let bot: TelegramBot | null = null;

export const initBot = () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!token || token === 'YOUR_TELEGRAM_BOT_TOKEN') {
    console.warn('TELEGRAM_BOT_TOKEN is not set properly. Bot will not start.');
    return;
  }

  bot = new TelegramBot(token, { polling: true });

  console.log('Telegram Bot initialized.');

  bot.on('message', (msg) => {
    handleMessage(bot!, msg);
  });

  bot.on('callback_query', (query) => {
    handleCallbackQuery(bot!, query);
  });
};

export const getBot = () => bot;
