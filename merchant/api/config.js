// Serves wallet origin from environment variable
// This lets the merchant site know where the wallet iframe is hosted
module.exports = (req, res) => {
  res.json({
    WALLET_ORIGIN: process.env.WALLET_ORIGIN || '',
  });
};
