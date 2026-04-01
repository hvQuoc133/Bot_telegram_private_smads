import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
export const bot = token ? new TelegramBot(token, { polling: true }) : null;

export let botUsername = '';
export const getBotUsername = () => botUsername;
if (bot) {
    bot.getMe().then(me => {
        botUsername = me.username || '';
    }).catch(console.error);
}

export const scheduleCleanup = (chatId: number, messageIds: number[]) => {
    if (!bot) return;
    setTimeout(async () => {
        for (const msgId of messageIds) {
            try {
                await bot.deleteMessage(chatId, msgId);
            } catch (e) {
                // Ignore if message already deleted
            }
        }
    }, 30000);
};

export const isAdmin = async (groupId: number, userId: number) => {
    if (!bot) return false;
    try {
        const member = await bot.getChatMember(groupId, userId);
        return ['creator', 'administrator'].includes(member.status);
    } catch (e) {
        return false;
    }
};
