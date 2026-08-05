const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Подключение к PostgreSQL (Neon)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Инициализация Telegram Бота
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// 1. Получить список всех товаров
app.get('/api/products', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products WHERE is_available = true ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Получить или зарегистрировать пользователя
app.post('/api/user/init', async (req, res) => {
  const { telegramId, username, firstName } = req.body;
  try {
    let user = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
    
    if (user.rows.length === 0) {
      user = await pool.query(
        'INSERT INTO users (telegram_id, username, first_name) VALUES ($1, $2, $3) RETURNING *',
        [telegramId, username, firstName]
      );
    }
    res.json(user.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Создать заказ
app.post('/api/orders', async (req, res) => {
  const { userId, fullName, city, postalCode, address, phone, deliveryType, totalAmount, bonusesUsed } = req.body;

  try {
    const newOrder = await pool.query(
      `INSERT INTO orders (user_id, full_name, city, postal_code, address, phone, delivery_type, total_amount, bonuses_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [userId, fullName, city, postalCode, address, phone, deliveryType, totalAmount, bonusesUsed]
    );

    const orderId = newOrder.rows[0].id;

    const message = `🛍 **НОВЫЙ ЗАКАЗ №${orderId}**\n\n` +
      `👤 **Покупатель:** ${fullName} (${phone})\n` +
      `📍 **Адрес:** ${city}, ${address}, ${postalCode}\n` +
      `🚚 **Доставка:** ${deliveryType}\n` +
      `💵 **Сумма:** ${totalAmount} ₽ (Списано бонусов: ${bonusesUsed})\n\n` +
      `Статус: Ожидает отправки чека в бот.`;

    await bot.sendMessage(process.env.ADMIN_CHAT_ID, message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Подтвердить чек", callback_data: `confirm_${orderId}` }],
          [{ text: "❌ Отклонить чек", callback_data: `reject_${orderId}` }]
        ]
      }
    });

    res.json({ success: true, orderId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Обработка кнопок администратора
bot.on('callback_query', async (query) => {
  const [action, orderId] = query.data.split('_');
  
  if (action === 'confirm' || action === 'reject') {
    const newStatus = action === 'confirm' ? 'Подтвержден' : 'Отклонен';
    
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [newStatus, orderId]);

    if (action === 'confirm') {
      const orderRes = await pool.query('SELECT user_id, total_amount FROM orders WHERE id = $1', [orderId]);
      if (orderRes.rows.length > 0) {
        const { user_id, total_amount } = orderRes.rows[0];
        const userRes = await pool.query('SELECT is_first_order FROM users WHERE telegram_id = $1', [user_id]);
        
        const isFirst = userRes.rows[0]?.is_first_order;
        const percent = isFirst ? 0.15 : 0.05;
        const bonusEarned = Math.round(total_amount * percent);

        await pool.query(
          'UPDATE users SET bonuses = bonuses + $1, is_first_order = FALSE WHERE telegram_id = $2',
          [bonusEarned, user_id]
        );

        bot.sendMessage(user_id, `🎉 Ваш заказ №${orderId} подтвержден! Начислено бонусов: +${bonusEarned} Б.`);
      }
    }

    bot.answerCallbackQuery(query.id, { text: `Заказ №${orderId} ${newStatus}` });
    bot.editMessageText(query.message.text + `\n\nСтатус изменен: **${newStatus}**`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
