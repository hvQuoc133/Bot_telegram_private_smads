import { bot, scheduleCleanup, isAdmin, getBotUsername } from '../../bot.ts';
import { pool } from '../../db/index.ts';
import { SessionData } from '../../types.ts';

const sessions = new Map<string, SessionData>();
const lastUserIncome = new Map<number, { month: string, incomeType: string, rowNumber: number, data: any }>();

const monthIncomeConfig = new Map<string, {
    sheetRefundId: string,
    sheetProjectId: string,
    folderRefundId: string,
    folderProjectId: string
}>();

let allowedIncomeTopic: { chatId?: number, threadId?: number } = {};

async function saveAllowedIncomeTopic(topic: any) {
    allowedIncomeTopic = topic;
    if (pool) {
        await pool.query(`
      INSERT INTO bot_config (key, value) VALUES ('income_allowedTopic', $1)
      ON CONFLICT (key) DO UPDATE SET value = $1
    `, [topic]);
    }
}

async function saveMonthIncomeConfig(month: string, config: any) {
    monthIncomeConfig.set(month, config);
    if (pool) {
        await pool.query(`
      INSERT INTO bot_config (key, value) VALUES ($1, $2)
      ON CONFLICT (key) DO UPDATE SET value = $2
    `, [`income_monthConfig_${month}`, config]);
    }
}

function parseAmount(input: string): { displayAmount: string, sheetAmount: number } {
    let str = input.trim().toLowerCase();
    let isUSD = str.includes('$') || str.includes('usd');

    let numStr = str.replace(/[^\d.,]/g, '');
    let value = 0;

    if (isUSD) {
        numStr = numStr.replace(',', '.');
        value = parseFloat(numStr);
        if (isNaN(value)) value = 0;

        return {
            displayAmount: `$${value}`,
            sheetAmount: value * 26500
        };
    } else {
        numStr = numStr.replace(/[.,]/g, '');
        value = parseInt(numStr, 10);
        if (isNaN(value)) value = 0;

        return {
            displayAmount: `${new Intl.NumberFormat('vi-VN').format(value)} vnd`,
            sheetAmount: value
        };
    }
}

const STATES = {
    IDLE: 'IDLE',
    AWAITING_INCOME_TYPE: 'AWAITING_INCOME_TYPE',
    AWAITING_MONTH: 'AWAITING_MONTH',
    AWAITING_DATE: 'AWAITING_DATE',
    AWAITING_CATEGORY: 'AWAITING_CATEGORY',
    AWAITING_BANK: 'AWAITING_BANK',
    AWAITING_ACCOUNT_NUM: 'AWAITING_ACCOUNT_NUM',
    AWAITING_SENDER: 'AWAITING_SENDER',
    AWAITING_AMOUNT: 'AWAITING_AMOUNT',
    AWAITING_RECEIPT: 'AWAITING_RECEIPT',
    AWAITING_NOTES: 'AWAITING_NOTES',

    ADMIN_AWAITING_MONTH: 'ADMIN_AWAITING_MONTH',
    ADMIN_AWAITING_SHEET_REFUND_ID: 'ADMIN_AWAITING_SHEET_REFUND_ID',
    ADMIN_AWAITING_SHEET_PROJECT_ID: 'ADMIN_AWAITING_SHEET_PROJECT_ID',
    ADMIN_AWAITING_FOLDER_REFUND_ID: 'ADMIN_AWAITING_FOLDER_REFUND_ID',
    ADMIN_AWAITING_FOLDER_PROJECT_ID: 'ADMIN_AWAITING_FOLDER_PROJECT_ID',
    ADMIN_AWAITING_SPECIFIC_EDIT: 'ADMIN_AWAITING_SPECIFIC_EDIT',
};

const getSession = (chatId: number, userId: number) => {
    const key = `income_${chatId}_${userId}`;
    if (!sessions.has(key)) {
        sessions.set(key, { state: STATES.IDLE, data: {}, messageIds: [] });
    }
    return sessions.get(key)!;
};

const showAdminMenu = async (chatId: number, userId: number, session: SessionData, sendMsg: any) => {
    if (!(await isAdmin(allowedIncomeTopic.chatId || chatId, userId))) {
        await sendMsg("⛔ Chỉ Admin mới có quyền cấu hình tháng.");
        return;
    }
    session.state = STATES.IDLE;

    const availableMonths = Array.from(monthIncomeConfig.keys());
    const keyboard = availableMonths.map(m => ([{ text: `Tháng ${m}`, callback_data: `INC_ADMIN_VIEW_MONTH_${m}` }]));

    keyboard.push([{ text: "➕ Thêm tháng mới", callback_data: "INC_ADMIN_ADD_MONTH" }]);
    keyboard.push([{ text: "🔙 Trở lại Menu Thu", callback_data: "CMD_INCOME_MENU" }]);

    await sendMsg("⚙️ **QUẢN LÝ THÁNG (THU)**\nChọn tháng để xem/sửa hoặc thêm mới:", {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });
};

const showEditMenu = async (chatId: number, userId: number, session: SessionData, sendMsg: any) => {
    const lastInc = lastUserIncome.get(userId);
    if (!lastInc) return;
    const d = lastInc.data;
    const displayAmt = d.displayAmount || new Intl.NumberFormat('vi-VN').format(Number(d.amount)) + ' vnd';
    const msg = `📝 **SỬA THÔNG TIN THU**\n\n` +
        `**Tháng:** ${lastInc.month}\n` +
        `**Loại:** ${lastInc.incomeType}\n` +
        `**Ngày:** ${d.date}\n` +
        `**Hạng mục/Dự án:** ${d.category}\n` +
        `**Ngân hàng:** ${d.bank}\n` +
        `**Số TK:** ${d.accountNum}\n` +
        `**Người CK:** ${d.sender}\n` +
        `**Số tiền:** ${displayAmt}\n` +
        `**Ghi chú:** ${d.notes || 'Không có'}\n\n` +
        `Vui lòng chọn phần muốn sửa:`;

    await sendMsg(msg, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "✏️ Sửa Ngày", callback_data: "INC_EDIT_DATE" }],
                [{ text: "✏️ Sửa Hạng mục/Dự án", callback_data: "INC_EDIT_CATEGORY" }],
                [{ text: "✏️ Sửa Ngân hàng", callback_data: "INC_EDIT_BANK" }],
                [{ text: "✏️ Sửa Số TK", callback_data: "INC_EDIT_ACCOUNT_NUM" }],
                [{ text: "✏️ Sửa Người CK", callback_data: "INC_EDIT_SENDER" }],
                [{ text: "✏️ Sửa Số tiền", callback_data: "INC_EDIT_AMOUNT" }],
                [{ text: "✏️ Sửa Ghi chú", callback_data: "INC_EDIT_NOTES" }],
                [{ text: "❌ Hủy", callback_data: "INC_CMD_CANCEL" }]
            ]
        }
    });
};

const showMainMenu = async (chatId: number, session: SessionData, sendMsg: any, isPrivate: boolean) => {
    session.state = STATES.IDLE;
    if (isPrivate) {
        await sendMsg("💰 **MENU THU**\nVui lòng chọn chức năng bên dưới:", {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "📝 Nhập khoản thu mới", callback_data: "CMD_NHAPTHU" }],
                    [{ text: "📊 Quản lí sheet Thu", callback_data: "CMD_MANAGE_INCOME_SHEET" }],
                    [{ text: "⚙️ Quản lí tháng Thu", callback_data: "CMD_INCOME_ADMIN" }],
                    [{ text: "❌ Huỷ thao tác", callback_data: "INC_CMD_CANCEL" }]
                ]
            }
        });
    } else {
        await sendMsg("💰 **MENU THU**\nVui lòng chọn chức năng bên dưới:", {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "📝 Nhập khoản thu mới", url: `https://t.me/${getBotUsername()}?start=addincome` }],
                    [{ text: "📊 Quản lí sheet Thu", url: `https://t.me/${getBotUsername()}?start=manageincome` }],
                    [{ text: "⚙️ Quản lí tháng Thu", url: `https://t.me/${getBotUsername()}?start=adminincome` }],
                    [{ text: "❌ Huỷ thao tác", url: `https://t.me/${getBotUsername()}?start=cancelincome` }]
                ]
            }
        });
    }
};

export async function initIncomeTopic() {
    if (!bot) return;

    if (pool) {
        try {
            const topicRes = await pool.query("SELECT value FROM bot_config WHERE key = 'income_allowedTopic'");
            if (topicRes.rows.length > 0) allowedIncomeTopic = topicRes.rows[0].value;

            const monthsRes = await pool.query("SELECT key, value FROM bot_config WHERE key LIKE 'income_monthConfig_%'");
            for (const row of monthsRes.rows) {
                const month = row.key.replace('income_monthConfig_', '');
                monthIncomeConfig.set(month, row.value);
            }
            console.log("✅ Income Topic loaded successfully!");
        } catch (err) {
            console.error("❌ Income Topic Init Error:", err);
        }
    }

    bot.on('callback_query', async (query) => {
        const chatId = query.message?.chat.id;
        const userId = query.from.id;
        const data = query.data;

        if (!chatId || !data) return;

        // Only process income related callbacks
        if (!data.startsWith('INC_') && !data.startsWith('CMD_INCOME') && !data.startsWith('CMD_NHAPTHU') && !data.startsWith('CMD_MANAGE_INCOME')) return;

        const session = getSession(chatId, userId);

        const sendMsg = async (content: string, options: any = {}) => {
            if (query.message?.message_thread_id) {
                options.message_thread_id = query.message.message_thread_id;
            }
            const sent = await bot!.sendMessage(chatId, content, options);
            session.messageIds.push(sent.message_id);
            return sent;
        };

        bot!.answerCallbackQuery(query.id);

        if (data === 'INC_CMD_CANCEL') {
            session.state = STATES.IDLE;
            await sendMsg("Đã hủy thao tác. Các tin nhắn sẽ được dọn dẹp sau 30s.");
            scheduleCleanup(chatId, [...session.messageIds]);
            session.messageIds = [];
            session.data = {};
            return;
        }

        if (data === 'INC_CMD_DONE_PHOTOS') {
            if (session.state === STATES.AWAITING_RECEIPT) {
                session.state = STATES.AWAITING_NOTES;
                await sendMsg("Nhập Ghi chú (Hoặc gõ /skip để bỏ qua):");
            }
            return;
        }

        if (data === 'CMD_INCOME_ADMIN' || data === 'INC_ADMIN_BACK_TO_LIST') {
            await showAdminMenu(chatId, userId, session, sendMsg);
            return;
        }

        if (data === 'INC_ADMIN_ADD_MONTH') {
            if (!(await isAdmin(allowedIncomeTopic.chatId || chatId, userId))) return;
            session.state = STATES.ADMIN_AWAITING_MONTH;
            await sendMsg("Vui lòng nhập tháng bạn muốn cấu hình cho phần THU (VD: 03/2026):", {
                reply_markup: {
                    inline_keyboard: [[{ text: "🔙 Trở lại", callback_data: "INC_ADMIN_BACK_TO_LIST" }]]
                }
            });
            return;
        }

        if (data.startsWith('INC_ADMIN_VIEW_MONTH_')) {
            if (!(await isAdmin(allowedIncomeTopic.chatId || chatId, userId))) return;
            const month = data.replace('INC_ADMIN_VIEW_MONTH_', '');
            const config = monthIncomeConfig.get(month);
            if (!config) {
                await sendMsg("⚠️ Không tìm thấy cấu hình cho tháng này.");
                return;
            }

            const msg = `⚙️ **CẤU HÌNH THÁNG ${month} (THU)**\n\n` +
                `**Sheet Hoàn phí:** ${config.sheetRefundId}\n` +
                `**Sheet Thu dự án:** ${config.sheetProjectId}\n` +
                `**Folder Hoàn phí:** ${config.folderRefundId}\n` +
                `**Folder Thu dự án:** ${config.folderProjectId}\n`;

            await sendMsg(msg, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✏️ Sửa", callback_data: `INC_ADMIN_EDIT_MONTH_${month}` }, { text: "🗑️ Xóa", callback_data: `INC_ADMIN_DEL_MONTH_${month}` }],
                        [{ text: "🔙 Trở lại danh sách", callback_data: "INC_ADMIN_BACK_TO_LIST" }]
                    ]
                }
            });
            return;
        }

        if (data.startsWith('INC_ADMIN_EDIT_MONTH_')) {
            if (!(await isAdmin(allowedIncomeTopic.chatId || chatId, userId))) return;
            const month = data.replace('INC_ADMIN_EDIT_MONTH_', '');

            await sendMsg(`✏️ **SỬA CẤU HÌNH THÁNG ${month} (THU)**\nChọn mục bạn muốn sửa:`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "Sheet Hoàn phí", callback_data: `INC_ADMIN_EDIT_SPECIFIC_${month}_sheetRefundId` }],
                        [{ text: "Sheet Thu dự án", callback_data: `INC_ADMIN_EDIT_SPECIFIC_${month}_sheetProjectId` }],
                        [{ text: "Folder Hoàn phí", callback_data: `INC_ADMIN_EDIT_SPECIFIC_${month}_folderRefundId` }],
                        [{ text: "Folder Thu dự án", callback_data: `INC_ADMIN_EDIT_SPECIFIC_${month}_folderProjectId` }],
                        [{ text: "🔙 Trở lại", callback_data: `INC_ADMIN_VIEW_MONTH_${month}` }]
                    ]
                }
            });
            return;
        }

        if (data.startsWith('INC_ADMIN_EDIT_SPECIFIC_')) {
            if (!(await isAdmin(allowedIncomeTopic.chatId || chatId, userId))) return;
            const parts = data.replace('INC_ADMIN_EDIT_SPECIFIC_', '').split('_');
            const field = parts.pop()!;
            const month = parts.join('_');

            session.state = STATES.ADMIN_AWAITING_SPECIFIC_EDIT;
            session.data.adminMonth = month;
            session.data.adminEditField = field;

            const fieldNames: Record<string, string> = {
                'sheetRefundId': 'Sheet Hoàn phí',
                'sheetProjectId': 'Sheet Thu dự án',
                'folderRefundId': 'Folder Hoàn phí',
                'folderProjectId': 'Folder Thu dự án'
            };

            await sendMsg(`Đang sửa **${fieldNames[field]}** cho tháng **${month}**.\nVui lòng nhập ID (hoặc Link) mới:`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: "🔙 Hủy sửa", callback_data: `INC_ADMIN_EDIT_MONTH_${month}` }]]
                }
            });
            return;
        }

        if (data.startsWith('INC_ADMIN_DEL_MONTH_')) {
            if (!(await isAdmin(allowedIncomeTopic.chatId || chatId, userId))) return;
            const month = data.replace('INC_ADMIN_DEL_MONTH_', '');
            await sendMsg(`⚠️ Bạn có chắc chắn muốn xóa cấu hình THU của tháng **${month}** không?`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ Xác nhận Xóa", callback_data: `INC_ADMIN_CONFIRM_DEL_${month}` }],
                        [{ text: "❌ Hủy", callback_data: `INC_ADMIN_VIEW_MONTH_${month}` }]
                    ]
                }
            });
            return;
        }

        if (data.startsWith('INC_ADMIN_CONFIRM_DEL_')) {
            if (!(await isAdmin(allowedIncomeTopic.chatId || chatId, userId))) return;
            const month = data.replace('INC_ADMIN_CONFIRM_DEL_', '');

            monthIncomeConfig.delete(month);
            if (pool) {
                await pool.query("DELETE FROM bot_config WHERE key = $1", [`income_monthConfig_${month}`]);
            }

            await sendMsg(`✅ Đã xóa cấu hình THU tháng **${month}**.`, { parse_mode: 'Markdown' });

            const availableMonths = Array.from(monthIncomeConfig.keys());
            const keyboard = availableMonths.map(m => ([{ text: `Tháng ${m}`, callback_data: `INC_ADMIN_VIEW_MONTH_${m}` }]));
            keyboard.push([{ text: "➕ Thêm tháng mới", callback_data: "INC_ADMIN_ADD_MONTH" }]);
            keyboard.push([{ text: "🔙 Trở lại Menu Thu", callback_data: "CMD_INCOME_MENU" }]);

            await sendMsg("⚙️ **QUẢN LÝ THÁNG (THU)**\nChọn tháng để xem/sửa hoặc thêm mới:", {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
            return;
        }

        if (data === 'CMD_INCOME_MENU') {
            await showMainMenu(chatId, session, sendMsg, query.message?.chat.type === 'private');
            return;
        }

        if (data === 'CMD_MANAGE_INCOME_SHEET') {
            session.state = STATES.IDLE;
            const availableMonths = Array.from(monthIncomeConfig.keys());
            if (availableMonths.length === 0) {
                await sendMsg("⚠️ Chưa có tháng nào được cấu hình.", {
                    reply_markup: {
                        inline_keyboard: [[{ text: "🔙 Trở lại", callback_data: "CMD_INCOME_MENU" }]]
                    }
                });
                return;
            }

            const keyboard = availableMonths.map(month => ([{ text: `Tháng ${month}`, callback_data: `INC_CMD_MANAGE_MONTH_${month}` }]));
            keyboard.push([{ text: "🔙 Trở lại", callback_data: "CMD_INCOME_MENU" }]);

            await sendMsg("📊 **QUẢN LÍ SHEET THU**\nChọn tháng để xem danh sách khoản thu:", {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
            return;
        }

        if (data.startsWith('INC_CMD_MANAGE_MONTH_')) {
            const month = data.replace('INC_CMD_MANAGE_MONTH_', '');
            const config = monthIncomeConfig.get(month);
            if (!config) {
                await sendMsg("⚠️ Không tìm thấy cấu hình tháng này.");
                return;
            }

            const loadingMsg = await sendMsg(`⏳ Đang tải danh sách khoản thu tháng ${month}...`);

            if (process.env.GAS_WEB_APP_URL) {
                try {
                    const gasRes = await fetch(process.env.GAS_WEB_APP_URL, {
                        method: 'POST',
                        body: JSON.stringify({
                            action: 'get_incomes',
                            sheetRefundId: config.sheetRefundId,
                            sheetProjectId: config.sheetProjectId
                        })
                    });
                    const result = await gasRes.json();

                    try {
                        await bot!.deleteMessage(chatId, loadingMsg.message_id);
                        session.messageIds = session.messageIds.filter(id => id !== loadingMsg.message_id);
                    } catch (e) { }

                    if (result.success && result.incomes && result.incomes.length > 0) {
                        session.data.loadedIncomes = result.incomes;
                        session.data.currentMonth = month;

                        const recentIncomes = result.incomes.slice(-10).reverse();
                        const keyboard = recentIncomes.map((inc: any, index: number) => {
                            const shortCat = inc.category.length > 15 ? inc.category.substring(0, 15) + '...' : inc.category;
                            const displayAmt = inc.displayAmount || new Intl.NumberFormat('vi-VN').format(Number(inc.amount));
                            return [{ text: `[${inc.date}] ${shortCat} - ${displayAmt}`, callback_data: `INC_CMD_VIEW_${index}` }];
                        });
                        keyboard.push([{ text: "🔙 Trở lại", callback_data: "CMD_MANAGE_INCOME_SHEET" }]);

                        await sendMsg(`📊 **Danh sách khoản thu tháng ${month}** (10 giao dịch gần nhất):`, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: keyboard }
                        });
                    } else {
                        await sendMsg(`Tháng ${month} chưa có khoản thu nào hoặc không thể tải dữ liệu.`, {
                            reply_markup: { inline_keyboard: [[{ text: "🔙 Trở lại", callback_data: "CMD_MANAGE_INCOME_SHEET" }]] }
                        });
                    }
                } catch (e) {
                    await sendMsg(`❌ Lỗi khi tải dữ liệu: ${e}`, {
                        reply_markup: { inline_keyboard: [[{ text: "🔙 Trở lại", callback_data: "CMD_MANAGE_INCOME_SHEET" }]] }
                    });
                }
            } else {
                await sendMsg("⚠️ Chưa cấu hình GAS_WEB_APP_URL.", {
                    reply_markup: { inline_keyboard: [[{ text: "🔙 Trở lại", callback_data: "CMD_MANAGE_INCOME_SHEET" }]] }
                });
            }
            return;
        }

        if (data.startsWith('INC_CMD_VIEW_')) {
            const index = parseInt(data.replace('INC_CMD_VIEW_', ''));
            const incomes = session.data.loadedIncomes;
            if (!incomes || !incomes.slice(-10).reverse()[index]) {
                await sendMsg("⚠️ Không tìm thấy thông tin giao dịch.");
                return;
            }

            const inc = incomes.slice(-10).reverse()[index];
            session.data.selectedIncome = inc;

            const msgText = `🧾 **CHI TIẾT KHOẢN THU**\n\n` +
                `📅 Ngày: ${inc.date}\n` +
                `Loại: ${inc.incomeType}\n` +
                `🏷 Hạng mục/Dự án: ${inc.category}\n` +
                `🏦 Ngân hàng: ${inc.bank}\n` +
                `🔢 Số TK: ${inc.accountNum}\n` +
                `👤 Người CK: ${inc.sender}\n` +
                `💵 Số tiền: ${inc.displayAmount || new Intl.NumberFormat('vi-VN').format(Number(inc.amount)) + ' vnd'}\n` +
                `📝 Ghi chú: ${inc.notes || 'Không có'}\n\n` +
                `Bạn muốn làm gì với giao dịch này?`;

            await sendMsg(msgText, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✏️ Sửa", callback_data: "INC_CMD_EDIT_SELECT" }, { text: "🗑️ Xóa", callback_data: "INC_CMD_DEL_CONFIRM" }],
                        [{ text: "🔙 Trở lại danh sách", callback_data: `INC_CMD_MANAGE_MONTH_${session.data.currentMonth}` }]
                    ]
                }
            });
            return;
        }

        if (data === 'INC_CMD_DEL_CONFIRM') {
            await sendMsg("⚠️ Bạn có chắc chắn muốn xóa khoản thu này không?", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ Có, xóa ngay", callback_data: "INC_CMD_DEL_EXECUTE" }],
                        [{ text: "❌ Không, quay lại", callback_data: "INC_CMD_VIEW_BACK" }]
                    ]
                }
            });
            return;
        }

        if (data === 'INC_CMD_VIEW_BACK') {
            const inc = session.data.selectedIncome;
            if (!inc) {
                if (session.data.currentMonth) {
                    bot!.processUpdate({ update_id: 0, callback_query: { ...query, data: `INC_CMD_MANAGE_MONTH_${session.data.currentMonth}` } as any });
                }
                return;
            }

            const msgText = `🧾 **CHI TIẾT KHOẢN THU**\n\n` +
                `📅 Ngày: ${inc.date}\n` +
                `Loại: ${inc.incomeType}\n` +
                `🏷 Hạng mục/Dự án: ${inc.category}\n` +
                `🏦 Ngân hàng: ${inc.bank}\n` +
                `🔢 Số TK: ${inc.accountNum}\n` +
                `👤 Người CK: ${inc.sender}\n` +
                `💵 Số tiền: ${inc.displayAmount || new Intl.NumberFormat('vi-VN').format(Number(inc.amount)) + ' vnd'}\n` +
                `📝 Ghi chú: ${inc.notes || 'Không có'}\n\n` +
                `Bạn muốn làm gì với giao dịch này?`;

            await sendMsg(msgText, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✏️ Sửa", callback_data: "INC_CMD_EDIT_SELECT" }, { text: "🗑️ Xóa", callback_data: "INC_CMD_DEL_CONFIRM" }],
                        [{ text: "🔙 Trở lại danh sách", callback_data: `INC_CMD_MANAGE_MONTH_${session.data.currentMonth}` }]
                    ]
                }
            });
            return;
        }

        if (data === 'INC_CMD_DEL_EXECUTE') {
            const inc = session.data.selectedIncome;
            const month = session.data.currentMonth;
            if (!inc || !month) {
                await sendMsg("⚠️ Lỗi: Không tìm thấy thông tin giao dịch để xóa.");
                return;
            }

            const config = monthIncomeConfig.get(month);
            if (!config) return;

            const sheetId = inc.incomeType === 'Hoàn phí' ? config.sheetRefundId : config.sheetProjectId;

            await sendMsg("⏳ Đang xóa giao dịch...");
            if (process.env.GAS_WEB_APP_URL) {
                try {
                    const gasRes = await fetch(process.env.GAS_WEB_APP_URL, {
                        method: 'POST',
                        body: JSON.stringify({
                            action: 'delete_income',
                            sheetId: sheetId,
                            rowNumber: inc.rowNumber
                        })
                    });
                    const result = await gasRes.json();
                    if (result.success) {
                        for (const msgId of session.messageIds) {
                            try {
                                await bot!.deleteMessage(chatId, msgId);
                            } catch (e) { }
                        }
                        session.messageIds = [];

                        const successMsg = await sendMsg("✅ Đã xóa khoản thu thành công!");
                        setTimeout(async () => {
                            try {
                                await bot!.deleteMessage(chatId, successMsg.message_id);
                                session.messageIds = session.messageIds.filter(id => id !== successMsg.message_id);
                            } catch (e) { }
                        }, 3000);

                        bot!.processUpdate({ update_id: 0, callback_query: { ...query, data: `INC_CMD_MANAGE_MONTH_${month}` } as any });
                    } else {
                        await sendMsg(`❌ Lỗi khi xóa: ${result.error}`);
                    }
                } catch (e) {
                    await sendMsg(`❌ Lỗi kết nối: ${e}`);
                }
            }
            return;
        }

        if (data === 'INC_CMD_EDIT_SELECT') {
            const inc = session.data.selectedIncome;
            if (!inc) return;

            lastUserIncome.set(userId, {
                rowNumber: inc.rowNumber,
                month: session.data.currentMonth,
                incomeType: inc.incomeType,
                data: {
                    date: inc.date,
                    category: inc.category,
                    bank: inc.bank,
                    accountNum: inc.accountNum,
                    sender: inc.sender,
                    amount: inc.amount,
                    notes: inc.notes,
                    receiptUrl: ''
                }
            });

            session.state = STATES.IDLE;
            await showEditMenu(chatId, userId, session, sendMsg);
            return;
        }

        if (data === 'INC_CMD_EDIT') {
            const lastInc = lastUserIncome.get(userId);
            if (!lastInc) {
                await sendMsg("⚠️ Không tìm thấy khoản thu nào vừa nhập để sửa.");
                return;
            }
            session.state = STATES.IDLE;
            await showEditMenu(chatId, userId, session, sendMsg);
            return;
        }

        if (data.startsWith('INC_EDIT_')) {
            const field = data.replace('INC_EDIT_', '');
            session.state = `AWAITING_INCOME_EDIT_${field}`;
            session.data.editField = field;

            const fieldNames: Record<string, string> = {
                'DATE': 'Ngày thanh toán (VD: 15/03/26)',
                'CATEGORY': 'Hạng mục/Dự án',
                'BANK': 'Ngân hàng',
                'ACCOUNT_NUM': 'Số tài khoản',
                'SENDER': 'Chủ tài khoản',
                'AMOUNT': 'Số tiền',
                'NOTES': 'Ghi chú'
            };

            await sendMsg(`Nhập giá trị mới cho **${fieldNames[field]}**:`, { parse_mode: 'Markdown' });
            return;
        }

        if (data === 'INC_CMD_UNDO') {
            const lastInc = lastUserIncome.get(userId);
            if (!lastInc) {
                await sendMsg("⚠️ Không tìm thấy khoản thu nào vừa nhập để xóa.");
                return;
            }

            const config = monthIncomeConfig.get(lastInc.month);
            if (!config) {
                await sendMsg("⚠️ Lỗi: Không tìm thấy cấu hình cho tháng này.");
                return;
            }
            const sheetId = lastInc.incomeType === 'Hoàn phí' ? config.sheetRefundId : config.sheetProjectId;

            await sendMsg("⏳ Đang tiến hành xóa khoản thu cuối cùng trên Google Sheets...");
            if (process.env.GAS_WEB_APP_URL) {
                try {
                    const gasRes = await fetch(process.env.GAS_WEB_APP_URL, {
                        method: 'POST',
                        body: JSON.stringify({
                            action: 'delete_income',
                            sheetId: sheetId,
                            rowNumber: lastInc.rowNumber
                        })
                    });
                    const result = await gasRes.json();
                    if (result.success) {
                        await sendMsg("✅ Đã xóa thành công khoản thu vừa nhập!");

                        if (allowedIncomeTopic.chatId && allowedIncomeTopic.threadId) {
                            const groupMsg = `🗑️ **XÓA KHOẢN THU** (bởi ${query.from.first_name})\n\n` +
                                `Đã xóa giao dịch: ${lastInc.data.category} - ${lastInc.data.displayAmount || lastInc.data.amount}`;
                            try {
                                await bot!.sendMessage(allowedIncomeTopic.chatId, groupMsg, {
                                    message_thread_id: allowedIncomeTopic.threadId,
                                    parse_mode: 'Markdown'
                                });
                            } catch (e) {
                                console.error("Could not send group notification", e);
                            }
                        }

                        lastUserIncome.delete(userId);
                    } else {
                        await sendMsg(`❌ Lỗi khi xóa: ${result.error}`);
                    }
                } catch (e) {
                    await sendMsg("❌ Lỗi kết nối tới Google Apps Script.");
                }
            }
            return;
        }

        if (data === 'CMD_NHAPTHU') {
            const availableMonths = Array.from(monthIncomeConfig.entries())
                .filter(([_, config]) => config.sheetRefundId && config.sheetProjectId && config.folderRefundId && config.folderProjectId)
                .map(([month, _]) => month);

            if (availableMonths.length === 0) {
                await sendMsg("⚠️ Chưa có tháng nào được cấu hình ID Sheet/Folder THU.\nVui lòng báo Admin cấu hình trước khi nhập liệu.");
                return;
            }

            session.state = STATES.AWAITING_INCOME_TYPE;
            session.data = {};
            await sendMsg("Chào bạn! Vui lòng chọn loại khoản thu:", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "Hoàn phí", callback_data: "INC_TYPE_REFUND" }],
                        [{ text: "Thu dự án", callback_data: "INC_TYPE_PROJECT" }]
                    ]
                }
            });
            return;
        }

        if (session.state === STATES.AWAITING_INCOME_TYPE && data.startsWith('INC_TYPE_')) {
            session.data.incomeType = data === 'INC_TYPE_REFUND' ? 'Hoàn phí' : 'Thu dự án';
            session.state = STATES.AWAITING_MONTH;

            const availableMonths = Array.from(monthIncomeConfig.entries())
                .filter(([_, config]) => config.sheetRefundId && config.sheetProjectId && config.folderRefundId && config.folderProjectId)
                .map(([month, _]) => month);

            const keyboard = availableMonths.map(m => ([{ text: m, callback_data: `INC_MONTH_${m}` }]));

            await sendMsg(`Đã chọn: **${session.data.incomeType}**\nChọn tháng để lưu:`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });
            return;
        }

        if (session.state === STATES.AWAITING_MONTH && data.startsWith('INC_MONTH_')) {
            session.data.month = data.replace('INC_MONTH_', '');
            session.state = STATES.AWAITING_DATE;
            await sendMsg(`Đã chọn tháng: **${session.data.month}**\nNhập Ngày thanh toán (VD: 15/03/26):`, {
                parse_mode: 'Markdown'
            });
            return;
        }
    });

    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from?.id;
        const text = msg.text?.trim();

        if (!userId) return;

        const isCommand = text?.startsWith('/');
        if (msg.chat.type !== 'private') {
            if (allowedIncomeTopic.chatId && allowedIncomeTopic.threadId) {
                if (msg.chat.id !== allowedIncomeTopic.chatId || msg.message_thread_id !== allowedIncomeTopic.threadId) {
                    if (!isCommand) return;
                } else {
                    if (!isCommand && !getSession(chatId, userId).state.startsWith('AWAITING_')) {
                        // Only warn if not in an active flow
                        return;
                    }
                }
            } else {
                if (!isCommand) return;
            }
        }

        const session = getSession(chatId, userId);

        if (msg.message_id) {
            session.messageIds.push(msg.message_id);
        }

        const sendMsg = async (content: string, options: any = {}) => {
            if (msg.message_thread_id) {
                options.message_thread_id = msg.message_thread_id;
            }
            const sent = await bot!.sendMessage(chatId, content, options);
            session.messageIds.push(sent.message_id);
            return sent;
        };

        const command = text?.split('@')[0];

        if (command === '/set_income_topic') {
            if (await isAdmin(allowedIncomeTopic.chatId || msg.chat.id, userId)) {
                if (msg.chat.type === 'supergroup' && msg.message_thread_id) {
                    await saveAllowedIncomeTopic({ chatId: msg.chat.id, threadId: msg.message_thread_id });
                    const sent = await sendMsg("✅ Đã thiết lập Topic này làm nơi chuyên nhập liệu THU!\n\n💰 **MENU THU**\nVui lòng chọn chức năng bên dưới:", {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: "📝 Nhập khoản thu mới", url: `https://t.me/${getBotUsername()}?start=addincome` }],
                                [{ text: "📊 Quản lí sheet Thu", url: `https://t.me/${getBotUsername()}?start=manageincome` }],
                                [{ text: "⚙️ Quản lí tháng Thu", url: `https://t.me/${getBotUsername()}?start=adminincome` }],
                                [{ text: "❌ Huỷ thao tác", url: `https://t.me/${getBotUsername()}?start=cancelincome` }]
                            ]
                        }
                    });
                    try {
                        await bot!.pinChatMessage(chatId, sent.message_id);
                    } catch (e) { }
                } else {
                    await sendMsg("⚠️ Lệnh này chỉ hoạt động trong một Topic của Group (Supergroup).");
                }
            } else {
                await sendMsg("⛔ Chỉ Admin mới có quyền set topic.");
            }
            return;
        }

        if (command === '/start addincome') {
            if (msg.chat.type !== 'private') return;
            const availableMonths = Array.from(monthIncomeConfig.entries())
                .filter(([_, config]) => config.sheetRefundId && config.sheetProjectId && config.folderRefundId && config.folderProjectId)
                .map(([month, _]) => month);

            if (availableMonths.length === 0) {
                await sendMsg("⚠️ Chưa có tháng nào được cấu hình ID Sheet/Folder THU.\nVui lòng báo Admin cấu hình trước khi nhập liệu.");
                return;
            }

            session.state = STATES.AWAITING_INCOME_TYPE;
            session.data = {};
            await sendMsg("Chào bạn! Vui lòng chọn loại khoản thu:", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "Hoàn phí", callback_data: "INC_TYPE_REFUND" }],
                        [{ text: "Thu dự án", callback_data: "INC_TYPE_PROJECT" }]
                    ]
                }
            });
            return;
        }

        if (command === '/start manageincome') {
            if (msg.chat.type !== 'private') return;
            session.state = STATES.IDLE;
            const availableMonths = Array.from(monthIncomeConfig.keys());
            if (availableMonths.length === 0) {
                await sendMsg("⚠️ Chưa có tháng nào được cấu hình.", {
                    reply_markup: {
                        inline_keyboard: [[{ text: "🔙 Trở lại", callback_data: "CMD_INCOME_MENU" }]]
                    }
                });
                return;
            }

            const keyboard = availableMonths.map(month => ([{ text: `Tháng ${month}`, callback_data: `INC_CMD_MANAGE_MONTH_${month}` }]));
            keyboard.push([{ text: "🔙 Trở lại", callback_data: "CMD_INCOME_MENU" }]);

            await sendMsg("📊 **QUẢN LÍ SHEET THU**\nChọn tháng để xem danh sách khoản thu:", {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
            return;
        }

        if (command === '/start adminincome') {
            if (msg.chat.type !== 'private') return;
            session.state = STATES.IDLE;
            await showAdminMenu(chatId, userId, session, sendMsg);
            return;
        }

        if (command === '/start cancelincome' || command === '/cancelincome') {
            session.state = STATES.IDLE;
            await sendMsg("Đã hủy thao tác hiện tại. Các tin nhắn sẽ được dọn dẹp sau 30s.");
            scheduleCleanup(chatId, [...session.messageIds]);
            session.messageIds = [];
            session.data = {};
            return;
        }

        if (command === '/income_menu') {
            if (allowedIncomeTopic.chatId && allowedIncomeTopic.threadId && msg.chat.type !== 'private') {
                if (msg.chat.id !== allowedIncomeTopic.chatId || msg.message_thread_id !== allowedIncomeTopic.threadId) {
                    await sendMsg("⚠️ Vui lòng vào đúng Topic THU đã được chỉ định để sử dụng Bot.");
                    return;
                }
            }
            await showMainMenu(chatId, session, sendMsg, msg.chat.type === 'private');
            return;
        }

        try {
            if (session.state.startsWith('AWAITING_INCOME_EDIT_')) {
                const field = session.data.editField;
                const newValue = text;

                if (!newValue) return;

                if (field === 'DATE' && !/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(newValue)) {
                    await sendMsg("Sai định dạng ngày. Vui lòng nhập lại (VD: 15/03/26):");
                    return;
                }

                const lastInc = lastUserIncome.get(userId);
                if (!lastInc) {
                    await sendMsg("⚠️ Phiên sửa đã hết hạn.");
                    session.state = STATES.IDLE;
                    return;
                }

                const fieldMap: Record<string, string> = {
                    'DATE': 'date',
                    'CATEGORY': 'category',
                    'BANK': 'bank',
                    'ACCOUNT_NUM': 'accountNum',
                    'SENDER': 'sender',
                    'AMOUNT': 'amount',
                    'NOTES': 'notes'
                };
                const fieldNames: Record<string, string> = {
                    'DATE': 'Ngày',
                    'CATEGORY': 'Hạng mục/Dự án',
                    'BANK': 'Ngân hàng',
                    'ACCOUNT_NUM': 'Số TK',
                    'SENDER': 'Người CK',
                    'AMOUNT': 'Số tiền',
                    'NOTES': 'Ghi chú'
                };
                const dataKey = fieldMap[field];

                let finalValue = newValue;
                if (field === 'AMOUNT') {
                    const parsed = parseAmount(newValue);
                    finalValue = parsed.sheetAmount.toString();
                    lastInc.data.displayAmount = parsed.displayAmount;
                }

                lastInc.data[dataKey] = finalValue;

                await sendMsg("⏳ Đang cập nhật lên Google Sheets...");

                const config = monthIncomeConfig.get(lastInc.month);
                if (!config) {
                    await sendMsg("⚠️ Lỗi: Không tìm thấy cấu hình cho tháng này.");
                    return;
                }
                const sheetId = lastInc.incomeType === 'Hoàn phí' ? config.sheetRefundId : config.sheetProjectId;

                if (process.env.GAS_WEB_APP_URL) {
                    try {
                        const gasRes = await fetch(process.env.GAS_WEB_APP_URL, {
                            method: 'POST',
                            body: JSON.stringify({
                                action: 'update_income',
                                sheetId: sheetId,
                                rowNumber: lastInc.rowNumber,
                                field: dataKey,
                                value: finalValue
                            })
                        });
                        const result = await gasRes.json();
                        if (result.success) {
                            await sendMsg("✅ Đã cập nhật thành công!");

                            if (allowedIncomeTopic.chatId && allowedIncomeTopic.threadId) {
                                const groupMsg = `✏️ **CẬP NHẬT KHOẢN THU** (bởi ${msg.from?.first_name})\n\n` +
                                    `Đã sửa **${fieldNames[field]}** thành: ${field === 'AMOUNT' ? lastInc.data.displayAmount : finalValue}\n` +
                                    `(Giao dịch: ${lastInc.data.category} - ${lastInc.data.displayAmount || lastInc.data.amount})`;
                                try {
                                    await bot!.sendMessage(allowedIncomeTopic.chatId, groupMsg, {
                                        message_thread_id: allowedIncomeTopic.threadId,
                                        parse_mode: 'Markdown'
                                    });
                                } catch (e) {
                                    console.error("Could not send group notification", e);
                                }
                            }

                            session.state = STATES.IDLE;
                            await showEditMenu(chatId, userId, session, sendMsg);
                        } else {
                            await sendMsg(`❌ Lỗi khi cập nhật: ${result.error}`);
                        }
                    } catch (e) {
                        await sendMsg("❌ Lỗi kết nối tới Google Apps Script.");
                    }
                }
                return;
            }

            switch (session.state) {
                case STATES.ADMIN_AWAITING_MONTH:
                    if (!text || !/^\d{2}\/\d{4}$/.test(text)) {
                        await sendMsg("Sai định dạng. Vui lòng nhập lại (VD: 03/2026):");
                        return;
                    }
                    session.data.adminMonth = text;
                    session.state = STATES.ADMIN_AWAITING_SHEET_REFUND_ID;
                    await sendMsg(`Nhập ID (hoặc Link) Google Sheet lưu text [Hoàn phí] cho tháng ${text}:`);
                    return;

                case STATES.ADMIN_AWAITING_SHEET_REFUND_ID:
                    if (!text) return;
                    session.data.adminSheetRefundId = text;
                    session.state = STATES.ADMIN_AWAITING_SHEET_PROJECT_ID;
                    await sendMsg(`Nhập ID (hoặc Link) Google Sheet lưu text [Thu dự án] cho tháng ${session.data.adminMonth}:`);
                    return;

                case STATES.ADMIN_AWAITING_SHEET_PROJECT_ID:
                    if (!text) return;
                    session.data.adminSheetProjectId = text;
                    session.state = STATES.ADMIN_AWAITING_FOLDER_REFUND_ID;
                    await sendMsg(`Nhập ID (hoặc Link) Thư mục Google Drive để lưu ảnh [Hoàn phí] cho tháng ${session.data.adminMonth}:`);
                    return;

                case STATES.ADMIN_AWAITING_FOLDER_REFUND_ID:
                    if (!text) return;
                    session.data.adminFolderRefundId = text;
                    session.state = STATES.ADMIN_AWAITING_FOLDER_PROJECT_ID;
                    await sendMsg(`Nhập ID (hoặc Link) Thư mục Google Drive để lưu ảnh [Thu dự án] cho tháng ${session.data.adminMonth}:`);
                    return;

                case STATES.ADMIN_AWAITING_FOLDER_PROJECT_ID:
                    if (!text) return;
                    session.data.adminFolderProjectId = text;

                    const newConfig = {
                        sheetRefundId: session.data.adminSheetRefundId,
                        sheetProjectId: session.data.adminSheetProjectId,
                        folderRefundId: session.data.adminFolderRefundId,
                        folderProjectId: session.data.adminFolderProjectId
                    };

                    await saveMonthIncomeConfig(session.data.adminMonth, newConfig);
                    session.state = STATES.IDLE;

                    if (process.env.GAS_WEB_APP_URL) {
                        try {
                            await fetch(process.env.GAS_WEB_APP_URL, {
                                method: 'POST',
                                body: JSON.stringify({
                                    action: 'save_income_config',
                                    month: session.data.adminMonth,
                                    sheetRefundId: session.data.adminSheetRefundId,
                                    sheetProjectId: session.data.adminSheetProjectId,
                                    folderRefundId: session.data.adminFolderRefundId,
                                    folderProjectId: session.data.adminFolderProjectId
                                })
                            });
                        } catch (e) {
                            console.error("Failed to save config to GAS", e);
                        }
                    }
                    await sendMsg(`✅ Đã lưu cấu hình THU thành công cho tháng ${session.data.adminMonth}!\n\nCác tin nhắn sẽ được dọn dẹp sau 30s.`);
                    scheduleCleanup(chatId, [...session.messageIds]);
                    session.messageIds = [];
                    return;

                case STATES.ADMIN_AWAITING_SPECIFIC_EDIT: {
                    if (!text) return;
                    const month = session.data.adminMonth;
                    const field = session.data.adminEditField;

                    const config = monthIncomeConfig.get(month);
                    if (!config) {
                        await sendMsg("⚠️ Không tìm thấy cấu hình tháng này.");
                        session.state = STATES.IDLE;
                        return;
                    }

                    config[field as keyof typeof config] = text;
                    await saveMonthIncomeConfig(month, config);

                    if (process.env.GAS_WEB_APP_URL) {
                        try {
                            await fetch(process.env.GAS_WEB_APP_URL, {
                                method: 'POST',
                                body: JSON.stringify({
                                    action: 'save_income_config',
                                    month: month,
                                    sheetRefundId: config.sheetRefundId,
                                    sheetProjectId: config.sheetProjectId,
                                    folderRefundId: config.folderRefundId,
                                    folderProjectId: config.folderProjectId
                                })
                            });
                        } catch (e) {
                            console.error("Failed to save config to GAS", e);
                        }
                    }

                    session.state = STATES.IDLE;
                    await sendMsg(`✅ Đã cập nhật thành công!`, { parse_mode: 'Markdown' });

                    const configMsg = `⚙️ **CẤU HÌNH THÁNG ${month} (THU)**\n\n` +
                        `**Sheet Hoàn phí:** ${config.sheetRefundId}\n` +
                        `**Sheet Thu dự án:** ${config.sheetProjectId}\n` +
                        `**Folder Hoàn phí:** ${config.folderRefundId}\n` +
                        `**Folder Thu dự án:** ${config.folderProjectId}\n`;

                    await sendMsg(configMsg, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: "✏️ Sửa", callback_data: `INC_ADMIN_EDIT_MONTH_${month}` }, { text: "🗑️ Xóa", callback_data: `INC_ADMIN_DEL_MONTH_${month}` }],
                                [{ text: "🔙 Trở lại danh sách", callback_data: "INC_ADMIN_BACK_TO_LIST" }]
                            ]
                        }
                    });
                    return;
                }

                case STATES.AWAITING_DATE:
                    if (!text || !/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(text)) {
                        await sendMsg("Sai định dạng ngày. Vui lòng nhập lại (VD: 15/03/26):");
                        return;
                    }
                    session.data.date = text;
                    session.state = STATES.AWAITING_CATEGORY;
                    const catPrompt = session.data.incomeType === 'Hoàn phí' ? 'Hạng mục hoàn phí' : 'Tên dự án';
                    await sendMsg(`Nhập ${catPrompt} (Bắt buộc):`);
                    return;

                case STATES.AWAITING_CATEGORY:
                    if (!text) {
                        await sendMsg("Không được để trống. Vui lòng nhập:");
                        return;
                    }
                    session.data.category = text;
                    session.state = STATES.AWAITING_BANK;
                    await sendMsg("Nhập Ngân hàng (Bắt buộc):");
                    return;

                case STATES.AWAITING_BANK:
                    if (!text) {
                        await sendMsg("Ngân hàng không được để trống. Vui lòng nhập:");
                        return;
                    }
                    session.data.bank = text;
                    session.state = STATES.AWAITING_ACCOUNT_NUM;
                    await sendMsg("Nhập Số tài khoản (Bắt buộc):");
                    return;

                case STATES.AWAITING_ACCOUNT_NUM:
                    if (!text || !/^\d+$/.test(text)) {
                        await sendMsg("Số tài khoản phải là số. Vui lòng nhập lại:");
                        return;
                    }
                    session.data.accountNum = text;
                    session.state = STATES.AWAITING_SENDER;
                    await sendMsg("Nhập Tên chủ tài khoản (Bắt buộc):");
                    return;

                case STATES.AWAITING_SENDER:
                    if (!text) {
                        await sendMsg("Tên chủ tài khoản không được để trống. Vui lòng nhập:");
                        return;
                    }
                    session.data.sender = text;
                    session.state = STATES.AWAITING_AMOUNT;
                    await sendMsg("Nhập Số tiền (VD: 50.000 vnd hoặc $77):");
                    return;

                case STATES.AWAITING_AMOUNT:
                    if (!text) {
                        await sendMsg("Số tiền không được để trống. Vui lòng nhập:");
                        return;
                    }
                    const parsed = parseAmount(text);
                    session.data.amount = parsed.sheetAmount;
                    session.data.displayAmount = parsed.displayAmount;
                    session.state = STATES.AWAITING_RECEIPT;
                    await sendMsg("Vui lòng đính kèm Chứng từ tham chiếu (Gửi ảnh). Bạn có thể gửi nhiều ảnh. Khi nào xong, hãy bấm /done hoặc nút bên dưới để tiếp tục.", {
                        reply_markup: {
                            inline_keyboard: [[{ text: "✅ Đã gửi xong ảnh", callback_data: "INC_CMD_DONE_PHOTOS" }]]
                        }
                    });
                    return;

                case STATES.AWAITING_RECEIPT:
                    if (text === '/done' || text === '/skip') {
                        session.state = STATES.AWAITING_NOTES;
                        await sendMsg("Nhập Ghi chú (Hoặc gõ /skip để bỏ qua):");
                        return;
                    }

                    if (!msg.photo || msg.photo.length === 0) {
                        await sendMsg("Vui lòng gửi một file ảnh làm chứng từ tham chiếu, hoặc bấm /done để tiếp tục.");
                        return;
                    }

                    await sendMsg("Đang tải ảnh...");
                    const photo = msg.photo[msg.photo.length - 1];
                    const fileLink = await bot!.getFileLink(photo.file_id);

                    const response = await fetch(fileLink);
                    const arrayBuffer = await response.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);

                    if (!session.data.receiptBase64s) session.data.receiptBase64s = [];
                    if (!session.data.receiptFileIds) session.data.receiptFileIds = [];

                    session.data.receiptBase64s.push(buffer.toString('base64'));
                    session.data.receiptFileIds.push(photo.file_id);

                    await sendMsg(`Đã nhận ${session.data.receiptBase64s.length} ảnh. Bạn có thể gửi thêm ảnh, hoặc bấm nút bên dưới để hoàn tất.`, {
                        reply_markup: {
                            inline_keyboard: [[{ text: "✅ Đã gửi xong ảnh", callback_data: "INC_CMD_DONE_PHOTOS" }]]
                        }
                    });
                    return;

                case STATES.AWAITING_NOTES: {
                    session.data.notes = text === '/skip' ? '' : text;

                    const finalData = { ...session.data };
                    session.state = STATES.IDLE;
                    session.data = {};

                    const config = monthIncomeConfig.get(finalData.month);
                    if (!config) {
                        await sendMsg("⚠️ Lỗi: Không tìm thấy cấu hình cho tháng này.");
                        return;
                    }
                    const sheetId = finalData.incomeType === 'Hoàn phí' ? config.sheetRefundId : config.sheetProjectId;
                    const folderId = finalData.incomeType === 'Hoàn phí' ? config.folderRefundId : config.folderProjectId;

                    await sendMsg("Đang xử lý và lưu dữ liệu lên Google Sheets...");

                    let gasMessage = '';
                    if (process.env.GAS_WEB_APP_URL) {
                        try {
                            const gasRes = await fetch(process.env.GAS_WEB_APP_URL, {
                                method: 'POST',
                                body: JSON.stringify({
                                    action: 'add_income',
                                    sheetId: sheetId,
                                    folderId: folderId,
                                    ...finalData
                                })
                            });
                            const result = await gasRes.json();
                            if (result.success) {
                                gasMessage = `\n(Đã đồng bộ lên Google Sheets & Drive thành công!)`;
                                if (result.rowNumber) {
                                    lastUserIncome.set(userId, {
                                        month: finalData.month,
                                        incomeType: finalData.incomeType,
                                        rowNumber: result.rowNumber,
                                        data: finalData
                                    });
                                }
                            } else {
                                gasMessage = `\n(Lỗi đồng bộ: ${result.error})`;
                            }
                        } catch (e) {
                            gasMessage = `\n(Lỗi kết nối tới Google Apps Script)`;
                        }
                    } else {
                        gasMessage = `\n(Chế độ Demo: Chưa cấu hình GAS_WEB_APP_URL)`;
                    }

                    const successMsg = `✅ Đã lưu thành công khoản thu!${gasMessage}\n\n` +
                        `Tháng: ${finalData.month}\n` +
                        `Loại: ${finalData.incomeType}\n` +
                        `Ngày: ${finalData.date}\n` +
                        `Hạng mục/Dự án: ${finalData.category}\n` +
                        `Ngân hàng: ${finalData.bank}\n` +
                        `Số TK: ${finalData.accountNum}\n` +
                        `Người CK: ${finalData.sender}\n` +
                        `Số tiền: ${finalData.displayAmount || finalData.amount}\n` +
                        `Ghi chú: ${finalData.notes || 'Không có'}\n\n` +
                        `Các tin nhắn sẽ được dọn dẹp sau 30s.`;

                    await sendMsg(successMsg, {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: "✏️ Sửa khoản thu vừa nhập", callback_data: "INC_CMD_EDIT" },
                                    { text: "🗑️ Xóa khoản thu vừa nhập", callback_data: "INC_CMD_UNDO" }
                                ],
                                [{ text: "🔙 Về Menu Thu", callback_data: "CMD_INCOME_MENU" }]
                            ]
                        }
                    });

                    if (allowedIncomeTopic.chatId && allowedIncomeTopic.threadId) {
                        const groupMsg = `🆕 **KHOẢN THU MỚI [${finalData.incomeType}]** (bởi ${msg.from?.first_name})\n\n` +
                            `Tháng: ${finalData.month}\n` +
                            `Ngày: ${finalData.date}\n` +
                            `Hạng mục/Dự án: ${finalData.category}\n` +
                            `Ngân hàng: ${finalData.bank}\n` +
                            `Số TK: ${finalData.accountNum}\n` +
                            `Người CK: ${finalData.sender}\n` +
                            `Số tiền: ${finalData.displayAmount || finalData.amount}\n` +
                            `Ghi chú: ${finalData.notes || 'Không có'}`;
                        try {
                            if (finalData.receiptFileIds && finalData.receiptFileIds.length > 0) {
                                if (finalData.receiptFileIds.length === 1) {
                                    await bot!.sendPhoto(allowedIncomeTopic.chatId, finalData.receiptFileIds[0], {
                                        caption: groupMsg,
                                        message_thread_id: allowedIncomeTopic.threadId,
                                        parse_mode: 'Markdown'
                                    });
                                } else {
                                    const mediaGroup = finalData.receiptFileIds.map((fileId: string, index: number) => ({
                                        type: 'photo',
                                        media: fileId,
                                        caption: index === 0 ? groupMsg : '',
                                        parse_mode: 'Markdown'
                                    }));
                                    await bot!.sendMediaGroup(allowedIncomeTopic.chatId, mediaGroup as any, {
                                        message_thread_id: allowedIncomeTopic.threadId
                                    } as any);
                                }
                            } else if (finalData.receiptFileId) {
                                await bot!.sendPhoto(allowedIncomeTopic.chatId, finalData.receiptFileId, {
                                    caption: groupMsg,
                                    message_thread_id: allowedIncomeTopic.threadId,
                                    parse_mode: 'Markdown'
                                });
                            } else {
                                await bot!.sendMessage(allowedIncomeTopic.chatId, groupMsg, {
                                    message_thread_id: allowedIncomeTopic.threadId,
                                    parse_mode: 'Markdown'
                                });
                            }
                        } catch (e) {
                            console.error("Could not send group notification", e);
                        }
                    }

                    scheduleCleanup(chatId, [...session.messageIds]);
                    session.messageIds = [];
                    return;
                }
            }
        } catch (err) {
            console.error(err);
            await sendMsg("Đã xảy ra lỗi trong quá trình xử lý. Vui lòng thử lại bằng lệnh /income_menu.");
            session.state = STATES.IDLE;
        }
    });
}
