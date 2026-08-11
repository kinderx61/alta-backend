import express from 'express';
import cors from 'cors';
import pg from 'pg';
import TelegramBot from 'node-telegram-bot-api';

const app = express();
app.use(cors());
app.use(express.json());

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const WEB_APP_URL = 'https://alta-frontend-six.vercel.app';

const PAYMENT_REQUISITES = `💳 **Реквизиты для оплаты:**\n\n` +
  `• **Номер телефона (СБП):** \`+79895292935\`\n` +
  `• **Банк:** ВТБ\n` +
  `• **Получатель:** Кутилин А.А.\n\n` +
  `⚠️ *После перевода прикрепите скриншот чека прямо в этот чат для проверки!*`;

const ADMIN_IDS = [
  '843132781',
  '5186266444',
  process.env.ADMIN_CHAT_ID
].filter(Boolean);

const isAdmin = (chatId) => ADMIN_IDS.includes(chatId.toString());

// Инициализация БД
const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        bonuses INT DEFAULT 0,
        is_first_order BOOLEAN DEFAULT TRUE
      );

      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        price NUMERIC NOT NULL,
        image_url TEXT,
        image_urls TEXT[],
        category TEXT DEFAULT 'Все'
      );

      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id BIGINT,
        full_name TEXT,
        city TEXT,
        postal_code TEXT,
        address TEXT,
        phone TEXT,
        delivery_type TEXT,
        total_amount NUMERIC,
        bonuses_used INT,
        status TEXT DEFAULT 'waiting_payment'
      );
    `);

    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_urls TEXT[];`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Все';`);
  } catch (err) {
    console.error('Ошибка БД:', err);
  }
};
initDb();

// Настройка меню
const setupCommands = async () => {
  try {
    await bot.setMyCommands([
      { command: 'start', description: '🛒 Открыть каталог ALTA' }
    ], { scope: { type: 'default' } });

    const adminCommands = [
      { command: 'start', description: '🚀 Запустить бот' },
      { command: 'admin', description: '⚙️ Инструкция и справка' },
      { command: 'addproduct', description: '➕ Добавить товар в каталог' },
      { command: 'listproducts', description: '📦 Управление товарами и удаление' }
    ];

    for (const adminId of ADMIN_IDS) {
      await bot.setMyCommands(adminCommands, { scope: { type: 'chat', chat_id: adminId } }).catch(() => {});
    }
  } catch (err) {
    console.error('Ошибка настройки команд:', err);
  }
};
setupCommands();

// Прием чека
bot.on('photo', async (msg) => {
  await handleReceiptUpload(msg, msg.photo[msg.photo.length - 1].file_id, 'photo');
});

bot.on('document', async (msg) => {
  if (msg.document.mime_type?.includes('image') || msg.document.mime_type?.includes('pdf')) {
    await handleReceiptUpload(msg, msg.document.file_id, 'document');
  }
});

async function handleReceiptUpload(msg, fileId, type) {
  const userId = msg.from.id;

  try {
    const orderRes = await pool.query(
      `SELECT * FROM orders WHERE user_id = $1 AND status = 'waiting_payment' ORDER BY id DESC LIMIT 1`,
      [userId]
    );

    if (orderRes.rows.length === 0) {
      return bot.sendMessage(userId, 'У вас нет активных заказов, ожидающих оплаты.');
    }

    const order = orderRes.rows[0];
    await pool.query(`UPDATE orders SET status = 'on_review' WHERE id = $1`, [order.id]);

    bot.sendMessage(userId, `✅ **Чек по заказу №${order.id} получен!**\nАдминистраторы уже проверяют оплату. Ожидайте подтверждения.`, { parse_mode: 'Markdown' });

    const msgText = `🧾 **ЧЕК ОБ ОПЛАТЕ ПО ЗАКАЗУ №${order.id}**\n\n` +
      `👤 **Покупатель:** ${order.full_name} (@${msg.from.username || 'no_username'})\n` +
      `📞 **Телефон:** ${order.phone}\n` +
      `📍 **Доставка:** ${order.delivery_type}, г. ${order.city}, ${order.address}\n` +
      `💰 **Сумма к оплате:** ${order.total_amount} ₽`;

    const opts = {
      caption: msgText,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Подтвердить оплату', callback_data: `approve_${order.id}_${userId}_${order.total_amount}` },
            { text: '❌ Отклонить', callback_data: `reject_${order.id}` }
          ]
        ]
      }
    };

    ADMIN_IDS.forEach(adminId => {
      if (type === 'photo') {
        bot.sendPhoto(adminId, fileId, opts).catch(() => {});
      } else {
        bot.sendDocument(adminId, fileId, opts).catch(() => {});
      }
    });

  } catch (err) {
    console.error('Ошибка приема чека:', err);
  }
}

// КОМАНДЫ
bot.onText(/\/start/, (msg) => {
  const text = `Привет, ${msg.from.first_name || 'друг'}! 👋\n\nДобро пожаловать в **ALTA® CONCEPT STORE**.\n\nНажми на кнопку ниже, чтобы открыть каталог одежды:`;
  
  bot.sendMessage(msg.chat.id, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🛒 ОТКРЫТЬ МАГАЗИН ALTA', web_app: { url: WEB_APP_URL } }
        ]
      ]
    }
  });
});

bot.onText(/\/admin/, (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  const helpText = `⚙️ **Админ-меню ALTA:**\n\n` +
    `1. Добавить товар:\n\`/addproduct Худи Черное | 4500 | https://img1.jpg | Худи\`\n\n` +
    `2. Управление и удаление товаров:\n\`/listproducts\``;
  bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
});

bot.onText(/\/addproduct(?:\s+(.+))?/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return;
  const arg = match ? match[1] : null;
  if (!arg) return bot.sendMessage(msg.chat.id, `Формат: \`/addproduct Название | Цена | Ссылки | Категория\``, { parse_mode: 'Markdown' });

  const parts = arg.split('|').map(p => p.trim());
  const [name, price, imagesStr, category] = parts;
  const imageUrls = imagesStr ? imagesStr.split(',').map(s => s.trim()) : [];

  try {
    const res = await pool.query(
      'INSERT INTO products (name, price, image_url, image_urls, category) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, Number(price), imageUrls[0] || '', imageUrls, category || 'Все']
    );
    bot.sendMessage(msg.chat.id, `✅ Товар "${res.rows[0].name}" (ID: ${res.rows[0].id}) успешно добавлен!`);
  } catch (err) {
    bot.sendMessage(msg.chat.id, `Ошибка: ${err.message}`);
  }
});

// СПИСОК С КНОПКАМИ УДАЛЕНИЯ
bot.onText(/\/listproducts/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  try {
    const res = await pool.query('SELECT * FROM products ORDER BY id DESC');
    if (res.rows.length === 0) return bot.sendMessage(msg.chat.id, 'Каталог пуст.');
    
    bot.sendMessage(msg.chat.id, `📦 **Список товаров в БД (${res.rows.length} шт.):**`);

    for (const p of res.rows) {
      const pText = `• **ID ${p.id}**: ${p.name}\n💰 **Цена:** ${p.price} ₽ | **Категория:** ${p.category || 'Все'}`;
      await bot.sendMessage(msg.chat.id, pText, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: `🗑 Удалить товар №${p.id}`, callback_data: `delprod_${p.id}` }]
          ]
        }
      });
    }
  } catch (err) {
    bot.sendMessage(msg.chat.id, `Ошибка: ${err.message}`);
  }
});

// РАБОТА С КНОПКАМИ
bot.on('callback_query', async (query) => {
  const data = query.data;

  // Удаление товара по кнопке
  if (data.startsWith('delprod_')) {
    const productId = data.split('_')[1];
    try {
      await pool.query('DELETE FROM products WHERE id = $1', [productId]);
      bot.editMessageText(`🗑 **Товар ID ${productId} успешно удален из базы!**`, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });
    } catch (err) {
      bot.sendMessage(query.message.chat.id, `Ошибка удаления: ${err.message}`);
    }
  } 
  // Подтверждение / отклонение оплаты
  else if (data.startsWith('approve_') || data.startsWith('reject_')) {
    const [action, orderId, userId, amount] = data.split('_');

    if (action === 'approve') {
      await pool.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [orderId]);

      const userRes = await pool.query('SELECT is_first_order FROM users WHERE telegram_id = $1', [userId]);
      const isFirst = userRes.rows[0]?.is_first_order ?? true;

      const bonusPercent = isFirst ? 0.15 : 0.05;
      const earnedBonuses = Math.round(Number(amount) * bonusPercent);

      await pool.query(
        'UPDATE users SET bonuses = bonuses + $1, is_first_order = FALSE WHERE telegram_id = $2',
        [earnedBonuses, userId]
      );

      ADMIN_IDS.forEach(adminId => {
        bot.sendMessage(adminId, `✅ **Заказ №${orderId} подтвержден!** Пользователю начислено ${earnedBonuses} Б.`, { parse_mode: 'Markdown' }).catch(() => {});
      });

      bot.sendMessage(userId, `🎉 **Ваша оплата по заказу №${orderId} подтверждена!**\nВам начислено ${earnedBonuses} бонусов. Готовим заказ к отправке!`, { parse_mode: 'Markdown' });
    } else if (action === 'reject') {
      await pool.query(`UPDATE orders SET status = 'rejected' WHERE id = $1`, [orderId]);

      ADMIN_IDS.forEach(adminId => {
        bot.sendMessage(adminId, `❌ Заказ №${orderId} отклонен.`).catch(() => {});
      });

      bot.sendMessage(userId, `❌ Ваш чек по заказу №${orderId} не прошел проверку. Свяжитесь с поддержкой @AltaClotheswrk.`);
    }
  }

  bot.answerCallbackQuery(query.id);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
