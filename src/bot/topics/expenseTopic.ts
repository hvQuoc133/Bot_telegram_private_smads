import { bot, scheduleCleanup, isAdmin, getBotUsername } from '../../bot.ts';
import { pool } from '../../db/index.ts';
import { SessionData } from '../../types.ts';

const sessions = new Map<string, SessionData>();
const lastUserExpense = new Map<number, { month: string, costType: string, rowNumber: number, data: any }>();

const monthSheetConfig = new Map<string, {
  sheetFixedId: string,
  sheetNonFixedId: string,
  folderFixedId: string,
  folderNonFixedId: string
}>();

let allowedTopic: { chatId?: number, threadId?: number } = {};

async function saveAllowedTopic(topic: any) {
  allowedTopic = topic;
  if (pool) {
    await pool.query(`
      INSERT INTO bot_config (key, value) VALUES ('expense_allowedTopic', $1)
      ON CONFLICT (key) DO UPDATE SET value = $1
    `, [topic]);
  }
}

async function saveMonthConfig(month: string, config: any) {
  monthSheetConfig.set(month, config);
  if (pool) {
    await pool.query(`
      INSERT INTO bot_config (key, value) VALUES ($1, $2)
      ON CONFLICT (key) DO UPDATE SET value = $2
    `, [`expense_monthConfig_${month}`, config]);
  }
}

function isValidPastOrToday(dateStr: string): boolean {
  const parts = dateStr.split('/');
  if (parts.length !== 3) return false;
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1; // 0-indexed
  let year = parseInt(parts[2], 10);
  if (year < 100) year += 2000;

  const inputDate = new Date(year, month, day);
  if (inputDate.getDate() !== day || inputDate.getMonth() !== month || inputDate.getFullYear() !== year) {
    return false;
  }

  // Lấy ngày hiện tại theo giờ Việt Nam (UTC+7)
  const now = new Date();
  const vnTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
  const today = new Date(vnTime.getUTCFullYear(), vnTime.getUTCMonth(), vnTime.getUTCDate());
  today.setHours(0, 0, 0, 0);

  return inputDate.getTime() <= today.getTime();
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
  AWAITING_COST_TYPE: 'AWAITING_COST_TYPE',
  AWAITING_MONTH: 'AWAITING_MONTH',
  AWAITING_DATE: 'AWAITING_DATE',
  AWAITING_CATEGORY: 'AWAITING_CATEGORY',
  AWAITING_AMOUNT: 'AWAITING_AMOUNT',
  AWAITING_UNIT: 'AWAITING_UNIT',
  AWAITING_PAYER: 'AWAITING_PAYER',
  AWAITING_RECEIPT: 'AWAITING_RECEIPT',
  AWAITING_NOTES: 'AWAITING_NOTES',

  ADMIN_AWAITING_MONTH: 'ADMIN_AWAITING_MONTH',
  ADMIN_AWAITING_SHEET_FIXED_ID: 'ADMIN_AWAITING_SHEET_FIXED_ID',
  ADMIN_AWAITING_SHEET_NON_FIXED_ID: 'ADMIN_AWAITING_SHEET_NON_FIXED_ID',
  ADMIN_AWAITING_FOLDER_FIXED_ID: 'ADMIN_AWAITING_FOLDER_FIXED_ID',
  ADMIN_AWAITING_FOLDER_NON_FIXED_ID: 'ADMIN_AWAITING_FOLDER_NON_FIXED_ID',
  ADMIN_AWAITING_SPECIFIC_EDIT: 'ADMIN_AWAITING_SPECIFIC_EDIT',
};

const getSession = (chatId: number, userId: number) => {
  const key = `${chatId}_${userId}`;
  if (!sessions.has(key)) {
    sessions.set(key, { state: STATES.IDLE, data: {}, messageIds: [] });
  }
  return sessions.get(key)!;
};

const showAdminMenu = async (chatId: number, userId: number, session: SessionData, sendMsg: any) => {
  if (!(await checkAdmin(chatId, userId))) {
    await sendMsg("⛔ Chỉ Admin mới có quyền cấu hình tháng.");
    return;
  }
  session.state = STATES.IDLE;

  const availableMonths = Array.from(monthSheetConfig.keys());
  const keyboard = availableMonths.map(m => ([{ text: `Tháng ${m}`, callback_data: `ADMIN_VIEW_MONTH_${m}` }]));

  keyboard.push([{ text: "➕ Thêm tháng mới", callback_data: "ADMIN_ADD_MONTH" }]);
  keyboard.push([{ text: "🔙 Trở lại Menu", callback_data: "CMD_MENU_INLINE" }]);

  await sendMsg("⚙️ **QUẢN LÝ THÁNG**\nChọn tháng để xem/sửa hoặc thêm mới:", {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
};

const showEditMenu = async (chatId: number, userId: number, session: SessionData, sendMsg: any) => {
  const lastExp = lastUserExpense.get(userId);
  if (!lastExp) return;
  const d = lastExp.data;
  const displayAmt = d.displayAmount || new Intl.NumberFormat('vi-VN').format(Number(d.amount)) + ' vnd';
  const msg = `📝 **SỬA THÔNG TIN CHI PHÍ**\n\n` +
    `**Tháng:** ${lastExp.month}\n` +
    `**Loại:** ${lastExp.costType}\n` +
    `**Ngày:** ${d.date}\n` +
    `**Hạng mục:** ${d.category}\n` +
    `**Số tiền:** ${displayAmt}\n` +
    `**Đơn vị:** ${d.unit}\n` +
    `**Người TT:** ${d.payer}\n` +
    `**Ghi chú:** ${d.notes || 'Không có'}\n\n` +
    `Vui lòng chọn phần muốn sửa:`;

  await sendMsg(msg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: "✏️ Sửa Ngày", callback_data: "EDIT_DATE" }],
        [{ text: "✏️ Sửa Hạng mục", callback_data: "EDIT_CATEGORY" }],
        [{ text: "✏️ Sửa Số tiền", callback_data: "EDIT_AMOUNT" }],
        [{ text: "✏️ Sửa Đơn vị", callback_data: "EDIT_UNIT" }],
        [{ text: "✏️ Sửa Người TT", callback_data: "EDIT_PAYER" }],
        [{ text: "✏️ Sửa Ghi chú", callback_data: "EDIT_NOTES" }],
        [{ text: "❌ Hủy", callback_data: "CMD_CANCEL" }]
      ]
    }
  });
};

const showMainMenu = async (chatId: number, session: SessionData, sendMsg: any, isPrivate: boolean) => {
  session.state = STATES.IDLE;
  if (isPrivate) {
    await sendMsg("📋 **MENU CHÍNH**\nVui lòng chọn chức năng bên dưới:", {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: "📝 Nhập chi phí mới", callback_data: "CMD_NHAPCHIPHI" }],
          [{ text: "📊 Quản lí sheet", callback_data: "CMD_MANAGE_SHEET_LIST" }],
          [{ text: "⚙️ Quản lí tháng", callback_data: "CMD_ADMIN" }],
          [{ text: "❌ Huỷ thao tác", callback_data: "CMD_CANCEL" }]
        ]
      }
    });
  } else {
    await sendMsg("📋 **MENU CHÍNH**\nVui lòng chọn chức năng bên dưới:", {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: "📝 Nhập chi phí mới", url: `https://t.me/${getBotUsername()}?start=add` }],
          [{ text: "📊 Quản lí sheet", url: `https://t.me/${getBotUsername()}?start=manage` }],
          [{ text: "⚙️ Quản lí tháng", url: `https://t.me/${getBotUsername()}?start=admin` }],
          [{ text: "❌ Huỷ thao tác", url: `https://t.me/${getBotUsername()}?start=cancel` }]
        ]
      }
    });
  }
};

const checkAdmin = async (chatId: number, userId: number) => {
  const targetChatId = allowedTopic.chatId || chatId;
  return await isAdmin(targetChatId, userId);
};

export async function initExpenseTopic() {
  if (!bot) return;

  // Load config from DB
  if (pool) {
    try {
      const topicRes = await pool.query("SELECT value FROM bot_config WHERE key = 'expense_allowedTopic'");
      if (topicRes.rows.length > 0) allowedTopic = topicRes.rows[0].value;

      const monthsRes = await pool.query("SELECT key, value FROM bot_config WHERE key LIKE 'expense_monthConfig_%'");
      for (const row of monthsRes.rows) {
        const month = row.key.replace('expense_monthConfig_', '');
        monthSheetConfig.set(month, row.value);
      }
      console.log("✅ Expense Topic loaded successfully!");
    } catch (err) {
      console.error("❌ Expense Topic Init Error:", err);
    }
  }

  // --- CALLBACK QUERY HANDLER ---
  bot.on('callback_query', async (query) => {
    const chatId = query.message?.chat.id;
    const userId = query.from.id;
    const data = query.data;

    if (!chatId || !data) return;

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

    if (data === 'CMD_CANCEL') {
      session.state = STATES.IDLE;
      await sendMsg("Đã hủy thao tác. Các tin nhắn sẽ được dọn dẹp sau 30s.");
      scheduleCleanup(chatId, [...session.messageIds]);
      session.messageIds = [];
      session.data = {};
      return;
    }

    if (data === 'CMD_ADMIN' || data === 'ADMIN_BACK_TO_LIST') {
      await showAdminMenu(chatId, userId, session, sendMsg);
      return;
    }

    if (data === 'ADMIN_ADD_MONTH') {
      if (!(await checkAdmin(chatId, userId))) return;
      session.state = STATES.ADMIN_AWAITING_MONTH;
      await sendMsg("Vui lòng nhập tháng bạn muốn cấu hình (VD: 03/2026):", {
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 Trở lại", callback_data: "ADMIN_BACK_TO_LIST" }]]
        }
      });
      return;
    }

    if (data.startsWith('ADMIN_VIEW_MONTH_')) {
      if (!(await checkAdmin(chatId, userId))) return;
      const month = data.replace('ADMIN_VIEW_MONTH_', '');
      const config = monthSheetConfig.get(month);
      if (!config) {
        await sendMsg("⚠️ Không tìm thấy cấu hình cho tháng này.");
        return;
      }

      const msg = `⚙️ **CẤU HÌNH THÁNG ${month}**\n\n` +
        `**Sheet Cố định:** ${config.sheetFixedId}\n` +
        `**Sheet Không cố định:** ${config.sheetNonFixedId}\n` +
        `**Folder Cố định:** ${config.folderFixedId}\n` +
        `**Folder Không cố định:** ${config.folderNonFixedId}\n`;

      await sendMsg(msg, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: "✏️ Sửa", callback_data: `ADMIN_EDIT_MONTH_${month}` }, { text: "🗑️ Xóa", callback_data: `ADMIN_DEL_MONTH_${month}` }],
            [{ text: "🔙 Trở lại danh sách", callback_data: "ADMIN_BACK_TO_LIST" }]
          ]
        }
      });
      return;
    }

    if (data.startsWith('ADMIN_EDIT_MONTH_')) {
      if (!(await checkAdmin(chatId, userId))) return;
      const month = data.replace('ADMIN_EDIT_MONTH_', '');

      await sendMsg(`✏️ **SỬA CẤU HÌNH THÁNG ${month}**\nChọn mục bạn muốn sửa:`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: "Sheet Cố định", callback_data: `ADMIN_EDIT_SPECIFIC_${month}_sheetFixedId` }],
            [{ text: "Sheet Không cố định", callback_data: `ADMIN_EDIT_SPECIFIC_${month}_sheetNonFixedId` }],
            [{ text: "Folder Cố định", callback_data: `ADMIN_EDIT_SPECIFIC_${month}_folderFixedId` }],
            [{ text: "Folder Không cố định", callback_data: `ADMIN_EDIT_SPECIFIC_${month}_folderNonFixedId` }],
            [{ text: "🔙 Trở lại", callback_data: `ADMIN_VIEW_MONTH_${month}` }]
          ]
        }
      });
      return;
    }

    if (data.startsWith('ADMIN_EDIT_SPECIFIC_')) {
      if (!(await checkAdmin(chatId, userId))) return;
      const parts = data.replace('ADMIN_EDIT_SPECIFIC_', '').split('_');
      const field = parts.pop()!;
      const month = parts.join('_');

      session.state = STATES.ADMIN_AWAITING_SPECIFIC_EDIT;
      session.data.adminMonth = month;
      session.data.adminEditField = field;

      const fieldNames: Record<string, string> = {
        'sheetFixedId': 'Sheet Cố định',
        'sheetNonFixedId': 'Sheet Không cố định',
        'folderFixedId': 'Folder Cố định',
        'folderNonFixedId': 'Folder Không cố định'
      };

      await sendMsg(`Đang sửa **${fieldNames[field]}** cho tháng **${month}**.\nVui lòng nhập ID (hoặc Link) mới:`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 Hủy sửa", callback_data: `ADMIN_EDIT_MONTH_${month}` }]]
        }
      });
      return;
    }

    if (data.startsWith('ADMIN_DEL_MONTH_')) {
      if (!(await checkAdmin(chatId, userId))) return;
      const month = data.replace('ADMIN_DEL_MONTH_', '');
      await sendMsg(`⚠️ Bạn có chắc chắn muốn xóa cấu hình của tháng **${month}** không?`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Xác nhận Xóa", callback_data: `ADMIN_CONFIRM_DEL_${month}` }],
            [{ text: "❌ Hủy", callback_data: `ADMIN_VIEW_MONTH_${month}` }]
          ]
        }
      });
      return;
    }

    if (data.startsWith('ADMIN_CONFIRM_DEL_')) {
      if (!(await checkAdmin(chatId, userId))) return;
      const month = data.replace('ADMIN_CONFIRM_DEL_', '');

      monthSheetConfig.delete(month);
      if (pool) {
        await pool.query("DELETE FROM bot_config WHERE key = $1", [`expense_monthConfig_${month}`]);
      }

      await sendMsg(`✅ Đã xóa cấu hình tháng **${month}**.`, { parse_mode: 'Markdown' });

      const availableMonths = Array.from(monthSheetConfig.keys());
      const keyboard = availableMonths.map(m => ([{ text: `Tháng ${m}`, callback_data: `ADMIN_VIEW_MONTH_${m}` }]));
      keyboard.push([{ text: "➕ Thêm tháng mới", callback_data: "ADMIN_ADD_MONTH" }]);
      keyboard.push([{ text: "🔙 Trở lại Menu", callback_data: "CMD_MENU_INLINE" }]);

      await sendMsg("⚙️ **QUẢN LÝ THÁNG**\nChọn tháng để xem/sửa hoặc thêm mới:", {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
      return;
    }

    if (data === 'CMD_MENU_INLINE') {
      await showMainMenu(chatId, session, sendMsg, query.message?.chat.type === 'private');
      return;
    }

    if (data === 'CMD_DONE_PHOTOS') {
      if (session.state === STATES.AWAITING_RECEIPT) {
        session.state = STATES.AWAITING_NOTES;
        await sendMsg("Nhập Ghi chú (Hoặc gõ /skip để bỏ qua):");
      }
      return;
    }

    if (data === 'CMD_MANAGE_SHEET_LIST') {
      session.state = STATES.IDLE;
      const availableMonths = Array.from(monthSheetConfig.keys());
      if (availableMonths.length === 0) {
        await sendMsg("⚠️ Chưa có tháng nào được cấu hình.", {
          reply_markup: {
            inline_keyboard: [[{ text: "🔙 Trở lại", callback_data: "CMD_MENU_INLINE" }]]
          }
        });
        return;
      }

      const keyboard = availableMonths.map(month => ([{ text: `Tháng ${month}`, callback_data: `CMD_MANAGE_MONTH_${month}` }]));
      keyboard.push([{ text: "🔙 Trở lại", callback_data: "CMD_MENU_INLINE" }]);

      await sendMsg("📊 **QUẢN LÍ SHEET**\nChọn tháng để xem danh sách chi phí:", {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
      return;
    }

    if (data.startsWith('CMD_MANAGE_MONTH_')) {
      const month = data.replace('CMD_MANAGE_MONTH_', '');
      const config = monthSheetConfig.get(month);
      if (!config) {
        await sendMsg("⚠️ Không tìm thấy cấu hình tháng này.");
        return;
      }

      const loadingMsg = await sendMsg(`⏳ Đang tải danh sách chi phí tháng ${month}...`);

      if (process.env.GAS_WEB_APP_URL) {
        try {
          const gasRes = await fetch(process.env.GAS_WEB_APP_URL, {
            method: 'POST',
            body: JSON.stringify({
              action: 'get_expenses',
              sheetFixedId: config.sheetFixedId,
              sheetNonFixedId: config.sheetNonFixedId
            })
          });
          const result = await gasRes.json();

          try {
            await bot!.deleteMessage(chatId, loadingMsg.message_id);
            session.messageIds = session.messageIds.filter(id => id !== loadingMsg.message_id);
          } catch (e) { }

          if (result.success && result.expenses && result.expenses.length > 0) {
            // Store expenses in session for later viewing
            session.data.loadedExpenses = result.expenses;
            session.data.currentMonth = month;

            // Show last 10 expenses
            const recentExpenses = result.expenses.slice(-10).reverse();
            const keyboard = recentExpenses.map((exp: any, index: number) => {
              // exp should have: id, date, category, amount, costType
              const shortCat = exp.category.length > 15 ? exp.category.substring(0, 15) + '...' : exp.category;
              const displayAmt = exp.displayAmount || new Intl.NumberFormat('vi-VN').format(Number(exp.amount));
              return [{ text: `[${exp.date}] ${shortCat} - ${displayAmt}`, callback_data: `CMD_VIEW_EXP_${index}` }];
            });
            keyboard.push([{ text: "🔙 Trở lại", callback_data: "CMD_MANAGE_SHEET_LIST" }]);

            await sendMsg(`📊 **Danh sách chi phí tháng ${month}** (10 giao dịch gần nhất):`, {
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: keyboard }
            });
          } else {
            await sendMsg(`Tháng ${month} chưa có giao dịch nào hoặc không thể tải dữ liệu.`, {
              reply_markup: { inline_keyboard: [[{ text: "🔙 Trở lại", callback_data: "CMD_MANAGE_SHEET_LIST" }]] }
            });
          }
        } catch (e) {
          await sendMsg(`❌ Lỗi khi tải dữ liệu: ${e}`, {
            reply_markup: { inline_keyboard: [[{ text: "🔙 Trở lại", callback_data: "CMD_MANAGE_SHEET_LIST" }]] }
          });
        }
      } else {
        await sendMsg("⚠️ Chưa cấu hình GAS_WEB_APP_URL.", {
          reply_markup: { inline_keyboard: [[{ text: "🔙 Trở lại", callback_data: "CMD_MANAGE_SHEET_LIST" }]] }
        });
      }
      return;
    }

    if (data.startsWith('CMD_VIEW_EXP_')) {
      const index = parseInt(data.replace('CMD_VIEW_EXP_', ''));
      const expenses = session.data.loadedExpenses;
      if (!expenses || !expenses.slice(-10).reverse()[index]) {
        await sendMsg("⚠️ Không tìm thấy thông tin giao dịch.");
        return;
      }

      const exp = expenses.slice(-10).reverse()[index];
      session.data.selectedExpense = exp;

      const msgText = `🧾 **CHI TIẾT GIAO DỊCH**\n\n` +
        `📅 Ngày: ${exp.date}\n` +
        `Loại: ${exp.costType}\n` +
        `🏷 Hạng mục: ${exp.category}\n` +
        `💵 Số tiền: ${exp.displayAmount || new Intl.NumberFormat('vi-VN').format(Number(exp.amount)) + ' vnd'} ${exp.unit || ''}\n` +
        `👤 Người chi: ${exp.payer || ''}\n` +
        `📝 Ghi chú: ${exp.notes || 'Không có'}\n\n` +
        `Bạn muốn làm gì với giao dịch này?`;

      await sendMsg(msgText, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: "✏️ Sửa", callback_data: "CMD_EDIT_EXP_SELECT" }, { text: "🗑️ Xóa", callback_data: "CMD_DEL_EXP_CONFIRM" }],
            [{ text: "🔙 Trở lại danh sách", callback_data: `CMD_MANAGE_MONTH_${session.data.currentMonth}` }]
          ]
        }
      });
      return;
    }

    if (data === 'CMD_DEL_EXP_CONFIRM') {
      await sendMsg("⚠️ Bạn có chắc chắn muốn xóa giao dịch này không?", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Có, xóa ngay", callback_data: "CMD_DEL_EXP_EXECUTE" }],
            [{ text: "❌ Không, quay lại", callback_data: "CMD_VIEW_EXP_BACK" }]
          ]
        }
      });
      return;
    }

    if (data === 'CMD_VIEW_EXP_BACK') {
      const exp = session.data.selectedExpense;
      if (!exp) {
        if (session.data.currentMonth) {
          bot!.processUpdate({ update_id: 0, callback_query: { ...query, data: `CMD_MANAGE_MONTH_${session.data.currentMonth}` } as any });
        }
        return;
      }

      const msgText = `🧾 **CHI TIẾT GIAO DỊCH**\n\n` +
        `📅 Ngày: ${exp.date}\n` +
        `Loại: ${exp.costType}\n` +
        `🏷 Hạng mục: ${exp.category}\n` +
        `💵 Số tiền: ${exp.displayAmount || new Intl.NumberFormat('vi-VN').format(Number(exp.amount)) + ' vnd'} ${exp.unit || ''}\n` +
        `👤 Người chi: ${exp.payer || ''}\n` +
        `📝 Ghi chú: ${exp.notes || 'Không có'}\n\n` +
        `Bạn muốn làm gì với giao dịch này?`;

      await sendMsg(msgText, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: "✏️ Sửa", callback_data: "CMD_EDIT_EXP_SELECT" }, { text: "🗑️ Xóa", callback_data: "CMD_DEL_EXP_CONFIRM" }],
            [{ text: "🔙 Trở lại danh sách", callback_data: `CMD_MANAGE_MONTH_${session.data.currentMonth}` }]
          ]
        }
      });
      return;
    }

    if (data === 'CMD_DEL_EXP_EXECUTE') {
      const exp = session.data.selectedExpense;
      const month = session.data.currentMonth;
      if (!exp || !month) {
        await sendMsg("⚠️ Lỗi: Không tìm thấy thông tin giao dịch để xóa.");
        return;
      }

      const config = monthSheetConfig.get(month);
      if (!config) return;

      const sheetId = exp.costType === 'Chi phí cố định' ? config.sheetFixedId : config.sheetNonFixedId;

      await sendMsg("⏳ Đang xóa giao dịch...");
      if (process.env.GAS_WEB_APP_URL) {
        try {
          const gasRes = await fetch(process.env.GAS_WEB_APP_URL, {
            method: 'POST',
            body: JSON.stringify({
              action: 'delete_expense',
              sheetId: sheetId,
              rowNumber: exp.rowNumber
            })
          });
          const result = await gasRes.json();
          if (result.success) {
            // Xóa tất cả tin nhắn trong phiên
            for (const msgId of session.messageIds) {
              try {
                await bot!.deleteMessage(chatId, msgId);
              } catch (e) { }
            }
            session.messageIds = [];

            const successMsg = await sendMsg("✅ Đã xóa giao dịch thành công!");
            setTimeout(async () => {
              try {
                await bot!.deleteMessage(chatId, successMsg.message_id);
                session.messageIds = session.messageIds.filter(id => id !== successMsg.message_id);
              } catch (e) { }
            }, 3000);

            // Gọi lại hàm hiển thị danh sách
            bot!.processUpdate({ update_id: 0, callback_query: { ...query, data: `CMD_MANAGE_MONTH_${month}` } as any });
          } else {
            await sendMsg(`❌ Lỗi khi xóa: ${result.error}`);
          }
        } catch (e) {
          await sendMsg(`❌ Lỗi kết nối: ${e}`);
        }
      }
      return;
    }

    if (data === 'CMD_EDIT_EXP_SELECT') {
      const exp = session.data.selectedExpense;
      if (!exp) return;

      // We reuse the existing edit flow but set lastUserExpense to this exp
      lastUserExpense.set(userId, {
        rowNumber: exp.rowNumber,
        month: session.data.currentMonth,
        costType: exp.costType,
        data: {
          date: exp.date,
          category: exp.category,
          amount: exp.amount,
          unit: exp.unit,
          payer: exp.payer,
          notes: exp.notes,
          receiptUrl: ''
        }
      });

      session.state = STATES.IDLE;
      await showEditMenu(chatId, userId, session, sendMsg);
      return;
    }

    if (data === 'CMD_EDIT') {
      const lastExp = lastUserExpense.get(userId);
      if (!lastExp) {
        await sendMsg("⚠️ Không tìm thấy giao dịch nào vừa nhập để sửa.");
        return;
      }
      session.state = STATES.IDLE;
      await showEditMenu(chatId, userId, session, sendMsg);
      return;
    }

    if (data.startsWith('EDIT_')) {
      const field = data.replace('EDIT_', '');
      session.state = `AWAITING_EDIT_${field}`;
      session.data.editField = field;

      const fieldNames: Record<string, string> = {
        'DATE': 'Ngày thanh toán (VD: 15/03/26)',
        'CATEGORY': 'Hạng mục',
        'AMOUNT': 'Số tiền',
        'UNIT': 'Đơn vị',
        'PAYER': 'Người thanh toán',
        'NOTES': 'Ghi chú'
      };

      if (field === 'DATE') {
        const now = new Date();
        const vnTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
        const todayStr = `${vnTime.getUTCDate().toString().padStart(2, '0')}/${(vnTime.getUTCMonth() + 1).toString().padStart(2, '0')}/${vnTime.getUTCFullYear().toString().slice(-2)}`;

        await sendMsg(`Nhập giá trị mới cho **${fieldNames[field]}** hoặc chọn Hôm nay:`, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: `📅 Hôm nay (${todayStr})`, callback_data: `CMD_USE_TODAY_EDIT_DATE_${todayStr}` }]
            ]
          }
        });
      } else {
        await sendMsg(`Nhập giá trị mới cho **${fieldNames[field]}**:`, { parse_mode: 'Markdown' });
      }
      return;
    }

    if (session.state === 'AWAITING_EDIT_DATE' && data.startsWith('CMD_USE_TODAY_EDIT_DATE_')) {
      const dateStr = data.replace('CMD_USE_TODAY_EDIT_DATE_', '');
      // We simulate the user typing the date
      bot!.processUpdate({
        update_id: 0,
        message: {
          message_id: 0,
          from: query.from,
          chat: query.message!.chat,
          date: Math.floor(Date.now() / 1000),
          text: dateStr
        }
      });
      return;
    }

    if (data === 'CMD_UNDO') {
      const lastExp = lastUserExpense.get(userId);
      if (!lastExp) {
        await sendMsg("⚠️ Không tìm thấy giao dịch nào vừa nhập để xóa.");
        return;
      }

      const config = monthSheetConfig.get(lastExp.month);
      if (!config) {
        await sendMsg("⚠️ Lỗi: Không tìm thấy cấu hình cho tháng này.");
        return;
      }
      const sheetId = lastExp.costType === 'Chi phí cố định' ? config.sheetFixedId : config.sheetNonFixedId;

      await sendMsg("⏳ Đang tiến hành xóa giao dịch cuối cùng trên Google Sheets...");
      if (process.env.GAS_WEB_APP_URL) {
        try {
          const gasRes = await fetch(process.env.GAS_WEB_APP_URL, {
            method: 'POST',
            body: JSON.stringify({
              action: 'delete_expense',
              sheetId: sheetId,
              rowNumber: lastExp.rowNumber
            })
          });
          const result = await gasRes.json();
          if (result.success) {
            await sendMsg("✅ Đã xóa thành công giao dịch vừa nhập!");

            if (allowedTopic.chatId && allowedTopic.threadId) {
              const groupMsg = `🗑️ **XÓA CHI PHÍ** (bởi ${query.from.first_name})\n\n` +
                `Đã xóa giao dịch: ${lastExp.data.category} - ${lastExp.data.displayAmount || lastExp.data.amount}`;
              try {
                await bot!.sendMessage(allowedTopic.chatId, groupMsg, {
                  message_thread_id: allowedTopic.threadId,
                  parse_mode: 'Markdown'
                });
              } catch (e) {
                console.error("Could not send group notification", e);
              }
            }

            lastUserExpense.delete(userId); // Xóa khỏi bộ nhớ
          } else {
            await sendMsg(`❌ Lỗi khi xóa: ${result.error}`);
          }
        } catch (e) {
          await sendMsg("❌ Lỗi kết nối tới Google Apps Script.");
        }
      }
      return;
    }

    if (data === 'CMD_NHAPCHIPHI') {
      const availableMonths = Array.from(monthSheetConfig.entries())
        .filter(([_, config]) => config.sheetFixedId && config.sheetNonFixedId && config.folderFixedId && config.folderNonFixedId)
        .map(([month, _]) => month);

      if (availableMonths.length === 0) {
        await sendMsg("⚠️ Chưa có tháng nào được cấu hình ID Sheet/Folder.\nVui lòng báo Admin cấu hình trước khi nhập liệu.");
        return;
      }

      session.state = STATES.AWAITING_COST_TYPE;
      session.data = {};
      await sendMsg("Chào bạn! Vui lòng chọn loại chi phí:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Chi phí cố định", callback_data: "COST_FIXED" }],
            [{ text: "Chi phí không cố định", callback_data: "COST_NON_FIXED" }]
          ]
        }
      });
      return;
    }

    if (session.state === STATES.AWAITING_COST_TYPE && data.startsWith('COST_')) {
      session.data.costType = data === 'COST_FIXED' ? 'Chi phí cố định' : 'Chi phí không cố định';
      session.state = STATES.AWAITING_MONTH;

      const availableMonths = Array.from(monthSheetConfig.entries())
        .filter(([_, config]) => config.sheetFixedId && config.sheetNonFixedId && config.folderFixedId && config.folderNonFixedId)
        .map(([month, _]) => month);

      const keyboard = availableMonths.map(m => ([{ text: m, callback_data: `MONTH_${m}` }]));

      await sendMsg(`Đã chọn: **${session.data.costType}**\nChọn tháng để xuất:`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: keyboard
        }
      });
      return;
    }

    if (session.state === STATES.AWAITING_MONTH && data.startsWith('MONTH_')) {
      session.data.month = data.replace('MONTH_', '');
      session.state = STATES.AWAITING_DATE;

      // Lấy ngày hiện tại theo giờ Việt Nam (UTC+7)
      const now = new Date();
      const vnTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
      const todayStr = `${vnTime.getUTCDate().toString().padStart(2, '0')}/${(vnTime.getUTCMonth() + 1).toString().padStart(2, '0')}/${vnTime.getUTCFullYear().toString().slice(-2)}`;

      await sendMsg(`Đã chọn tháng: **${session.data.month}**\nNhập Ngày thanh toán (VD: 15/03/26) hoặc chọn Hôm nay:`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: `📅 Hôm nay (${todayStr})`, callback_data: `CMD_USE_TODAY_DATE_${todayStr}` }]
          ]
        }
      });
      return;
    }

    if (session.state === STATES.AWAITING_DATE && data.startsWith('CMD_USE_TODAY_DATE_')) {
      const dateStr = data.replace('CMD_USE_TODAY_DATE_', '');
      session.data.date = dateStr;
      session.state = STATES.AWAITING_CATEGORY;
      await sendMsg("Nhập Hạng mục thanh toán (Bắt buộc):");
      return;
    }
  });

  // --- MESSAGE HANDLER ---
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text?.trim();

    if (!userId) return;

    // Check if this message is for this topic
    const isCommand = text?.startsWith('/');
    if (msg.chat.type !== 'private') {
      if (allowedTopic.chatId && allowedTopic.threadId) {
        if (msg.chat.id !== allowedTopic.chatId || msg.message_thread_id !== allowedTopic.threadId) {
          if (!isCommand) return; // Ignore normal messages outside topic
        } else {
          // Inside the allowed topic
          if (!isCommand) {
            try {
              const warningMsg = await bot!.sendMessage(chatId, "⚠️ Vui lòng không nhắn tin trong Topic này. Topic này chỉ dùng để nhận thông báo và lệnh Bot.", {
                message_thread_id: msg.message_thread_id
              });
              setTimeout(async () => {
                try {
                  if (msg.message_id) {
                    await bot!.deleteMessage(chatId, msg.message_id);
                  }
                  await bot!.deleteMessage(chatId, warningMsg.message_id);
                } catch (e) {
                  // Ignore if already deleted
                }
              }, 5000);
            } catch (e) {
              console.error("Failed to send warning message", e);
            }
            return;
          }
        }
      } else {
        if (!isCommand) return; // Ignore normal messages in groups if topic not set
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

    // Handle Commands
    const command = text?.split('@')[0];

    if (command === '/reset_topic') {
      if (await isAdmin(msg.chat.id, userId)) {
        await saveAllowedTopic({});
        await sendMsg("✅ Đã xóa thiết lập Topic. Bạn có thể dùng lệnh /set_topic ở một Topic mới.");
      } else {
        await sendMsg("⚠️ Chỉ Quản trị viên của nhóm mới có thể sử dụng lệnh này.");
      }
      return;
    }

    if (command === '/set_topic') {
      if (await isAdmin(allowedTopic.chatId || msg.chat.id, userId)) {
        if (allowedTopic.chatId && allowedTopic.chatId !== msg.chat.id) {
          await sendMsg("⚠️ Bot đã được thiết lập ở một Nhóm khác rồi. Không thể thiết lập lại.");
          return;
        }
        if (allowedTopic.chatId === msg.chat.id && allowedTopic.threadId && allowedTopic.threadId !== msg.message_thread_id) {
          await sendMsg("⚠️ Bot đã được thiết lập ở một Topic khác trong nhóm này rồi. Không thể thiết lập lại.");
          return;
        }
        if (allowedTopic.chatId === msg.chat.id && allowedTopic.threadId === msg.message_thread_id) {
          await sendMsg("⚠️ Topic này đã được thiết lập làm nơi nhập liệu rồi.");
          return;
        }
        if (msg.chat.type === 'supergroup' && msg.message_thread_id) {
          await saveAllowedTopic({ chatId: msg.chat.id, threadId: msg.message_thread_id });
          const sent = await sendMsg("✅ Đã thiết lập Topic này làm nơi chuyên nhập liệu chi phí!\n\n📋 **MENU CHÍNH**\nVui lòng chọn chức năng bên dưới:", {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: "📝 Nhập chi phí mới", url: `https://t.me/${getBotUsername()}?start=add` }],
                [{ text: "📊 Quản lí sheet", url: `https://t.me/${getBotUsername()}?start=manage` }],
                [{ text: "⚙️ Quản lí tháng", url: `https://t.me/${getBotUsername()}?start=admin` }],
                [{ text: "❌ Huỷ thao tác", url: `https://t.me/${getBotUsername()}?start=cancel` }]
              ]
            }
          });
          try {
            await bot!.pinChatMessage(chatId, sent.message_id);
          } catch (e) {
            console.error("Could not pin message", e);
          }
        } else {
          await sendMsg("⚠️ Lệnh này chỉ hoạt động trong một Topic của Group (Supergroup).");
        }
      } else {
        await sendMsg("⛔ Chỉ Admin mới có quyền set topic.");
      }
      return;
    }

    if (command === '/start add') {
      if (msg.chat.type !== 'private') return;
      const availableMonths = Array.from(monthSheetConfig.entries())
        .filter(([_, config]) => config.sheetFixedId && config.sheetNonFixedId && config.folderFixedId && config.folderNonFixedId)
        .map(([month, _]) => month);

      if (availableMonths.length === 0) {
        await sendMsg("⚠️ Chưa có tháng nào được cấu hình ID Sheet/Folder.\nVui lòng báo Admin cấu hình trước khi nhập liệu.");
        return;
      }

      session.state = STATES.AWAITING_COST_TYPE;
      session.data = {};
      await sendMsg("Chào bạn! Vui lòng chọn loại chi phí:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Chi phí cố định", callback_data: "COST_FIXED" }],
            [{ text: "Chi phí không cố định", callback_data: "COST_NON_FIXED" }]
          ]
        }
      });
      return;
    }

    if (command === '/start manage') {
      if (msg.chat.type !== 'private') return;
      session.state = STATES.IDLE;
      const availableMonths = Array.from(monthSheetConfig.keys());
      if (availableMonths.length === 0) {
        await sendMsg("⚠️ Chưa có tháng nào được cấu hình.", {
          reply_markup: {
            inline_keyboard: [[{ text: "🔙 Trở lại", callback_data: "CMD_MENU_INLINE" }]]
          }
        });
        return;
      }

      const keyboard = availableMonths.map(month => ([{ text: `Tháng ${month}`, callback_data: `CMD_MANAGE_MONTH_${month}` }]));
      keyboard.push([{ text: "🔙 Trở lại", callback_data: "CMD_MENU_INLINE" }]);

      await sendMsg("📊 **QUẢN LÍ SHEET**\nChọn tháng để xem danh sách chi phí:", {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
      return;
    }

    if (command === '/start admin') {
      if (msg.chat.type !== 'private') return;
      session.state = STATES.IDLE;
      await showAdminMenu(chatId, userId, session, sendMsg);
      return;
    }

    if (command === '/start cancel' || command === '/cancel' || command === '/huy') {
      session.state = STATES.IDLE;
      await sendMsg("Đã hủy thao tác hiện tại. Các tin nhắn sẽ được dọn dẹp sau 30s.");
      scheduleCleanup(chatId, [...session.messageIds]);
      session.messageIds = [];
      session.data = {};
      return;
    }

    if (command === '/expense_menu' || command === '/start') {
      if (allowedTopic.chatId && allowedTopic.threadId && msg.chat.type !== 'private') {
        if (msg.chat.id !== allowedTopic.chatId || msg.message_thread_id !== allowedTopic.threadId) {
          await sendMsg("⚠️ Vui lòng vào đúng Topic đã được chỉ định để sử dụng Bot.");
          return;
        }
      }

      await showMainMenu(chatId, session, sendMsg, msg.chat.type === 'private');
      return;
    }

    // State Machine Processing
    try {
      if (session.state.startsWith('AWAITING_EDIT_')) {
        const field = session.data.editField;
        const newValue = text;

        if (!newValue) return;

        if (field === 'DATE') {
          if (!/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(newValue)) {
            await sendMsg("Sai định dạng ngày. Vui lòng nhập lại (VD: 15/03/2026):");
            return;
          }
          if (!isValidPastOrToday(newValue)) {
            await sendMsg("Không được nhập ngày tương lai. Vui lòng nhập ngày hôm nay hoặc các ngày trước đó:");
            return;
          }
        }

        const lastExp = lastUserExpense.get(userId);
        if (!lastExp) {
          await sendMsg("⚠️ Phiên sửa đã hết hạn.");
          session.state = STATES.IDLE;
          return;
        }

        const fieldMap: Record<string, string> = {
          'DATE': 'date',
          'CATEGORY': 'category',
          'AMOUNT': 'amount',
          'UNIT': 'unit',
          'PAYER': 'payer',
          'NOTES': 'notes'
        };
        const fieldNames: Record<string, string> = {
          'DATE': 'Ngày',
          'CATEGORY': 'Hạng mục',
          'AMOUNT': 'Số tiền',
          'UNIT': 'Đơn vị',
          'PAYER': 'Người chi',
          'NOTES': 'Ghi chú'
        };
        const dataKey = fieldMap[field];

        let finalValue = newValue;
        if (field === 'CATEGORY') {
          finalValue = newValue;
        } else if (field === 'AMOUNT') {
          const parsed = parseAmount(newValue);
          finalValue = parsed.sheetAmount.toString();
          lastExp.data.displayAmount = parsed.displayAmount;
        }

        lastExp.data[dataKey] = finalValue;

        await sendMsg("⏳ Đang cập nhật lên Google Sheets...");

        const config = monthSheetConfig.get(lastExp.month);
        if (!config) {
          await sendMsg("⚠️ Lỗi: Không tìm thấy cấu hình cho tháng này.");
          return;
        }
        const sheetId = lastExp.costType === 'Chi phí cố định' ? config.sheetFixedId : config.sheetNonFixedId;

        if (process.env.GAS_WEB_APP_URL) {
          try {
            const gasRes = await fetch(process.env.GAS_WEB_APP_URL, {
              method: 'POST',
              body: JSON.stringify({
                action: 'update_expense',
                sheetId: sheetId,
                rowNumber: lastExp.rowNumber,
                field: dataKey,
                value: finalValue
              })
            });
            const result = await gasRes.json();
            if (result.success) {
              await sendMsg("✅ Đã cập nhật thành công!");

              if (allowedTopic.chatId && allowedTopic.threadId) {
                const groupMsg = `✏️ **CẬP NHẬT CHI PHÍ** (bởi ${msg.from?.first_name})\n\n` +
                  `Đã sửa **${fieldNames[field]}** thành: ${field === 'AMOUNT' ? lastExp.data.displayAmount : finalValue}\n` +
                  `(Giao dịch: ${lastExp.data.category} - ${lastExp.data.displayAmount || lastExp.data.amount})`;
                try {
                  await bot!.sendMessage(allowedTopic.chatId, groupMsg, {
                    message_thread_id: allowedTopic.threadId,
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
        // --- ADMIN FLOW ---
        case STATES.ADMIN_AWAITING_MONTH:
          if (!text || !/^\d{2}\/\d{4}$/.test(text)) {
            await sendMsg("Sai định dạng. Vui lòng nhập lại (VD: 03/2026):");
            return;
          }
          session.data.adminMonth = text;
          session.state = STATES.ADMIN_AWAITING_SHEET_FIXED_ID;
          await sendMsg(`Nhập ID (hoặc Link) Google Sheet lưu text [Chi phí cố định] cho tháng ${text}:`);
          return;

        case STATES.ADMIN_AWAITING_SHEET_FIXED_ID:
          if (!text) return;
          session.data.adminSheetFixedId = text;
          session.state = STATES.ADMIN_AWAITING_SHEET_NON_FIXED_ID;
          await sendMsg(`Nhập ID (hoặc Link) Google Sheet lưu text [Chi phí KHÔNG cố định] cho tháng ${session.data.adminMonth}:`);
          return;

        case STATES.ADMIN_AWAITING_SHEET_NON_FIXED_ID:
          if (!text) return;
          session.data.adminSheetNonFixedId = text;
          session.state = STATES.ADMIN_AWAITING_FOLDER_FIXED_ID;
          await sendMsg(`Nhập ID (hoặc Link) Thư mục Google Drive để lưu ảnh [Chi phí cố định] cho tháng ${session.data.adminMonth}:`);
          return;

        case STATES.ADMIN_AWAITING_FOLDER_FIXED_ID:
          if (!text) return;
          session.data.adminFolderFixedId = text;
          session.state = STATES.ADMIN_AWAITING_FOLDER_NON_FIXED_ID;
          await sendMsg(`Nhập ID (hoặc Link) Thư mục Google Drive để lưu ảnh [Chi phí KHÔNG cố định] cho tháng ${session.data.adminMonth}:`);
          return;

        case STATES.ADMIN_AWAITING_FOLDER_NON_FIXED_ID:
          if (!text) return;
          session.data.adminFolderNonFixedId = text;

          const newConfig = {
            sheetFixedId: session.data.adminSheetFixedId,
            sheetNonFixedId: session.data.adminSheetNonFixedId,
            folderFixedId: session.data.adminFolderFixedId,
            folderNonFixedId: session.data.adminFolderNonFixedId
          };

          await saveMonthConfig(session.data.adminMonth, newConfig);
          session.state = STATES.IDLE;

          if (process.env.GAS_WEB_APP_URL) {
            try {
              await fetch(process.env.GAS_WEB_APP_URL, {
                method: 'POST',
                body: JSON.stringify({
                  action: 'save_config',
                  month: session.data.adminMonth,
                  sheetFixedId: session.data.adminSheetFixedId,
                  sheetNonFixedId: session.data.adminSheetNonFixedId,
                  folderFixedId: session.data.adminFolderFixedId,
                  folderNonFixedId: session.data.adminFolderNonFixedId
                })
              });
            } catch (e) {
              console.error("Failed to save config to GAS", e);
            }
          }
          await sendMsg(`✅ Đã lưu cấu hình thành công cho tháng ${session.data.adminMonth}!\n\nCác tin nhắn sẽ được dọn dẹp sau 30s.`);
          scheduleCleanup(chatId, [...session.messageIds]);
          session.messageIds = [];
          return;

        case STATES.ADMIN_AWAITING_SPECIFIC_EDIT: {
          if (!text) return;
          const month = session.data.adminMonth;
          const field = session.data.adminEditField;

          const config = monthSheetConfig.get(month);
          if (!config) {
            await sendMsg("⚠️ Không tìm thấy cấu hình tháng này.");
            session.state = STATES.IDLE;
            return;
          }

          config[field as keyof typeof config] = text;
          await saveMonthConfig(month, config);

          if (process.env.GAS_WEB_APP_URL) {
            try {
              await fetch(process.env.GAS_WEB_APP_URL, {
                method: 'POST',
                body: JSON.stringify({
                  action: 'save_config',
                  month: month,
                  sheetFixedId: config.sheetFixedId,
                  sheetNonFixedId: config.sheetNonFixedId,
                  folderFixedId: config.folderFixedId,
                  folderNonFixedId: config.folderNonFixedId
                })
              });
            } catch (e) {
              console.error("Failed to save config to GAS", e);
            }
          }

          session.state = STATES.IDLE;
          await sendMsg(`✅ Đã cập nhật thành công!`, { parse_mode: 'Markdown' });

          const configMsg = `⚙️ **CẤU HÌNH THÁNG ${month}**\n\n` +
            `**Sheet Cố định:** ${config.sheetFixedId}\n` +
            `**Sheet Không cố định:** ${config.sheetNonFixedId}\n` +
            `**Folder Cố định:** ${config.folderFixedId}\n` +
            `**Folder Không cố định:** ${config.folderNonFixedId}\n`;

          await sendMsg(configMsg, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: "✏️ Sửa", callback_data: `ADMIN_EDIT_MONTH_${month}` }, { text: "🗑️ Xóa", callback_data: `ADMIN_DEL_MONTH_${month}` }],
                [{ text: "🔙 Trở lại danh sách", callback_data: "ADMIN_BACK_TO_LIST" }]
              ]
            }
          });
          return;
        }

        // --- EXPENSE ENTRY FLOW ---
        case STATES.AWAITING_DATE:
          if (!text || !/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(text)) {
            await sendMsg("Sai định dạng ngày. Vui lòng nhập lại (VD: 15/03/2026):");
            return;
          }
          if (!isValidPastOrToday(text)) {
            await sendMsg("Không được nhập ngày tương lai. Vui lòng nhập ngày hôm nay hoặc các ngày trước đó:");
            return;
          }
          session.data.date = text;
          session.state = STATES.AWAITING_CATEGORY;
          await sendMsg("Nhập Hạng mục thanh toán (Bắt buộc):");
          return;

        case STATES.AWAITING_CATEGORY:
          if (!text) {
            await sendMsg("Hạng mục không được để trống. Vui lòng nhập:");
            return;
          }
          session.data.category = text;
          session.state = STATES.AWAITING_AMOUNT;
          await sendMsg("Nhập Số tiền thanh toán (VD: 50.000 vnd hoặc $77):");
          return;

        case STATES.AWAITING_AMOUNT:
          if (!text) {
            await sendMsg("Số tiền không được để trống. Vui lòng nhập:");
            return;
          }
          const parsed = parseAmount(text);
          session.data.amount = parsed.sheetAmount;
          session.data.displayAmount = parsed.displayAmount;
          session.state = STATES.AWAITING_UNIT;
          await sendMsg("Nhập Đơn vị đề xuất thanh toán (Bắt buộc):");
          return;

        case STATES.AWAITING_UNIT:
          if (!text) {
            await sendMsg("Đơn vị không được để trống. Vui lòng nhập:");
            return;
          }
          session.data.unit = text;
          session.state = STATES.AWAITING_PAYER;
          await sendMsg("Nhập Người thanh toán (Bắt buộc):");
          return;

        case STATES.AWAITING_PAYER:
          if (!text) {
            await sendMsg("Người thanh toán không được để trống. Vui lòng nhập:");
            return;
          }
          session.data.payer = text;
          session.state = STATES.AWAITING_RECEIPT;
          await sendMsg("Vui lòng đính kèm Chứng từ tham chiếu (Gửi ảnh). Bạn có thể gửi nhiều ảnh. Khi nào xong, hãy bấm /done hoặc nút bên dưới để tiếp tục.", {
            reply_markup: {
              inline_keyboard: [[{ text: "✅ Đã gửi xong ảnh", callback_data: "CMD_DONE_PHOTOS" }]]
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
          const photo = msg.photo[msg.photo.length - 1]; // Get highest resolution
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
              inline_keyboard: [[{ text: "✅ Đã gửi xong ảnh", callback_data: "CMD_DONE_PHOTOS" }]]
            }
          });
          return;

        case STATES.AWAITING_NOTES: {
          session.data.notes = text === '/skip' ? '' : text;

          const finalData = { ...session.data };
          session.state = STATES.IDLE;
          session.data = {};

          const config = monthSheetConfig.get(finalData.month);
          if (!config) {
            await sendMsg("⚠️ Lỗi: Không tìm thấy cấu hình cho tháng này.");
            return;
          }
          const sheetId = finalData.costType === 'Chi phí cố định' ? config.sheetFixedId : config.sheetNonFixedId;
          const folderId = finalData.costType === 'Chi phí cố định' ? config.folderFixedId : config.folderNonFixedId;

          await sendMsg("Đang xử lý và lưu dữ liệu lên Google Sheets...");

          let gasMessage = '';
          if (process.env.GAS_WEB_APP_URL) {
            try {
              const gasRes = await fetch(process.env.GAS_WEB_APP_URL, {
                method: 'POST',
                body: JSON.stringify({
                  action: 'add_expense',
                  sheetId: sheetId,
                  folderId: folderId,
                  ...finalData
                })
              });
              const result = await gasRes.json();
              if (result.success) {
                gasMessage = `\n(Đã đồng bộ lên Google Sheets & Drive thành công!)`;
                if (result.rowNumber) {
                  lastUserExpense.set(userId, {
                    month: finalData.month,
                    costType: finalData.costType,
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

          const successMsg = `✅ Đã lưu thành công!${gasMessage}\n\n` +
            `Tháng: ${finalData.month}\n` +
            `Loại: ${finalData.costType}\n` +
            `Ngày: ${finalData.date}\n` +
            `Hạng mục: ${finalData.category}\n` +
            `Số tiền: ${finalData.displayAmount || finalData.amount}\n` +
            `Đơn vị: ${finalData.unit}\n` +
            `Người TT: ${finalData.payer}\n` +
            `Ghi chú: ${finalData.notes || 'Không có'}\n\n` +
            `Các tin nhắn sẽ được dọn dẹp sau 30s.`;

          await sendMsg(successMsg, {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✏️ Sửa chi phí vừa nhập", callback_data: "CMD_EDIT" },
                  { text: "🗑️ Xóa chi phí vừa nhập", callback_data: "CMD_UNDO" }
                ],
                [{ text: "🔙 Về Menu", callback_data: "CMD_MENU" }]
              ]
            }
          });

          if (allowedTopic.chatId && allowedTopic.threadId) {
            const groupMsg = `🆕 **CHI PHÍ MỚI [${finalData.costType}]** (bởi ${msg.from?.first_name})\n\n` +
              `Tháng: ${finalData.month}\n` +
              `Ngày: ${finalData.date}\n` +
              `Hạng mục: ${finalData.category}\n` +
              `Số tiền: ${finalData.displayAmount || finalData.amount}\n` +
              `Đơn vị: ${finalData.unit}\n` +
              `Người TT: ${finalData.payer}\n` +
              `Ghi chú: ${finalData.notes || 'Không có'}`;
            try {
              if (finalData.receiptFileIds && finalData.receiptFileIds.length > 0) {
                if (finalData.receiptFileIds.length === 1) {
                  await bot!.sendPhoto(allowedTopic.chatId, finalData.receiptFileIds[0], {
                    caption: groupMsg,
                    message_thread_id: allowedTopic.threadId,
                    parse_mode: 'Markdown'
                  });
                } else {
                  const mediaGroup = finalData.receiptFileIds.map((fileId: string, index: number) => ({
                    type: 'photo',
                    media: fileId,
                    caption: index === 0 ? groupMsg : '',
                    parse_mode: 'Markdown'
                  }));
                  await bot!.sendMediaGroup(allowedTopic.chatId, mediaGroup as any, {
                    message_thread_id: allowedTopic.threadId
                  } as any);
                }
              } else if (finalData.receiptFileId) {
                await bot!.sendPhoto(allowedTopic.chatId, finalData.receiptFileId, {
                  caption: groupMsg,
                  message_thread_id: allowedTopic.threadId,
                  parse_mode: 'Markdown'
                });
              } else {
                await bot!.sendMessage(allowedTopic.chatId, groupMsg, {
                  message_thread_id: allowedTopic.threadId,
                  parse_mode: 'Markdown'
                });
              }
            } catch (e) {
              console.error("Could not send group notification", e);
            }
          }

          // Cleanup messages after 30s
          scheduleCleanup(chatId, [...session.messageIds]);
          session.messageIds = [];
          return;
        }
      }
    } catch (err) {
      console.error(err);
      await sendMsg("Đã xảy ra lỗi trong quá trình xử lý. Vui lòng thử lại bằng lệnh /expense_menu.");
      session.state = STATES.IDLE;
    }
  });
}
