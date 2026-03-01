const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/config', (req, res) => {
  res.json({ WALLET_ORIGIN: process.env.WALLET_URL || 'http://wallet.localhost:3001' });
});

app.listen(PORT, () => {
  console.log(`🏪 Merchant site running at http://store.localhost:${PORT}`);
  console.log(`   (also accessible at http://localhost:${PORT})`);
});
