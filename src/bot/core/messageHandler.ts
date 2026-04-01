import TelegramBot from 'node-telegram-bot-api';
import { getSession } from '../services/sessionManager';
import { handleExampleTopic } from '../topics/expenseTopic';

export const handleMessage = (bot: TelegramBot, msg: TelegramBot.Message) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;

  const session = getSession(chatId);

  if (text === '/start') {
    bot.sendMessage(chatId, 'Bot đã sẵn sàng!');
    return;
  }

  // Điều hướng tới các topic dựa trên state hoặc command
  handleExampleTopic(bot, msg, session);
};
