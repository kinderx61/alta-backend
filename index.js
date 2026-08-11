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

// Список администраторов
const ADMIN_IDS = [
  '843132781',
  '5186266444',
  process.env.ADMIN_CHAT_ID
].filter(Boolean);

const isAdmin = (chatId) => ADMIN_IDS.includes(chatId.toString());

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
      { command: 'listproducts', description: '📦 Посмотреть список всех товаров' },
      { command: 'editprice', description: '✏️ Изменить цену товара' },
      { command: 'editphotos', description: '🖼 Обновить фото товара' },
      { command: 'deleteproduct', description: '🗑 Удалить товар по ID' }
    ];

    for (const adminId of ADMIN_IDS) {
      await bot.setMyCommands(adminCommands, { scope: { type: 'chat', chat_id: adminId } }).catch(() => {});
    }
  } catch (err) {
    console.error('Ошибка настройки команд:', err);
  }
};
setupCommands();

// БД
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
        status TEXT DEFAULT 'pending'
      );
    `);

    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_urls TEXT[];`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Все';`);
  } catch (err) {
    console.error('Ошибка БД:', err);
  }
};
initDb();

// При /start отправляем красивую большую кнопку во всю ширину чата
bot.onText(/\/start/, (msg) => {
  const text = `Привет, ${msg.from.first_name || 'друг'}! 👋\n\nДобро пожаловать в **ALTA® CONCEPT STORE**.\n\nНажми на кнопку ниже, чтобы открыть каталог одежды:`;
  
  bot.sendMessage(msg.chat.id, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '🛒 ОТКРЫТЬ МАГАЗИН ALTA',
            web_app: { url: WEB_APP_URL }
          }
        ]
      ]
    }
  });
});

bot.onText(/\/admin/, (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  const helpText = `⚙️ **Админ-меню ALTA:**\n\n` +
    `1. Добавить товар:\n\`/addproduct Худи Черное | 4500 | https://img1.jpg, https://img2.jpg | Худи\`\n\n` +
    `2. Изменить фото:\n\`/editphotos ID https://img1.jpg, https://img2.jpg\`\n\n` +
    `3. Изменить цену:\n\`/editprice ID 5000\`\n\n` +
    `4. Список всех товаров:\n\`/listproducts\`\n\n` +
    `5. Удалить товар:\n\`/deleteproduct ID\``;
  bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
});

bot.onText(/\/addproduct(?:\s+(.+))?/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return;

  const arg = match[1];
  if (!arg) {
    return bot.sendMessage(msg.chat.id, 
      `➕ **Как добавить товар:**\n\nСкопируйте и заполните команду ниже:\n\n` +
      `\`/addproduct Название | Цена | Ссылка1, Ссылка2 | Категория\`\n\n` +
      `*Пример:*\n\`/addproduct Зип-худи ALTA | 5500 | https://i.ibb.co/photo1.jpg | Худи\``, 
      { parse_mode: 'Markdown' }
    );
  }

  const parts = arg.split('|').map(p => p.trim());
  if (parts.length < 2) {
    return bot.sendMessage(msg.chat.id, '❌ Неверный формат. Используйте разделитель `|` между полями.', { parse_mode: 'Markdown' });
  }

  const [name, price, imagesStr, category] = parts;
  const imageUrls = imagesStr ? imagesStr.split(',').map(s => s.trim()) : [];
  const mainImage = imageUrls[0] || '';

  try {
    const res = await pool.query(
      'INSERT INTO products (name, price, image_url, image_urls, category) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, Number(price), mainImage, imageUrls, category || 'Все']
    );
    bot.sendMessage(msg.chat.id, `✅ Товар "${res.rows[0].name}" (ID: ${res.rows[0].id}) успешно добавлен в каталог!`);
  } catch (err) {
    bot.sendMessage(msg.chat.id, `❌ Ошибка БД: ${err.message}`);
  }
});

bot.onText(/\/listproducts/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  try {
    const res = await pool.query('SELECT * FROM products ORDER BY id DESC');
    if (res.rows.length === 0) return bot.sendMessage(msg.chat.id, 'Каталог пока пуст.');
    
    let text = '📦 **Список товаров в базе ALTA:**\n\n';
    res.rows.forEach(p => {
      text += `• **ID ${p.id}**: ${p.name} — ${p.price} ₽ [${p.category || 'Все'}]\n`;
    });
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`);
  }
});

bot.onText(/\/editprice(?:\s+(\d+)\s+(\d+))?/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return;

  const productId = match[1];
  const newPrice = match[2];

  if (!productId || !newPrice) {
    return bot.sendMessage(msg.chat.id, 
      `✏️ **Изменение цены:**\n\nОтправьте команду в формате:\n\`/editprice ID_Товара НоваяЦена\`\n\n*Пример:*\n\`/editprice 1 4900\``, 
      { parse_mode: 'Markdown' }
    );
  }

  try {
    await pool.query('UPDATE products SET price = $1 WHERE id = $2', [Number(newPrice), productId]);
    bot.sendMessage(msg.chat.id, `✅ Цена товара ID ${productId} обновлена на ${newPrice} ₽.`);
  } catch (err) {
    bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`);
  }
});

bot.onText(/\/editphotos(?:\s+(\d+)\s+(.+))?/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return;

  const productId = match[1];
  const photosStr = match[2];

  if (!productId || !photosStr) {
    return bot.sendMessage(msg.chat.id, 
      `🖼 **Обновление фото:**\n\nОтправьте команду в формате:\n\`/editphotos ID_Товара Ссылка1, Ссылка2\`\n\n*Пример:*\n\`/editphotos 1 https://img1.jpg, https://img2.jpg\``, 
      { parse_mode: 'Markdown' }
    );
  }

  const imageUrls = photosStr.split(',').map(s => s.trim());
  const mainImage = imageUrls[0] || '';

  try {
    await pool.query('UPDATE products SET image_url = $1, image_urls = $2 WHERE id = $3', [mainImage, imageUrls, productId]);
    bot.sendMessage(msg.chat.id, `✅ Фотографии товара ID ${productId} обновлены (${imageUrls.length} шт).`);
  } catch (err) {
    bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`);
  }
});

bot.onText(/\/deleteproduct(?:\s+(\d+))?/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return;

  const productId = match[1];
  if (!productId) {
    return bot.sendMessage(msg.chat.id, 
      `🗑 **Удаление товара:**\n\nОтправьте команду с ID товара:\n\`/deleteproduct ID_Товара\`\n\n*Пример:*\n\`/deleteproduct 1\``, 
      { parse_mode: 'Markdown' }
    );
  }

  try {
    await pool.query('DELETE FROM products WHERE id = $1', [productId]);
    bot.sendMessage(msg.chat.id, `🗑 Товар ID ${productId} успешно удален.`);
  } catch (err) {
    bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`);
  }
});

// API
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

app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

    const itemsText = items?.map(i => `- ${i.name} (${i.selectedSize || 'M'}) — ${i.price} ₽`).join('\n') || 'Не указаны';

    const msg = `🛍 **НОВЫЙ ЗАКАЗ №${orderId}**\n\n` +
      `👤 **Покупатель:** ${fullName} (${telegramUsername || '@no_username'})\n` +
      `📞 **Телефон:** ${phone}\n` +
      `📍 **Доставка:** ${deliveryType}, г. ${city}, ${address} (${postalCode})\n\n` +
      `📦 **Состав заказа:**\n${itemsText}\n\n` +
      `💰 **К оплате:** ${totalAmount} ₽ (Списано бонусов: ${bonusesUsed})`;

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
      bot.sendMessage(adminId, `✅ Заказ №${orderId} подтвержден! Начислено ${earnedBonuses} бонусов.`).catch(() => {});
    });
    bot.sendMessage(userId, `🎉 Ваш заказ №${orderId} успешно подтвержден! Начислено ${earnedBonuses} бонусов.`);
  }

  bot.answerCallbackQuery(query.id);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
