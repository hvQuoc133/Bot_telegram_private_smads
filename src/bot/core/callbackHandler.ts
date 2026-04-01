import TelegramBot from 'node-telegram-bot-api';
import { getSession } from '../services/sessionManager';

export const handleCallbackQuery = (bot: TelegramBot, query: TelegramBot.CallbackQuery) => {
  const chatId = query.message?.chat.id;
  if (!chatId) return;

  const data = query.data;
  const session = getSession(chatId);

  // Xử lý callback query
  bot.answerCallbackQuery(query.id, { text: `Bạn đã chọn: ${data}` });
};
