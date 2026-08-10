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

// СПИСОК АДМИНИСТРАТОРОВ (2 админа)
const ADMIN_IDS = [
  process.env.ADMIN_CHAT_ID, // Твой ID из переменных окружения Render
  '5186266444'               // Второй админ
].filter(Boolean);

const isAdmin = (chatId) => ADMIN_IDS.includes(chatId.toString());

// 1. Инициализация БД
const initDb = async () => {
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
      status TEXT DEFAULT 'pending'
    );
  `);
};
initDb().catch(console.error);

// API 1: Инициализация пользователя
app.post('/api/user/init', async (req, res) => {
  const { telegramId, username, firstName } = req.body;
  try {
    let result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
    if (result.rows.length === 0) {
      result = await pool.query(
        'INSERT INTO users (telegram_id, username, first_name) VALUES ($1, $2, $3) RETURNING *',
        [telegramId, username, firstName]
      );
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API 2: Получение товаров
app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API 3: Создание заказа
app.post('/api/orders', async (req, res) => {
  const { userId, telegramUsername, fullName, city, postalCode, address, phone, deliveryType, totalAmount, bonusesUsed, items } = req.body;

  try {
    const orderRes = await pool.query(
      `INSERT INTO orders (user_id, full_name, city, postal_code, address, phone, delivery_type, total_amount, bonuses_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [userId, fullName, city, postalCode, address, phone, deliveryType, totalAmount, bonusesUsed]
    );

    const orderId = orderRes.rows[0].id;

    if (bonusesUsed > 0) {
      await pool.query('UPDATE users SET bonuses = bonuses - $1 WHERE telegram_id = $2', [bonusesUsed, userId]);
    }

    const itemsText = items?.map(i => `- ${i.name} (${i.selectedSize || 'M'}) — ${i.price}₽`).join('\n') || 'Не указаны';

    const msg = `🛍 **НОВЫЙ ЗАКАЗ №${orderId}**\n\n` +
      `👤 **Покупатель:** ${fullName} (${telegramUsername || '@no_username'})\n` +
      `📞 **Телефон:** ${phone}\n` +
      `📍 **Доставка:** ${deliveryType}, г. ${city}, ${address} (${postalCode})\n\n` +
      `📦 **Состав заказа:**\n${itemsText}\n\n` +
      `💰 **К оплате:** ${totalAmount} ₽ (Списано бонусов: ${bonusesUsed})`;

    // Отправка уведомления ВСЕМ админам
    ADMIN_IDS.forEach(adminId => {
      bot.sendMessage(adminId, msg, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Подтвердить оплату', callback_data: `approve_${orderId}_${userId}_${totalAmount}` },
              { text: '❌ Отклонить', callback_data: `reject_${orderId}` }
            ]
          ]
        }
      }).catch(() => {});
    });

    res.json({ success: true, orderId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- АДМИН-КОМАНДЫ В БОТЕ ---

// 1. Добавление товара: /addproduct Название | Цена | СсылкаНаФото | Категория
bot.onText(/\/addproduct (.+)/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return;

  const parts = match[1].split('|').map(p => p.trim());
  if (parts.length < 2) {
    return bot.sendMessage(msg.chat.id, '❌ Формат: `/addproduct Название | Цена | СсылкаНаФото | Категория`\n\nКатегории: Худи, Футболки, Штаны, Аксессуары', { parse_mode: 'Markdown' });
  }

  const [name, price, imageUrl, category] = parts;
  try {
    const res = await pool.query(
      'INSERT INTO products (name, price, image_url, category) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, Number(price), imageUrl || '', category || 'Все']
    );
    bot.sendMessage(msg.chat.id, `✅ Товар "${res.rows[0].name}" (ID: ${res.rows[0].id}, Категория: ${res.rows[0].category}) добавлен!`);
  } catch (err) {
    bot.sendMessage(msg.chat.id, `Ошибка: ${err.message}`);
  }
});

// 2. Список товаров: /listproducts
bot.onText(/\/listproducts/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  try {
    const res = await pool.query('SELECT * FROM products ORDER BY id DESC');
    if (res.rows.length === 0) return bot.sendMessage(msg.chat.id, 'Каталог пуст.');
    
    let text = '📦 **Список товаров в базе:**\n\n';
    res.rows.forEach(p => {
      text += `• **ID ${p.id}**: ${p.name} — ${p.price}₽ [${p.category || 'Все'}]\n`;
    });
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(msg.chat.id, `Ошибка: ${err.message}`);
  }
});

// 3. Изменить цену: /editprice ID НоваяЦена
bot.onText(/\/editprice (\d+) (\d+)/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return;
  const [_, productId, newPrice] = match;
  try {
    await pool.query('UPDATE products SET price = $1 WHERE id = $2', [Number(newPrice), productId]);
    bot.sendMessage(msg.chat.id, `✅ Цена товара ID ${productId} изменена на ${newPrice} ₽.`);
  } catch (err) {
    bot.sendMessage(msg.chat.id, `Ошибка: ${err.message}`);
  }
});

// 4. Удаление товара: /deleteproduct ID
bot.onText(/\/deleteproduct (\d+)/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return;
  const productId = match[1];
  try {
    await pool.query('DELETE FROM products WHERE id = $1', [productId]);
    bot.sendMessage(msg.chat.id, `🗑 Товар ID ${productId} удален из базы.`);
  } catch (err) {
    bot.sendMessage(msg.chat.id, `Ошибка: ${err.message}`);
  }
});

// Команда помощи по админке: /admin
bot.onText(/\/admin/, (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  const helpText = `⚙️ **Команды администратора ALTA:**\n\n` +
    `1. Добавить товар:\n\`/addproduct Худи Черное | 4500 | https://... | Худи\`\n\n` +
    `2. Изменить цену:\n\`/editprice ID 5000\`\n\n` +
    `3. Посмотреть все товары:\n\`/listproducts\`\n\n` +
    `4. Удалить товар:\n\`/deleteproduct ID\``;
  bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
});

// Обработка кнопок в боте
bot.on('callback_query', async (query) => {
  const [action, orderId, userId, amount] = query.data.split('_');

  if (action === 'approve') {
    const userRes = await pool.query('SELECT is_first_order FROM users WHERE telegram_id = $1', [userId]);
    const isFirst = userRes.rows[0]?.is_first_order ?? true;

    const bonusPercent = isFirst ? 0.15 : 0.05;
    const earnedBonuses = Math.round(Number(amount) * bonusPercent);

    await pool.query(
      'UPDATE users SET bonuses = bonuses + $1, is_first_order = FALSE WHERE telegram_id = $2',
      [earnedBonuses, userId]
    );

    ADMIN_IDS.forEach(adminId => {
      bot.sendMessage(adminId, `Заказ №${orderId} подтвержден! Начислено ${earnedBonuses} Б.`).catch(() => {});
    });
    bot.sendMessage(userId, `🎉 Ваш заказ №${orderId} подтвержден! Начислено ${earnedBonuses} бонусов.`);
  }

  bot.answerCallbackQuery(query.id);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
